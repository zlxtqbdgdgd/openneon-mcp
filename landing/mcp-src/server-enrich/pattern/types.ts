/**
 * Shared types · feat-037 log pattern 聚类 hybrid path.
 *
 * Detail design: zlxtqbdgdgd/openneon-design#51 §4 schema.
 *
 * Two-tier 命名 (Q5A) + 5 fixed enum (Q5B) 在这里统一定义 · drain3 / llm-clustering / path-router /
 * mcp tool 都引用本文件 · 避免主备两路径漂移。
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
   * "WAL Replay Lag" / "Vacuum Skipped Tuples". `null` 表示备路径 Drain3 不参与命名.
   */
  semantic_name: string | null;
  /** Q5B 5 enum + other 兜底 · 备路径默认 other · LLM 主路径才填精确分类 */
  semantic_category: SemanticCategory;
  /** 二级自由 · 1-2 句话 · LLM 主路径填 · 备路径 null */
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
};

// ------------------------------------------------------------------------------------------------
// path-router output schema · Q2 路径选择 · 主备切换决策对外可见 (debug + audit)
// ------------------------------------------------------------------------------------------------

export type PathDecision = 'main' | 'backup';

/** path-router 的 force_path · agent 可强制走主或备 · default 'auto' */
export type ForcePath = 'auto' | 'main' | 'backup';

export type RouterResult = {
  decision: PathDecision;
  /** 路径选择原因 (debug + audit) */
  reason: 'auto_under_threshold' | 'auto_over_threshold' | 'force_main' | 'force_backup' | 'fallback_from_main';
  /** 估算的 input token (chars/4 heuristic · 跟 feat-045 estimateTokens 同源) */
  estimated_tokens: number;
  /** 主路径 LLM 失败时填 · 否则 null */
  fallback_reason: string | null;
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
