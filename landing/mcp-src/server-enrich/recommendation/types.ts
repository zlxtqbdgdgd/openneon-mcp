/**
 * recommendation/types.ts · feat-022 (L2b) · T7 recommendations 数据契约。
 *
 * 详设: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-022-L2b-mcp-server-enrich-recommendation-rule-set.html (§4 数据契约)
 *
 * **架构关键** (§3.3.0 数据流原则): 规则集是 if-else 确定性逻辑 · 上移 mcp/server-enrich 子层 ·
 * 不调 LLM · 跨 client 一致 + token 经济 (agent 不当统计学家)。
 *
 * 这里只定义类型 + RuleEvaluator 接口 + 给 evaluator 用的依赖注入入口 (RuleContext)。具体规则
 * 实现见 rule-*.ts · 总入口 + 并发 runner + severity 排序见 index.ts。
 */

/** T7 5 类推荐 type · 跟 Datadog DBM recommendations 对位 (§1)。 */
export type RecommendationType =
  | 'missing_index'
  | 'unused_index'
  | 'oversized_temp'
  | 'autovacuum_lag'
  | 'inefficient_join';

export type RecommendationSeverity = 'critical' | 'high' | 'medium' | 'low';

/** confidence: hypopg/history 可用时 high · 降级 (无 cost diff / snapshot only) 时 medium。 */
export type RecommendationConfidence = 'low' | 'medium' | 'high';

export interface Recommendation {
  type: RecommendationType;
  severity: RecommendationSeverity;
  /** table / index / database / query_signature 名。 */
  target: string;
  /** per-rule 具体证据字段 (§3 详细) · 不含值/PII · 仅表名/列名/行数/比率。 */
  evidence: Record<string, unknown>;
  /** 可执行 SQL 模板 (不直接执行 · 给 agent 进 plan mode)。 */
  suggested_action: string;
  confidence: RecommendationConfidence;
  /** 规则版本 (调整 阈值/算法 时 incrementing · §11 OQ3)。 */
  rule_version: string;
}

/**
 * 最小 SQL 客户端契约 (跟 tools/handlers/sql-driver.ts 的 SqlClient.query 同形)。规则只读 ·
 * 不需要 transaction/release (那些由 handler 层管理 · 见 index.ts 的 RuleContext)。
 */
export interface RuleSqlClient {
  query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
}

/**
 * feat-019 T3 explain_plans 的注入式调用 (handler 已绑定 projectId/branchId/neonClient)。
 * 返回结构化 plan 结果 (跟 handlers/explain-plans.ts 的 ExplainPlansResult 同形的子集)。
 * 调用失败 → 抛错 · 由规则各自 catch 降级 (§5: T3 失败 → missing_index/inefficient_join 跳过)。
 */
export type ExplainProbe = (input: {
  sql: string;
  querySignature?: string;
}) => Promise<ExplainProbeResult>;

export interface ExplainProbeResult {
  /** 根节点 total cost (cost 比对用)。 */
  total_cost: number;
  /** depth=full 的 raw EXPLAIN JSON (plan walk 用)。 */
  plan: unknown;
}

/**
 * baseline 探针 (注入 feat-016/017 baseline) · oversized_temp 用。返回 null = baseline 不可用/不足
 * → 规则降级跳过 (§5)。
 */
export type BaselineProbe = (input: {
  signal: string;
  currentValue: number;
}) => Promise<BaselineProbeResult | null>;

export interface BaselineProbeResult {
  /** baseline median (band 中位)。 */
  median: number;
  /** band 上界 (median + k·MAD)。 */
  upper: number;
  /** 偏离标签。 */
  label: 'normal' | 'high' | 'low';
}

/**
 * metrics-history 探针 (注入 feat-064 seam) · unused_index 30d / oversized_temp 1h trend 用。
 * 返回 null = history seam 不可用 → 规则降级到 snapshot only · confidence=medium (§5)。
 */
export type HistoryProbe = (input: {
  signal: string;
  window: string;
  /**
   * sustained 判定方向 (per-rule · §3 · #127 fix)。同一条 history 序列对不同规则语义相反:
   *  - 'high' (默认): 所有数据点持续「高」(value > 0) —— oversized_temp 用 (1h 持续超 baseline)。
   *  - 'zero':        所有数据点持续「为 0 / 低」(value <= 0) —— unused_index 用 (30d idx_scan 持续 0)。
   * 缺省走 'high' 以兼容历史调用。
   */
  sustainedMode?: HistorySustainedMode;
}) => Promise<HistoryProbeResult | null>;

/** history sustained 判定方向 (见 HistoryProbe.sustainedMode)。 */
export type HistorySustainedMode = 'high' | 'zero';

export interface HistoryProbeResult {
  /** 是否覆盖足够 (coverage 达标)。 */
  sufficient: boolean;
  /** window 内是否「持续满足条件」(按 sustainedMode 方向: 持续高 / 持续为 0)。 */
  sustained: boolean;
  /** window 天数 (evidence 用)。 */
  windowDays?: number;
}

/**
 * 规则可调阈值 (§11 OQ2 · 来自 policy.yaml.recommendation_thresholds · 默认值 hardcoded ·
 * 不暴露给 agent)。见 thresholds.ts。
 */
export interface RecommendationThresholds {
  /** autovacuum_lag: last_autovacuum 早于多少小时算 lag · default 24。 */
  autovacuum_lag_hours: number;
  /** autovacuum_lag: n_dead_tup 超过多少算需要 vacuum · default 10000。 */
  autovacuum_dead_tuple_min: number;
  /** unused_index: pg_relation_size 超过多少字节才算「值得 DROP 的大索引」· default 1MB。 */
  unused_index_min_bytes: number;
  /** missing_index: hypopg cost_ratio 超过多少才推荐 confidence=high · default 10。 */
  missing_index_cost_ratio: number;
  /** inefficient_join: nested loop 的 outer rows 超过多少算低效 · default 10000。 */
  inefficient_join_outer_rows: number;
}

/**
 * 单个规则 evaluator 运行所需的全部依赖 (依赖注入 · 便于单测 mock · 见 §7 fixture)。
 * handler 层 (get-recommendations.ts) 负责构造 (建 sql client / 绑定 T3 / baseline / history) ·
 * 规则本身不碰 neonClient / connection string。
 */
export interface RuleContext {
  projectId: string;
  querySignature?: string;
  sql: RuleSqlClient;
  /** feat-019 T3 explain 注入 · 不可用 (未提供) 时 missing_index/inefficient_join 跳过。 */
  explain?: ExplainProbe;
  /** feat-016/017 baseline 注入 · 不可用时 oversized_temp 跳过。 */
  baseline?: BaselineProbe;
  /** feat-064 metrics-history 注入 · 不可用时 unused_index/oversized_temp 降级 snapshot only。 */
  history?: HistoryProbe;
  /** hypopg 启动期 detect 的结果 (§3.1 · missing_index 用 · 不可用 → confidence=medium)。 */
  hypopgAvailable: boolean;
  thresholds: RecommendationThresholds;
}

export interface RuleEvaluator {
  type: RecommendationType;
  /** 每个规则可被 per-rule env flag 关 (§8 回滚 · 如 T7_MISSING_INDEX_ENABLED=false)。 */
  envFlag: string;
  /** 跑规则 · 0..N 条推荐。规则内部自行 catch 降级 · 不抛 (一个规则失败不拖垮其余)。 */
  evaluate(ctx: RuleContext): Promise<Recommendation[]>;
}
