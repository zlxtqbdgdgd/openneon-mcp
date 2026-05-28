#!/usr/bin/env python3
"""
feat-038 · STL TS 简化版 vs Python statsmodels.STL build-time 对比 fixture 生成器.

详设：https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-038-L3-mcp-server-enrich-baseline-stl.html §7 case 5

行为：合成 720 数据点 (跟 TS feat-038-stl.test.ts 同 deterministic 输入) → 喂 Python
statsmodels.tsa.seasonal.STL(period=168) → 输出 trend / seasonal / residual 序列到 JSON →
TS 侧 `feat-038-stl-fixture-vs-statsmodels.test.ts` 读 JSON 跟自家 stlDecompose 输出做
per-point relative diff，验证均值 ≤ 5%。

设计约束：fixture 是 BUILD-TIME 工件 · runtime 不依赖 statsmodels (109 dev server 可能没装 ·
也不该在 mcp 运行时引 Python)。结果 commit 进仓 fixtures/feat-038-stl-statsmodels.json ·
重生成只在算法或合成数据变化时执行。

用法:
    python3 scripts/feat-038-statsmodels-fixture.py \
        --out landing/mcp-src/__tests__/fixtures/feat-038-stl-statsmodels.json

依赖: pip3 install --user statsmodels numpy
"""
from __future__ import annotations
import argparse
import json
import math
import os
import sys

try:
    import numpy as np
    from statsmodels.tsa.seasonal import STL
except ImportError:
    print(
        "ERROR: 缺 numpy / statsmodels — pip3 install --user statsmodels numpy",
        file=sys.stderr,
    )
    sys.exit(2)


def build_drifting_series(n: int = 720) -> list[float]:
    """跟 TS feat-038-stl.test.ts buildDriftingSeries() 完全一致 deterministic 输入。

    trend = 100 → 500 跨 30d (slope ≈ 13.3/day) + seasonal 周期 7d 振幅 10 + 微噪声.
    """
    samples_per_day = 24
    seasonal_period = 7 * samples_per_day  # 168.
    series = []
    for i in range(n):
        day_idx = i / samples_per_day
        trend = 100 + (400 * day_idx) / 30
        seasonal = 10 * math.sin((2 * math.pi * i) / seasonal_period)
        noise = 1.5 * math.sin(i * 0.7)
        series.append(trend + seasonal + noise)
    return series


def build_flat_series(n: int = 720) -> list[float]:
    """跟 TS buildNoisySeries() 一致 · 围绕 100 的纯噪声 (no trend)."""
    series = []
    for i in range(n):
        noise = 5 * math.sin(i * 0.41) + 3 * math.cos(i * 1.13)
        series.append(100 + noise)
    return series


def run_statsmodels_stl(samples: list[float], period: int) -> dict:
    """跑 statsmodels.tsa.seasonal.STL · 返回 {trend, seasonal, residual} 序列."""
    arr = np.array(samples, dtype=float)
    # period=168 (7d @ 1h bucket) · 跟 TS DEFAULT_STL_OPTS.seasonalPeriod 一致.
    # seasonal=7 是 seasonal LOESS 窗口 (≥7 推荐) · 简化版 TS 不用 LOESS 用周期均值 ·
    # 这里 statsmodels 用默认 robust=False · LOESS 平滑.
    stl_result = STL(arr, period=period, robust=False).fit()
    return {
        "trend": stl_result.trend.tolist(),
        "seasonal": stl_result.seasonal.tolist(),
        "residual": stl_result.resid.tolist(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        required=True,
        help="JSON fixture 输出路径 (commit 进仓 · build-time 工件).",
    )
    args = parser.parse_args()

    fixture = {
        "_meta": {
            "generated_by": "scripts/feat-038-statsmodels-fixture.py",
            "design_ref": "feat-038 §7 case 5",
            "statsmodels_version": __import__("statsmodels").__version__,
            "numpy_version": np.__version__,
            "note": (
                "build-time artifact · runtime 不依赖 statsmodels · "
                "重生成时机：算法或合成 series 变化时."
            ),
        },
        "cases": [
            {
                "name": "drifting_100_to_500_30d",
                "period": 168,
                "samples": build_drifting_series(720),
                "expected": run_statsmodels_stl(build_drifting_series(720), 168),
            },
            {
                "name": "flat_noisy",
                "period": 168,
                "samples": build_flat_series(720),
                "expected": run_statsmodels_stl(build_flat_series(720), 168),
            },
        ],
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {args.out} · {len(fixture['cases'])} cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
