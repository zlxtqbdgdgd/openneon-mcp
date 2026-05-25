/**
 * Progressive disclosure depth configuration for openneon-mcp · L1 day-one ship.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-007-L1-mcp-server-progressive-disclosure.html
 *
 * Some tools return tiered responses · 'shallow' (token economy default) vs 'full' (opt-in via ?depth=full).
 * Pairs with feat-006 CSV (宽度 token 经济) to form "宽度 + 深度" two-axis token management.
 *
 * Day-one L1 depth-supporting tools:
 * - T6 `get_neondb_query_statement` · shallow = SQL 前 30 行 / full = 全 SQL · narrative #3 主卖点
 * - T8 `get_neondb_schemas` · shallow = column_name+data_type+is_indexed / full = +pg_index 全字段 · narrative #3 配对
 *
 * Other L1 tools (T1 find_instances · T2 calling_services) don't need depth (simple list/lookup).
 *
 * Related sub-issues:
 * - feat-007 #1 (this file) · depth config module
 * - feat-007 #2 (next PR) · T8 schemas handler shallow/full impl
 * - feat-007 #3 (next PR) · T6 query_statement handler shallow/full impl
 * - feat-007 #4 (next PR) · tools/list handler advertise supportsDepth field
 * - feat-007 #5 (next PR) · feat-061 fixture step 3 depth check
 */

/**
 * Depth levels for progressive disclosure tools.
 *
 * - 'shallow' (default · token economy 优先) · ~1K token per response · 字段名 + 关键 metadata
 * - 'full' (opt-in via ?depth=full) · ~5K token per response · 含所有 detail 字段
 */
export type DepthLevel = 'shallow' | 'full';

export const SUPPORTED_DEPTHS: readonly DepthLevel[] = [
  'shallow',
  'full',
] as const;

/**
 * Default depth. 'shallow' chosen as token-economy default per feat-007 §3 + feat-006 共享 token 经济地基。
 *
 * Detail design: features/feat-007-L1-mcp-server-progressive-disclosure.html §3 "怎么做"
 */
export const DEFAULT_DEPTH: DepthLevel = 'shallow';

/**
 * L1 day-one tools that support progressive disclosure (shallow/full depth param).
 *
 * 2 tools matching narrative #3 防 LLM 自负幻觉一对组合:
 * - `get_neondb_query_statement` (T6) · SQL 文本 30 行截断 (shallow) vs 全 SQL (full)
 * - `get_neondb_schemas` (T8) · column 5 字段 (shallow) vs +pg_index 9 字段 (full)
 *
 * Other 27 upstream tools + 2 L1 day-one tools (T1/T2) don't support depth:
 * - List/lookup tools (T1 find_instances · T2 calling_services) · simple result · no depth tiering
 * - Upstream Neon tools · don't have shallow/full distinction · default to full single-tier
 */
export const DEPTH_SUPPORTING_TOOLS: ReadonlySet<string> = new Set<string>([
  'get_neondb_query_statement',
  'get_neondb_schemas',
  // feat-019/#2 (L2a): T3 explain · shallow = signals 摘要 / full = raw EXPLAIN JSON
  'get_neondb_explain_plans',
  // feat-020/#1 (L2a): T4 health signals · shallow = 异常+unavailable+key 摘要 / full = 全部信号
  'get_neondb_health_signals',
]);

/**
 * Check if a tool supports progressive disclosure.
 *
 * @param toolName - The tool's registered name
 * @returns true if the tool accepts a `depth` param (shallow/full)
 */
export function isToolSupportingDepth(toolName: string): boolean {
  return DEPTH_SUPPORTING_TOOLS.has(toolName);
}

/**
 * Type guard for DepthLevel · use to validate runtime values (e.g. from query params).
 *
 * @param value - any value to check
 * @returns true if value is a valid DepthLevel
 */
export function isValidDepth(value: unknown): value is DepthLevel {
  return (
    typeof value === 'string' &&
    (SUPPORTED_DEPTHS as readonly string[]).includes(value)
  );
}
