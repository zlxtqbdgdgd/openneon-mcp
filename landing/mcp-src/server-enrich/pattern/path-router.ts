/**
 * path-router · feat-037/#3 (L3) · 确定性聚类 + enrichment-hint + cache 命名空间.
 *
 * Detail design: zlxtqbdgdgd/openneon-design#51 §3.2 path-router + §3.5 cache + Q2 路径选择.
 *
 * **feat-037 form-shift (规则 P4 · LLM-out-of-mcp)**: mcp 只跑确定性 Drain3 · 不调 LLM。
 * 旧版"≤ 50K 走 LLM 主路径 · > 50K 走 Drain3 备路径 + fallback"已下线 —— LLM 语义补全职责
 * 迁到 cc skill。path-router 现在永远跑 Drain3 · 只用 token 阈值给 skill 一个 enrichment hint:
 *
 *   force_path | estimated_tokens | requires_llm_enrichment | reason
 *   -----------|------------------|-------------------------|--------------------------
 *   auto       | ≤ 50K            | true                    | auto_under_threshold
 *   auto       | > 50K            | false                   | auto_over_threshold
 *   main       | ≤ 200K           | true                    | force_enrich
 *   main       | > 200K           | THROW · reject + log warn (强制 main 上限 · §3.2)
 *   backup     | any              | false                   | force_no_enrich
 *
 * enrichment hint = "cluster 集小到值得 cc skill 拉去做 LLM 语义补全" · mcp 自己不补 ·
 * skill 拿 enriched cluster (deterministic template + tail) 后决定是否调 LLM 填 semantic_*。
 *
 * Cache 命名空间 (§3.5 跟 feat-066 一致):
 *   key = cluster_logs:deterministic:{endpoint_id}:{time_range_hash}:{trace_id||'*'}:{severity_hash}
 *   ttl: trace_id state=closed → 永久 (24h) · ongoing → 1h · 无 trace_id → 1h
 *   走 ADR-0009 通用 ttl-cache.ts 收口。
 */

import { createHash } from 'node:crypto';
import { TtlCache } from '../ttl-cache';
import { Drain3, readDrain3ConfigFromEnv } from './drain3';
import type {
  ForcePath,
  LogLine,
  PathDecision,
  PatternClusterResult,
  RouterResult,
} from './types';

// ------------------------------------------------------------------------------------------------
// Thresholds (Q2 锁定值 · GUC 暴露)
// ------------------------------------------------------------------------------------------------

/** auto → enrichment hint 上限 (input ≤ 50K → 建议 skill 补语义 · § Q2). */
export const PATH_ROUTER_AUTO_THRESHOLD_TOKENS = 50_000;

/** force=main 强制上限 (input > 200K + force=main → 拒绝 + warn · §3.2). */
export const PATH_ROUTER_FORCE_MAIN_LIMIT_TOKENS = 200_000;

const TTL_ONGOING_MS = 60 * 60 * 1000; // 1h
const TTL_CLOSED_MS = 24 * 60 * 60 * 1000; // 24h

// ------------------------------------------------------------------------------------------------
// Inputs & outputs
// ------------------------------------------------------------------------------------------------

export type ClusterTraceState = 'ongoing' | 'closed';

export type RouterRequest = {
  endpointId: string;
  /** Obfuscated log lines (mcp tool 边界已保证脱敏 · path-router 不重复 obfuscate) */
  lines: LogLine[];
  /** auto · main · backup · default 'auto' · 现在只控制 enrichment hint (form-shift) */
  forcePath?: ForcePath;
  /** Top N · 跟 drain3 共用 · default 50 */
  topN?: number;
  /** trace_id filter (v1 阶段交由 mcp tool handler 处理 staged delivery) · cache key 一部分 */
  traceId?: string | null;
  /** Severity filter sig · cache key 一部分 */
  severityFilter?: string[];
  /** ISO8601 起止 · cache key 一部分 */
  timeRange?: { start: string; end: string };
  traceState?: ClusterTraceState;
  /** cache enable · default true · 拒 cache 跑全 */
  cache?: boolean;
};

export type RouterPayload = {
  router: RouterResult;
  cluster: PatternClusterResult;
  cached: boolean;
};

// ------------------------------------------------------------------------------------------------
// Custom errors
// ------------------------------------------------------------------------------------------------

export class ForceMainOverLimitError extends Error {
  readonly estimatedTokens: number;
  constructor(estimatedTokens: number) {
    super(
      `force_path='main' but estimated_tokens=${estimatedTokens} > ${PATH_ROUTER_FORCE_MAIN_LIMIT_TOKENS}; refuse enrichment hint (feat-037 §3.2 强制 main 上限).`,
    );
    this.name = 'ForceMainOverLimitError';
    this.estimatedTokens = estimatedTokens;
  }
}

// ------------------------------------------------------------------------------------------------
// Module-level cache (TtlCache reuse · ADR-0009 single collection point)
// ------------------------------------------------------------------------------------------------

let cacheStore = new TtlCache<RouterPayload>();

