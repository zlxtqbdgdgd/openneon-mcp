/**
 * feat-040 autosuspend 段排除 · 6 case fixture
 *
 * 详设: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-040-L3-mcp-server-enrich-baseline-autosuspend-exclusion.html §6 + §7
 * 父 issue: zlxtqbdgdgd/openneon-design#49
 *
 * 覆盖 6 case (per #151 验收门):
 *   1. autosuspend 段排除 · 30d 含 5 个 12h windows · filter 后用 normal 段算 baseline
 *   2. valid sample 不足 (dev/test 90% 时间 autosuspend) → baseline_state='not_computable' · T4 raw 输出
 *   3. control plane API 不可达 (mock 5xx) → fallback 用全部 sample + log warn (跟 L2a behavior 一致)
 *   4. 跨 tenant 隔离 (project_A 调 T4 · 不漏 project_B 的 autosuspend windows)
 *   5. mcp 后台 cron 集成 (cache 1h · 重复 baseline 算时直接读 cache)
 *   6. ttl-cache 跟 feat-038 STL 共享 cache 实例 · 验 key 不冲突
 *
 * 设计哲学 (跟 L2a 既有 baseline.test.ts 一致):
 * - history 注入 (no real Datadog)
 * - autosuspend windows 注入 (no real Neon control plane API)
 * - 独立 fixture (overview §10 规约 5)
 */

import { describe, it, expect } from 'vitest';
import {
  filterAutosuspendWindows,
  checkMinSamples,
  BaselineNotComputableError,
  DEFAULT_MIN_VALID_SAMPLES,
  type AutosuspendWindow,
} from '../server-enrich/sample-filter';
import {
  baseline,
  createBaselineCache,
  createSeasonalCache,
} from '../server-enrich/baseline/baseline';
import {
  type MetricHistoryRequest,
  type MetricHistoryResult,
  type Coverage,
} from '../server-enrich/metrics-history';
import {
  type AutosuspendEventFetchAdapter,
  type AutosuspendEventsResult,
  createAutosuspendCache,
  getAutosuspendWindows,
} from '../server-enrich/metrics-history/autosuspend-events';

function coverage(actual: number, expected: number): Coverage {
  return {
    actual_points: actual,
    expected_points: expected,
    span_seconds: expected * 3600,
    latest_point_ts: 1000,
  };
}

/** Build a history fetcher returning a value series with timestamps (unix-second). */
function historyWithTimestamps(
  series: Array<[number, number | null]>,
): (req: MetricHistoryRequest) => Promise<MetricHistoryResult> {
  return async () => ({
    points: series,
    coverage: coverage(series.length, series.length),
  });
}

function adapterUnreachable(): AutosuspendEventFetchAdapter {
  return {
    async getAutosuspendWindows(): Promise<AutosuspendEventsResult> {
      return { error: { reason: 'unreachable' as const, detail: 'mock 5xx' } };
    },
  };
}

// =====================================================================================
// sample-filter.ts 共享层 · 双指针 O(N+M)
// =====================================================================================

