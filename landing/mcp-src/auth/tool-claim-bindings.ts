/**
 * tool-claim-bindings.ts · feat-060/#3 (#131) · per-tool fromClaim 声明注册表 (side-table)
 *
 * 设计依据: [feat-060 详设 §4.2](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-060-L2-mcp-server-claim-binding.html)
 *
 * 为什么用 side-table 不直接挂 zod schema?
 *   tool inputSchema 是 zod schema · zod 不支持任意元数据 (no \`.fromClaim()\`扩展);
 *   走 \`.passthrough()\` / \`.describe()\` 塞结构化数据 hack 不优雅。
 *   side-table 把 fromClaim (security policy) 和 zod (validation) 解耦 · 各管各的:
 *     - zod schema: 客户端协议层 (input shape · type)
 *     - tool-claim-bindings: server-side security policy 注册
 *
 * 命名空间: paramName 用 dot-path · e.g. \`expected_user_filter.value\` 标 run_sql 的嵌套字段。
 * (claim-binding.ts 支持 dot-path · 见 \`bindClaims\` impl)
 *
 * 新 tool 接 fromClaim · 只需在本文件加一行 entry · 不动 tool handler 代码。
 */

import type { FromClaimSpec, ToolInputSchema } from './claim-binding';

/** per-tool 的 fromClaim 声明 (1 个 paramName + 1 个 spec) */
export type ToolClaimBinding = {
  /** dot-path · 'user_id' 或 'expected_user_filter.value' */
  paramName: string;
  spec: FromClaimSpec;
};

/**
 * 生产 tool 的 fromClaim 注册表。
 *
 * key = tool name (跟 NEON_TOOLS / definitions.ts 同名)。value = N 个 binding。
 *
 * 当前 (feat-060/#3 day-one): run_sql 接 expected_user_filter.value 是唯一注册 · 单 tool 试水。
 * 后续 (follow-up): 加 run_sql_transaction / get_neondb_query_samples 等带 user-scoped 数据的 tool。
 *
 * 测试用 mock tool (\`get_user_orders\`) 不在此 · 仅 fixture 内联注册 (per feat-060/#2 测试 mock pattern)。
 */
export const TOOL_CLAIM_BINDINGS: Record<string, ToolClaimBinding[]> = {
  // run_sql: \`expected_user_filter.value\` 由 JWT.sub 强制覆盖 (per feat-060 详设 §3 + 用户决策)。
  // agent 传 sql 必含 WHERE <column> = <value> 谓词 · libpg-query 验 (sql-where-filter-check.ts) ·
  // value != JWT.sub → deny_invalid (sql/claim 不一致)。
  // 未传 expected_user_filter 时 · 本 tool 维持 feat-029-only 行为 (向后兼容)。
  run_sql: [
    {
      paramName: 'expected_user_filter.value',
      spec: { service: 'default', field: 'sub' },
    },
  ],
};

/**
 * 给 route.ts middleware 用 · 把 side-table 翻成 claim-binding 期待的 ToolInputSchema 形态。
 *
 * 返 undefined → 该 tool 没注册 fromClaim · claim-binding 完全旁路 (per #130 行为)。
 *
 * note: 实际生产 service 名应该 dynamic 取 (e.g. 看 project policy 配的第一个 authService 或者
 * 让 agent header 明示)。day-one 用 'default' 占位 · #131 fixture 注入 mock policy 覆盖 ·
 * production 之前要替换成 dynamic 取 service (留 follow-up issue)。
 */
export function getToolClaimBindings(
  toolName: string,
): ToolInputSchema | undefined {
  const decls = TOOL_CLAIM_BINDINGS[toolName];
  if (!decls || decls.length === 0) return undefined;
  // 用 paramName (dot-path) 作 properties key · claim-binding.ts collectFromClaims 会取 paramName
  // 当 path 用 · 实际 nested set 在 bindClaims 内部 (per #131 dot-path 增强)。
  const properties: Record<string, { fromClaim: FromClaimSpec }> = {};
  for (const d of decls) {
    properties[d.paramName] = { fromClaim: d.spec };
  }
  return { properties };
}
