/**
 * role-toolsets.ts · feat-059/#1 · 按 agent 角色的 toolset 预设 + 软 listing 过滤。
 *
 * 给 MCP tools/list 加第三个分组维度 (role · 正交于 scope/category)。**软过滤** ——
 * 只影响 listing 显示什么 (省 token + 减误用倾向),**不是安全边界**:非 toolset 的 tool 被调时
 * 仍走 feat-056 enforcement (不因"不在 toolset"而拒)。真安全靠 feat-056 + feat-029 key scope + hard-deny。
 *
 * 4 套预设 (customer-service / data-analyst / ops / sre) 的精确 tool 清单按当前 tool 集校准
 * (详设 §4 + §11 OQ2 · 随 tool 集演进调整)。借鉴 Google MCP Toolbox toolset + form-shift。
 *
 * 设计: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-059-L2-mcp-server-toolset-by-role.html
 */

export type AgentRole = 'customer-service' | 'data-analyst' | 'ops' | 'sre';

// ① 客服 agent: 只读查询 (无 run_sql · 无写 · 无 project 管理面) —— 查用户订单类场景
const CUSTOMER_SERVICE: readonly string[] = [
  'find_neondb_instances', // T1 · 入口
  'get_neondb_calling_services', // T2 · 应用归因
  'get_neondb_query_statement', // T6 · 查 SQL
  'get_neondb_schemas', // T8 · 查 schema
  'get_neondb_policy', // advisory · 让 agent 知 L 边界
];

// ② 数据分析 / DBA agent: 客服 + 全套只读性能诊断 (仍不含写)
const DATA_ANALYST: readonly string[] = [
  ...CUSTOMER_SERVICE,
  'get_neondb_explain_plans', // T3 · op-class-aware explain (feat-019)
  'get_neondb_query_samples', // T11 · 脱敏样本检索 (feat-024 · 客服 role 不含 · 减敏感数据接触面)
  'get_neondb_search_plans', // T10 · 主动巡检 plan history (feat-023 · 只读)
  'explain_sql_statement', // 上游 explain
  'list_slow_queries',
  'describe_table_schema',
  'get_database_tables',
  'compare_database_schema',
  'describe_branch',
  'describe_project',
  'get_connection_string',
  'list_branch_computes',
];

// ③ 运维 agent: 数据分析 + 写 op (run_sql / 迁移 / tuning / 分支) —— 写仍走 feat-056 plan/confirm/canary
const OPS: readonly string[] = [
  ...DATA_ANALYST,
  'run_sql',
  'run_sql_transaction',
  'prepare_query_tuning',
  'complete_query_tuning',
  'prepare_database_migration',
  'complete_database_migration',
  'create_branch',
  'delete_branch',
  'reset_from_parent',
];

// ④ SRE on-call agent: 运维全集 + (L4 MRC 决策树权限 · L4 feat-049 后扩) · day-one = ops 超集
const SRE: readonly string[] = [...OPS];

export const ROLE_TOOLSETS: Record<AgentRole, ReadonlySet<string>> = {
  'customer-service': new Set(CUSTOMER_SERVICE),
  'data-analyst': new Set(DATA_ANALYST),
  ops: new Set(OPS),
  sre: new Set(SRE),
};

/** agent_role 合法性 (用于 policy.yaml 校验 + 过滤判定)。 */
export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && value in ROLE_TOOLSETS;
}

/**
 * 软 listing 过滤: tools ∩ ROLE_TOOLSETS[role]。
 *
 * role 缺失 / 非法 (含未配 agent_role) → **不过滤**,原样返回 (退 feat-005 category-only listing)。
 * 纯函数 · 只裁 listing · 不拦调用 (soft · 真权威是 feat-056 enforcement)。
 */
export function filterToolsByRole<T extends { name: string }>(
  tools: T[],
  role: string | undefined,
): T[] {
  if (!isAgentRole(role)) return tools;
  const allowed = ROLE_TOOLSETS[role];
  return tools.filter((tool) => allowed.has(tool.name));
}
