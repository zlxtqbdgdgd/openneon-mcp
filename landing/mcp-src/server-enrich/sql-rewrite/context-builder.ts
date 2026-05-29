/**
 * context-builder.ts · feat-041/#2 (L3) · LLM 改写 SQL 的 EXPLAIN context 拉取 + size guard.
 *
 * Detail design:
 *   - Parent: https://github.com/zlxtqbdgdgd/openneon-design/issues/56
 *   - feat-041 详设 §3.3 (context-builder size guard) + §3.6 workflow step 4-5
 *   - openneon-mcp#185 (本文件)
 *
 * 一句话职责: handler 调本 builder, 传 (已脱敏的) SQL + endpoint_id + level →
 *   size guard 判简单查询跳 EXPLAIN / 复杂查询调 feat-019 `get_neondb_explain_plans` 拉 plan →
 *   feat-024 T11 obfuscator 强制脱敏 EXPLAIN 文本 (LLM call 前) → 返 { sql, explain, path }.
 *
 * size guard (详设 §3.3 · 兜底简单查询跳 EXPLAIN):
 *   - level='sql_only'    → 永远跳 EXPLAIN (path='sql_only_simple')
 *   - level='with_explain' → 永远拉 EXPLAIN (path='with_explain')
 *   - level='auto' (默认):
 *       · trim 后长度 < 100 char            → 跳 (短查询不值得 EXPLAIN 开销)
 *       · 不含 FROM/JOIN/UPDATE/DELETE/INSERT → 跳 (不涉表 · EXPLAIN 无意义)
 *       · 否则                                → 拉 EXPLAIN (复杂查询)
 *
 * 脱敏边界 (详设 §3.6 step 5 · feat-024 OWASP LLM02):
 *   - 传入的 `sql` 已由 handler 用 T11 obfuscator 脱敏 (handler line `obfuscator(input.sql)`)。
 *   - EXPLAIN plan 文本可能含 Filter 字面量 (如 `(email = 'a@b.com')`) · **本 builder 在返回前
 *     强制把 EXPLAIN 文本再过一次 obfuscator** · 保证 raw 字面量绝不进 LLM context (fail-closed)。
 *
 * DI (contract-first · 跟 generate-rca-report.ts / explain-plans.ts 同 pattern):
 *   - `explainRunner` 注入式拉 EXPLAIN —— 生产 wiring 在 tools.ts 绑定 endpoint→project/branch +
 *     **真实 (未脱敏的) SQL** 调 feat-019 handleExplainPlans (EXPLAIN 必须跑真 SQL · 脱敏 SQL 无法 parse)。
 *     测试注入 mock。返回 `null` 表示 EXPLAIN fetch 失败 (context-builder 降级到 sql_only · 不抛)。
 *   - `obfuscator` 默认 = feat-024 T11 `obfuscateLogLine` (EXPLAIN 文本不是合法 SQL · 走 log line 通路)。
 */

import { obfuscateLogLine } from '../samples-store/obfuscator';

export type RewriteContextPath = 'with_explain' | 'sql_only_simple';

export type RewriteContext = {
  /** 已脱敏的 SQL (handler 传入时已过 T11 obfuscator)。 */
  sql: string;
  /** 脱敏后的 EXPLAIN 文本 · 简单查询或 fetch 失败时为 null。 */
  explain: string | null;
  path: RewriteContextPath;
};

export type RewriteContextLevel = 'auto' | 'sql_only' | 'with_explain';

/**
 * 注入式 EXPLAIN 拉取 (feat-019 `get_neondb_explain_plans`)。生产 wiring 绑定**真实 SQL** +
 * endpoint→project/branch。返回 EXPLAIN 文本 (任意结构序列化) 或 null (fetch 失败 → 降级)。
 */
export type ExplainContextRunner = (args: {
  endpoint_id: string;
}) => Promise<string | null>;

/** EXPLAIN 文本脱敏 (默认 = feat-024 T11 · log-line 通路 · EXPLAIN 非合法 SQL)。 */
export type ContextObfuscator = (text: string) => string;

export type BuildContextArgs = {
  /** 已脱敏的 SQL (handler 已过 T11)。 */
  sql: string;
  endpoint_id: string;
  level: RewriteContextLevel;
};

export type BuildContextDeps = {
  explainRunner: ExplainContextRunner;
  obfuscator?: ContextObfuscator;
};

const MIN_EXPLAIN_SQL_CHARS = 100;
const TABLE_OP_PATTERN = /\b(FROM|JOIN|UPDATE|DELETE|INSERT)\b/i;

/**
 * size guard (详设 §3.3): 'auto' 下短查询 (< 100 char) 或不涉表 (无 FROM/JOIN/UPDATE/DELETE/INSERT)
 * → 跳 EXPLAIN。返回 true 表示需要拉 EXPLAIN。
 */
export function needsExplain(sql: string, level: RewriteContextLevel): boolean {
  if (level === 'sql_only') return false;
  if (level === 'with_explain') return true;
  // 'auto'
  const stripped = sql.trim();
  if (stripped.length < MIN_EXPLAIN_SQL_CHARS) return false;
  if (!TABLE_OP_PATTERN.test(stripped)) return false;
  return true;
}

/**
 * 拉 context (详设 §3.3 + §3.6 step 4-5):
 *   1. size guard → 简单查询直接返 sql_only_simple (跳 EXPLAIN · 零拉取开销)
 *   2. 复杂查询 → 调注入的 explainRunner (feat-019) 拉 EXPLAIN
 *   3. EXPLAIN fetch 失败 (null) → 降级到 sql_only_simple (不抑 · handler 不需 context_fetch_failed 兜底)
 *   4. EXPLAIN 成功 → **强制脱敏 EXPLAIN 文本** (feat-024 T11) → path='with_explain'
 */
export async function buildRewriteContext(
  args: BuildContextArgs,
  deps: BuildContextDeps,
): Promise<RewriteContext> {
  const obfuscator = deps.obfuscator ?? obfuscateLogLine;

  if (!needsExplain(args.sql, args.level)) {
    return { sql: args.sql, explain: null, path: 'sql_only_simple' };
  }

  const rawExplain = await deps.explainRunner({ endpoint_id: args.endpoint_id });
  if (rawExplain === null || rawExplain.trim().length === 0) {
    // EXPLAIN 拉取失败 / 空 → 降级到 sql_only (不阻断改写 · LLM prompt 用 [DATA_MISSING:explain] 占位)。
    return { sql: args.sql, explain: null, path: 'sql_only_simple' };
  }

  // 强制脱敏 EXPLAIN 文本 (OWASP LLM02 · Filter 字面量绝不进 LLM context)。
  const obfuscatedExplain = obfuscator(rawExplain);
  return { sql: args.sql, explain: obfuscatedExplain, path: 'with_explain' };
}
