/**
 * median+MAD baseline library · feat-016 (L2a) + seasonal-MAD branch · feat-017 (L2b).
 *
 * Detail design:
 *   - feat-016: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-016-L2-mcp-server-enrich-baseline-mad.html
 *   - feat-017: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-017-L2b-mcp-server-enrich-baseline-seasonal-mad.html
 *
 * Signal-agnostic robust baseline. Given a logical signal, fetch its history via the feat-064 seam,
 * compute a median+MAD band, and (if a current value is supplied) the deviation. Honest THREE-STATE:
 * never emits a fake band when data is insufficient or degenerate. Consumed by feat-018 (SLO) /
 * feat-020 (T4) / feat-038 (STL). INTERNAL · not agent-facing.
 *
 * Caching (feat-020 grill · 2026-05-25): the OBJECTIVE core (status + median + MAD + coverage) is
 * cached per signal+dimensions+window+bucket with TTL ≈ bucket. robust_z / band edges / label are
 * computed FRESH each call from the cached core + the live current_value (which is never cached).
 * The key includes full dimensions → cross-tenant isolation (§6).
 *
 * feat-017 seasonal branch: when `seasonal: true`, history is split into 24 UTC hour-of-day buckets;
 * each bucket runs its own median+MAD. The result picks the bucket for the current hour with a
 * three-level fallback chain (seasonal → global → insufficient_data · §3.2). The seasonal core
 * cache is SEPARATE from the non-seasonal one (different key prefix · independent TTL · per-signal
 * opt-in via signal-registry's `seasonalApplicable`).
 */

import {
  getMetricHistory,
  type MetricHistoryRequest,
  type MetricHistoryResult,
  isMetricHistoryError,
  type Coverage,
} from '../metrics-history';
import { TtlCache, dimensionsKey, type Clock } from '../ttl-cache';
import {
  median,
  medianAbsoluteDeviation,
  computeBand,
  robustZ,
  deviationLabel,
  type BaselineBand,
  type DeviationLabel,
} from './median-mad';
import {
  groupByHourOfDay,
  computeBucketCore,
  flattenFiniteValues,
  hourOfDayUTC,
  BUCKET_COUNT,
  type BucketCore,
} from './seasonal-bucketing';
import { parseDurationSeconds } from '../metrics-history/duration';
import {
  filterAutosuspendWindows,
  checkMinSamples,
  getMinValidSamples,
  BaselineNotComputableError,
} from '../sample-filter';
import type { AutosuspendWindow } from '../metrics-history/autosuspend-events';

export const DEFAULT_K = 3;
export const DEFAULT_MIN_POINTS = 20;

export type BaselineStatus = 'ok' | 'insufficient_data' | 'degenerate';

/** Which baseline algorithm produced the band · null when no usable baseline could be formed. */
export type BaselineAlgo = 'median-mad' | 'seasonal-mad' | null;