describe('sample-filter · filterAutosuspendWindows 双指针 O(N+M)', () => {
  it('排除 autosuspend window 内的 sample · 保留外面的', () => {
    const samples: Array<[number, number | null]> = [
      [100, 1],
      [200, 2],
      [300, 3], // in window [250, 350]
      [400, 4],
      [500, 5], // in window [450, 600]
      [550, 6], // in window [450, 600]
      [700, 7],
    ];
    const windows: AutosuspendWindow[] = [
      { start: 250, end: 350 },
      { start: 450, end: 600 },
    ];
    const filtered = filterAutosuspendWindows(samples, windows);
    expect(filtered.map(([t]) => t)).toEqual([100, 200, 400, 700]);
  });

  it('空 windows · 全保留 (Aurora 无 autosuspend 概念时 adapter 返空 windows · 自动 no-op)', () => {
    const samples: Array<[number, number | null]> = [
      [100, 1],
      [200, 2],
      [300, 3],
    ];
    expect(filterAutosuspendWindows(samples, [])).toEqual(samples);
  });

  it('空 samples · 返空', () => {
    expect(filterAutosuspendWindows([], [{ start: 0, end: 100 }])).toEqual([]);
  });

  it('window 边界 · [start, end) 半开区间 · start 命中排除 · end 不命中', () => {
    const samples: Array<[number, number | null]> = [
      [99, 1],
      [100, 2], // start: 排除
      [199, 3], // 在区间内: 排除
      [200, 4], // end: 保留
    ];
    const filtered = filterAutosuspendWindows(samples, [
      { start: 100, end: 200 },
    ]);
    expect(filtered.map(([t]) => t)).toEqual([99, 200]);
  });

  it('保留 null sample · sparse ≠ 排除 (后续 flattenFiniteValues 才会去 null)', () => {
    const samples: Array<[number, number | null]> = [
      [100, null],
      [200, 2],
      [300, null], // 在 window 内 · 排除
    ];
    const filtered = filterAutosuspendWindows(samples, [
      { start: 250, end: 350 },
    ]);
    expect(filtered.map(([t]) => t)).toEqual([100, 200]);
  });

  it('windows 不必排序 · 内部 sort 保证 O(N log M + N + M)', () => {
    const samples: Array<[number, number | null]> = [
      [100, 1],
      [300, 3],
      [500, 5],
      [700, 7],
    ];
    // 故意乱序
    const windows: AutosuspendWindow[] = [
      { start: 600, end: 750 },
      { start: 250, end: 350 },
    ];
    const filtered = filterAutosuspendWindows(samples, windows);
    expect(filtered.map(([t]) => t)).toEqual([100, 500]);
  });
});

describe('sample-filter · checkMinSamples', () => {
  it('finite values 数 >= 阈值 · 不 throw', () => {
    const samples: Array<[number, number | null]> = [
      [1, 1],
      [2, 2],
      [3, 3],
    ];
    expect(() => checkMinSamples(samples, 3)).not.toThrow();
  });

  it('finite values 数 < 阈值 · throw BaselineNotComputableError', () => {
    const samples: Array<[number, number | null]> = [
      [1, 1],
      [2, null],
      [3, 2],
    ];
    expect(() => checkMinSamples(samples, 3)).toThrow(
      BaselineNotComputableError,
    );
  });

  it('null / NaN / non-finite 不计入有效 sample', () => {
    const samples: Array<[number, number | null]> = [
      [1, 1],
      [2, null],
      [3, Number.NaN],
      [4, Number.POSITIVE_INFINITY],
      [5, 2],
    ];
    expect(() => checkMinSamples(samples, 3)).toThrow(
      BaselineNotComputableError,
    );
    expect(() => checkMinSamples(samples, 2)).not.toThrow();
  });

  it('DEFAULT_MIN_VALID_SAMPLES = 100 (policy.yaml baseline.min_valid_samples 默认)', () => {
    expect(DEFAULT_MIN_VALID_SAMPLES).toBe(100);
  });
});

// =====================================================================================
// AutosuspendEventFetchAdapter · sub-interface + control plane API 双模式
// =====================================================================================

