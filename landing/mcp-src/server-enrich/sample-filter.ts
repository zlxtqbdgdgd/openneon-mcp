/**
 * sample-filter.ts · feat-040 (L3) · autosuspend 段 sample 过滤共享层。
 *
 * 详设: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-040-L3-mcp-server-enrich-baseline-autosuspend-exclusion.html §3.3
 * 父 issue: zlxtqbdgdgd/openneon-design#49 · 子 issue: zlxtqbdgdgd/openneon-mcp#153
 *
 * 责任:
 *   - `filterAutosuspendWindows(samples, windows)` · 双指针 O(N+M) 排除 autosuspend 段 sample
 *   - `checkMinSamples(filtered, N)` · throw BaselineNotComputableError 当 finite sample 不足
 *   - `getMinValidSamples(policy?)` · 读 policy.yaml `baseline.min_valid_samples` (默认 100)
 *   - 留 warming_up tag filter hook (跟 feat-039 联动 · 后续可加)
 *
 * 为什么独立 module (overview §10.2 规约 2 · 4 模块边界):
 *   4 个 baseline 算法 (feat-016 median-mad / feat-017 seasonal / feat-018 SLO / feat-038 STL) 都消费
 *   sample 序列 · autosuspend 排除是横切关注 · 集中一处 · 算法本身不动 · 后面新算法可直接复用。
 *
 * 接口契约 (4 baseline 算法约定 · w2 PR body 写):
 *   - 输入 `samples: Array<[number, number | null]>` (跟 MetricHistory.points 同形)
 *   - 输入 `windows: AutosuspendWindow[]` (从 AutosuspendEventFetchAdapter 拿)
 *   - 输出 `Array<[number, number | null]>` · 时序保持 · null sample 不丢 (后续 flatten 才去 null)
 *   - 时间单位: unix 秒 (跟 MetricHistory.points / Coverage.latest_point_ts 一致)
 *   - window 边界: [start, end) 半开区间 · start 命中排除 · end 不命中
 *
 * 不做 (out of scope):
 *   - autosuspend events 拉取 (那是 #1 的 AutosuspendEventFetchAdapter)
 *   - 算法本身 (那是 baseline.ts / slo-burn-rate.ts / seasonal-bucketing.ts)
 *   - policy.yaml schema 校验自身 (那是 policy/loader.ts)
 */

import type { AutosuspendWindow } from './metrics-history/autosuspend-events';

/**
 * policy.yaml `baseline.min_valid_samples` 默认值 · 100 (per 详设 §3.5)。
 *
 * 不足 100 个有效 sample → baseline_state='not_computable' · T4 raw 输出 · 不算 anomaly。
 * dev/test 环境 90% 时间 autosuspend → 30d 含 ~72 sample → fallback 到 not_computable
 * (不让 baseline_median 被 0 值拉趋近 0 → wake 后 normal 流量当 spike 误报)。
 */
export const DEFAULT_MIN_VALID_SAMPLES = 100;

/**
 * baseline 无法计算时抛 · 调用方按 catch 翻 `baseline_state='not_computable'` · T4 raw 输出。
 *
 * 跟 feat-016 既有三态 (ok/insufficient_data/degenerate) 配合 · 算法主路径 throw 此 error
 * 时 fallback 到 insufficient_data behavior (不报 anomaly · 不阻塞 T4)。
 *
 * 设计哲学: fail-honest · "blind ≠ healthy"。
 */
export class BaselineNotComputableError extends Error {
  constructor(
    public readonly reason: 'min_valid_samples_unmet' | 'all_filtered',
    public readonly validSampleCount: number,
    public readonly minRequired: number,
    message?: string,
  ) {
    super(
      message ??
        `baseline 不可算: ${reason} · valid=${validSampleCount} · min=${minRequired}`,
    );
    this.name = 'BaselineNotComputableError';
  }
}

/**
 * 双指针 O(N + M log M + M) 排除 autosuspend window 内的 sample。
 *
 * 算法:
 *   1. windows 按 start 排序 (M log M · 通常 5 个一级 cheap)
 *   2. samples 假定按 timestamp 单调升 (MetricHistory 出口约定)
 *   3. 双指针 i 走 samples · j 走 windows · 跳过 sample.ts ∈ [windows[j].start, windows[j].end)
 *   4. window 用完 (sample.ts >= windows[j].end) 推 j
 *
 * 单调升 sample 假设来自 feat-064 MetricHistory.points · 不满足时 sort 之 (本函数不强加 cost)。
 *
 * 半开区间 [start, end) 的理由: autosuspend 事件 wake 时刻 sample 应该是 normal · 不能排除掉。
 *
 * null sample 不丢: sparse ≠ 失败 · 后续 flattenFiniteValues 才去 null (跟 baseline.ts 既有 pattern)。
 */
