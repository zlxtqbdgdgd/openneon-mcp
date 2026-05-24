/**
 * destructive-detector.ts · op 分类的单一源 (ADR-0005)
 *
 * classifyOp(toolName, sql?) → §8.1 矩阵的 op-class。feat-056 pipeline 据此查矩阵 /
 * 命中 hard-deny;feat-028 (G4) / feat-058 (dynamic annotation) 复用同一判定
 * (ADR-0005 single source · 0 drift)。
 *
 * day-one: keyword-regex (本文件)。L2a 后期 feat-028 升级 PostgreSQL-parser-based
 * (防 line/block 注释 / Unicode escape 绕过) + 加 VACUUM FULL / CLUSTER 长锁 op-class。
 *
 * 局限 (feat-028 修): keyword-regex 会被 SQL 注释 / 大小写变体绕过 · 故本判定只作 op-class
 * 提示;hard-deny 的绝对安全由 server enforcement (pipeline) 兜底,不依赖 client。
 */

// §8.1 矩阵的操作类别 (overview §8.1 行)
export type OpClass =
  | 'READ_ONLY' //                SELECT / EXPLAIN · 专用只读 tool
  | 'CREATE_OR_RESTORE_BRANCH'
  | 'CREATE_INDEX_CONCURRENTLY'
  | 'DDL_ADD_COLUMN' //           普通低风险 DDL (CREATE TABLE / ADD COLUMN / 非并发建索引)
  | 'ALTER_TABLE_BIG_LOCK'
  | 'DELETE_UPDATE_BULK'
  | 'DROP_TABLE_OR_INDEX'
  | 'DROP_REPLICATION_SLOT'
  // —— 以下命中 hard-deny (任何 autonomy_level 都 deny · ADR-0007) ——
  | 'DROP_DATABASE_OR_TRUNCATE'
  | 'DROP_USER_OR_REVOKE'
  | 'CROSS_PROJECT'; //           由 grant scope vs project_id 判 (G1 stage · 非 SQL 内容 · feat-056/#3)

/** 走 SQL 内容分类的 tool (其余专用 tool 视为 READ_ONLY · #73 焦点 run_sql 写路径) */
const SQL_TOOLS: ReadonlySet<string> = new Set([
  'run_sql',
  'run_sql_transaction',
]);

export function isDestructiveToolName(toolName: string): boolean {
  return SQL_TOOLS.has(toolName);
}

/**
 * 把一次 tool 调用映射到 §8.1 op-class。
 * - 专用 tool (T1-T12 只读) → READ_ONLY
 * - run_sql / run_sql_transaction → 解析 SQL 内容
 *
 * 注: 非-SQL 管理写 tool (delete_branch / delete_project 等) 的 op-class + 护栏在后续
 *     issue (matrix / 管理面) 覆盖 · #73 焦点 run_sql 写路径 hard-deny · 此处归 READ_ONLY
 *     不改变现状 (#73 前这些 tool 本就无 pipeline 护栏 · 不 regress)。
 */
export function classifyOp(toolName: string, sql?: string): OpClass {
  if (!SQL_TOOLS.has(toolName)) return 'READ_ONLY';
  if (!sql || sql.trim() === '') return 'READ_ONLY';
  return classifySql(sql);
}

/**
 * keyword-regex 分类 SQL · 取最危险 (顺序: 先匹配最危险的)。
 * 入参可为多语句拼接 (run_sql_transaction 的 sqlStatements.join) · 任一片段命中即归该类。
 */
export function classifySql(sql: string): OpClass {
  const s = sql.toUpperCase();
  // pg_drop_replication_slot(...) 是函数调用 · 先于通配 DROP 匹配
  if (/PG_DROP_REPLICATION_SLOT/.test(s)) return 'DROP_REPLICATION_SLOT';
  if (/\bDROP\s+DATABASE\b/.test(s) || /\bTRUNCATE\b/.test(s)) {
    return 'DROP_DATABASE_OR_TRUNCATE';
  }
  if (/\bDROP\s+(USER|ROLE|GROUP)\b/.test(s) || /\bREVOKE\b/.test(s)) {
    return 'DROP_USER_OR_REVOKE';
  }
  if (/\bDROP\s+(TABLE|INDEX|MATERIALIZED\s+VIEW|VIEW|SCHEMA)\b/.test(s)) {
    return 'DROP_TABLE_OR_INDEX';
  }
  if (/\bCREATE\s+INDEX\s+CONCURRENTLY\b/.test(s)) {
    return 'CREATE_INDEX_CONCURRENTLY';
  }
  // 保守: 所有 ALTER TABLE 先归大锁 · feat-028 再细分 (ADD COLUMN 快路径 vs 改类型大锁)
  if (/\bALTER\s+TABLE\b/.test(s)) return 'ALTER_TABLE_BIG_LOCK';
  if (/\b(DELETE|UPDATE)\b/.test(s)) return 'DELETE_UPDATE_BULK';
  if (
    /\bCREATE\s+INDEX\b/.test(s) ||
    /\b(CREATE|ALTER)\s+(SCHEMA|TYPE|SEQUENCE)\b/.test(s) ||
    /\bCREATE\s+TABLE\b/.test(s) ||
    /\bADD\s+COLUMN\b/.test(s)
  ) {
    return 'DDL_ADD_COLUMN';
  }
  // SELECT / EXPLAIN / SHOW / WITH ... SELECT 等只读
  return 'READ_ONLY';
}

/** binary destructive (feat-058 dynamic annotation 用) · = 非只读、非分支操作 */
export function isDestructiveSql(sql: string): boolean {
  const c = classifySql(sql);
  return c !== 'READ_ONLY' && c !== 'CREATE_OR_RESTORE_BRANCH';
}
