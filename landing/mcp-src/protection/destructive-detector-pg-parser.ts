/**
 * destructive-detector-pg-parser.ts · feat-028 PG parser AST backend (ADR-0005)
 *
 * 用 libpg-query (WASM · PgAnalyze 维护 · 跟 PG 17 同步) 把 SQL 解析成 AST · 走 AST 顶节点
 * map 到 §8.1 op-class · 闭防 4 类绕过 (line/block comment / Unicode escape / multi-stmt)
 * + 长锁 op-class (VACUUM FULL / CLUSTER · #109)。
 *
 * 实施依据: feat-028/#107 audit (https://github.com/zlxtqbdgdgd/openneon-mcp/issues/107 ·
 * macOS 本地实测 · p99=0.013ms · 2.1MB wasm · loadModule cold ~50ms 一次性)。
 *
 * 启动期: 调用方 (mcp-server 主进程) 必须 await initPgParser() · 失败 throw → mcp 启动拒
 * (fail-closed · 不 silent fallback 到 regex backend)。
 *
 * 热路径: classifyOpPgParser / classifySqlPgParser 同步 · 用 parseSync · parse 失败 → 'OTHER'
 * (fail-closed · **不**退 'READ_ONLY' · 防误判放行)。
 */

import type { OpClass } from './destructive-detector';

// ──────────────────────────────────────────────────────────────
// libpg-query 模块加载 · WASM init 必须显式 await
// ──────────────────────────────────────────────────────────────

type PgParserModule = {
  loadModule: () => Promise<void>;
  parseSync: (sql: string) => { stmts?: PgStmt[] } | unknown;
};

type PgStmt = { stmt?: Record<string, unknown>; stmt_len?: number };

let pgParserModule: PgParserModule | null = null;
let initPromise: Promise<void> | null = null;

/**
 * mcp-server 启动期调用一次 · WASM runtime 初始化 + 模块 import 校验。
 * 失败 throw (典型: 包未装 / wasm 加载失败) → 调用方 (mcp 主进程) 让启动失败 ·
 * 不 silent 退到 regex backend (安全策略: parser 装不上就拒启动 · 比悄悄降级安全)。
 */
export async function initPgParser(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // dynamic import · 让没装 libpg-query 时 regex backend 仍可用
    const mod = (await import('libpg-query')) as unknown as PgParserModule;
    await mod.loadModule();
    pgParserModule = mod;
  })();
  return initPromise;
}

export function isPgParserReady(): boolean {
  return pgParserModule !== null;
}

/** test helper · 单测可 reset · 不导出做正式 API */
export function _resetPgParserForTests(): void {
  pgParserModule = null;
  initPromise = null;
}

// ──────────────────────────────────────────────────────────────
// classifyOpPgParser · 主入口 (同 day-one classifyOp 接口)
// ──────────────────────────────────────────────────────────────

const SQL_TOOLS: ReadonlySet<string> = new Set([
  'run_sql',
  'run_sql_transaction',
]);

export function classifyOpPgParser(toolName: string, sql?: string): OpClass {
  if (!SQL_TOOLS.has(toolName)) return 'READ_ONLY';
  if (!sql || sql.trim() === '') return 'READ_ONLY';
  return classifySqlPgParser(sql);
}

/**
 * 用 AST 分类 SQL · 多语句取 mostDangerous (priority order 见 PRIORITY)。
 * parse 失败 → 'OTHER' fail-closed (不 'READ_ONLY' · 防误判放行)。
 */
export function classifySqlPgParser(sql: string): OpClass {
  if (!pgParserModule) {
    // 防御性: initPgParser 未跑就走到这 · throw 让 caller 报错 (而不是回退)
    throw new Error(
      'pg-parser not initialized · call initPgParser() at startup',
    );
  }
  let ast: { stmts?: PgStmt[] };
  try {
    ast = pgParserModule.parseSync(sql) as { stmts?: PgStmt[] };
  } catch {
    return 'OTHER'; // parse error (典型: typo / Unicode escape / 嵌套块注释 PG 拒)
  }
  const stmts = ast?.stmts ?? [];
  if (stmts.length === 0) return 'READ_ONLY'; // 空 SQL / 只有注释
  let worst: OpClass = 'READ_ONLY';
  for (const s of stmts) {
    const c = classifyStmt(s.stmt ?? {});
    if (rank(c) > rank(worst)) worst = c;
  }
  return worst;
}

// ──────────────────────────────────────────────────────────────
// AST → OpClass mapper
// ──────────────────────────────────────────────────────────────

/**
 * server-side 函数名 → 特殊 op-class (函数调用形态 · 不是 statement 形态 · 走 SelectStmt 时
 * 需 scan FuncCall 节点判定)。
 */
