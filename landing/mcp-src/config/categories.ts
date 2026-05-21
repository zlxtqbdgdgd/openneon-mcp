/**
 * Tool category configuration for openneon-mcp · L1 day-one ship.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-005-L1-mcp-server-tool-listing-core-optional.html
 *
 * Splits MCP tools into 2 tiers per F9 design (Datadog 7DL #2 · tool listing budget):
 * - **core** · default loaded · agent every session 自动看到 · day-one 4 tools
 * - **optional** · client must opt-in (?include=all or capability flag) · upstream 27 tools default 进 optional
 *
 * Rationale (per feat-005 §2):
 * - Mainstream MCP client (Cursor / Claude Code / Claude Desktop / Codex) `tools/list` 默认上限 ~30
 * - ohsql + Neon 官方 27 tool + user 其他 MCP (GitHub / Linear / Slack 等) easy 超
 * - Core 4 tool 留 26 budget 给 ecosystem · 不挤兑用户其他 MCP
 *
 * Related sub-issues:
 * - feat-005 #1 (this file) · categories module + TOOL_CATEGORIES const
 * - feat-005 #2 (next PR) · tool registry 加 category 字段 · 27 个 tool 全标
 * - feat-005 #3 (next PR) · tools/list handler filter by category + add meta
 * - feat-005 #4 (next PR) · feat-061 fixture step 1 listing check
 */

/**
 * Supported tool categories. Used by tools/list filter (feat-005 #3) +
 * tool registry annotations (feat-005 #2).
 */
export type ToolCategory = 'core' | 'optional';

export const SUPPORTED_TOOL_CATEGORIES: readonly ToolCategory[] = [
  'core',
  'optional',
] as const;

/**
 * Default category for tools without explicit categorization.
 *
 * Chosen 'optional' as safe default · prevents accidentally promoting a new
 * upstream tool to core (which would挤兑 listing budget). New core tools must
 * be explicitly added to CORE_TOOL_NAMES below.
 */
export const DEFAULT_TOOL_CATEGORY: ToolCategory = 'optional';

/**
 * L1 day-one core tool names · default loaded in agent listing.
 *
 * 4 core tools matching sales 4-step troubleshooting playbook (per L1 验收剧本):
 * - `find_neondb_instances` (T1) · sales step 1 · 列实例入口工具
 * - `get_neondb_calling_services` (T2) · application attribution
 * - `get_neondb_query_statement` (T6) · 防 LLM 自负幻觉 SQL (narrative #3 主卖点)
 * - `get_neondb_schemas` (T8) · 防凭表名幻觉字段 (narrative #3 配对)
 *
 * Other 27 upstream Neon tools default → optional (loaded only via ?include=all opt-in).
 *
 * IMPORTANT: keep this list small (≤ 4) per feat-005 §5 budget constraint:
 * - mainstream MCP client `tools/list` cap ~30
 * - 4 core tools = 13% budget · 留 87% for ecosystem
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'find_neondb_instances',
  'get_neondb_calling_services',
  'get_neondb_query_statement',
  'get_neondb_schemas',
]);

/**
 * Get the category for a given tool name.
 *
 * Returns 'core' if the tool name is in CORE_TOOL_NAMES, else 'optional'.
 *
 * @param toolName - The tool's registered name (e.g. 'find_neondb_instances')
 * @returns 'core' or 'optional'
 */
export function getToolCategory(toolName: string): ToolCategory {
  return CORE_TOOL_NAMES.has(toolName) ? 'core' : DEFAULT_TOOL_CATEGORY;
}

/**
 * Type guard for ToolCategory · use to validate runtime values (e.g. from query params).
 *
 * @param value - any value to check
 * @returns true if value is a valid ToolCategory
 */
export function isValidToolCategory(value: unknown): value is ToolCategory {
  return (
    typeof value === 'string' &&
    (SUPPORTED_TOOL_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Listing filter for `tools/list` MCP response.
 *
 * - 'core'  · default · only core tools (T1/T2/T6/T8 day-one) · keeps ~26 listing budget for ecosystem MCPs
 * - 'all'   · core + optional · 33-tool listing · opt-in via `?include=all` HTTP query param
 *
 * Per feat-005 §3 + §11 OQ1 decision · ship as HTTP query param (not MCP-level capability)
 * to avoid forking MCP spec for day-one (MCP spec 2025-06-18 does not standardize tools/list
 * filtering · we layer at the HTTP routing tier instead).
 */
export type CategoryInclude = 'core' | 'all';

export const DEFAULT_CATEGORY_INCLUDE: CategoryInclude = 'core';

/**
 * Parse the `?include=` HTTP query param value into a CategoryInclude.
 *
 * Strict whitelist: only 'core' / 'all' accepted · anything else (null, '', 'optional', 'foo',
 * etc.) falls back to DEFAULT_CATEGORY_INCLUDE ('core'). Defending against typos and stale
 * client query strings · same posture as readonly query param parsing in the transport route.
 *
 * @param raw - the raw query param value from `url.searchParams.get('include')` (string | null)
 * @returns CategoryInclude · 'core' (default) or 'all'
 */
export function parseCategoryInclude(raw: string | null): CategoryInclude {
  if (raw === 'core' || raw === 'all') return raw;
  return DEFAULT_CATEGORY_INCLUDE;
}