export type BaselineRequest = {
  signal: string;
  dimensions: Record<string, string>;
  window: MetricHistoryRequest['window'];
  bucket: string;
  /** Live current value from the consumer (live DB) · supply to get deviation. NEVER cached. */
  current_value?: number;
  /** Band width multiplier · default 3. */
  k?: number;
  /** Minimum non-null points required before a band is trusted · default 20. */
  min_points?: number;
  /** feat-017: enable seasonal (24 hour-of-day buckets) · default false (== feat-016 behavior). */
  seasonal?: boolean;
  /** feat-017: bucketing strategy · default 'hour-of-day' (only value supported in L2b). */
  bucketStrategy?: 'hour-of-day';
  /**
   * feat-040 (L3): autosuspend windows from Neon control plane · sample-filter 双指针 O(N+M) 排除
   *
   * 来自 AutosuspendEventFetchAdapter (metrics-history/autosuspend-events.ts) · 调用方 (T4 handler /
   * cron) 提前拉好传进来 · baseline 算法本身不直接打 control plane API (保持 pure · 跟 fetchHistory
   * 同 pattern)。Aurora / 无 autosuspend 概念时传空数组 / 省略 · 自动 no-op。
   *
   * 详 §3.3 sample-filter 共享层 · 跟 sample-filter.filterAutosuspendWindows 接口契约一致。
   */
  autosuspendWindows?: AutosuspendWindow[];
  /**
   * feat-040 (L3): policy.yaml `baseline.min_valid_samples` override · 默认 100。
   *
   * filter 后 finite sample 不足时 throw BaselineNotComputableError · baseline 内部 catch 翻 status
   * 'insufficient_data' (跟既有 三态 一致 · 调用方无需改) · 上游 T4 handler 后续可读 baseline_state 字段。
   */
  minValidSamples?: number;
};
export type BaselineResult = {
  status: BaselineStatus;
  /** Only on status='ok'. */
  band?: BaselineBand;
  /** Only on status='ok' AND a current_value was supplied. */
  deviation?: { robust_z: number; label: DeviationLabel };
  /** Always present (zeroed on a history-fetch failure · honest "no data"). */
  coverage: Coverage;
  /** feat-017: 'seasonal-mad' / 'median-mad' / null · honest about which fallback level was taken. */
  algo: BaselineAlgo;
  /** feat-017: UTC hour-of-day of the chosen bucket · seasonal-mad AND median-mad fallback both set
   *  this (median-mad seasonal-fallback records the bucket it WANTED · transparency for the agent). */
  bucket_id?: number;
};

/** The objective, cacheable part of feat-016 · k-independent · current_value-independent. */
type BaselineCore = {
  status: BaselineStatus;
  median?: number;
  mad?: number;
  coverage: Coverage;
};

/**
 * feat-017 seasonal core · holds 24 hour-of-day buckets + a global fallback core (level ② of the
 * three-level fallback chain in §3.2). All k-independent · current_value-independent · cacheable.
 */
export type SeasonalCore = {
  buckets: { [hour: number]: BucketCore };
  global: BaselineCore;
  coverage: Coverage;
};

const ZERO_COVERAGE: Coverage = {
  actual_points: 0,
  expected_points: 0,
  span_seconds: 0,
  latest_point_ts: null,
};

export type BaselineDeps = {
  /** History fetcher · defaults to the feat-064 seam · overridable in tests. */
  fetchHistory?: (req: MetricHistoryRequest) => Promise<MetricHistoryResult>;
  /** Band-core cache (feat-016) · overridable for test isolation. */
  cache?: TtlCache<BaselineCore>;
  /** Seasonal-core cache (feat-017) · overridable for test isolation. */
  seasonalCache?: TtlCache<SeasonalCore>;
  /** Clock for "now" (used by seasonal to pick current hour) · injected for deterministic tests. */
  now?: Clock;
};

const defaultCache = new TtlCache<BaselineCore>();
const defaultSeasonalCache = new TtlCache<SeasonalCore>();

/** Build a typed band-core cache (e.g. for test isolation with a controllable clock). */
export function createBaselineCache(now?: Clock): TtlCache<BaselineCore> {
  return new TtlCache<BaselineCore>(now);
}

/** feat-017: build a typed seasonal-core cache (e.g. for test isolation). */
export function createSeasonalCache(now?: Clock): TtlCache<SeasonalCore> {
  return new TtlCache<SeasonalCore>(now);
}

/** Test / rollback helper · clear the module-level band cache. */
export function clearBaselineCache(): void {
  defaultCache.clear();
}

/** feat-017: clear the module-level seasonal-core cache. */
export function clearSeasonalCache(): void {
  defaultSeasonalCache.clear();
}

function windowKey(window: MetricHistoryRequest['window']): string {
  return 'last' in window
    ? `last:${window.last}`
    : `abs:${window.from}-${window.to}`;
}

