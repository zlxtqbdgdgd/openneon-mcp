/**
 * destructive-detector.ts · op 分类的单一源 (ADR-0005)
 *
 * classifyOp(toolName, sql?) → §8.1 矩阵的 op-class。feat-056 pipeline 据此查矩阵 /
 * 命中 hard-deny;feat-028 (G4) / feat-058 (dynamic annotation) 复用同一判定
 * (ADR-0005 single source · 0 drift)。
 *
 * feat-028: backend 切换 + LRU 缓存 + audit event。
 *
 * - `PARSER_BACKEND=pg-parser` (默认): 走 libpg-query AST · 闭防 4 类绕过 (line/block
 *   comment / Unicode escape / multi-stmt) + 长锁 op-class。详 destructive-detector-pg-parser.ts。
 *   mcp-server 启动期需 await initPgParser() · 失败 throw → mcp 启动拒 (不 silent fallback)。
 * - `PARSER_BACKEND=regex`: 回滚通路 · 退到 day-one keyword regex (失 4 类绕过防护 + 长锁识别)。
 *
 * LRU 缓存 by sha256(sql) · cap 10000 (经验值 · LRU evict · 命中 < 0.1ms · 防热 SQL 重复 parse)。
 *
 * audit event `classify_op` (含 parser_backend / cache hit/miss · feat-031 集成时接 OTel)。
 *
 * 局限: keyword-regex backend 会被 SQL 注释 / 大小写变体绕过 · 故 regex backend 只作 op-class
 * 提示;hard-deny 的绝对安全由 server enforcement (pipeline) 兜底。
 */

import { createHash } from 'node:crypto';
import {
  classifyOpPgParser,
  classifySqlPgParser,
} from './destructive-detector-pg-parser';

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
  | 'CROSS_PROJECT' //            由 grant scope vs project_id 判 (G1 stage · 非 SQL 内容 · feat-056/#3)
  // —— fail-closed bucket (feat-028 #108 · PG parser 解析失败 / 未识别 stmt) ——
  | 'OTHER'; //                   不退 READ_ONLY · 走 matrix 视为 require_plan 兜底

/** 走 SQL 内容分类的 tool (其余专用 tool 视为 READ_ONLY · #73 焦点 run_sql 写路径) */
const SQL_TOOLS: ReadonlySet<string> = new Set([
  'run_sql',
  'run_sql_transaction',
]);

export function isDestructiveToolName(toolName: string): boolean {
  return SQL_TOOLS.has(toolName);
}

// ──────────────────────────────────────────────────────────────
// backend 切换
// ──────────────────────────────────────────────────────────────

export type ParserBackend = 'pg-parser' | 'regex';

/** 读 env · 默认 'pg-parser' (#108) · 'regex' 是回滚通路 · 启动期 log 明示 */
export function getParserBackend(): ParserBackend {
  const v = process.env.PARSER_BACKEND;
  if (v === 'regex') return 'regex';
  return 'pg-parser';
}

// ──────────────────────────────────────────────────────────────
// LRU 缓存 by sha256(sql) · cap 10000
// ──────────────────────────────────────────────────────────────

const CACHE_CAP = 10000;
// 用 Map 的插入顺序 = LRU · get 命中时删后重 set 把它挪到最新
const cache = new Map<string, OpClass>();
let cacheHits = 0;
let cacheMisses = 0;