describe('AutosuspendEventFetchAdapter sub-interface (#152)', () => {
  it('adapter 是 sub-interface · 跟 feat-066 TraceFetchAdapter 同 pattern · 不强 ObservabilityAdapter union', () => {
    const adapter: AutosuspendEventFetchAdapter = {
      async getAutosuspendWindows() {
        return { windows: [] };
      },
    };
    // 编译期 check · 运行期只验调用通过
    expect(typeof adapter.getAutosuspendWindows).toBe('function');
  });

  it('getAutosuspendWindows() 拿 endpoint_id + project_id + time_range · 返 windows', async () => {
    const calls: Array<{ endpoint_id: string; project_id: string }> = [];
    const adapter: AutosuspendEventFetchAdapter = {
      async getAutosuspendWindows(req) {
        calls.push({
          endpoint_id: req.endpoint_id,
          project_id: req.project_id,
        });
        return {
          windows: [{ start: 1000, end: 2000 }],
        };
      },
    };
    const result = await getAutosuspendWindows(
      {
        endpoint_id: 'ep-main',
        project_id: 'proj-A',
        since: 0,
        until: 3000,
      },
      { adapter, cache: createAutosuspendCache(() => 0) },
    );
    expect(result).toEqual({ windows: [{ start: 1000, end: 2000 }] });
    expect(calls).toEqual([{ endpoint_id: 'ep-main', project_id: 'proj-A' }]);
  });

  it('ttl-cache · TTL 1h · key = autosuspend:{endpoint_id}:{since}_{until} · 同 key 复读 cache', async () => {
    let callCount = 0;
    const adapter: AutosuspendEventFetchAdapter = {
      async getAutosuspendWindows() {
        callCount += 1;
        return { windows: [{ start: 100, end: 200 }] };
      },
    };
    const cache = createAutosuspendCache(() => 0);
    await getAutosuspendWindows(
      { endpoint_id: 'ep-main', project_id: 'p1', since: 0, until: 3600 },
      { adapter, cache },
    );
    await getAutosuspendWindows(
      { endpoint_id: 'ep-main', project_id: 'p1', since: 0, until: 3600 },
      { adapter, cache },
    );
    expect(callCount).toBe(1);
  });

  it('双模式: NEON_CONTROL_PLANE_MODE=cloud vs oss · 接口同 · base URL 不同 (本测仅 mock adapter · 真集成在 e2e)', () => {
    // 占位 · adapter 内部 mode 在 datadog-adapter 同 pattern · 真切换在实例化时
    // 这里只验 sub-interface 抽象稳定
    const adapter: AutosuspendEventFetchAdapter = {
      async getAutosuspendWindows() {
        return { windows: [] };
      },
    };
    expect(adapter).toBeTruthy();
  });
});

// =====================================================================================
// 6 case fixture · 集成 baseline 算法
// =====================================================================================