export function filterAutosuspendWindows(
  samples: ReadonlyArray<[number, number | null]>,
  windows: ReadonlyArray<AutosuspendWindow>,
): Array<[number, number | null]> {
  if (windows.length === 0) {
    return samples.slice() as Array<[number, number | null]>;
  }
  // sort copy · 不动调用方传入
  const sortedWindows = [...windows].sort((a, b) => a.start - b.start);
  const out: Array<[number, number | null]> = [];

  let j = 0;
  for (let i = 0; i < samples.length; i++) {
    const [ts] = samples[i];
    // 推进 j 直到当前 window 的 end > ts (即可能覆盖到 ts)
    while (j < sortedWindows.length && sortedWindows[j].end <= ts) {
      j += 1;
    }
    if (j >= sortedWindows.length) {
      // 没 window 可能覆盖了 · 后面 sample 全保留
      for (let k = i; k < samples.length; k++) out.push(samples[k]);
      return out;
    }
    // 半开 [start, end)
    if (ts >= sortedWindows[j].start && ts < sortedWindows[j].end) {
      continue; // 落 autosuspend 段 · 排除
    }
    out.push(samples[i]);
  }
  return out;
}

/**
 * finite (非 null / NaN / Infinity) sample 数不足 minRequired → throw BaselineNotComputableError。
 *
 * 跟 baseline.ts `flattenFiniteValues` 同口径 · 排除 null / NaN / non-finite (sparse ≠ valid)。
 * 调用方按 catch 翻 baseline_state='not_computable' · T4 raw 输出 (不报 anomaly)。
 */
export function checkMinSamples(
  samples: ReadonlyArray<[number, number | null]>,
  minRequired: number,
): void {
  let valid = 0;
  for (const [, v] of samples) {
    if (v !== null && v !== undefined && Number.isFinite(v)) valid += 1;
  }
  if (valid < minRequired) {
    throw new BaselineNotComputableError(
      valid === 0 ? 'all_filtered' : 'min_valid_samples_unmet',
      valid,
      minRequired,
    );
  }
}

/**
 * 读 policy.yaml `baseline.min_valid_samples` · 默认 DEFAULT_MIN_VALID_SAMPLES (100)。
 *
 * 当前 policy/loader.ts 没暴 baseline 字段 (feat-040 新增) · 给个可注入 hook · 后续 loader 加字段时
 * 调用方传 `resolvedPolicy.baseline?.min_valid_samples` 即可 · 无 policy 字段时仍走默认。
 */
export function getMinValidSamples(opts?: {
  policyMinValidSamples?: number;
}): number {
  if (
    opts?.policyMinValidSamples !== undefined &&
    Number.isFinite(opts.policyMinValidSamples) &&
    opts.policyMinValidSamples > 0
  ) {
    return opts.policyMinValidSamples;
  }
  return DEFAULT_MIN_VALID_SAMPLES;
}

/**
 * warming_up tag filter hook · 留扩展点跟 feat-039 联动。
 *
 * feat-039 在 Neon kernel 给冷启后过渡段 sample 打 `warming_up=true` tag · 本 hook 接受
 * tag predicate · samples 落 hook 排除。当前 day-one 不强制实现 (feat-039 还没 ship · feat-040
 * autosuspend 段排除是 disjoint 问题) · 留接口防后续 refactor。
 */
export type TagPredicate = (
  ts: number,
  v: number | null,
  tags?: Record<string, string>,
) => boolean;

/**
 * 复合过滤 · 先 autosuspend windows · 再 (可选) warming_up tag · 返一份 sample。
 *
 * 当前 tag 信息不在 [ts, v] tuple 里 · 后续 metrics-history 扩 tags 字段后实化此 hook。
 */
export function applyFilters(
  samples: ReadonlyArray<[number, number | null]>,
  windows: ReadonlyArray<AutosuspendWindow>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _warmingUpFilter?: TagPredicate,
): Array<[number, number | null]> {
  return filterAutosuspendWindows(samples, windows);
}

export type { AutosuspendWindow };
