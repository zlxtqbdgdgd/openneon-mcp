/**
 * SLO multi-window burn rate · feat-018 (L2a) · pure algorithm + seam-fed (no LLM · §3.3.0).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-018-L2-mcp-server-enrich-sli-burn-rate.html
 *
 * Answers a DIFFERENT question from feat-016: feat-016 = "is it deviating from normal?" (anomaly);
 * feat-018 = "is the error budget burning fast?" (SLO · page-level · incident trigger). A DB can
 * habitually violate an SLO (baseline says "normal" because it's always like this) while the budget
 * still burns — which is exactly why the two are computed separately (don't launder habitual-bad).
 *
 * L2a does the FAST-burn dual window only (1h + 5m @ 14.4 · Google SRE MWMBR). Honest THREE-STATE:
 * short-window SLI history insufficient → is_sli_burning='unknown' (NOT false); 30d history
 * insufficient → error_budget_remaining=null. INTERNAL · not agent-facing.
 */

import {
  getMetricHistory,
  type MetricHistoryRequest,
  type MetricHistoryResult,
  isMetricHistoryError,
} from '../metrics-history';
import { TtlCache, dimensionsKey, type Clock } from '../ttl-cache';
import { filterAutosuspendWindows } from '../sample-filter';
import type { AutosuspendWindow } from '../metrics-history/autosuspend-events';

/** Fast-burn threshold · 14.4 (Google SRE · ~2% of a 30d budget in 1h). */
export const FAST_BURN_THRESHOLD = 14.4;

// Fast-burn dual window (anti-staleness: both must burn). L2a only — mid/slow burn deferred (OQ2).
const WINDOW_1H = { last: '1h' } as const;
const BUCKET_1H = '5m';
const WINDOW_5M = { last: '5m' } as const;
const BUCKET_5M = '1m';
const BUCKET_BUDGET = '1h';

/** SLO block short-TTL cache (whole block · OQ4 simplification: short window dominates · 5m). */
const SLO_BLOCK_TTL_MS = 300_000;

export type SliKind = 'native_ratio' | 'gauge_threshold';

export type SloSpec = {
  signal: string;
  sli_kind: SliKind;
  /** gauge_threshold: the value that counts as "satisfying". */
  threshold?: number;
  /** gauge_threshold satisfy direction · default 'below' (a value at/under threshold is good). */
  good_when?: 'below' | 'above';
  /** e.g. 0.99. */
  slo_target: number;
  /** e.g. '30d'. */
  budget_window: string;
};

export type SloBlock = {
  /** Current SLI (the most-recent / 5m SLI ratio) · null when unavailable. */
  sli_value: number | null;
  slo_target: number;
  budget_window: string;
  /** Fraction of error budget remaining over budget_window · null when 30d history insufficient. */
  error_budget_remaining: number | null;
  burn_rate_1h: number | null;
  burn_rate_5m: number | null;
  /** Both windows > 14.4 → true · either window unavailable → 'unknown' (NEVER false). */
  is_sli_burning: boolean | 'unknown';
};

/**
 * Compute the SLI (a ratio in [0,1]) from a window's points.
 *
 * - native_ratio: mean of the non-null ratio values.
 * - gauge_threshold: proportion of non-null buckets that satisfy the threshold (good_when).
 *
 * Returns null when there is no usable data in the window (→ caller emits 'unknown', not false).
 */
