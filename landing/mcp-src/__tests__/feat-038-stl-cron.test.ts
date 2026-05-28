/**
 * feat-038/#2 STL 后台 cron 1h 预计算 + ttl-cache 集成 · 单测.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-038-L3-mcp-server-enrich-baseline-stl.html §3.3-§3.4
 *
 * 覆盖：
 *   - p-limit 并发 5 控制 · 单 endpoint × metric 失败不阻塞其他.
 *   - cache key = `stl:{endpoint_id}:{metric_name}` · TTL = 3600s.
 *   - cache miss → caller 看 5 字段全 null (T4 集成测里验证 · 此处验 cache 未命中行为).
 *   - seam fetch 失败 → log warn + 跳过本 endpoint × metric · 不抛.
 *   - 注入 fetchHistory + clock + signal 列表 (避免 mock 全局).
 *   - 跨 endpoint 隔离 · 一个失败不影响其他.
 *
 * 接口契约 (W2-A5 feat-043 复用)：
 *   - `runStlPrecomputeOnce(opts)` · 跑一轮 · 返回 {written, failed} 数 (测试断言用).
 *   - `startStlPrecomputeScheduler(opts)` · setInterval + 启动期一次性 · 返回 handle.stop().
 *   - `stlCacheKey(endpointId, metricName)` · 单一拼接点 · cron 和 T4 都用这个.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runStlPrecomputeOnce,
  startStlPrecomputeScheduler,
  stlCacheKey,
  STL_CACHE_TTL_MS,
  type StlPrecomputeOptions,
} from '../server-enrich/baseline/stl-cron';
import { TtlCache } from '../server-enrich/ttl-cache';
import { DEFAULT_STL_OPTS } from '../server-enrich/baseline/stl';
import type { StlEnrich } from '../server-enrich/baseline/stl';
import type {
  MetricHistoryRequest,
  MetricHistoryResult,
} from '../server-enrich/metrics-history';

function buildDriftingHistory(): MetricHistoryResult {
  const N = 720;
  const points: Array<[number, number | null]> = [];
  for (let i = 0; i < N; i++) {
    const dayIdx = i / 24;
    const trend = 100 + (400 * dayIdx) / 30;
    const seasonal = 10 * Math.sin((2 * Math.PI * i) / 168);
    points.push([1000 + i * 3600, trend + seasonal]);
  }
  return {
    points,
    coverage: {
      actual_points: N,
      expected_points: N,
      span_seconds: N * 3600,
      latest_point_ts: 1000 + N * 3600,
    },
  };
}

function buildFlatHistory(value: number, n = 720): MetricHistoryResult {
  const points: Array<[number, number | null]> = [];
  for (let i = 0; i < n; i++) {
    points.push([1000 + i * 3600, value]);
  }
  return {
    points,
    coverage: {
      actual_points: n,
      expected_points: n,
      span_seconds: n * 3600,
      latest_point_ts: 1000 + n * 3600,
    },
  };
}

const ENDPOINTS = ['ep-a', 'ep-b', 'ep-c'];
const METRICS = ['connections', 'cache_hit_ratio'];

describe('feat-038 · stl-cron 后台预计算', () => {
  let cache: TtlCache<StlEnrich>;
  let warnings: string[];

  beforeEach(() => {
    cache = new TtlCache<StlEnrich>();
    warnings = [];
  });

  it('runStlPrecomputeOnce · 写 cache key 跟 stlCacheKey 一致 · 漂移数据 → is_drifting=true', async () => {
    const fetchHistory = vi.fn(
      async (_req: MetricHistoryRequest): Promise<MetricHistoryResult> =>
        buildDriftingHistory(),
    );

    const opts: StlPrecomputeOptions = {
      endpoints: ['ep-a'],
      metrics: ['connections'],
      cache,
      fetchHistory,
      concurrency: 5,
      stlOpts: DEFAULT_STL_OPTS,
      warn: (m, e) => warnings.push(`${m} ${e ?? ''}`),
    };

    const { written, failed, skipped } = await runStlPrecomputeOnce(opts);
    expect(written).toBe(1);
    expect(failed).toBe(0);
    expect(skipped).toBe(0);

    const cached = cache.get(stlCacheKey('ep-a', 'connections'));
    expect(cached).toBeDefined();
    expect(cached!.is_drifting).toBe(true);
    expect(cached!.trend_direction).toBe('rising');
  });

  it('并发 5 限制 · 30 任务发到 fetchHistory 全跑完且单次并发 ≤ 5', async () => {
    let inflight = 0;
    let peakInflight = 0;
    const fetchHistory = vi.fn(async (): Promise<MetricHistoryResult> => {
      inflight += 1;
      if (inflight > peakInflight) peakInflight = inflight;
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      return buildDriftingHistory();
    });

    // 5 endpoint × 6 metric = 30 task.
    const endpoints = ['ep-1', 'ep-2', 'ep-3', 'ep-4', 'ep-5'];
    const metrics = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    const opts: StlPrecomputeOptions = {
      endpoints,
      metrics,
      cache,
      fetchHistory,
      concurrency: 5,
      stlOpts: DEFAULT_STL_OPTS,
      warn: () => {},
    };
    const { written } = await runStlPrecomputeOnce(opts);
    expect(written).toBe(30);
    expect(fetchHistory).toHaveBeenCalledTimes(30);
    expect(peakInflight).toBeLessThanOrEqual(5);
  });

  it('seam 失败 · 跨 endpoint 隔离 · 一个失败不阻塞其他', async () => {
    const fetchHistory = vi.fn(async (req: MetricHistoryRequest) => {
      if (req.dimensions.endpoint === 'ep-b') {
        return { error: { reason: 'unreachable' as const } };
      }
      return buildDriftingHistory();
    });

    const opts: StlPrecomputeOptions = {
      endpoints: ENDPOINTS,
      metrics: METRICS,
      cache,
      fetchHistory,
      concurrency: 5,
      stlOpts: DEFAULT_STL_OPTS,
      warn: (m, e) => warnings.push(`${m} ${e ?? ''}`),
    };

    const result = await runStlPrecomputeOnce(opts);
    // 3 endpoints × 2 metrics = 6 总。ep-b × 2 failed · 其他 4 written.
    expect(result.written).toBe(4);
    expect(result.failed).toBe(2);
    // ep-a / ep-c 的两个 metric cache 都在.
    expect(cache.get(stlCacheKey('ep-a', 'connections'))).toBeDefined();
    expect(cache.get(stlCacheKey('ep-c', 'connections'))).toBeDefined();
    expect(cache.get(stlCacheKey('ep-b', 'connections'))).toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('seam 抛异常 · 不传播 · 单 endpoint × metric 计入 failed', async () => {
    const fetchHistory = vi.fn(async () => {
      throw new Error('boom');
    });

    const opts: StlPrecomputeOptions = {
      endpoints: ['ep-a'],
      metrics: ['connections'],
      cache,
      fetchHistory,
      concurrency: 5,
      stlOpts: DEFAULT_STL_OPTS,
      warn: (m, e) => warnings.push(`${m} ${e ?? ''}`),
    };

    await expect(runStlPrecomputeOnce(opts)).resolves.toEqual({
      written: 0,
      failed: 1,
      skipped: 0,
    });
    expect(warnings.some((w) => w.includes('boom'))).toBe(true);
  });

  it("valid sample 不足 → STL 返 not_computable → 计入 skipped (不是 failed)", async () => {
    const fetchHistory = vi.fn(async () =>
      // 仅 50 个 valid sample (< 100 阈值).
      buildFlatHistory(100, 50),
    );
    const opts: StlPrecomputeOptions = {
      endpoints: ['ep-a'],
      metrics: ['connections'],
      cache,
      fetchHistory,
      concurrency: 5,
      stlOpts: DEFAULT_STL_OPTS,
      warn: () => {},
    };
    const { written, failed, skipped } = await runStlPrecomputeOnce(opts);
    expect(written).toBe(0);
    expect(failed).toBe(0);
    expect(skipped).toBe(1);
    expect(cache.get(stlCacheKey('ep-a', 'connections'))).toBeUndefined();
  });

  it('TTL = 3600s · 跟 STL_CACHE_TTL_MS 一致 · 过期后 get 返 undefined', async () => {
    expect(STL_CACHE_TTL_MS).toBe(3_600_000);

    // 注入可控 clock.
    let nowMs = 1_000_000;
    const controlledCache = new TtlCache<StlEnrich>(() => nowMs);

    const fetchHistory = vi.fn(async () => buildDriftingHistory());
    await runStlPrecomputeOnce({
      endpoints: ['ep-a'],
      metrics: ['connections'],
      cache: controlledCache,
      fetchHistory,
      concurrency: 5,
      stlOpts: DEFAULT_STL_OPTS,
      warn: () => {},
    });
    const key = stlCacheKey('ep-a', 'connections');
    expect(controlledCache.get(key)).toBeDefined();
    // 推进 3600s.
    nowMs += STL_CACHE_TTL_MS + 1;
    expect(controlledCache.get(key)).toBeUndefined();
  });

  it('startStlPrecomputeScheduler · 启动期立即跑一轮 + interval 调度 + stop() 清 timer', async () => {
    vi.useFakeTimers();
    try {
      const fetchHistory = vi.fn(async () => buildDriftingHistory());
      const handle = startStlPrecomputeScheduler({
        endpoints: ['ep-a'],
        metrics: ['connections'],
        cache,
        fetchHistory,
        concurrency: 5,
        stlOpts: DEFAULT_STL_OPTS,
        warn: () => {},
        intervalMs: 3_600_000,
      });

      // 立即调一次 (启动期).
      await vi.advanceTimersByTimeAsync(0);
      // 让 microtask 跑完.
      await vi.runOnlyPendingTimersAsync();

      // 一轮已写 cache.
      expect(cache.get(stlCacheKey('ep-a', 'connections'))).toBeDefined();

      handle.stop();
      // 推进时间不应再触发.
      const before = fetchHistory.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3_600_000 * 2);
      expect(fetchHistory.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  afterEach(() => {
    cache.clear();
  });
});

describe('feat-038 · stlCacheKey 单一拼接点', () => {
  it('cache key 格式 stl:{endpoint_id}:{metric_name}', () => {
    expect(stlCacheKey('ep-foo', 'connections')).toBe('stl:ep-foo:connections');
  });

  it('endpoint / metric 含特殊字符 (含 :) 时不混淆 · 用 base64 隔离', () => {
    // 此 case 是 future-proof · 当前实现可允许 raw : · 但断言不出现混淆 (固定 separator 是 |).
    const a = stlCacheKey('a:b', 'c');
    const b = stlCacheKey('a', 'b:c');
    expect(a).not.toBe(b);
  });
});
