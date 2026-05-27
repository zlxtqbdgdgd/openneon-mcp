/**
 * plan-store seam types · feat-023/#1 (L2b) · server-enrich 第 4 个子层。
 *
 * 详设: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-023-L2b-mcp-tool-t10-search-plans.html §4
 *
 * plan history 持久层 —— 跨 query_signature × time_range 存 EXPLAIN plan 摘要。两个 collector
 * (on_demand from feat-019 T3 · background from pg_stat_statements) 填充 · T10 search_plans tool 查。
 * 跟 baseline / metrics-history / recommendation 同 enrich 子层模式 · backend 藏在接口后
 * (memory default · redis L3+ stub)。multi-project 隔离 by projectId scope (§6)。
 */

/** plan tree 摘要化后写入的单条记录 (详设 §4)。 */
export interface PlanRecord {
  /** sha256(normalized_query) first 16 hex · 跟 feat-019 T3 / feat-022 T7 统一 (§4 · §11 OQ7)。 */
  signature: string;
  /**
   * EXPLAIN (FORMAT JSON) root node 的**摘要化**版本 (§11 OQ6 · 防 100KB plan 占满内存):
   * 只保留 root + Seq Scan / Index Scan / Nested Loop 关键 node · 不保 buffer/cache 细节。
   */
  plan_json: object;
  /** for T11 (feat-024) 联动: 同 query_text 多次执行 plan 不同时区分。 */
  query_text_sha256?: string;
  /** epoch ms · 采集时刻。 */
  captured_at: number;
  /** 采集来源: feat-019 T3 顺手写 · 或 background collector 周期收集。 */
  source: 'on_demand' | 'background';
  /** plan root 的 Total Cost。 */
  cost_total: number;
  /** plan walk 是否含 'Seq Scan' node。 */
  has_seq_scan: boolean;
  /** nested loop + outer rows > 10K (大 nested loop · 潜在性能隐患)。 */
  has_nested_loop_big: boolean;
  /** project scope · multi-project 隔离边界 (§6)。 */
  projectId: string;
  /** USR (feat-008-011 L2b ship 后追加)。 */
  usr?: {
    tenant_id: string;
    timeline_id: string;
    endpoint_id: string;
    shard_id?: string;
  };
}

/** T10 / searchPlans filter (详设 §4)。projectId 必填 —— 是隔离边界。 */
export interface PlanFilter {
  projectId: string;
  /** glob on plan_json (string LIKE · 如 "*Seq Scan*")。 */
  pattern?: string;
  /** 绝对时间窗 (epoch ms) · T10 handler 把 'last 7d' 类相对窗解析成它。 */
  time_range?: { from: number; to: number };
  cost_min?: number;
  has_seq_scan?: boolean;
  /** 指定 signature 查 plan 演变 (场景 B)。 */
  signature_list?: string[];
  /** default 50 · T10 handler cap 200。 */
  limit?: number;
}

/**
 * plan-store backend 契约 (memory / redis 实现它)。换 backend = 换实现 · 接口 + 消费方不动。
 */
export interface PlanStoreBackend {
  writePlan(record: PlanRecord): Promise<void>;
  searchPlans(filter: PlanFilter): Promise<PlanRecord[]>;
  /** TTL evict · 返回清掉的条数 (测试 + lifecycle 用)。 */
  evictExpired(): Promise<number>;
  /** 后端类型 · 给 audit event 的 backend 字段。 */
  readonly kind: 'memory' | 'redis';
}
