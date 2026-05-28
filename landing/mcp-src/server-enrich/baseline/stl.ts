/**
 * feat-038 · STL (Seasonal-Trend decomposition) 残差分解 · 长漂移检测 · 纯 TS 简化版.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-038-L3-mcp-server-enrich-baseline-stl.html §3.2
 *
 * 跟 [feat-016 median+MAD](../../tools/handlers/health-signals.ts) (24h 短期 baseline · 点突变)
 * + [feat-017 seasonal-MAD](./seasonal-bucketing.ts) (7d 周期日内分桶 · 周内规律) 正交：
 * STL 看**月级慢漂移** —— 每天涨 1-2% 在 MAD 范围内但 4 个月累 5x 增长完全沉默的容量预警盲区。
 *
 * 算法简化 4 步（详设 §3.2）：
 *   1. trend = 滑动中位数 (window=24h) · 抗短期噪声.
 *   2. detrend = raw − trend.
 *   3. seasonal = 周期均值 (period=168h=7d · 同 phase 点取均值).
 *   4. residual = detrend − seasonal.
 * 然后对 trend 跑线性回归取 slope (per-day) + R² (drift_confidence).
 *
 * 形态：纯函数 · 无 I/O · 无副作用 · 可任意 mock seam 喂数据.
 *
 * MAD 单位复用 [feat-016 medianMad](./median-mad.ts)：is_drifting 阈值用 MAD_per_day 表达 ·
 * 不在本模块重复实现 MAD.
 */

import { median, medianAbsoluteDeviation } from './median-mad';

/** STL 算法参数 · 详设 §3.2 + §3.6. */
export type StlOpts = {
  /** trend 滑动中位数窗口大小 (sample 数) · 默认 24 (≈ 1 day @ 1h bucket). */
  trendWindow: number;
  /** seasonal 周期长度 (sample 数) · 默认 168 (= 7d @ 1h bucket · 跟 feat-017 一致). */
  seasonalPeriod: number;
  /** 1d 占多少 sample · 默认 24 (1h bucket). 用于把 slope 换算成 per-day rate. */
  samplesPerDay: number;
  /** valid sample 不足该阈值则返回 'not_computable' (跟 ADR-0014 阈值一致). */
  minValidSamples: number;
  /** is_drifting 阈值 = drift_threshold_mad_per_day × MAD_per_day · 详设 §3.6. */
  driftThresholdMadPerDay: number;
  /** drift_confidence 阈值 (R²) · 详设 §3.6. */
  minDriftConfidence: number;
  /** drift_window_days 阈值 · 单调段必须 ≥ 该天数才算 drift · 详设 §3.6. */
  minDriftWindowDays: number;
};

export const DEFAULT_STL_OPTS: StlOpts = {
  trendWindow: 24,
  seasonalPeriod: 168,
  samplesPerDay: 24,
  minValidSamples: 100,
  driftThresholdMadPerDay: 0.5,
  minDriftConfidence: 0.7,
  minDriftWindowDays: 7,
};

/** T4 enrich 5 字段 · 详设 §4.1. */
export type StlEnrich = {
  /** |trend_slope| > driftThresholdMadPerDay × MAD_per_day && drift_confidence ≥ minDriftConfidence && drift_window_days ≥ minDriftWindowDays. */
  is_drifting: boolean;
  /** per-day rate · 从 trend 线性回归取斜率 · 单位跟 metric 一致. */
  trend_slope: number;
  /** sign(trend_slope) · |slope| < threshold → 'flat'. */
  trend_direction: 'rising' | 'falling' | 'flat';
  /** 漂移持续天数 · trend 序列单调段最长长度 (samples / samplesPerDay). */
  drift_window_days: number;
  /** 0-1 · 线性回归 R². */
  drift_confidence: number;
};

/** 内部 STL 分解结果 · 给单测 / debug 用. */
export type StlDecomposition = {
  trend: number[];
  seasonal: number[];
  residual: number[];
};

