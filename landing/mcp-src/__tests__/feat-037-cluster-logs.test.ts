/**
 * feat-037/#4 + #5 · cluster_neondb_logs handler · 确定性聚类 + 8 case fixture.
 *
 * openneon-mcp#154 (handler) + #156 (fixture).
 *
 * **form-shift (规则 P4 · LLM-out-of-mcp)**: mcp 只跑确定性 Drain3 · 不调 LLM · semantic_* 永 null ·
 * 语义补全 + plan mode 归 cc skill。旧版"LLM 主路径 8 cluster / 跨 model 一致性 / plan-mode approval"
 * 已下线 —— 本测试只验确定性 backbone + enrichment hint。
 *
 * case (form-shift 后):
 *   1. standard         — 小 input → deterministic · requires_llm_enrichment=true
 *   2. large            — 100K input → deterministic · requires_llm_enrichment=false
 *   3. estimate         — token 估算偏差
 *   4. semantic_null    — 所有 pattern semantic_* = null (mcp 不语义命名)
 *   5. force_path       — force=main / backup → enrichment hint
 *   6. force_main_over_limit — input > 200K + force=main → 拒绝
 *   7. cache_hit        — < 5ms + cached=true · 无 LLM (deterministic recompute 省掉)
 *   8. trace_id_v1_blocked — feat_036_not_ready
 *   + tail anomaly: FATAL 在 tail aggregate 可见
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  handleClusterNeondbLogs,
  type ClusterAuditEvent,
} from '../tools/handlers/cluster-neondb-logs';
import {
  resetRouterCache,
} from '../server-enrich/pattern/path-router';
import {
  setLogFetchAdapter,
  resetLogFetchAdapter,
  type LogFetchAdapter,
} from '../server-enrich/metrics-history/log-fetch';
import {
  genStandardLogs,
  genAnomalyLogs,
  genLogsByTokenSize,
} from './fixtures/feat-037-cluster-cases';
import type { LogLine } from '../server-enrich/pattern/types';

// ------------------------------------------------------------------------------------------------
// Test helpers
// ------------------------------------------------------------------------------------------------

function adapterReturning(lines: LogLine[]): LogFetchAdapter {
  return {
    fetch: async () => ({
      lines,
      coverage: {
        fetched_lines: lines.length,
        total_matching_lines: lines.length,
        truncated: false,
        latest_line_ts: lines[lines.length - 1]?.timestamp ?? null,
      },
    }),
  };
}

beforeEach(() => {
  resetRouterCache();
  resetLogFetchAdapter();
});

afterEach(() => {
  resetRouterCache();
  resetLogFetchAdapter();
});

// ------------------------------------------------------------------------------------------------
// case fixture (form-shift · deterministic)
// ------------------------------------------------------------------------------------------------

describe('feat-037/#5 · case 1 · standard (small input → deterministic · enrich hint true)', () => {
  it('runs deterministic Drain3 · requires_llm_enrichment=true · emits allow audit', async () => {
    setLogFetchAdapter(adapterReturning(genStandardLogs(100)));
    const audit: ClusterAuditEvent[] = [];
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-1',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      },
      {
        projectId: 'proj-1',
        emitAudit: (e) => audit.push(e),
      },
    );
    expect(r.decision).toBe('deterministic');
    expect(r.cluster_requires_llm_enrichment).toBe(true);
    expect(r.cluster.patterns.length).toBeGreaterThan(0);
    expect(audit).toHaveLength(1);
    expect(audit[0].event_type).toBe('log_clustering_invoked');
    expect(audit[0].outcome).toBe('allow');
    expect(audit[0].path_used).toBe('deterministic');
    expect(audit[0].cost_estimate_usd).toBe(0);
    expect(audit[0].requires_llm_enrichment).toBe(true);
    expect(audit[0].project_id).toBe('proj-1');
  });
});

describe('feat-037/#5 · case 2 · large (100K input → deterministic · enrich hint false)', () => {
  it('large input → requires_llm_enrichment=false · cost 0', async () => {
    setLogFetchAdapter(adapterReturning(genLogsByTokenSize(80_000)));
    const audit: ClusterAuditEvent[] = [];
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-2',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      },
      { emitAudit: (e) => audit.push(e) },
    );
    expect(r.decision).toBe('deterministic');
    expect(r.cluster_requires_llm_enrichment).toBe(false);
    expect(audit[0].path_used).toBe('deterministic');
    expect(audit[0].cost_estimate_usd).toBe(0);
    expect(audit[0].requires_llm_enrichment).toBe(false);
  });
});

describe('feat-037/#5 · case 3 · path_estimate_accuracy', () => {
  it('estimated_tokens is consistent with chars/4 heuristic', async () => {
    const lines = genLogsByTokenSize(40_000);
    setLogFetchAdapter(adapterReturning(lines));
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-3',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      },
      {},
    );
    // 40K ± 30% 容差
    expect(r.estimated_tokens).toBeGreaterThan(25_000);
    expect(r.estimated_tokens).toBeLessThan(60_000);
  });
});

describe('feat-037/#5 · case 4 · semantic_* always null (mcp 不语义命名)', () => {
  it('every pattern has semantic_name / semantic_category / semantic_summary = null', async () => {
    setLogFetchAdapter(adapterReturning(genStandardLogs(100)));
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-sem',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      },
      {},
    );
    expect(r.cluster.patterns.length).toBeGreaterThan(0);
    for (const p of r.cluster.patterns) {
      expect(p.semantic_name).toBeNull();
      expect(p.semantic_category).toBeNull();
      expect(p.semantic_summary).toBeNull();
    }
  });
});

describe('feat-037/#5 · case 5 · force_path override (enrichment hint)', () => {
  it('force=backup · hint=false · deterministic', async () => {
    setLogFetchAdapter(adapterReturning(genStandardLogs(5)));
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-5a',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
        force_path: 'backup',
      },
      {},
    );
    expect(r.decision).toBe('deterministic');
    expect(r.cluster_requires_llm_enrichment).toBe(false);
  });

  it('force=main · hint=true at any size ≤ 200K', async () => {
    setLogFetchAdapter(adapterReturning(genLogsByTokenSize(60_000)));
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-5b',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
        force_path: 'main',
      },
      {},
    );
    expect(r.decision).toBe('deterministic');
    expect(r.cluster_requires_llm_enrichment).toBe(true);
  });
});

describe('feat-037/#5 · case 6 · force_main_over_limit', () => {
  it('refuses force=main when estimated_tokens > 200K · emits deny audit', async () => {
    setLogFetchAdapter(adapterReturning(genLogsByTokenSize(250_000)));
    const audit: ClusterAuditEvent[] = [];
    await expect(
      handleClusterNeondbLogs(
        {
          endpoint_id: 'ep-6',
          time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
          force_path: 'main',
        },
        { emitAudit: (e) => audit.push(e) },
      ),
    ).rejects.toThrow(/feat-037 §3.2 强制 main 上限|force_path='main'/);
    expect(audit.some((e) => e.outcome === 'deny')).toBe(true);
  });
});

describe('feat-037/#5 · case 7 · cache_hit (second call cached · deterministic recompute省掉)', () => {
  it('returns cached payload on second identical call', async () => {
    setLogFetchAdapter(adapterReturning(genStandardLogs(50)));
    const first = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-7',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      },
      {},
    );
    const second = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-7',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      },
      {},
    );
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });
});

describe('feat-037/#5 · case 8 · trace_id_v1_blocked (feat_036_not_ready)', () => {
  it('throws feat_036_not_ready when adapter returns staged-delivery error', async () => {
    // default stub adapter already returns feat_036_not_ready on trace_id
    const audit: ClusterAuditEvent[] = [];
    await expect(
      handleClusterNeondbLogs(
        {
          endpoint_id: 'ep-8',
          time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
          trace_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        },
        { emitAudit: (e) => audit.push(e) },
      ),
    ).rejects.toThrow(/feat_036_not_ready/);
    expect(audit[0].outcome).toBe('deny');
    expect(audit[0].fallback_reason).toBe('feat_036_not_ready');
  });
});

// ------------------------------------------------------------------------------------------------
// Bonus · tail anomaly detection (deterministic Drain3 preserves FATAL in tail)
// ------------------------------------------------------------------------------------------------

describe('feat-037/#5 · tail anomaly (FATAL preserved in deterministic path)', () => {
  it('tail aggregate captures FATAL severity even with top_n=1', async () => {
    setLogFetchAdapter(adapterReturning(genAnomalyLogs(100)));
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-anom',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
        force_path: 'backup',
        top_n: 1,
      },
      {},
    );
    const totalFatal =
      r.cluster.patterns.reduce((s, p) => s + p.severity_distribution.FATAL, 0) +
      r.cluster.tail_aggregate.severity_distribution.FATAL;
    expect(totalFatal).toBe(10);
  });
});