export function computeSli(
  points: Array<[number, number | null]>,
  spec: SloSpec,
): number | null {
  const values: number[] = [];
  for (const [, v] of points) {
    if (v !== null && v !== undefined && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return null;

  if (spec.sli_kind === 'native_ratio') {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  // gauge_threshold
  const threshold = spec.threshold ?? 0;
  const goodWhen = spec.good_when ?? 'below';
  const satisfied = values.filter((v) =>
    goodWhen === 'below' ? v <= threshold : v >= threshold,
  ).length;
  return satisfied / values.length;
}

/** burn_rate = (1 − SLI) / (1 − slo_target). Higher = burning the error budget faster. */
export function burnRate(sli: number, sloTarget: number): number {
  const budget = 1 - sloTarget;
  if (budget <= 0) return 0; // slo_target >= 1 is degenerate · no budget to burn
  return (1 - sli) / budget;
}

/** error_budget_remaining = clamp(1 − consumed_fraction, 0, 1) where consumed = (1−SLI)/(1−target). */
export function errorBudgetRemaining(
  sliOverBudgetWindow: number,
  sloTarget: number,
): number {
  const budget = 1 - sloTarget;
  if (budget <= 0) return 1;
  const consumed = (1 - sliOverBudgetWindow) / budget;
  return Math.max(0, Math.min(1, 1 - consumed));
}

export type SloBurnDeps = {
  fetchHistory?: (req: MetricHistoryRequest) => Promise<MetricHistoryResult>;
  cache?: TtlCache<SloBlock>;
  /**
   * feat-040 (L3): autosuspend windows · 计算 SLI 时排除 autosuspend 段 sample。
   * 调用方提前从 AutosuspendEventFetchAdapter 拉好传入 · 空 / 省略 → no-op 向后兼容。
   * (SLI 通常算成功率 · autosuspend 段 metric 缺失会被当 ratio NaN 而影响算式 · 排除最干净。)
   */
  autosuspendWindows?: AutosuspendWindow[];
};

const defaultSloCache = new TtlCache<SloBlock>();

/** Build a typed SLO-block cache (e.g. for test isolation with a controllable clock). */
export function createSloCache(now?: Clock): TtlCache<SloBlock> {
  return new TtlCache<SloBlock>(now);
}

/** Test / rollback helper · clear the module-level SLO cache. */
export function clearSloCache(): void {
  defaultSloCache.clear();
}

/**
 * feat-040: autosuspend windows 进 cache key · 跟 baseline.coreCacheKey 同口径。
 * 不同 windows 集合算出的 SLI 不同 · key 必须区分。
 */
function autosuspendKey(windows?: AutosuspendWindow[]): string {
  if (!windows || windows.length === 0) return 'aw:none';
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  return `aw:${sorted.map((w) => `${w.start}-${w.end}`).join(',')}`;
}

function sloCacheKey(
  spec: SloSpec,
  dimensions: Record<string, string>,
  autosuspendWindows?: AutosuspendWindow[],
): string {
  return `${spec.signal}|${dimensionsKey(dimensions)}|t:${spec.slo_target}|bw:${spec.budget_window}|${autosuspendKey(autosuspendWindows)}`;
}

async function sliForWindow(
  spec: SloSpec,
  dimensions: Record<string, string>,
  window: MetricHistoryRequest['window'],
  bucket: string,
  fetchHistory: NonNullable<SloBurnDeps['fetchHistory']>,
  autosuspendWindows?: AutosuspendWindow[],
): Promise<number | null> {
  const history = await fetchHistory({
    signal: spec.signal,
    dimensions,
    window,
    bucket,
  });
  if (isMetricHistoryError(history)) return null; // failure ≠ "fine" · → 'unknown'/null upstream
  // feat-040: autosuspend 段排除 (sample-filter 共享层 · 跟 baseline.computeCore 同 pattern)。
  const points =
    autosuspendWindows && autosuspendWindows.length > 0
      ? filterAutosuspendWindows(history.points, autosuspendWindows)
      : history.points;
  return computeSli(points, spec);
}

/**
 * Compute the SLO burn-rate block for a signal.
 *
 * Fetches SLI history over 1h / 5m / budget_window, derives the dual-window fast burn + honest
 * three-state. The whole block is cached at a short TTL (history-only · no live value involved).
 */
export async function sloBurnRate(
  spec: SloSpec,
  dimensions: Record<string, string>,
  deps: SloBurnDeps = {},
): Promise<SloBlock> {
  const fetchHistory = deps.fetchHistory ?? getMetricHistory;
  const cache = deps.cache ?? defaultSloCache;

  const key = sloCacheKey(spec, dimensions, deps.autosuspendWindows);
  const cached = cache.get(key);
  if (cached) return cached;

  const [sli1h, sli5m, sliBudget] = await Promise.all([
    sliForWindow(
      spec,
      dimensions,
      WINDOW_1H,
      BUCKET_1H,
      fetchHistory,
      deps.autosuspendWindows,
    ),
    sliForWindow(
      spec,
      dimensions,
      WINDOW_5M,
      BUCKET_5M,
      fetchHistory,
      deps.autosuspendWindows,
    ),
    sliForWindow(
      spec,
      dimensions,
      { last: spec.budget_window },
      BUCKET_BUDGET,
      fetchHistory,
      deps.autosuspendWindows,
    ),
  ]);

  const burn1h = sli1h !== null ? burnRate(sli1h, spec.slo_target) : null;
  const burn5m = sli5m !== null ? burnRate(sli5m, spec.slo_target) : null;

  // Short-window SLI insufficient → 'unknown' (NOT false · the signal is blind, not healthy).
  // Anti-staleness: BOTH windows must exceed the threshold (a recovered 5m → not burning).
  const is_sli_burning: boolean | 'unknown' =
    burn1h === null || burn5m === null
      ? 'unknown'
      : burn1h > FAST_BURN_THRESHOLD && burn5m > FAST_BURN_THRESHOLD;

  const error_budget_remaining =
    sliBudget !== null
      ? errorBudgetRemaining(sliBudget, spec.slo_target)
      : null;

  const block: SloBlock = {
    sli_value: sli5m,
    slo_target: spec.slo_target,
    budget_window: spec.budget_window,
    error_budget_remaining,
    burn_rate_1h: burn1h,
    burn_rate_5m: burn5m,
    is_sli_burning,
  };

  cache.set(key, block, SLO_BLOCK_TTL_MS);
  return block;
}
