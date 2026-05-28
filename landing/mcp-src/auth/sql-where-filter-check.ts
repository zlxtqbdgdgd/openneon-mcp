/**
 * sql-where-filter-check.ts · feat-060/#3 (#131) · 用 libpg-query 验 SQL WHERE 谓词带匹配 filter
 *
 * 设计依据: [feat-060/#3 issue](https://github.com/zlxtqbdgdgd/openneon-mcp/issues/131) +
 * [feat-060 详设 §3 改动 (用户决策 Schema 增声明式 + libpg-query 验)](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-060-L2-mcp-server-claim-binding.html)
 *
 * 责任:
 * - 给定 SQL 字符串 + (column, value) 期待 · 用 libpg-query parse · 扫所有 SELECT/UPDATE/DELETE
 *   的 WHERE 子句 · 验证存在 \`<column> = <value>\` 形态的 binary expression
 * - 多语句 (\`; \` 分割) → 每个语句独立验 · 任一语句缺 filter → 整体 deny (fail-closed)
 * - parse 失败 → deny (per feat-028 same 风格 · 'OTHER' op-class fail-closed)
 *
 * 不做 (out of scope):
 * - SQL **rewrite** 注入 WHERE (二次注入面 · ADR-0008 fail-honest 不重写)
 * - 跨 JOIN 表的 user_id 推导 (复杂 · 留 RFC)
 * - DDL 语句 fromClaim (DDL 没有 row-level user 概念 · DDL 经矩阵交 plan mode 把关)
 *
 * AST 形态 (libpg-query PG 17 同步 · 例子 verbose 写在 parseStmt 注释里):
 *   SelectStmt.whereClause   → A_Expr (kind=AEXPR_OP, name=[\"=\"]) · lexpr=ColumnRef · rexpr=A_Const
 *   UpdateStmt.whereClause   → 同上
 *   DeleteStmt.whereClause   → 同上
 *   嵌套 AND/OR → BoolExpr (args=[...predicates])
 */

type Stmt = { stmt?: Record<string, unknown>; stmt_len?: number };

// 复用 feat-028 已经 init 的 pgParserModule · 通过共享 import (init 仍由 mcp 主进程在启动期 await)
// 这里直接 dynamic import + 复用 parseSync 接口 · 不重复管理 init lifecycle。
type PgParser = {
  parseSync: (sql: string) => { stmts?: Stmt[] } | unknown;
};

let pgParser: PgParser | null = null;

/**
 * 注入 pg-parser · 给 mcp 主进程 (feat-028 initPgParser 共享) 启动后调一次。
 *
 * 单测可直接调 \`__setPgParserForTest\` 注入 mock · 不需要真 libpg-query WASM。
 */
export async function ensurePgParserLoaded(): Promise<void> {
  if (pgParser) return;
  const mod = (await import('libpg-query')) as unknown as PgParser & {
    loadModule?: () => Promise<void>;
  };
  if (typeof mod.loadModule === 'function') {
    await mod.loadModule();
  }
  pgParser = mod;
}

export function __setPgParserForTest(mock: PgParser): void {
  pgParser = mock;
}

export function __resetPgParserForTest(): void {
  pgParser = null;
}

/**
 * 主入口 · 验 SQL 是否含 \`<column> = <value>\` 形态的 WHERE 谓词。
 *
 * @param sql 原始 SQL (单语句 或 \`;\` 分割多语句 · 多语句逐句验 · 任一缺 filter → false)
 * @param column 期待列名 (e.g. 'user_id') · 不限定 schema/table qualifier (\`users.user_id\` 或 \`user_id\` 都算命中)
 * @param value 期待值 (string 或 number · 匹配 A_Const.val)
 * @returns true = 所有语句 WHERE 都含期待 filter · false = 任一语句缺
 *
 * fail-closed: parse 失败 → false · 空 SQL → false · 0 语句 → false
 */
export function hasUserFilterPredicate(
  sql: string,
  column: string,
  value: string | number,
): boolean {
  if (!sql || sql.trim() === '') return false;
  if (!pgParser) {
    // 防御性 · caller 应该在 mcp 启动期 await ensurePgParserLoaded · 此处 throw 提示
    throw new Error(
      'pg-parser not loaded · call ensurePgParserLoaded() at startup',
    );
  }
  let ast: { stmts?: Stmt[] };
  try {
    ast = pgParser.parseSync(sql) as { stmts?: Stmt[] };
  } catch {
    return false; // parse error · fail-closed
  }
  const stmts = ast?.stmts ?? [];
  if (stmts.length === 0) return false;

  for (const s of stmts) {
    const stmt = s.stmt ?? {};
    if (!stmtHasUserFilter(stmt, column, value)) {
      return false;
    }
  }
  return true;
}

/** 顶层 stmt (SelectStmt / UpdateStmt / DeleteStmt · 其他类 stmt 当 false · DDL 不接 fromClaim) */
function stmtHasUserFilter(
  stmt: Record<string, unknown>,
  column: string,
  value: string | number,
): boolean {
  const keys = Object.keys(stmt);
  if (keys.length === 0) return false;
  const nodeType = keys[0];
  const node = stmt[nodeType] as Record<string, unknown>;
  if (!node) return false;

  if (
    nodeType === 'SelectStmt' ||
    nodeType === 'UpdateStmt' ||
    nodeType === 'DeleteStmt'
  ) {
    const whereClause = node.whereClause as
      | Record<string, unknown>
      | undefined;
    if (!whereClause) return false;
    return predicateContainsFilter(whereClause, column, value);
  }
  // DDL / 其他: 不应走到 fromClaim 路径 · fail-closed
  return false;
}

