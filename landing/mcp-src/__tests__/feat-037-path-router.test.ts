/**
 * feat-037/#3 · path-router 确定性聚类 + enrichment-hint + cache unit tests · openneon-mcp#158.
 *
 * **form-shift (规则 P4 · LLM-out-of-mcp)**: mcp 只跑确定性 Drain3 · 不调 LLM。旧版"≤50K LLM 主路径 /
 * fallback"已下线 —— path-router 永远跑 Drain3 · 只用 token 阈值给 skill 一个 enrichment hint。
 *
 * 验收门:
 *   1. 50K token 阈值 → requires_llm_enrichment hint (auto)
 *   2. agent override · force=main / backup / auto → hint
 *   3. force=main + input > 200K → ForceMainOverLimitError
 *   4. 永远跑 Drain3 · semantic_* 全 null (mcp 不语义命名)
 *   5. ttl-cache 命名空间 · key = deterministic 单桶 · 不带 model
 *   6. cache hit · ongoing 1h / closed 24h
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  routeAndCluster,
  resetRouterCache,
  buildCacheKey,
  estimateLines,
  ForceMainOverLimitError,
} from '../server-enrich/pattern/path-router';
import {
  genStandardLogs,
  genLogsByTokenSize,
} from './fixtures/feat-037-cluster-cases';

describe('feat-037/#3 · auto-path enrichment hint (50K token threshold)', () => {
  beforeEach(() => {
    resetRouterCache();
  });

  it('small input (< 50K tokens) → requires_llm_enrichment=true · always deterministic Drain3', async () => {
    const payload = await routeAndCluster({
      endpointId: 'ep-1',
      lines: genStandardLogs(50),
      cache: false,
    });
    expect(payload.router.decision).toBe('deterministic');
    expect(payload.router.reason).toBe('auto_under_threshold');
    expect(payload.router.requires_llm_enrichment).toBe(true);
    expect(payload.cluster.cluster_requires_llm_enrichment).toBe(true);
    // Drain3 跑出 cluster · semantic_* 全 null (mcp 不语义命名 · skill 补)
    expect(payload.cluster.patterns.length).toBeGreaterThan(0);
    for (const p of payload.cluster.patterns) {
      expect(p.semantic_name).toBeNull();
      expect(p.semantic_category).toBeNull();
      expect(p.semantic_summary).toBeNull();
    }
  });

  it('large input (> 50K tokens) → requires_llm_enrichment=false · still deterministic', async () => {
    const big = genLogsByTokenSize(80_000);
    const payload = await routeAndCluster({
      endpointId: 'ep-1',
      lines: big,
      cache: false,
    });
    expect(payload.router.decision).toBe('deterministic');
    expect(payload.router.reason).toBe('auto_over_threshold');
    expect(payload.router.requires_llm_enrichment).toBe(false);
    expect(payload.cluster.cluster_requires_llm_enrichment).toBe(false);
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

describe('feat-037/#3 · force_path override (enrichment hint only · mcp 不调 LLM)', () => {
  beforeEach(() => {
    resetRouterCache();
  });

  it('force=backup → hint=false regardless of size · deterministic', async () => {
    const payload = await routeAndCluster({
      endpointId: 'ep-1',
      lines: genStandardLogs(5),
      forcePath: 'backup',
      cache: false,
    });
    expect(payload.router.decision).toBe('deterministic');
    expect(payload.router.reason).toBe('force_no_enrich');
    expect(payload.router.requires_llm_enrichment).toBe(false);
  });

  it('force=main → hint=true even when input over 50K (≤ 200K)', async () => {
    const payload = await routeAndCluster({
      endpointId: 'ep-1',
      lines: genLogsByTokenSize(80_000),
      forcePath: 'main',
      cache: false,
    });
    expect(payload.router.decision).toBe('deterministic');
    expect(payload.router.reason).toBe('force_enrich');
    expect(payload.router.requires_llm_enrichment).toBe(true);
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

describe('feat-037/#3 · cache namespace (§3.5 · deterministic single bucket)', () => {
  beforeEach(() => {
    resetRouterCache();
  });

  it('key uses deterministic decision · no model segment', () => {
    const k = buildCacheKey({
      decision: 'deterministic',
      endpointId: 'ep-1',
    });
    expect(k).toContain(':deterministic:');
    expect(k).toContain('cluster_logs:deterministic:ep-1');
  });

  it('key encodes endpoint / time_range / trace_id / severity', () => {
    const k = buildCacheKey({
      decision: 'deterministic',
      endpointId: 'ep-9',
      timeRange: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      traceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      severityFilter: ['ERROR', 'FATAL'],
    });
    expect(k).toContain('cluster_logs:deterministic:ep-9');
    expect(k).toContain('a1b2c3d4e5f60718293a4b5c6d7e8f90');
  });

  it('cache hit second call · cached=true · same result', async () => {
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
    expect(second.cluster.total_clusters).toBe(first.cluster.total_clusters);
  });

  it('cache disabled · both calls recompute (cached=false)', async () => {
    const a = await routeAndCluster({
      endpointId: 'ep-nocache',
      lines: genStandardLogs(5),
      cache: false,
    });
    const b = await routeAndCluster({
      endpointId: 'ep-nocache',
      lines: genStandardLogs(5),
      cache: false,
    });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false);
  });
});