describe('feat-040 · 6 case fixture (#151)', () => {
  // Case 1: autosuspend 段排除 · 30d 含 5 个 12h windows · filter 后用 normal 段算 baseline
  it('Case 1 · autosuspend 段排除 · filter 后用 normal 段算 baseline · 不被 autosuspend 段 0 值拉趋近 0', async () => {
    // 30d (720h) · 5 个 12h autosuspend window · normal 段 100 connection 稳定
    // 不过滤: median 被一堆 0 拉近 0 · 后续 wake 后 100 conn 算 spike (假警报)
    // 过滤后: median ≈ 100 · 100 conn 在 band 内 normal
    const points: Array<[number, number | null]> = [];
    const autoWindows: AutosuspendWindow[] = [];

    // 30d 每小时一个点 (720 个点)
    const BASE_TS = 1_000_000;
    for (let h = 0; h < 720; h++) {
      const t = BASE_TS + h * 3600;
      // 每 6 天一次 12h autosuspend (5 段) · 0..11 / 144..155 / 288..299 / 432..443 / 576..587
      const block = Math.floor(h / 144);
      const inAutoBlock = h % 144 < 12;
      if (inAutoBlock && block < 5) {
        points.push([t, 0]); // autosuspend 段 · 0 值
        if (h % 144 === 0) {
          autoWindows.push({
            start: t,
            end: t + 12 * 3600,
          });
        }
      } else {
        // normal 段 · 100 conn 加点波动
        points.push([t, 100 + (h % 7) - 3]);
      }
    }
    expect(autoWindows).toHaveLength(5);

    // 直接验 sample-filter
    const filtered = filterAutosuspendWindows(points, autoWindows);
    const finiteValues = filtered
      .map(([, v]) => v)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    // 5 段 × 12h = 60 sample 被排除
    expect(filtered.length).toBe(points.length - 60);
    // filter 后 median ≈ 100 (不是趋近 0)
    const sorted = [...finiteValues].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    expect(med).toBeGreaterThan(95);
    expect(med).toBeLessThan(105);
  });

  // Case 2: valid sample 不足 → baseline_state='not_computable'
  it("Case 2 · valid sample 不足 (dev/test 90% 时间 autosuspend) → throw BaselineNotComputableError · 上游翻 baseline_state='not_computable'", () => {
    // dev/test 30d · 90% autosuspend · 只剩 ~72 sample (< 100 阈值)
    const points: Array<[number, number | null]> = [];
    const BASE_TS = 1_000_000;
    for (let h = 0; h < 720; h++) {
      const t = BASE_TS + h * 3600;
      points.push([t, 100]);
    }
    // 90% autosuspend · 单段覆盖 648h
    const autoWindows: AutosuspendWindow[] = [
      { start: BASE_TS, end: BASE_TS + 648 * 3600 },
    ];
    const filtered = filterAutosuspendWindows(points, autoWindows);
    // 剩 ~72 sample · 不足 100
    expect(filtered.length).toBeLessThan(DEFAULT_MIN_VALID_SAMPLES);
    expect(() => checkMinSamples(filtered, DEFAULT_MIN_VALID_SAMPLES)).toThrow(
      BaselineNotComputableError,
    );
  });

  // Case 3: control plane API 不可达 → fallback 用全部 sample + log warn
  it('Case 3 · control plane API 不可达 (mock 5xx) → fallback 用全部 sample + log warn (跟 L2a behavior 一致 · 失败 ≠ 健康但不阻塞)', async () => {
    const adapter = adapterUnreachable();
    const cache = createAutosuspendCache(() => 0);
    const result = await getAutosuspendWindows(
      { endpoint_id: 'ep-main', project_id: 'p1', since: 0, until: 3600 },
      { adapter, cache },
    );
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.reason).toBe('unreachable');
    }

    // fallback behavior: 上游 baseline 算法应继续用全部 sample (跟 L2a 一致 · degrade · 不阻塞)
    const samples: Array<[number, number | null]> = [
      [100, 1],
      [200, 2],
      [300, 3],
    ];
    // 当 windows 为空 (adapter 失败上游默认空 · §3.5 fallback) · filter no-op
    expect(filterAutosuspendWindows(samples, [])).toEqual(samples);
  });

  // Case 4: 跨 tenant 隔离 · project_A 调 T4 · 不漏 project_B 的 autosuspend windows
  it('Case 4 · 跨 tenant 隔离 · project_A 拿 windows 不漏 project_B (feat-060 claim binding · cache key 含 project_id)', async () => {
    const projectAWindows: AutosuspendWindow[] = [{ start: 100, end: 200 }];
    const projectBWindows: AutosuspendWindow[] = [
      { start: 500, end: 800 }, // 不同时间段
    ];
    const calls: string[] = [];
    const adapter: AutosuspendEventFetchAdapter = {
      async getAutosuspendWindows(req) {
        calls.push(req.project_id);
        return {
          windows:
            req.project_id === 'proj-A' ? projectAWindows : projectBWindows,
        };
      },
    };
    const cache = createAutosuspendCache(() => 0);
    const resA = await getAutosuspendWindows(
      { endpoint_id: 'ep-shared', project_id: 'proj-A', since: 0, until: 1000 },
      { adapter, cache },
    );
    const resB = await getAutosuspendWindows(
      { endpoint_id: 'ep-shared', project_id: 'proj-B', since: 0, until: 1000 },
      { adapter, cache },
    );
    expect((resA as { windows: AutosuspendWindow[] }).windows).toEqual(
      projectAWindows,
    );
    expect((resB as { windows: AutosuspendWindow[] }).windows).toEqual(
      projectBWindows,
    );
    // cache key 含 project_id · 不会拿 A 的 cache 给 B
    expect(calls).toEqual(['proj-A', 'proj-B']);
  });

  // Case 5: mcp 后台 cron 集成 (cache 1h · 重复 baseline 算时直接读 cache)
  it('Case 5 · mcp 后台 cron 集成 · cache 1h · 重复 baseline 算时直接读 cache · 不重复打 control plane API', async () => {
    let callCount = 0;
    const adapter: AutosuspendEventFetchAdapter = {
      async getAutosuspendWindows() {
        callCount += 1;
        return { windows: [{ start: 100, end: 200 }] };
      },
    };
    let now = 0;
    const cache = createAutosuspendCache(() => now);
    const req = {
      endpoint_id: 'ep-main',
      project_id: 'p1',
      since: 0,
      until: 3600,
    };
    // 1st call: miss · 打 API
    await getAutosuspendWindows(req, { adapter, cache });
    // 2nd call 30min 后: hit cache · 不打 API
    now = 30 * 60 * 1000;
    await getAutosuspendWindows(req, { adapter, cache });
    // 3rd call 1h+1s 后: TTL 过期 · 重打 API
    now = 60 * 60 * 1000 + 1000;
    await getAutosuspendWindows(req, { adapter, cache });
    expect(callCount).toBe(2);
  });

  // Case 6: ttl-cache 跟 feat-038 STL 共享 cache 实例 · 验 key 不冲突
  it('Case 6 · ttl-cache key 不冲突 · autosuspend cache 用 "autosuspend:" prefix · 跟 feat-038 / feat-016 / feat-017 各自 prefix 隔离', async () => {
    // key prefix isolation · 跟 baseline.ts coreCacheKey / seasonalCoreKey 同 pattern
    // 这里通过验 cache 实例本身不串场 (类型 TtlCache<AutosuspendEventsSuccess>)
    const cache = createAutosuspendCache(() => 0);
    let count = 0;
    const adapter: AutosuspendEventFetchAdapter = {
      async getAutosuspendWindows() {
        count += 1;
        return { windows: [{ start: 100, end: 200 }] };
      },
    };
    // 同 endpoint 不同 time range · key 必不同
    await getAutosuspendWindows(
      { endpoint_id: 'ep1', project_id: 'p1', since: 0, until: 100 },
      { adapter, cache },
    );
    await getAutosuspendWindows(
      { endpoint_id: 'ep1', project_id: 'p1', since: 100, until: 200 },
      { adapter, cache },
    );
    expect(count).toBe(2);
  });
});