const FUNCTION_OP_CLASS: Record<string, OpClass> = {
  pg_drop_replication_slot: 'DROP_REPLICATION_SLOT',
};

/** stmt 节点 (有 1 个 key · 是 AST 顶节点名) → OpClass */
function classifyStmt(stmt: Record<string, unknown>): OpClass {
  const keys = Object.keys(stmt);
  if (keys.length === 0) return 'READ_ONLY';
  const nodeType = keys[0];
  const node = stmt[nodeType] as Record<string, unknown>;

  switch (nodeType) {
    // —— hard-deny tier ——
    case 'DropdbStmt':
      return 'DROP_DATABASE_OR_TRUNCATE';
    case 'TruncateStmt':
      return 'DROP_DATABASE_OR_TRUNCATE';
    case 'DropRoleStmt':
      return 'DROP_USER_OR_REVOKE';
    case 'GrantStmt': {
      // PG AST: is_grant=true → GRANT · undefined/false → REVOKE
      const isGrant = node.is_grant === true;
      return isGrant ? 'OTHER' : 'DROP_USER_OR_REVOKE';
    }
    case 'GrantRoleStmt': {
      const isGrant = node.is_grant === true;
      return isGrant ? 'OTHER' : 'DROP_USER_OR_REVOKE';
    }

    // —— DROP table/index/view/matview/schema · 长尾 DROP 形态 ——
    case 'DropStmt': {
      const removeType = String(node.removeType ?? '');
      // OBJECT_TABLE / OBJECT_INDEX / OBJECT_VIEW / OBJECT_MATVIEW / OBJECT_SCHEMA → DROP_TABLE_OR_INDEX
      if (
        removeType === 'OBJECT_TABLE' ||
        removeType === 'OBJECT_INDEX' ||
        removeType === 'OBJECT_VIEW' ||
        removeType === 'OBJECT_MATVIEW' ||
        removeType === 'OBJECT_SCHEMA' ||
        removeType === 'OBJECT_SEQUENCE' ||
        removeType === 'OBJECT_TYPE'
      ) {
        return 'DROP_TABLE_OR_INDEX';
      }
      // 兜底: 其它 DROP X (FOREIGN TABLE / TRIGGER / FUNCTION 等) 归 DROP_TABLE_OR_INDEX
      // (保守 · 不退 READ_ONLY)
      return 'DROP_TABLE_OR_INDEX';
    }

    // —— 长锁 (#109 · ACCESS EXCLUSIVE LOCK · 阻塞 SELECT) ——
    case 'VacuumStmt': {
      // VACUUM 默认非长锁 · 只有带 FULL 才 ACCESS EXCLUSIVE → 长锁 op-class
      const options = (node.options ?? []) as Array<{
        DefElem?: { defname?: string };
      }>;
      const hasFull = options.some(
        (o) => o.DefElem?.defname?.toLowerCase() === 'full',
      );
      // 普通 VACUUM 不长锁 → OTHER (按 fail-closed 走 require_plan · 不放行)
      // 注: 普通 VACUUM 不算"危险"但 day-one 也没明确归类 · 走 OTHER 保守 · 后续可细分 MAINTENANCE
      return hasFull ? 'VACUUM_FULL_LOCK' : 'OTHER';
    }
    case 'ClusterStmt':
      // CLUSTER (USING idx / refresh existing) 都取 ACCESS EXCLUSIVE LOCK
      return 'CLUSTER_LOCK';

    // —— CREATE INDEX (concurrently 区分) ——
    case 'IndexStmt': {
      const concurrent = node.concurrent === true;
      return concurrent ? 'CREATE_INDEX_CONCURRENTLY' : 'DDL_ADD_COLUMN';
    }

    // —— ALTER TABLE (day-one 保守归大锁 · 不细分 small lock) ——
    case 'AlterTableStmt':
      return 'ALTER_TABLE_BIG_LOCK';

    // —— DML (INSERT/UPDATE/DELETE) ——
    case 'InsertStmt':
    case 'UpdateStmt':
    case 'DeleteStmt':
      return 'DELETE_UPDATE_BULK';

    // —— DDL 低风险 ——
    case 'CreateStmt': // CREATE TABLE
    case 'CreateSchemaStmt':
    case 'CreateSeqStmt':
    case 'CreateEnumStmt':
    case 'CreateTrigStmt':
    case 'CreateFunctionStmt':
    case 'CreateExtensionStmt':
    case 'DefineStmt': // CREATE TYPE / CREATE AGGREGATE
      return 'DDL_ADD_COLUMN';

    // —— SELECT / CTE (内含 DML 取 mostDangerous) ——
    case 'SelectStmt':
      return classifySelectStmt(node);

    // —— 只读管理 ——
    case 'ExplainStmt':
    case 'VariableShowStmt':
    case 'VariableSetStmt': // SET / RESET
    case 'TransactionStmt': // BEGIN / COMMIT / ROLLBACK · 无 SQL 内容危害
    case 'CopyStmt': // 保守: COPY 表读/写, day-one regex 也没拦, 暂归 READ_ONLY (后续看场景再细分)
      return 'READ_ONLY';

    // —— EXECUTE prepared (§11 OQ3 · 不知道 prepared body · fail-closed OTHER) ——
    case 'ExecuteStmt':
      return 'OTHER';

    default:
      // 未识别节点 → OTHER (fail-closed · 不退 READ_ONLY)
      return 'OTHER';
  }
}

