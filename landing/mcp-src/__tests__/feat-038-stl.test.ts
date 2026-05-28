/**
 * feat-038 STL 残差长漂移检测 · 算法核心单测 (TS 实现).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-038-L3-mcp-server-enrich-baseline-stl.html §7
 *
 * 覆盖 §7 fixture 5 case 中 STL 算法纯函数侧（trend 漂移合成数据 / 噪声场景 / valid sample 不足 /
 * 端点+缺失值 + 周期均值正确性）。Python statsmodels 对比 fixture 由 `scripts/feat-038-statsmodels-fixture.py`
 * 离线生成 JSON 比对结果（详 `stl-fixture-vs-statsmodels.test.ts`）· cron + T4 集成在另外两个文件覆盖。
 *
 * 设计依据：feat-038 §3.2 算法 + §3.6 阈值 + §4.2 I/O 契约 + §11 风险。
 */

import { describe, expect, it } from 'vitest';
import { computeStl, DEFAULT_STL_OPTS } from '../server-enrich/baseline/stl';

/**
 * 合成 720 数据点 (30d × 24 sample/h)：trend 线性从 100 漂到 500 (slope ≈ 3.3/day) +
 * seasonal 周期 7d 振幅 ±10 (±10%) + 微噪声。
 */
function buildDriftingSeries(): number[] {
  const N = 720;
  const samplesPerDay = 24;
  const series: number[] = [];
  for (let i = 0; i < N; i++) {
    const dayIdx = i / samplesPerDay;
    // 线性 trend 100 → 500 跨 30 days.
    const trend = 100 + (400 * dayIdx) / 30;
    // 7d 周期 seasonal 振幅 10.
    const seasonal = 10 * Math.sin((2 * Math.PI * i) / (7 * samplesPerDay));
    // 确定性微噪声（不用 Math.random · fixture 跑稳）.
    const noise = 1.5 * Math.sin(i * 0.7);
    series.push(trend + seasonal + noise);
  }
  return series;
}

/** 围绕 baseline=100 的纯噪声序列 (no trend)，确定性. */
function buildNoisySeries(): number[] {
  const N = 720;
  const series: number[] = [];
  for (let i = 0; i < N; i++) {
    // 确定性振幅 ±5 噪声 (no trend).
    const noise = 5 * Math.sin(i * 0.41) + 3 * Math.cos(i * 1.13);
    series.push(100 + noise);
  }
  return series;
}

describe('feat-038 · computeStl 核心算法', () => {
  it('case 1 · 已知漂移场景 (trend 100→500 跨 30d) → is_drifting=true · direction=rising · confidence≥0.85', () => {
    const samples = buildDriftingSeries();
    const result = computeStl(samples, DEFAULT_STL_OPTS);

    expect(result).not.toBe('not_computable');
    if (result === 'not_computable') return;

    expect(result.is_drifting).toBe(true);
    expect(result.trend_direction).toBe('rising');
    // trend_slope per-day ≈ 400/30 = 13.3 (verified by linear fit), 留宽容
    expect(result.trend_slope).toBeGreaterThan(8);
    expect(result.trend_slope).toBeLessThan(20);
    expect(result.drift_window_days).toBeGreaterThanOrEqual(7);
    expect(result.drift_confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('case 2 · 噪声场景 (无 trend) → is_drifting=false · direction=flat · confidence 低', () => {
    const samples = buildNoisySeries();
    const result = computeStl(samples, DEFAULT_STL_OPTS);

    expect(result).not.toBe('not_computable');
    if (result === 'not_computable') return;

    expect(result.is_drifting).toBe(false);
    expect(result.trend_direction).toBe('flat');
    expect(Math.abs(result.trend_slope)).toBeLessThan(0.5);
    // R² 低 = trend 几乎不解释方差.
    expect(result.drift_confidence).toBeLessThan(0.3);
  });

  it('case 3 · valid sample 不足 (< min_valid_samples) → not_computable', () => {
    const samples = Array.from({ length: 80 }, (_, i) => 100 + i * 0.1);
    const result = computeStl(samples, DEFAULT_STL_OPTS);
    expect(result).toBe('not_computable');
  });

  it('case 4 · 端点 + 缺失值 (NaN/Infinity 自动跳过) · 仅 valid 数 < 阈值 → not_computable', () => {
    // 100 个点但一半 NaN → valid=50 不够.
    const samples = Array.from({ length: 100 }, (_, i) =>
      i % 2 === 0 ? 100 + i * 0.1 : NaN,
    );
    const result = computeStl(samples, DEFAULT_STL_OPTS);
    expect(result).toBe('not_computable');
  });

  it('case 5 · 下降趋势 (linear decline) → direction=falling · slope<0', () => {
    const N = 720;
    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      const dayIdx = i / 24;
      // 500 → 100 跨 30d.
      const trend = 500 - (400 * dayIdx) / 30;
      const seasonal = 5 * Math.sin((2 * Math.PI * i) / 168);
      samples.push(trend + seasonal);
    }
    const result = computeStl(samples, DEFAULT_STL_OPTS);
    expect(result).not.toBe('not_computable');
    if (result === 'not_computable') return;
    expect(result.is_drifting).toBe(true);
    expect(result.trend_direction).toBe('falling');
    expect(result.trend_slope).toBeLessThan(0);
    expect(result.drift_confidence).toBeGreaterThanOrEqual(0.85);
  });
});

describe('feat-038 · STL 分解可观察性', () => {
  it('trend/seasonal/residual 三序列长度跟输入一致 (经分解函数 stlDecompose · 内部使用)', async () => {
    const { stlDecompose } = await import('../server-enrich/baseline/stl');
    const samples = buildDriftingSeries();
    const decomp = stlDecompose(samples, DEFAULT_STL_OPTS);
    expect(decomp.trend.length).toBe(samples.length);
    expect(decomp.seasonal.length).toBe(samples.length);
    expect(decomp.residual.length).toBe(samples.length);
    // residual 量级 << raw 量级.
    const residualP95 = sortAbs(decomp.residual)[Math.floor(0.95 * decomp.residual.length)];
    const rawP95 = sortAbs(samples)[Math.floor(0.95 * samples.length)];
    expect(residualP95).toBeLessThan(rawP95 / 5);
  });
});

function sortAbs(arr: number[]): number[] {
  return [...arr].map((v) => Math.abs(v)).sort((a, b) => a - b);
}