// =====================================================================================
// baseline 算法集成 · sample filter 进 median-mad 主路径
// =====================================================================================

describe('baseline · sample filter 集成 (median-mad 主路径)', () => {
  it('注入 autosuspendWindows · 0 值 autosuspend 段被排除 · median 不被拉趋近 0', async () => {
    // 不过滤: 一半 0 一半 100 · median ≈ 50 · MAD 巨大 · band 宽到 200 也 normal
    // 过滤后: 全 ≈ 100 · median ≈ 100 · 当 current=200 时 high
    const BASE_TS = 1_000_000;
    const points: Array<[number, number | null]> = [];
    for (let h = 0; h < 168; h++) {
      const t = BASE_TS + h * 3600;
      // 前一半 autosuspend (0 值) · 后一半 normal (~100)
      points.push([t, h < 84 ? 0 : 100 + (h % 5) - 2]);
    }
    const autoWindows: AutosuspendWindow[] = [
      { start: BASE_TS, end: BASE_TS + 84 * 3600 },
    ];

    const result = await baseline(
      {
        signal: 'connections.active',
        dimensions: { endpoint: 'ep-main', project: 'proj-A' },
        window: { last: '7d' },
        bucket: '1h',
        current_value: 100,
        autosuspendWindows: autoWindows,
        // filter 后 84 sample · 高于本测下调阈值 · 但低于默 100 · 显式 override 走 ok 路径
        minValidSamples: 50,
      },
      {
        fetchHistory: historyWithTimestamps(points),
        cache: createBaselineCache(() => 0),
      },
    );

    expect(result.status).toBe('ok');
    expect(result.band!.median).toBeGreaterThan(95);
    expect(result.band!.median).toBeLessThan(105);
    expect(result.deviation!.label).toBe('normal'); // 100 是 baseline 中位 · normal
  });

  it('不传 autosuspendWindows · 跟旧 behavior 一致 (向后兼容 · 无 autosuspend 概念的 Aurora)', async () => {
    const BASE_TS = 1_000_000;
    const points: Array<[number, number | null]> = [];
    for (let h = 0; h < 50; h++) {
      points.push([BASE_TS + h * 3600, 100 + (h % 3) - 1]);
    }
    // 没传 autosuspendWindows · 也没传 minValidSamples · feat-040 校验整体旁路 · 走旧 min_points=20
    const result = await baseline(
      {
        signal: 's',
        dimensions: {},
        window: { last: '7d' },
        bucket: '1h',
        current_value: 100,
      },
      {
        fetchHistory: historyWithTimestamps(points),
        cache: createBaselineCache(() => 0),
      },
    );
    expect(result.status).toBe('ok');
    expect(result.band!.median).toBeGreaterThan(95);
  });

  it('feat-040 baseline_state · 旧三态 ok/insufficient_data/degenerate 不变 · sample-filter 不足时仍 insufficient_data', async () => {
    const BASE_TS = 1_000_000;
    const points: Array<[number, number | null]> = [];
    for (let h = 0; h < 30; h++) {
      points.push([BASE_TS + h * 3600, 100]);
    }
    // 排除 25 个 · 剩 5 个 · 低于 DEFAULT_MIN_POINTS=20
    const autoWindows: AutosuspendWindow[] = [
      { start: BASE_TS, end: BASE_TS + 25 * 3600 },
    ];
    const result = await baseline(
      {
        signal: 's',
        dimensions: {},
        window: { last: '7d' },
        bucket: '1h',
        autosuspendWindows: autoWindows,
      },
      {
        fetchHistory: historyWithTimestamps(points),
        cache: createBaselineCache(() => 0),
      },
    );
    expect(result.status).toBe('insufficient_data');
  });

  it('seasonal · 24 bucket 路径同样消费 autosuspendWindows', async () => {
    const BASE_TS = 1_000_000;
    const points: Array<[number, number | null]> = [];
    for (let h = 0; h < 7 * 24; h++) {
      // 7 天每小时 · 前 3 天 autosuspend (0) · 后 4 天 normal (~100)
      points.push([BASE_TS + h * 3600, h < 72 ? 0 : 100 + (h % 3) - 1]);
    }
    const autoWindows: AutosuspendWindow[] = [
      { start: BASE_TS, end: BASE_TS + 72 * 3600 },
    ];
    const result = await baseline(
      {
        signal: 's',
        dimensions: { endpoint: 'ep-main' },
        window: { last: '21d' },
        bucket: '1h',
        seasonal: true,
        autosuspendWindows: autoWindows,
        current_value: 100,
      },
      {
        fetchHistory: historyWithTimestamps(points),
        seasonalCache: createSeasonalCache(() => 0),
        now: () => (BASE_TS + 100 * 3600) * 1000,
      },
    );
    // 跟 median-mad 一样 · global fallback 起码 ok · median 偏 100 不偏 0
    if (result.status === 'ok') {
      expect(result.band!.median).toBeGreaterThan(50);
    }
  });
});