/**
 * SelectStmt 内的 CTE 可能含 DML (DELETE/UPDATE/INSERT RETURNING) · 走 withClause 找。
 * 同时 scan FuncCall 节点 · 命中 server-side 危险函数 (pg_drop_replication_slot) → 转其 op-class。
 *
 * Design §7.1 用例 9: `WITH t AS (DELETE FROM x RETURNING *) SELECT * FROM t` →
 * top-level 写 (DELETE_UPDATE_BULK · 即 design 的 WRITE_DML 名称)
 */
function classifySelectStmt(node: Record<string, unknown>): OpClass {
  let worst: OpClass = 'READ_ONLY';

  // 1. withClause 内的 CTE 写
  const withClause = node.withClause as
    | { ctes?: Array<{ CommonTableExpr?: { ctequery?: Record<string, unknown> } }> }
    | undefined;
  if (withClause?.ctes) {
    for (const cte of withClause.ctes) {
      const ctequery = cte.CommonTableExpr?.ctequery;
      if (!ctequery) continue;
      // ctequery 也是 stmt 形态 · 递归 classifyStmt
      const inner = classifyStmt(ctequery);
      if (rank(inner) > rank(worst)) worst = inner;
    }
  }

  // 2. scan FuncCall · 命中危险 server-side 函数
  const funcCallOp = scanFuncCalls(node);
  if (funcCallOp && rank(funcCallOp) > rank(worst)) worst = funcCallOp;

  return worst;
}

/** 递归 scan AST 子树 · 找 FuncCall 节点 · 命中 FUNCTION_OP_CLASS 返其 op-class */
function scanFuncCalls(obj: unknown): OpClass | null {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    let worst: OpClass | null = null;
    for (const item of obj) {
      const c = scanFuncCalls(item);
      if (c && (!worst || rank(c) > rank(worst))) worst = c;
    }
    return worst;
  }
  const o = obj as Record<string, unknown>;
  // 命中 FuncCall · 取最后一段 funcname (典型 [{String: { sval: 'pg_drop_replication_slot' }}])
  if (o.FuncCall) {
    const fc = o.FuncCall as { funcname?: Array<{ String?: { sval?: string } }> };
    const parts = fc.funcname ?? [];
    const last = parts[parts.length - 1];
    const name = last?.String?.sval;
    if (name && FUNCTION_OP_CLASS[name]) return FUNCTION_OP_CLASS[name];
  }
  // 递归子键
  let worst: OpClass | null = null;
  for (const k of Object.keys(o)) {
    const c = scanFuncCalls(o[k]);
    if (c && (!worst || rank(c) > rank(worst))) worst = c;
  }
  return worst;
}

// ──────────────────────────────────────────────────────────────
// mostDangerous priority · 多语句 / CTE / FuncCall scan 取最危险用
// ──────────────────────────────────────────────────────────────

const PRIORITY: OpClass[] = [
  'READ_ONLY',
  'OTHER',
  // feat-068 DYNAMIC_PROBE_ATTACH 非 SQL · PG parser 不会推出 · 列出仅满足 OpClass exhaustiveness
  'DYNAMIC_PROBE_ATTACH',
  'CLUSTER_LOCK',
  'VACUUM_FULL_LOCK',
  'CREATE_OR_RESTORE_BRANCH',
  'DDL_ADD_COLUMN',
  'CREATE_INDEX_CONCURRENTLY',
  'DELETE_UPDATE_BULK',
  'ALTER_TABLE_BIG_LOCK',
  'DROP_REPLICATION_SLOT',
  'DROP_TABLE_OR_INDEX',
  'DROP_USER_OR_REVOKE',
  'DROP_DATABASE_OR_TRUNCATE',
  'CROSS_PROJECT',
];

function rank(c: OpClass): number {
  const i = PRIORITY.indexOf(c);
  return i < 0 ? 0 : i;
}
