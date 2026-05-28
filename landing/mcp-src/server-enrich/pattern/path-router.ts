/**
 * path-router · feat-037/#3 (L3) · 主备双路径切换 + fallback + cache 命名空间.
 *
 * Detail design: zlxtqbdgdgd/openneon-design#51 §3.2 path-router + §3.5 cache + Q2 路径选择.
 *
 * 决策表 (Q2 路径选择):
 *
 *   force_path | estimated_tokens | decision  | reason
 *   -----------|------------------|-----------|--------------------------
 *   auto       | ≤ 50K            | main      | auto_under_threshold
 *   auto       | > 50K            | backup    | auto_over_threshold
 *   main       | ≤ 200K           | main      | force_main
 *   main       | > 200K           | THROW · reject + log warn (强制 main 上限 · §3.2)
 *   backup     | any              | backup    | force_backup
 *
 * Fallback (主路径 LLM 失败时):
 *   - LLM unreachable / rate_limited / token_cap / not_configured / invalid_json / schema_violation
 *     → 自动 fallback Drain3 + decision='backup' + reason='fallback_from_main' + fallback_reason
 *       填具体 LLM error reason · 整个 cluster_neondb_logs 不阻塞
 *
 * Cache 命名空间 (§3.5 跟 feat-066 一致):
 *   key = cluster_logs:{main|backup}:{endpoint_id}:{time_range_hash}:{trace_id||'*'}:{severity_hash}:{model?}
 *   ttl: trace_id state=closed → 永久 (24h) · ongoing → 1h · 无 trace_id → 1h
 *   走 ADR-0009 通用 ttl-cache.ts 收口。
 */

import { createHash } from 'node:crypto';
import { TtlCache } from '../ttl-cache';
import { estimateTokens } from '../rca/llm-prompt';
import type { RcaModelId } from '../rca/llm-client';
import { Drain3, readDrain3ConfigFromEnv } from './drain3';
import { llmClusterLogs } from './llm-clustering';
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

/** auto → main 上限 (input ≤ 50K 走 main · § Q2). */
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
  /** auto · main · backup · default 'auto' */
  forcePath?: ForcePath;
  /** Top N · 跟 drain3 / llm-clustering 共用 · default 50 */
  topN?: number;
  /** LLM 主路径 model · default opus · 备路径忽略 */
  model?: RcaModelId;
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
  /** LLM token usage (主路径成功才填 · 备路径填 0) */
  input_tokens: number;
  output_tokens: number;
  model: RcaModelId | null;
  cached: boolean;
};

// ------------------------------------------------------------------------------------------------
// Custom errors
// ------------------------------------------------------------------------------------------------