/**
 * 滑动中位数 (centered) · trend 成分.
 *
 * 用 centered window: 第 i 个点取 [i − w/2, i + w/2] 范围中位数。窗口跨越端点时按可用数据收缩 ·
 * 不做镜像填充（避免人为偏置端点 trend）。复杂度 O(N × W log W) · N=720 W=24 → ~17K op · 单调可接受.
 */
export function rollingMedian(values: number[], window: number): number[] {
  if (window < 1) throw new Error('rollingMedian: window must be ≥ 1');
  const N = values.length;
  const half = Math.floor(window / 2);
  const out: number[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(N, i + half + 1);
    out[i] = median(values.slice(lo, hi));
  }
  return out;
}

/**
 * 周期均值 seasonal 成分 · 同 phase 点 (i mod period) 取均值.
 *
 * 输入 detrend = raw − trend · 输出长度 = N · 每个点对应 phase 的均值 (跨周期重复).
 * 不做 robust normalization (Loess) · 简化 §3.2 用均值即可.
 */
export function seasonalMean(detrended: number[], period: number): number[] {
  if (period < 1) throw new Error('seasonalMean: period must be ≥ 1');
  const phaseSum: number[] = new Array(period).fill(0);
  const phaseCount: number[] = new Array(period).fill(0);
  for (let i = 0; i < detrended.length; i++) {
    const p = i % period;
    const v = detrended[i];
    if (Number.isFinite(v)) {
      phaseSum[p] += v;
      phaseCount[p] += 1;
    }
  }
  const phaseAvg: number[] = new Array(period);
  for (let p = 0; p < period; p++) {
    phaseAvg[p] = phaseCount[p] > 0 ? phaseSum[p] / phaseCount[p] : 0;
  }
  return detrended.map((_, i) => phaseAvg[i % period]);
}

/**
 * 完整 STL 分解 · 内部使用 (导出仅给单测可见性).
 *
 * 1. trend = rollingMedian.
 * 2. detrend = raw − trend.
 * 3. seasonal = seasonalMean(detrend).
 * 4. residual = detrend − seasonal.
 */
export function stlDecompose(samples: number[], opts: StlOpts): StlDecomposition {
  const trend = rollingMedian(samples, opts.trendWindow);
  const detrend = samples.map((v, i) => v - trend[i]);
  const seasonal = seasonalMean(detrend, opts.seasonalPeriod);
  const residual = detrend.map((v, i) => v - seasonal[i]);
  return { trend, seasonal, residual };
}

/**
 * 线性回归 (least squares · y = a + b·x) · 返回 {slope, r2}.
 *
 * x = sample 索引 (0..N−1) · y = trend values. 用于 trend 显著性判定.
 */
export function linearRegression(values: number[]): { slope: number; r2: number } {
  const N = values.length;
  if (N < 2) return { slope: 0, r2: 0 };
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;
  for (let i = 0; i < N; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const meanX = sumX / N;
  const meanY = sumY / N;
  const denom = sumX2 - N * meanX * meanX;
  if (denom === 0) return { slope: 0, r2: 0 };
  const slope = (sumXY - N * meanX * meanY) / denom;
  const intercept = meanY - slope * meanX;
  // R² = 1 − SS_res / SS_tot.
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < N; i++) {
    const yHat = intercept + slope * i;
    ssRes += (values[i] - yHat) ** 2;
    ssTot += (values[i] - meanY) ** 2;
  }
  if (ssTot === 0) return { slope: 0, r2: 0 };
  return { slope, r2: 1 - ssRes / ssTot };
}

/**
 * 漂移持续天数 · trend 序列最长连续单调段 ÷ samplesPerDay.
 *
 * 详设 §11 风险表 "多段单调如何处理"：取最长连续单调段 · 间断点 (符号翻转) 断段 ·
 * 不要求严格单调（容忍微小 noise）— 这里基于 slope 符号判定单调方向.
 */
export function longestMonotonicWindowDays(
  trend: number[],
  samplesPerDay: number,
  overallSlope: number,
): number {
  if (trend.length < 2) return 0;
  const direction = overallSlope > 0 ? 1 : overallSlope < 0 ? -1 : 0;
  if (direction === 0) return 0;
  let longest = 0;
  let current = 1; // 第一个点单独算 1 sample.
  for (let i = 1; i < trend.length; i++) {
    const delta = trend[i] - trend[i - 1];
    // 跟整体方向一致或持平 (delta=0 不破坏单调段)。
    const consistent = direction > 0 ? delta >= 0 : delta <= 0;
    if (consistent) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }
  return longest / samplesPerDay;
}