/**
 * feat-040: autosuspend windows 进 cache key · 不同 windows 集合算出的 core 是不同 objective core ·
 * key 必须区分 (不然 windows 变了 cache 仍返旧 band)。windows 通常 1h cache 内稳定 · 实际进入此函数
 * 的频率低 · key 用 start+end 紧凑 hash 不展开 JSON.stringify (省字节)。
 */
function autosuspendWindowsKey(
  windows: AutosuspendWindow[] | undefined,
): string {
  if (!windows || windows.length === 0) return 'aw:none';
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  return `aw:${sorted.map((w) => `${w.start}-${w.end}`).join(',')}`;
}

function coreCacheKey(req: BaselineRequest): string {
  // Full dimensions in the key = cross-tenant isolation boundary (§6).
  // feat-040: autosuspend windows 进 key · 不同 windows 不串场。
  return `${req.signal}|${dimensionsKey(req.dimensions)}|${windowKey(req.window)}|${req.bucket}|${autosuspendWindowsKey(req.autosuspendWindows)}`;
}

/**
 * feat-017: seasonal cache key. Prefix isolates it from the feat-016 cache space so a non-seasonal
 * and seasonal call for the same signal don't collide. `bucketStrategy` is in the key so a future
 * 'hour-of-week' strategy gets its own entries.
 *
 * feat-040: autosuspend windows 进 key · 跟 coreCacheKey 同口径。
 */
function seasonalCoreKey(req: BaselineRequest): string {
  const strategy = req.bucketStrategy ?? 'hour-of-day';
  return `seasonal:${strategy}|${req.signal}|${dimensionsKey(req.dimensions)}|${windowKey(req.window)}|${req.bucket}|${autosuspendWindowsKey(req.autosuspendWindows)}`;
}

function ttlMsFromBucket(bucket: string): number {
  try {
    return parseDurationSeconds(bucket) * 1000;
  } catch {
    // unparseable bucket already surfaced as insufficient_data upstream · use a safe default TTL
    return 60_000;
  }
}

/** Compute the objective band core (history fetch → median/MAD → three-state). No caching here.
 *
 * feat-040 (L3): autosuspend windows 排除走 sample-filter.filterAutosuspendWindows · filter 后
 * 跟既有 flattenFiniteValues / median / MAD 同口径 · 不动算法本身 (橫切关注集中在 sample-filter.ts)。
 */
async function computeCore(
  req: BaselineRequest,
  fetchHistory: NonNullable<BaselineDeps['fetchHistory']>,
  minPoints: number,
): Promise<BaselineCore> {
  const history = await fetchHistory({
    signal: req.signal,
    dimensions: req.dimensions,
    window: req.window,
    bucket: req.bucket,
  });

  // Fetch failure → can't baseline. Degrade to insufficient_data (the consumer then reports NO
  // anomaly · §8) · never silently treats it as "normal".
  if (isMetricHistoryError(history)) {
    return { status: 'insufficient_data', coverage: ZERO_COVERAGE };
  }

  // feat-040: autosuspend 段排除 (sample-filter 共享层 · 双指针 O(N+M))。windows 由调用方
  // 从 AutosuspendEventFetchAdapter 提前拉好传入 · 空 windows / 省略 → no-op (向后兼容)。
  const hasAutosuspendInputs =
    (req.autosuspendWindows && req.autosuspendWindows.length > 0) ||
    req.minValidSamples !== undefined;
  const points =
    req.autosuspendWindows && req.autosuspendWindows.length > 0
      ? filterAutosuspendWindows(history.points, req.autosuspendWindows)
      : history.points;

  // feat-040: min_valid_samples 阈值校验 · 仅在 feat-040 启用 (传了 autosuspendWindows 或显式 minValidSamples)
  // 时生效 · 向后兼容 feat-016/017 既有 behavior (min_points=20 单独走)。
  // filter 后不足时 throw → catch 翻 insufficient_data (三态保持不变 · 调用方 behavior 不动)。
  if (hasAutosuspendInputs) {
    const minValid = getMinValidSamples({
      policyMinValidSamples: req.minValidSamples,
    });
    try {
      checkMinSamples(points, minValid);
    } catch (err) {
      if (err instanceof BaselineNotComputableError) {
        return { status: 'insufficient_data', coverage: history.coverage };
      }
      throw err;
    }
  }

  const values = flattenFiniteValues(points);
  if (values.length < minPoints) {
    return { status: 'insufficient_data', coverage: history.coverage };
  }

  const med = median(values);
  const mad = medianAbsoluteDeviation(values, med);

  // MAD == 0 (all identical) → degenerate · give the median but no band / no robust_z (无尺度) ·
  // never report an anomaly off a zero-width band.
  if (mad === 0) {
    return { status: 'degenerate', median: med, coverage: history.coverage };
  }

  return { status: 'ok', median: med, mad, coverage: history.coverage };
}

