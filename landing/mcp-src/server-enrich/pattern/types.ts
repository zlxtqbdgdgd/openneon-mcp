/**
 * Shared types · feat-037 log pattern 聚类 (mcp 确定性 backbone · LLM 语义补全归 skill).
 *
 * Detail design: zlxtqbdgdgd/openneon-design#51 §4 schema.
 *
 * **feat-037 form-shift (规则 P4 · LLM-out-of-mcp)**: mcp 只跑确定性 Drain3 聚类 · 不调 LLM ·
 * 二级语义命名 (semantic_name / semantic_category / semantic_summary) 由 cc skill 拉 enriched
 * cluster 后补全。本文件因此把 semantic_* 全部建模成 nullable · mcp 永填 null · 不再有 LLM 主路径。
 *
 * Two-tier 命名契约 (Q5A) + 5 fixed enum (Q5B) 仍在这里统一定义 · 供 skill 端复用 schema ·
 * 避免 mcp 出的 deterministic backbone 跟 skill 出的 semantic 层漂移。
 */

// ------------------------------------------------------------------------------------------------
// Input · LogLine 跟 LogFetchAdapter 的 sub-interface 对齐 (feat-064 seam)
// ------------------------------------------------------------------------------------------------

export type Severity = 'FATAL' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

/** 入参 · 一行 obfuscated log + meta (raw log 在 LogFetchAdapter 边界已过 obfuscator). */
export type LogLine = {
  /** obfuscated 后的 log 正文 · 必经 obfuscateLogLine 才能进入此 type (mcp tool 边界保证) */
  message: string;
  severity?: string;
  timestamp?: string;
  trace_id?: string;
  /** ad-hoc · severity 之外的结构字段保留 (Q1 v2 jsonlog 阶段填充) */
  extra?: Record<string, unknown>;
};

// ------------------------------------------------------------------------------------------------
// 5 fixed enum (Q5B) · two-tier 命名 (Q5A) · 主备路径共享
// ------------------------------------------------------------------------------------------------

/** 一级粗类目 · 跨 model 一致性 ≥ 80% 验收门按此字段判 (feat-037/#5). */
export type SemanticCategory =
  | 'query'
  | 'error'
  | 'maintenance'
  | 'auth'
  | 'replication'
  | 'other';

export const SEMANTIC_CATEGORIES: readonly SemanticCategory[] = [
  'query',
  'error',
  'maintenance',
  'auth',
  'replication',
  'other',
] as const;

// ------------------------------------------------------------------------------------------------
// Pattern output schema · drain3.finalize() 和 llm-clustering.classify() 都返这个 shape
// ------------------------------------------------------------------------------------------------

export type LogPattern = {
  /** Cluster id · stable within one finalize() call · 跨 batch 不保证稳定 */
  pattern_id: string;
  /** Pattern template (drain3 出 token w/ `<*>` · LLM 主路径出 regex-like template) */
  template: string;
  /** 命中行数 */
  count: number;
  /** count / total_lines */
  percentage: number;
  /** Severity 分布 */
  severity_distribution: Record<Severity, number>;
  /** ISO8601 · 该 pattern 第一次命中时间 · null when no timestamp */
  first_seen: string | null;
  last_seen: string | null;
  /**
   * Q5A two-tier 命名 · 二级精模板 (strict format): "[Resource] [Operation]" e.g.
   * "WAL Replay Lag" / "Vacuum Skipped Tuples".
   *
   * **mcp 永填 `null`** (form-shift · 规则 P4): 确定性 Drain3 不参与语义命名 ·
   * 由 cc skill 拉 enriched cluster 后用 LLM 补全。`null` = "尚未语义标注 · 等 skill 补".
   */
  semantic_name?: string | null;
  /**
   * Q5B 5 enum + other 兜底.
   *
   * **mcp 永填 `null`** (form-shift): Drain3 不分类 · skill 端用 LLM 才填精确 enum。
   */
  semantic_category?: SemanticCategory | null;
  /**
   * 二级自由 · 1-2 句话.
   *
   * **mcp 永填 `null`** (form-shift): skill 端 LLM 补全。
   */
  semantic_summary?: string | null;
};

/** Tail 聚合 · 长尾 pattern 不在 top N 里 · 但保留 severity 分布 (anomaly 不漏 · §4) */
export type TailAggregate = {
  total_count: number;
  cluster_count: number;
  severity_distribution: Record<Severity, number>;
  first_seen: string | null;
  last_seen: string | null;
};

export type PatternClusterResult = {
  patterns: LogPattern[];
  tail_aggregate: TailAggregate;
  /** 总 log 行数 · 含 top + tail */
  total_lines: number;
  /** 总 cluster 数 (top + tail) */
  total_clusters: number;
  /**
   * form-shift 标记 (规则 P4): cluster 集小到值得 cc skill 做 LLM 语义补全.
   *
   * mcp 只跑确定性 Drain3 · 用 token 阈值 (≤ 50K · {@link PATH_ROUTER_AUTO_THRESHOLD_TOKENS})
   * 判断这批 log 是否足够小 · 小则 `true` (skill 拉去补 semantic_*) · 大则 `false`
   * (skill 默认只用 deterministic template · 不烧 token)。`undefined` = 路由器未标注。
   */
  cluster_requires_llm_enrichment?: boolean;
};

// ------------------------------------------------------------------------------------------------
// path-router output schema · Q2 路径选择 · enrichment-hint 决策对外可见 (debug + audit)
// ------------------------------------------------------------------------------------------------

/**
 * mcp 只跑确定性 Drain3 · 不再有 LLM 主路径 (form-shift · 规则 P4) · 所以 decision 永远
 * `'deterministic'`。保留字段是为了 audit / debug 可见 path-router 跑过 + 是否标了 enrichment hint。
 */
export type PathDecision = 'deterministic';

/**
 * path-router 的 force_path · default 'auto'.
 *
 * **form-shift 后语义** (规则 P4 · mcp 不调 LLM): force_path 不再切换"LLM 主 vs Drain3 备" ·
 * 现在只控制 {@link PatternClusterResult.cluster_requires_llm_enrichment} 这个给 skill 的 hint:
 *   - `auto`:   enrich = estimated_tokens ≤ 50K (集小才值得 skill 补语义)
 *   - `main`:   enrich = true (强制建议 skill 补语义 · 但 > 200K 仍拒 · 保留 hard cap 契约)
 *   - `backup`: enrich = false (强制只用 deterministic template · skill 不烧 token)
 */
export type ForcePath = 'auto' | 'main' | 'backup';

export type RouterResult = {
  decision: PathDecision;
  /** enrichment-hint 决策原因 (debug + audit) */
  reason: 'auto_under_threshold' | 'auto_over_threshold' | 'force_enrich' | 'force_no_enrich';
  /** 估算的 input token (chars/4 heuristic · 跟 feat-045 estimateTokens 同源) */
  estimated_tokens: number;
  /**
   * cc skill 是否被建议对这批 cluster 做 LLM 语义补全 (= cluster_requires_llm_enrichment).
   * mirror 到 router 层方便 audit。
   */
  requires_llm_enrichment: boolean;
};

// ------------------------------------------------------------------------------------------------
// Drain3 config (GUC · policy.yaml + env var 暴露)
// ------------------------------------------------------------------------------------------------

export type Drain3Config = {
  max_node_depth?: number;
  sim_th?: number;
  top_n_patterns?: number;
  tail_threshold_percentage?: number;
};
