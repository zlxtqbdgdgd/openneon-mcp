/**
 * feat-037/#3 · path-router 主备切换 + fallback unit tests · openneon-mcp#158.
 *
 * 验收门:
 *   1. 50K token 阈值切换 · auto path 决策正确
 *   2. agent override · force=main / backup / auto
 *   3. force=main + input > 200K → ForceMainOverLimitError
 *   4. 主路径 LLM 失败 → fallback Drain3 + fallback_reason
 *   5. ttl-cache 命名空间 · 主备分桶 · 不互相 contaminate
 *   6. cache hit · ongoing 1h / closed 24h
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  routeAndCluster,
  resetRouterCache,
  buildCacheKey,
  estimateLines,
  ForceMainOverLimitError,
  PATH_ROUTER_AUTO_THRESHOLD_TOKENS,
} from '../server-enrich/pattern/path-router';
import {
  setLlmClient,
  resetLlmClient,
} from '../server-enrich/rca/llm-client';
import {
  genStandardLogs,
  genLogsByTokenSize,
  MOCK_LLM_OUTPUT_OPUS,
} from './fixtures/feat-037-cluster-cases';

describe('feat-037/#3 · auto-path threshold (50K token)', () => {
  beforeEach(() => {
    resetRouterCache();
    resetLlmClient();
  });
  afterEach(() => resetLlmClient());

  it('routes small input (< 50K tokens) to main when LLM is configured', async () => {
    setLlmClient({
      call: async () => ({
        text: MOCK_LLM_OUTPUT_OPUS,
        inputTokens: 1200,
        outputTokens: 800,
        model: 'claude-opus-4-7',
      }),
    });
    const payload = await routeAndCluster({
      endpointId: 'ep-1',
      lines: genStandardLogs(50),
      cache: false,
    });
    expect(payload.router.decision).toBe('main');
    expect(payload.router.reason).toBe('auto_under_threshold');
    expect(payload.model).toBe('claude-opus-4-7');
  });

  it('routes large input (> 50K tokens) to backup', async () => {
    const big = genLogsByTokenSize(80_000);
    const payload = await routeAndCluster({
      endpointId: 'ep-1',
      lines: big,
      cache: false,
    });
    expect(payload.router.decision).toBe('backup');
    expect(payload.router.reason).toBe('auto_over_threshold');
    expect(payload.model).toBeNull();
    // backup 跑 Drain3 → cluster 必须出
    expect(payload.cluster.patterns.length).toBeGreaterThan(0);
  });

  it('estimateLines roughly matches expected size', () => {
    const lines = genLogsByTokenSize(50_000);
    const est = estimateLines(lines);
    // ±30% 容差 · per-line overhead 16 chars + prefix 估算误差
    expect(est).toBeGreaterThan(40_000);
    expect(est).toBeLessThan(70_000);
  });
});

describe('feat-037/#3 · force_path override', () => {
  beforeEach(() => {
    resetRouterCache();
    resetLlmClient();
  });
  afterEach(() => resetLlmClient());

  it('force=backup skips LLM entirely · 0 input/output tokens', async () => {
    setLlmClient({
      call: async () => {
        throw new Error('LLM should not be called when force=backup');
      },
    });
    const payload = await routeAndCluster({
      endpointId: 'ep-1',
      lines: genStandardLogs(5),
      forcePath: 'backup',
      cache: false,
    });
    expect(payload.router.decision).toBe('backup');
    expect(payload.router.reason).toBe('force_backup');
    expect(payload.input_tokens).toBe(0);
    expect(payload.output_tokens).toBe(0);
  });

  it('force=main calls LLM even when input over 50K', async () => {
    setLlmClient({
      call: async () => ({
        text: MOCK_LLM_OUTPUT_OPUS,
        inputTokens: 60_000,
        outputTokens: 800,
        model: 'claude-opus-4-7',
      }),
    });
    const payload = await routeAndCluster({
      endpointId: 'ep-1',
      lines: genLogsByTokenSize(80_000),
      forcePath: 'main',
      cache: false,
    });
    expect(payload.router.decision).toBe('main');
    expect(payload.router.reason).toBe('force_main');
  });

  it('force=main + input > 200K throws ForceMainOverLimitError', async () => {
    const huge = genLogsByTokenSize(250_000);
    await expect(
      routeAndCluster({
        endpointId: 'ep-1',
        lines: huge,
        forcePath: 'main',
        cache: false,
      }),
    ).rejects.toBeInstanceOf(ForceMainOverLimitError);
  });
});

describe('feat-037/#3 · fallback from main to backup', () => {
  beforeEach(() => {
    resetRouterCache();
    resetLlmClient();
  });
  afterEach(() => resetLlmClient());

  it('falls back to Drain3 when LLM returns rate_limited (auto path)', async () => {
    setLlmClient({
      call: async () => ({
        error: { reason: 'rate_limited', detail: '429 throttle' },
      }),
    });
    const payload = await routeAndCluster({
      endpointId: 'ep-1',
      lines: genStandardLogs(20),
      cache: false,
    });
    expect(payload.router.decision).toBe('backup');
    expect(payload.router.reason).toBe('fallback_from_main');
    expect(payload.router.fallback_reason).toContain('llm_rate_limited');
    expect(payload.cluster.patterns.length).toBeGreaterThan(0);
  });

  it('does NOT fallback when force=main · throws instead', async () => {
    setLlmClient({
      call: async () => ({
        error: { reason: 'rate_limited', detail: '429' },
      }),
    });
    await expect(
      routeAndCluster({
        endpointId: 'ep-1',
        lines: genStandardLogs(5),
        forcePath: 'main',
        cache: false,
      }),
    ).rejects.toThrow(/refuse to fallback/);
  });

  it('does not cache the fallback result (avoids固化 degrade state)', async () => {
    setLlmClient({
      call: async () => ({ error: { reason: 'rate_limited' } }),
    });
    const a = await routeAndCluster({
      endpointId: 'ep-1',
      lines: genStandardLogs(5),
      cache: true,
    });
    // 第二次仍走真实路径 (cache miss · 因为 fallback 不入 cache)
    const b = await routeAndCluster({
      endpointId: 'ep-1',
      lines: genStandardLogs(5),
      cache: true,
    });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false);
  });
});

describe('feat-037/#3 · cache namespace (§3.5)', () => {
  beforeEach(() => {
    resetRouterCache();
    resetLlmClient();
  });

  it('main/backup buckets are isolated · key includes decision', () => {
    const mainKey = buildCacheKey({
      decision: 'main',
      endpointId: 'ep-1',
      model: 'claude-opus-4-7',
    });
    const backupKey = buildCacheKey({
      decision: 'backup',
      endpointId: 'ep-1',
    });
    expect(mainKey).not.toBe(backupKey);
    expect(mainKey).toContain(':main:');
    expect(backupKey).toContain(':backup:');
  });

  it('key encodes endpoint / time_range / trace_id / severity / model', () => {
    const k = buildCacheKey({
      decision: 'main',
      endpointId: 'ep-9',
      timeRange: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      traceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      severityFilter: ['ERROR', 'FATAL'],
      model: 'claude-sonnet-4-6',
    });
    expect(k).toContain('cluster_logs:main:ep-9');
    expect(k).toContain('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(k).toContain('claude-sonnet-4-6');
  });

  it('cache hit second call · cached=true · same result', async () => {
    let llmCallCount = 0;
    setLlmClient({
      call: async () => {
        llmCallCount += 1;
        return {
          text: MOCK_LLM_OUTPUT_OPUS,
          inputTokens: 1200,
          outputTokens: 800,
          model: 'claude-opus-4-7',
        };
      },
    });
    const first = await routeAndCluster({
      endpointId: 'ep-cache',
      lines: genStandardLogs(50),
      cache: true,
    });
    const second = await routeAndCluster({
      endpointId: 'ep-cache',
      lines: genStandardLogs(50),
      cache: true,
    });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(llmCallCount).toBe(1);
  });
});