/**
 * feat-017: compute the seasonal core (24 buckets + global fallback). No caching here.
 *
 * One history fetch · split into 24 hour-of-day groups · each group independently runs the same
 * median+MAD three-state from feat-016. The global core (level ② fallback) is computed across all
 * values in the same fetch — no second round-trip to feat-064.
 */
async function computeSeasonalCoreLayer(
  req: BaselineRequest,
  fetchHistory: NonNullable<BaselineDeps['fetchHistory']>,
  minPoints: number,
): Promise<SeasonalCore> {
  const history = await fetchHistory({
    signal: req.signal,
    dimensions: req.dimensions,
    window: req.window,
    bucket: req.bucket,
  });

  if (isMetricHistoryError(history)) {
    const empty: SeasonalCore['buckets'] = {};
    for (let h = 0; h < BUCKET_COUNT; h++) {
      empty[h] = { status: 'insufficient_data', sample_count: 0 };
    }
    return {
      buckets: empty,
      global: { status: 'insufficient_data', coverage: ZERO_COVERAGE },
      coverage: ZERO_COVERAGE,
    };
  }

  // feat-040: autosuspend 段排除 (跟 computeCore 同 pattern · 双指针 O(N+M) · 算法不动)。
  const points =
    req.autosuspendWindows && req.autosuspendWindows.length > 0
      ? filterAutosuspendWindows(history.points, req.autosuspendWindows)
      : history.points;

  // Per-bucket cores.
  const groups = groupByHourOfDay(points);
  const buckets: SeasonalCore['buckets'] = {};
  for (const [h, vs] of groups) {
    buckets[h] = computeBucketCore(vs, minPoints);
  }

  // Global fallback core · same shape as feat-016 BaselineCore (跟 filter 后的 points 一致).
  const allValues = flattenFiniteValues(points);
  let global: BaselineCore;
  if (allValues.length < minPoints) {
    global = { status: 'insufficient_data', coverage: history.coverage };
  } else {
    const med = median(allValues);
    const mad = medianAbsoluteDeviation(allValues, med);
    global =
      mad === 0
        ? { status: 'degenerate', median: med, coverage: history.coverage }
        : { status: 'ok', median: med, mad, coverage: history.coverage };
  }

  return { buckets, global, coverage: history.coverage };
}

/**
 * feat-017 seasonal branch · three-level fallback chain in §3.2 of feat-017 detail design.
 *
 *   ① seasonal-mad   · bucket for current hour is `ok` (≥ MIN_POINTS · MAD > 0)
 *   ② median-mad     · bucket unavailable but the global core is `ok` (fallback to feat-016 main)
 *   ③ status only    · both levels unavailable · return status (insufficient_data / degenerate) ·
 *                       algo = null · honest about being blind
 *
 * `bucket_id` is set on ALL three levels (level ② records the bucket it WANTED · transparency to
 * the agent that this is a fallback path).
 */
