/**
 * feat-038/#3 · T4 enrich 5 字段集成 · ttl-cache + signal-registry 元数据.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-038-L3-mcp-server-enrich-baseline-stl.html §3.5 + §4.1
 *
 * 覆盖 §7 fixture 5 case 中 T4 集成侧 + signal-registry 元数据契约：
 *   - cache 命中 → 5 字段拼到 HealthSignal · status 切换规则 (is_drifting + rising/falling → anomalous).
 *   - cache 命中 < 5ms (token economy + p99 §5).
 *   - cache miss → 5 字段全 null (degrade · 不阻塞 T4 · 详设 §3.5).
 *   - signal-registry 元数据：每条 baseline_applicable signal 都登记 enrich_fields 字段名.
 *   - dimensions={endpoint: 'main'} → cache key 含 endpoint id (跨 tenant 安全).
 *
 * 跟 health-signals.ts 既有 feat-016/017/018 enrich 同 pattern (mock baseline · mock sql · 注入 cache).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  stlCacheKey,
  STL_CACHE_TTL_MS,
} from '../server-enrich/baseline/stl-cron';
import { TtlCache } from '../server-enrich/ttl-cache';
import type { StlEnrich } from '../server-enrich/baseline/stl';
import {
  SIGNAL_REGISTRY,
  type SignalDef,
} from '../tools/signal-registry';

const mockSqlQuery = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => ({ query: mockSqlQuery })),
}));

vi.mock('../tools/handlers/connection-string', () => ({
  handleGetConnectionString: vi.fn().mockResolvedValue({
    uri: 'postgresql://u:p@host/db',
    computeId: 'ep-mock',
  }),
}));

vi.mock('@sentry/node', () => ({
  startSpan: vi.fn((_opts, fn) => fn()),
}));

const mockBaseline = vi.fn();
vi.mock('../server-enrich/baseline/baseline', () => ({
  baseline: (...args: unknown[]) => mockBaseline(...args),
}));

const mockSloBurnRate = vi.fn();
vi.mock('../server-enrich/baseline/slo-burn-rate', async () => {
  const actual = await vi.importActual<
    typeof import('../server-enrich/baseline/slo-burn-rate')
  >('../server-enrich/baseline/slo-burn-rate');
  return {
    ...actual,
    sloBurnRate: (...args: unknown[]) => mockSloBurnRate(...args),
  };
});

// 全局可注入 STL cache · 让测试控 cache 命中.
let testStlCache: TtlCache<StlEnrich>;
vi.mock('../server-enrich/baseline/stl-cache-singleton', () => ({
  getStlCache: () => testStlCache,
  resetStlCache: () => {
    testStlCache = new TtlCache<StlEnrich>();
  },
}));

import { handleGetHealthSignals } from '../tools/handlers/health-signals';
import type { ToolHandlerExtraParams } from '../tools/types';

const mockNeonClient = {} as unknown as Parameters<
  typeof handleGetHealthSignals
>[1];
const mockExtra = { account: undefined } as unknown as ToolHandlerExtraParams;

const driftingEnrich: StlEnrich = {
  is_drifting: true,
  trend_slope: 3.3,
  trend_direction: 'rising',
  drift_window_days: 30,
  drift_confidence: 0.92,
};

const flatEnrich: StlEnrich = {
  is_drifting: false,
  trend_slope: 0.01,
  trend_direction: 'flat',
  drift_window_days: 0,
  drift_confidence: 0.1,
};

beforeEach(() => {
  mockSqlQuery.mockReset();
  mockBaseline.mockReset();
  mockSloBurnRate.mockReset();
  testStlCache = new TtlCache<StlEnrich>();
  // 默认 baseline / slo "insufficient_data" · 避免影响 STL 验证.
  mockBaseline.mockResolvedValue({
    status: 'insufficient_data',
    algo: null,
    coverage: {
      actual_points: 0,
      expected_points: 0,
      span_seconds: 0,
      latest_point_ts: null,
    },
  });
  mockSloBurnRate.mockResolvedValue({
    is_sli_burning: 'unknown',
    sli_value: null,
    slo_target: 0.99,
    burn_rate_1h: null,
    burn_rate_5m: null,
    error_budget_remaining: null,
  });
});

describe('feat-038/#3 · T4 enrich 5 字段集成 (cache hit)', () => {
  it('cache hit · is_drifting=true · rising → 5 字段都拼出来 + status 转 anomalous', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 500 }]); // connections current value
    testStlCache.set(
      stlCacheKey('main', 'connections'),
      driftingEnrich,
      STL_CACHE_TTL_MS,
    );

    const result = await handleGetHealthSignals(
      { projectId: 'p', dimensions: { endpoint: 'main' } },
      mockNeonClient,
      mockExtra,
    );

    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.is_drifting).toBe(true);
    expect(conn.trend_slope).toBeCloseTo(3.3, 5);
    expect(conn.trend_direction).toBe('rising');
    expect(conn.drift_window_days).toBe(30);
    expect(conn.drift_confidence).toBeCloseTo(0.92, 5);
    // is_drifting=true 翻 anomalous (跟 is_sli_burning 同语义).
    expect(conn.status).toBe('anomalous');
  });

  it('cache hit · is_drifting=false / flat → 5 字段拼出来 + status 保持 ok', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 50 }]);
    testStlCache.set(
      stlCacheKey('main', 'connections'),
      flatEnrich,
      STL_CACHE_TTL_MS,
    );

    const result = await handleGetHealthSignals(
      { projectId: 'p', dimensions: { endpoint: 'main' } },
      mockNeonClient,
      mockExtra,
    );
    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.is_drifting).toBe(false);
    expect(conn.trend_direction).toBe('flat');
    expect(conn.status).toBe('ok');
  });

  it('cache miss · 5 字段全 null · status 不变 (degrade 不阻塞 §3.5)', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 50 }]);
    // 不 set cache · 默认 miss.

    const result = await handleGetHealthSignals(
      { projectId: 'p', dimensions: { endpoint: 'main' } },
      mockNeonClient,
      mockExtra,
    );
    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.is_drifting).toBeNull();
    expect(conn.trend_slope).toBeNull();
    expect(conn.trend_direction).toBeNull();
    expect(conn.drift_window_days).toBeNull();
    expect(conn.drift_confidence).toBeNull();
    expect(conn.status).toBe('ok'); // baseline + slo 都没翻 anomalous · STL miss 也不翻.
  });

  it('cache key 含 dimensions.endpoint · 不同 endpoint 不混淆 (跨 tenant 安全)', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 99 }]);
    // 给 endpoint=other set drift · 但当前请求 endpoint=main · 应不命中.
    testStlCache.set(
      stlCacheKey('other', 'connections'),
      driftingEnrich,
      STL_CACHE_TTL_MS,
    );

    const result = await handleGetHealthSignals(
      { projectId: 'p', dimensions: { endpoint: 'main' } },
      mockNeonClient,
      mockExtra,
    );
    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.is_drifting).toBeNull();
  });

  it('dimensions 缺 endpoint · 用 projectId fallback · cache miss 时不报错 · 5 字段全 null', async () => {
    mockSqlQuery.mockResolvedValueOnce([{ value: 50 }]);

    const result = await handleGetHealthSignals(
      { projectId: 'p' },
      mockNeonClient,
      mockExtra,
    );
    const conn = result.find((s) => s.signal_type === 'connections')!;
    expect(conn.is_drifting).toBeNull();
  });

  it('p99 < 5ms · 100 次 cache hit · 单次平均 < 1ms (token economy / §5)', async () => {
    testStlCache.set(
      stlCacheKey('main', 'connections'),
      driftingEnrich,
      STL_CACHE_TTL_MS,
    );
    // 验 ttl-cache get 本身的速度 (不走完整 handler · 完整 handler 含 mock sql 不准).
    const N = 1000;
    const start = performance.now();
    for (let i = 0; i < N; i++) {
      testStlCache.get(stlCacheKey('main', 'connections'));
    }
    const elapsed = performance.now() - start;
    const perCallUs = (elapsed * 1000) / N;
    // < 50 microseconds per get (生产 p99 < 5ms 留 100x buffer).
    expect(perCallUs).toBeLessThan(50);
  });
});

describe('feat-038/#3 · signal-registry STL 元数据契约', () => {
  it('每条 baseline_applicable signal 都登记 stlEnrichApplicable 字段', () => {
    for (const def of SIGNAL_REGISTRY) {
      // 字段必须存在 (boolean).
      expect(typeof def.stlEnrichApplicable).toBe('boolean');
      // baseline_applicable=false 的 signal (storage_size_bytes monotonic) STL 也不适用.
      if (!def.baselineApplicable) {
        expect(def.stlEnrichApplicable).toBe(false);
      }
    }
  });

  it('signal-registry 的 STL enrich 字段名跟 StlEnrich 类型一致 (5 字段)', () => {
    // 确保字段名顺序 + 名字稳定 · agent 客户端可消费.
    const fields = (SIGNAL_REGISTRY[0] as SignalDef).stlEnrichFieldNames;
    expect(fields).toEqual([
      'is_drifting',
      'trend_slope',
      'trend_direction',
      'drift_window_days',
      'drift_confidence',
    ]);
  });
});