export class ForceMainOverLimitError extends Error {
  readonly estimatedTokens: number;
  constructor(estimatedTokens: number) {
    super(
      `force_path='main' but estimated_tokens=${estimatedTokens} > ${PATH_ROUTER_FORCE_MAIN_LIMIT_TOKENS}; refuse to call LLM (feat-037 §3.2 强制 main 上限).`,
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
  const topN = req.topN ?? 50;
  const model: RcaModelId = req.model ?? 'claude-opus-4-7';

  // 1. estimate tokens (chars/4 heuristic · 跟 feat-045 同源)
  const estTokens = estimateLines(req.lines);

  // 2. force=main 上限校验
  if (force === 'main' && estTokens > PATH_ROUTER_FORCE_MAIN_LIMIT_TOKENS) {
    console.warn(
      `[feat-037 path-router] force_path='main' but estimated_tokens=${estTokens} > ${PATH_ROUTER_FORCE_MAIN_LIMIT_TOKENS}, refusing.`,
    );
    throw new ForceMainOverLimitError(estTokens);
  }

  // 3. 决策
  const decision = decidePathInitial(force, estTokens);

  // 4. cache lookup (decision 也是 key 一部分 · 主备分桶 · 防漂移)
  const cacheKey = buildCacheKey({ decision, ...req, model });
  if (useCache) {
    const hit = cacheStore.get(cacheKey);
    if (hit) {
      return { ...hit, cached: true };
    }
  }

  // 5. 走主路径 or 备路径
  if (decision === 'main') {
    const llm = await llmClusterLogs({ lines: req.lines, topN, model });
    if (llm.ok) {
      const payload: RouterPayload = {
        router: {
          decision: 'main',
          reason: force === 'main' ? 'force_main' : 'auto_under_threshold',
          estimated_tokens: estTokens,
          fallback_reason: null,
        },
        cluster: llm.result,
        input_tokens: llm.input_tokens,
        output_tokens: llm.output_tokens,
        model: llm.model,
        cached: false,
      };
      cacheSet(useCache, cacheKey, payload, req.traceState);
      return payload;
    }
    // LLM 失败 → fallback Drain3 (除非 force=main 明确禁止 fallback · default 允许)
    if (force === 'main') {
      // force=main 时不 fallback · 直接抛 · 让 caller 决定怎么 degrade
      throw new Error(
        `force_path='main' but LLM clustering failed (${llm.error.reason}); refuse to fallback to Drain3.`,
      );
    }
    const fb = runDrain3(req.lines);
    const payload: RouterPayload = {
      router: {
        decision: 'backup',
        reason: 'fallback_from_main',
        estimated_tokens: estTokens,
        fallback_reason: llm.error.reason + (llm.error.detail ? `: ${llm.error.detail}` : ''),
      },
      cluster: fb,
      input_tokens: 0,
      output_tokens: 0,
      model: null,
      cached: false,
    };
    cacheSet(useCache, cacheKey, payload, req.traceState);
    return payload;
  }

  // backup 路径
  const fb = runDrain3(req.lines);
  const payload: RouterPayload = {
    router: {
      decision: 'backup',
      reason: force === 'backup' ? 'force_backup' : 'auto_over_threshold',
      estimated_tokens: estTokens,
      fallback_reason: null,
    },
    cluster: fb,
    input_tokens: 0,
    output_tokens: 0,
    model: null,
    cached: false,
  };
  cacheSet(useCache, cacheKey, payload, req.traceState);
  return payload;
}

// ------------------------------------------------------------------------------------------------
// helpers (pure)
// ------------------------------------------------------------------------------------------------

function decidePathInitial(force: ForcePath, estTokens: number): PathDecision {
  if (force === 'main') return 'main';
  if (force === 'backup') return 'backup';
  return estTokens <= PATH_ROUTER_AUTO_THRESHOLD_TOKENS ? 'main' : 'backup';
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
 *   cluster_logs:{decision}:{endpoint_id}:{time_range_hash}:{trace_id||'*'}:{severity_hash}:{model?}
 */
export function buildCacheKey(args: {
  decision: PathDecision;
  endpointId: string;
  timeRange?: { start: string; end: string };
  traceId?: string | null;
  severityFilter?: string[];
  model?: RcaModelId;
}): string {
  const trh = args.timeRange
    ? sha8(`${args.timeRange.start}|${args.timeRange.end}`)
    : 'no-range';
  const sevh = args.severityFilter && args.severityFilter.length > 0
    ? sha8([...args.severityFilter].sort().join(','))
    : 'no-sev';
  const tid = args.traceId ? args.traceId : '*';
  const modelSeg = args.decision === 'main' && args.model ? `:${args.model}` : '';
  return `cluster_logs:${args.decision}:${args.endpointId}:${trh}:${tid}:${sevh}${modelSeg}`;
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
  // fail-closed: 主路径有 fallback (router.reason='fallback_from_main') 不入 cache · 跟 feat-045 一致
  if (payload.router.reason === 'fallback_from_main') return;
  const ttl = state === 'closed' ? TTL_CLOSED_MS : TTL_ONGOING_MS;
  cacheStore.set(key, payload, ttl);
}