async function baselineSeasonal(
  req: BaselineRequest,
  fetchHistory: NonNullable<BaselineDeps['fetchHistory']>,
  cache: TtlCache<SeasonalCore>,
  k: number,
  minPoints: number,
  now: Clock,
): Promise<BaselineResult> {
  const key = seasonalCoreKey(req);
  let core = cache.get(key);
  if (!core) {
    core = await computeSeasonalCoreLayer(req, fetchHistory, minPoints);
    cache.set(key, core, ttlMsFromBucket(req.bucket));
  }

  const h = hourOfDayUTC(now() / 1000);
  const bucket = core.buckets[h];

  // Level ① · seasonal-mad
  if (bucket && bucket.status === 'ok') {
    const band = computeBand(bucket.median, bucket.mad, k);
    const result: BaselineResult = {
      status: 'ok',
      band,
      coverage: core.coverage,
      algo: 'seasonal-mad',
      bucket_id: h,
    };
    if (req.current_value !== undefined) {
      const z = robustZ(req.current_value, bucket.median, bucket.mad);
      result.deviation = { robust_z: z, label: deviationLabel(z, k) };
    }
    return result;
  }

  // Level ② · median-mad fallback (global ok)
  if (
    core.global.status === 'ok' &&
    core.global.median !== undefined &&
    core.global.mad !== undefined
  ) {
    const band = computeBand(core.global.median, core.global.mad, k);
    const result: BaselineResult = {
      status: 'ok',
      band,
      coverage: core.coverage,
      algo: 'median-mad',
      bucket_id: h,
    };
    if (req.current_value !== undefined) {
      const z = robustZ(req.current_value, core.global.median, core.global.mad);
      result.deviation = { robust_z: z, label: deviationLabel(z, k) };
    }
    return result;
  }

  // Level ③ · both unavailable · honest status pass-through · algo=null
  return {
    status: core.global.status,
    coverage: core.coverage,
    algo: null,
    bucket_id: h,
  };
}

/**
 * Compute a robust baseline for a signal.
 *
 * Cache-then-fetch on the objective core; assemble band edges + deviation fresh from the live
 * current_value (never cached). Returns a three-state result · honest about insufficient / degenerate.
 *
 * feat-017: when `req.seasonal === true`, the seasonal branch (24 hour-of-day buckets · three-level
 * fallback chain) is taken instead. The seasonal cache is separate so the non-seasonal call space
 * is untouched · this is opt-in per signal via signal-registry's `seasonalApplicable`.
 */
export async function baseline(
  req: BaselineRequest,
  deps: BaselineDeps = {},
): Promise<BaselineResult> {
  const fetchHistory = deps.fetchHistory ?? getMetricHistory;
  const k = req.k ?? DEFAULT_K;
  const minPoints = req.min_points ?? DEFAULT_MIN_POINTS;

  if (req.seasonal === true) {
    const seasonalCache = deps.seasonalCache ?? defaultSeasonalCache;
    const now = deps.now ?? Date.now;
    return baselineSeasonal(
      req,
      fetchHistory,
      seasonalCache,
      k,
      minPoints,
      now,
    );
  }

  const cache = deps.cache ?? defaultCache;
  const key = coreCacheKey(req);
  let core = cache.get(key);
  if (!core) {
    core = await computeCore(req, fetchHistory, minPoints);
    // TTL ≈ bucket · short-lived so the band tracks reality without hammering the backend.
    cache.set(key, core, ttlMsFromBucket(req.bucket));
  }

  if (
    core.status !== 'ok' ||
    core.median === undefined ||
    core.mad === undefined
  ) {
    return { status: core.status, coverage: core.coverage, algo: null };
  }

  const band = computeBand(core.median, core.mad, k);
  const result: BaselineResult = {
    status: 'ok',
    band,
    coverage: core.coverage,
    algo: 'median-mad',
  };

  if (req.current_value !== undefined) {
    const z = robustZ(req.current_value, core.median, core.mad);
    result.deviation = { robust_z: z, label: deviationLabel(z, k) };
  }

  return result;
}