/**
 * 计算 STL enrich 5 字段 · feat-038 主入口.
 *
 * 流程：
 *   1. valid sample (Number.isFinite) 数 < minValidSamples → 'not_computable'.
 *   2. 跑 STL 分解.
 *   3. trend 线性回归 → slope_per_sample, R² → drift_confidence.
 *   4. slope_per_day = slope_per_sample × samplesPerDay.
 *   5. MAD_per_day = MAD(raw valid samples) × samplesPerDay (用 raw 量级当尺度).
 *   6. is_drifting = |slope_per_day| > driftThresholdMadPerDay × MAD_per_day
 *      && drift_confidence ≥ minDriftConfidence && drift_window_days ≥ minDriftWindowDays.
 *   7. trend_direction = is_drifting ? sign(slope) : 'flat'.
 */
export function computeStl(
  samples: number[],
  opts: StlOpts = DEFAULT_STL_OPTS,
): StlEnrich | 'not_computable' {
  // 1. 过滤 valid (NaN/Infinity 跳过 · 跟 feat-064 seam 入口 filter 一致).
  const valid: number[] = samples.filter((v) => Number.isFinite(v));
  if (valid.length < opts.minValidSamples) {
    return 'not_computable';
  }

  // 2. 分解 (用 valid 序列 · 跟 trend 索引一致).
  const decomp = stlDecompose(valid, opts);

  // 3. trend 线性回归.
  const { slope: slopePerSample, r2 } = linearRegression(decomp.trend);
  const trendSlope = slopePerSample * opts.samplesPerDay; // per-day rate.

  // 5. MAD 当 robust scale · 用 RESIDUAL 序列的 MAD 作为 noise floor 尺度.
  //
  // 重要：不能用 raw 序列的 MAD —— raw 含 trend 跨度本身，MAD 会接近 trend 振幅的 1/4 ·
  // 导致 |slope_per_day| 几乎永远小于 0.5 × MAD_raw · case 1/5 fixture 验证 (raw MAD=103 时 slope 13/day
  // 跨不过 51.5 阈值)。Detrend 后的 residual MAD 才是 "如果没漂移这数据有多稳" 的尺度 ·
  // slope_per_day 跟这个比才能区分漂移 vs 噪声。详设 §3.6 注释 "每天漂移 0.5 MAD" 也是相对 noise floor 语义。
  const residualMad = medianAbsoluteDeviation(decomp.residual);
  // 给 ttl-cache 显示用的 raw baseline median (跟 feat-016 一致 robust 中心 · 非阈值).
  const _med = median(valid);
  const driftThresholdValue = opts.driftThresholdMadPerDay * residualMad;

  // 6. drift_window_days · 单调段最长长度.
  const driftWindowDays = longestMonotonicWindowDays(
    decomp.trend,
    opts.samplesPerDay,
    trendSlope,
  );

  // 7. is_drifting 复合判定.
  const slopeMagnitude = Math.abs(trendSlope);
  const slopeQualifies = slopeMagnitude > driftThresholdValue;
  const confidenceQualifies = r2 >= opts.minDriftConfidence;
  const windowQualifies = driftWindowDays >= opts.minDriftWindowDays;
  const isDrifting = slopeQualifies && confidenceQualifies && windowQualifies;

  // 8. trend_direction · 不漂移时 flat (不暴露 noise 方向 · 详设 §4.1).
  let trendDirection: StlEnrich['trend_direction'];
  if (!isDrifting) {
    trendDirection = 'flat';
  } else {
    trendDirection = trendSlope > 0 ? 'rising' : 'falling';
  }

  return {
    is_drifting: isDrifting,
    trend_slope: trendSlope,
    trend_direction: trendDirection,
    drift_window_days: driftWindowDays,
    drift_confidence: r2,
  };
}