export function resetRouterCache(): void {
  cacheStore = new TtlCache<RouterPayload>();
}

export function getRouterCache(): TtlCache<RouterPayload> {
  return cacheStore;
}

// ------------------------------------------------------------------------------------------------
// Main entrypoint
// ------------------------------------------------------------------------------------------------

export async function routeAndCluster(req: RouterRequest): Promise<RouterPayload> {
  const useCache = req.cache ?? true;
  const force: ForcePath = req.forcePath ?? 'auto';

  // 1. estimate tokens (chars/4 heuristic · 跟 feat-045 同源)
  const estTokens = estimateLines(req.lines);

  // 2. force=main 上限校验 (保留 hard cap 契约 · > 200K + force=main → 拒绝)
  if (force === 'main' && estTokens > PATH_ROUTER_FORCE_MAIN_LIMIT_TOKENS) {
    console.warn(
      `[feat-037 path-router] force_path='main' but estimated_tokens=${estTokens} > ${PATH_ROUTER_FORCE_MAIN_LIMIT_TOKENS}, refusing.`,
    );
    throw new ForceMainOverLimitError(estTokens);
  }

  // 3. enrichment-hint 决策 (form-shift: 不再切换 LLM/Drain3 · 只决定 skill 是否补语义)
  const { requiresEnrichment, reason } = decideEnrichment(force, estTokens);

  // 4. cache lookup (decision 也是 key 一部分 · 防漂移)
  const cacheKey = buildCacheKey({ decision: 'deterministic', ...req });
  if (useCache) {
    const hit = cacheStore.get(cacheKey);
    if (hit) {
      return { ...hit, cached: true };
    }
  }

  // 5. 永远跑确定性 Drain3 (mcp 不调 LLM · 语义补全归 skill)
  const cluster = runDrain3(req.lines);
  cluster.cluster_requires_llm_enrichment = requiresEnrichment;

  const payload: RouterPayload = {
    router: {
      decision: 'deterministic',
      reason,
      estimated_tokens: estTokens,
      requires_llm_enrichment: requiresEnrichment,
    },
    cluster,
    cached: false,
  };
  cacheSet(useCache, cacheKey, payload, req.traceState);
  return payload;
}

// ------------------------------------------------------------------------------------------------
// helpers (pure)
// ------------------------------------------------------------------------------------------------

function decideEnrichment(
  force: ForcePath,
  estTokens: number,
): { requiresEnrichment: boolean; reason: RouterResult['reason'] } {
  if (force === 'main') return { requiresEnrichment: true, reason: 'force_enrich' };
  if (force === 'backup') return { requiresEnrichment: false, reason: 'force_no_enrich' };
  return estTokens <= PATH_ROUTER_AUTO_THRESHOLD_TOKENS
    ? { requiresEnrichment: true, reason: 'auto_under_threshold' }
    : { requiresEnrichment: false, reason: 'auto_over_threshold' };
}

function runDrain3(lines: LogLine[]): PatternClusterResult {
  const cfg = readDrain3ConfigFromEnv();
  const d = new Drain3(cfg);
  d.addLogLines(lines);
  return d.finalize();
}

/**
 * Estimate tokens for a batch · chars/4 heuristic + 5% overhead for line prefixes (`[i] sev=... ::`).
 * 跟 feat-045 estimateTokens 同源 · 不引 tiktoken 依赖 (Q2 锁定: 用 chars/4 估算).
 */
export function estimateLines(lines: LogLine[]): number {
  let total = 0;
  for (const l of lines) {
    total += (l.message?.length ?? 0) + 16; // 16 = avg prefix overhead per line
  }
  return Math.ceil(total / 4);
}

/**
 * Cache key (§3.5 与 feat-066 一致):
 *   cluster_logs:{decision}:{endpoint_id}:{time_range_hash}:{trace_id||'*'}:{severity_hash}
 *
 * form-shift 后 decision 永远 'deterministic' · model 段去掉 (mcp 不调 LLM · 无 model 维度)。
 */
export function buildCacheKey(args: {
  decision: PathDecision;
  endpointId: string;
  timeRange?: { start: string; end: string };
  traceId?: string | null;
  severityFilter?: string[];
}): string {
  const trh = args.timeRange
    ? sha8(`${args.timeRange.start}|${args.timeRange.end}`)
    : 'no-range';
  const sevh = args.severityFilter && args.severityFilter.length > 0
    ? sha8([...args.severityFilter].sort().join(','))
    : 'no-sev';
  const tid = args.traceId ? args.traceId : '*';
  return `cluster_logs:${args.decision}:${args.endpointId}:${trh}:${tid}:${sevh}`;
}

function sha8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

function cacheSet(
  enabled: boolean,
  key: string,
  payload: RouterPayload,
  state: ClusterTraceState | undefined,
): void {
  if (!enabled) return;
  const ttl = state === 'closed' ? TTL_CLOSED_MS : TTL_ONGOING_MS;
  cacheStore.set(key, payload, ttl);
}