/** test helper · 不导出做正式 API */
export function _resetClassifyCacheForTests(): void {
  cache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

export function getClassifyCacheStats(): {
  size: number;
  hits: number;
  misses: number;
  cap: number;
} {
  return { size: cache.size, hits: cacheHits, misses: cacheMisses, cap: CACHE_CAP };
}

function cacheKeyFor(toolName: string, sql: string | undefined): string {
  // sql 为 undefined 时 (专用只读 tool) 不进缓存路径 · 这里只在 sql 存在时调用
  const h = createHash('sha256').update(toolName + '\0' + (sql ?? '')).digest('hex');
  return h;
}

function cacheGet(key: string): OpClass | undefined {
  const v = cache.get(key);
  if (v !== undefined) {
    // LRU touch: 删后重插入 = 挪到 Map 末尾
    cache.delete(key);
    cache.set(key, v);
    cacheHits++;
    return v;
  }
  cacheMisses++;
  return undefined;
}

function cacheSet(key: string, val: OpClass): void {
  if (cache.size >= CACHE_CAP) {
    // evict oldest (Map iteration order = 插入顺序)
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, val);
}

// ──────────────────────────────────────────────────────────────
// audit event (临时 console.log structured · feat-031 接 OTel)
// ──────────────────────────────────────────────────────────────

/** 默认 emitter · feat-031 集成时接 OTel · 单测可 monkey-patch */
let auditEmitter: (event: ClassifyOpAuditEvent) => void = (event) => {
  // 临时 structured log · feat-031 接管后切到 OTel span attribute
  // 不真打 log 防 production 噪音 (test 也无意义) · 只在 PARSER_AUDIT_DEBUG 开时打
  if (process.env.PARSER_AUDIT_DEBUG === '1') {
    console.log('[classify_op]', JSON.stringify(event));
  }
};

export function setClassifyOpAuditEmitter(
  fn: (e: ClassifyOpAuditEvent) => void,
): void {
  auditEmitter = fn;
}

export type ClassifyOpAuditEvent = {
  event: 'classify_op';
  tool_name: string;
  has_sql: boolean;
  op_class: OpClass;
  parser_backend: ParserBackend;
  cache_hit: boolean;
};

// ──────────────────────────────────────────────────────────────
// 公开 API
// ──────────────────────────────────────────────────────────────

/**
 * 把一次 tool 调用映射到 §8.1 op-class (单一源 · ADR-0005)。
 * - 专用 tool (T1-T12 只读) → READ_ONLY
 * - run_sql / run_sql_transaction → 解析 SQL 内容 · 走 PARSER_BACKEND 选定的实现 · 走 LRU 缓存
 *
 * 非-SQL 管理写 tool (delete_branch / delete_project 等) 的 op-class + 护栏在后续 issue (matrix /
 * 管理面) 覆盖 · #73 焦点 run_sql 写路径 hard-deny · 此处归 READ_ONLY 不改变现状。
 */
export function classifyOp(toolName: string, sql?: string): OpClass {
  const backend = getParserBackend();

  // 专用只读 tool · 不需要 SQL 解析 · 不进缓存
  if (!SQL_TOOLS.has(toolName)) {
    auditEmitter({
      event: 'classify_op',
      tool_name: toolName,
      has_sql: false,
      op_class: 'READ_ONLY',
      parser_backend: backend,
      cache_hit: false,
    });
    return 'READ_ONLY';
  }
  if (!sql || sql.trim() === '') {
    auditEmitter({
      event: 'classify_op',
      tool_name: toolName,
      has_sql: false,
      op_class: 'READ_ONLY',
      parser_backend: backend,
      cache_hit: false,
    });
    return 'READ_ONLY';
  }

  // LRU 缓存 key 含 backend (不同 backend 可能给不同结果 · 不能跨 backend 共享 entry)
  const key = backend + '|' + cacheKeyFor(toolName, sql);
  const cached = cacheGet(key);
  if (cached !== undefined) {
    auditEmitter({
      event: 'classify_op',
      tool_name: toolName,
      has_sql: true,
      op_class: cached,
      parser_backend: backend,
      cache_hit: true,
    });
    return cached;
  }

  const op =
    backend === 'pg-parser'
      ? classifyOpPgParser(toolName, sql)
      : classifyOpRegex(toolName, sql);
  cacheSet(key, op);
  auditEmitter({
    event: 'classify_op',
    tool_name: toolName,
    has_sql: true,
    op_class: op,
    parser_backend: backend,
    cache_hit: false,
  });
  return op;
}

/**
 * 直接给 SQL 内容 (不带 tool 名) 的分类入口 · feat-019 explain wrapper + feat-058 dynamic
 * annotation 复用 · 走当前 backend · 不走 cache (调用频度低 + key 设计要带 toolName)。
 */
export function classifySql(sql: string): OpClass {
  const backend = getParserBackend();
  return backend === 'pg-parser'
    ? classifySqlPgParser(sql)
    : classifySqlRegex(sql);
}

// ──────────────────────────────────────────────────────────────
// regex backend (day-one · feat-056 实现 · feat-028 保留作 fallback)
// ──────────────────────────────────────────────────────────────

export function classifyOpRegex(toolName: string, sql?: string): OpClass {
  if (!SQL_TOOLS.has(toolName)) return 'READ_ONLY';
  if (!sql || sql.trim() === '') return 'READ_ONLY';
  return classifySqlRegex(sql);
}

/**
 * keyword-regex 分类 SQL (day-one · 已知绕过: SQL 注释 / Unicode escape / 多语句拆分)。
 * 入参可为多语句拼接 (run_sql_transaction 的 sqlStatements.join) · 任一片段命中即归该类。
 */
export function classifySqlRegex(sql: string): OpClass {
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
  // 保守: 所有 ALTER TABLE 先归大锁
  if (/\bALTER\s+TABLE\b/.test(s)) return 'ALTER_TABLE_BIG_LOCK';
  if (/\b(DELETE|UPDATE|INSERT)\b/.test(s)) return 'DELETE_UPDATE_BULK';
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

/**
 * binary destructive (feat-058 dynamic annotation 用) · = 非只读、非分支操作。
 * 'OTHER' 视为 destructive (fail-closed · parse 失败 SQL 走 plan mode 兜底)。
 */
export function isDestructiveSql(sql: string): boolean {
  const c = classifySql(sql);
  return c !== 'READ_ONLY' && c !== 'CREATE_OR_RESTORE_BRANCH';
}

// ──────────────────────────────────────────────────────────────
// startup 初始化入口 · mcp-server 主进程 await · 失败 throw 让启动拒
// ──────────────────────────────────────────────────────────────

export { initPgParser } from './destructive-detector-pg-parser';