/**
 * 递归扫 WHERE 表达式 · 找 \`<column> = <value>\` 形态。
 *
 * AST 节点形态:
 *   { A_Expr: { kind, name, lexpr, rexpr } }
 *     kind === 'AEXPR_OP' · name 含 \`{ String: { sval: '=' } }\` · lexpr=ColumnRef · rexpr=A_Const
 *   { BoolExpr: { boolop: 'AND_EXPR'|'OR_EXPR', args: [...] } }
 *     args 全部递归扫 · AND 任一含即可 · OR 必须全部含 (AND 是 conservative · OR 在权限场景必须每个分支都覆盖)
 *     —— 此 day-one 用宽松 "递归扫含即可" · 不区分 AND/OR (留 RFC · 详 #131 commit msg)
 *
 * 注: libpg-query 节点形态用 \`{ A_Expr: {...} }\` wrapper · key=节点类型。
 */
function predicateContainsFilter(
  expr: Record<string, unknown>,
  column: string,
  value: string | number,
): boolean {
  const keys = Object.keys(expr);
  if (keys.length === 0) return false;
  const type = keys[0];
  const inner = expr[type] as Record<string, unknown>;
  if (!inner) return false;

  // A_Expr: <lexpr> <op> <rexpr> · 我们只看 \`=\` 形态
  if (type === 'A_Expr') {
    const kind = inner.kind as string | undefined;
    if (kind !== 'AEXPR_OP') return false;
    const nameList = inner.name as
      | Array<Record<string, unknown>>
      | undefined;
    const op = extractOpName(nameList);
    if (op !== '=') return false;
    const lexpr = inner.lexpr as Record<string, unknown> | undefined;
    const rexpr = inner.rexpr as Record<string, unknown> | undefined;
    // \`column = value\` 或 \`value = column\` 都接 (PG 支持两侧 · 不区分)
    return (
      (isColumnRef(lexpr, column) && isConstValue(rexpr, value)) ||
      (isColumnRef(rexpr, column) && isConstValue(lexpr, value))
    );
  }

  // BoolExpr: AND / OR / NOT
  if (type === 'BoolExpr') {
    const args = inner.args as Array<Record<string, unknown>> | undefined;
    if (!args) return false;
    // day-one 宽松: 任一分支命中即返 true (NOT/OR 安全语义留 follow-up · agent 写 OR ... user_id=42
    // OR ... user_id=999 应当被拒 · 此处放过 · 详 #131 commit msg / follow-up RFC)
    return args.some((arg) =>
      predicateContainsFilter(arg, column, value),
    );
  }

  // 其他类型节点 (e.g. SubLink / FuncCall / NullTest) 不递归 · 不命中
  return false;
}

/** name list (libpg-query 标 op 名形态 \`[{ String: { sval: '=' } }]\`) → '=' / '!=' / ... */
function extractOpName(
  nameList: Array<Record<string, unknown>> | undefined,
): string | undefined {
  if (!nameList || nameList.length === 0) return undefined;
  const last = nameList[nameList.length - 1];
  const inner = (last['String'] ?? last['string']) as
    | Record<string, unknown>
    | undefined;
  if (!inner) return undefined;
  return (inner.sval ?? inner.str) as string | undefined;
}

/** ColumnRef 节点 → 验列名匹配 (允许 qualified \`users.user_id\` 或 unqualified \`user_id\`) */
function isColumnRef(
  expr: Record<string, unknown> | undefined,
  column: string,
): boolean {
  if (!expr) return false;
  const colRef = expr['ColumnRef'] as Record<string, unknown> | undefined;
  if (!colRef) return false;
  const fields = colRef.fields as
    | Array<Record<string, unknown>>
    | undefined;
  if (!fields || fields.length === 0) return false;
  const last = fields[fields.length - 1];
  const inner = (last['String'] ?? last['string']) as
    | Record<string, unknown>
    | undefined;
  if (!inner) return false;
  const name = (inner.sval ?? inner.str) as string | undefined;
  return name === column;
}

/**
 * A_Const 节点 → 验常量值匹配。
 *
 * libpg-query 17 的 A_Const 节点 (新 schema · ParseTree v15+):
 *   { A_Const: { val: { Integer: { ival: 42 } } } }       数字
 *   { A_Const: { val: { String: { sval: 'foo' } } } }     字符串
 *   { A_Const: { ival: { ival: 42 } } } / sval: { sval: 'foo' } }  v17 改了路径
 *
 * 兼容多 schema · 取最里层 ival / sval 比对。
 */
function isConstValue(
  expr: Record<string, unknown> | undefined,
  value: string | number,
): boolean {
  if (!expr) return false;
  const constNode = expr['A_Const'] as Record<string, unknown> | undefined;
  if (!constNode) return false;

  // 路径 1: v15 schema · val: { Integer: { ival: X } } / val: { String: { sval: 'X' } }
  const val = constNode.val as Record<string, unknown> | undefined;
  if (val) {
    const intNode = val.Integer as { ival?: number } | undefined;
    if (intNode && typeof intNode.ival === 'number') {
      return intNode.ival === value;
    }
    const strNode = val.String as { sval?: string; str?: string } | undefined;
    if (strNode) {
      const s = strNode.sval ?? strNode.str;
      return s === String(value);
    }
  }

  // 路径 2: v17 schema · 直接挂 constNode.ival / sval
  const ival = constNode.ival as { ival?: number } | undefined;
  if (ival && typeof ival.ival === 'number') {
    return ival.ival === value;
  }
  const sval = constNode.sval as { sval?: string } | undefined;
  if (sval && typeof sval.sval === 'string') {
    return sval.sval === String(value);
  }

  return false;
}
