/**
 * feat-037/#4 + #5 · cluster_neondb_logs handler + 8 case fixture · 跨 model 一致性 跑批.
 *
 * openneon-mcp#154 (handler) + #156 (fixture + 跨 model 一致性).
 *
 * 8 case (跟 issue body):
 *   1. standard_main          — 30K input → main 路径 LLM
 *   2. standard_backup        — 100K input → backup Drain3
 *   3. path_estimate_accuracy — tiktoken 估算 vs 实际偏差
 *   4. fallback_from_main     — LLM 5xx → 自动 fallback + fallback_reason
 *   5. force_path_override    — force=main / backup
 *   6. force_main_over_limit  — input > 200K + force=main → 拒绝
 *   7. cache_hit              — < 5ms + cached=true
 *   8. trace_id_v1_blocked    — feat_036_not_ready
 *
 * + tail anomaly: FATAL 在 tail aggregate 可见
 * + 跨 model 一致性: opus / sonnet / haiku 三轮 → category 一致 ≥ 80% · coverage ≥ 95%
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  handleClusterNeondbLogs,
  type ClusterAuditEvent,
} from '../tools/handlers/cluster-neondb-logs';
import {
  setLlmClient,
  resetLlmClient,
  type LlmClient,
  type RcaModelId,
} from '../server-enrich/rca/llm-client';
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
  MOCK_LLM_OUTPUT_OPUS,
  MOCK_LLM_OUTPUT_SONNET,
  MOCK_LLM_OUTPUT_HAIKU,
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

function llmReturning(text: string): LlmClient {
  return {
    call: async () => ({
      text,
      inputTokens: 1200,
      outputTokens: 800,
      model: 'claude-opus-4-7',
    }),
  };
}

beforeEach(() => {
  resetRouterCache();
  resetLlmClient();
  resetLogFetchAdapter();
});

afterEach(() => {
  resetRouterCache();
  resetLlmClient();
  resetLogFetchAdapter();
});

// ------------------------------------------------------------------------------------------------
// 8 case fixture
// ------------------------------------------------------------------------------------------------

describe('feat-037/#5 · case 1 · standard_main (30K input → LLM main)', () => {
  it('routes to main · returns 8 LLM clusters · emits log_clustering_invoked allow', async () => {
    setLogFetchAdapter(adapterReturning(genStandardLogs(100)));
    setLlmClient(llmReturning(MOCK_LLM_OUTPUT_OPUS));
    const audit: ClusterAuditEvent[] = [];
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-1',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      },
      {
        projectId: 'proj-1',
        emitAudit: (e) => audit.push(e),
        skipPlanMode: true,
      },
    );
    expect(r.decision).toBe('main');
    expect(r.cluster.patterns).toHaveLength(8);
    expect(audit).toHaveLength(1);
    expect(audit[0].event_type).toBe('log_clustering_invoked');
    expect(audit[0].outcome).toBe('allow');
    expect(audit[0].path_used).toBe('main');
    expect(audit[0].project_id).toBe('proj-1');
  });
});

describe('feat-037/#5 · case 2 · standard_backup (100K input → Drain3)', () => {
  it('routes to backup when input > 50K · no LLM called', async () => {
    setLogFetchAdapter(adapterReturning(genLogsByTokenSize(80_000)));
    setLlmClient({
      call: async () => {
        throw new Error('LLM should not be called on backup path');
      },
    });
    const audit: ClusterAuditEvent[] = [];
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-2',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      },
      { emitAudit: (e) => audit.push(e), skipPlanMode: true },
    );
    expect(r.decision).toBe('backup');
    expect(r.model).toBeNull();
    expect(r.input_tokens).toBe(0);
    expect(audit[0].path_used).toBe('backup');
    expect(audit[0].cost_estimate_usd).toBe(0);
  });
});

describe('feat-037/#5 · case 3 · path_estimate_accuracy', () => {
  it('estimated_tokens is consistent with chars/4 heuristic', async () => {
    const lines = genLogsByTokenSize(40_000);
    setLogFetchAdapter(adapterReturning(lines));
    setLlmClient(llmReturning(MOCK_LLM_OUTPUT_OPUS));
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-3',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      },
      { skipPlanMode: true },
    );
    // 40K ± 30% 容差
    expect(r.estimated_tokens).toBeGreaterThan(25_000);
    expect(r.estimated_tokens).toBeLessThan(60_000);
  });
});

describe('feat-037/#5 · case 4 · fallback_from_main (LLM 5xx)', () => {
  it('auto fallbacks to Drain3 with fallback_reason populated', async () => {
    setLogFetchAdapter(adapterReturning(genStandardLogs(50)));
    setLlmClient({
      call: async () => ({
        error: { reason: 'backend_error', detail: '503 service unavailable' },
      }),
    });
    const audit: ClusterAuditEvent[] = [];
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-4',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      },
      { emitAudit: (e) => audit.push(e), skipPlanMode: true },
    );
    expect(r.decision).toBe('backup');
    expect(r.reason).toBe('fallback_from_main');
    expect(r.fallback_reason).toContain('llm_backend_error');
    expect(r.degraded).toContain('llm');
    expect(audit[0].fallback_reason).toContain('llm_backend_error');
  });
});

describe('feat-037/#5 · case 5 · force_path override', () => {
  it('force=backup · skips LLM · 0 cost regardless of input size', async () => {
    setLogFetchAdapter(adapterReturning(genStandardLogs(5)));
    setLlmClient({
      call: async () => {
        throw new Error('LLM must not be called when force=backup');
      },
    });
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-5a',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
        force_path: 'backup',
      },
      { skipPlanMode: true },
    );
    expect(r.decision).toBe('backup');
    expect(r.input_tokens).toBe(0);
  });

  it('force=main · still calls LLM at any size ≤ 200K', async () => {
    setLogFetchAdapter(adapterReturning(genLogsByTokenSize(60_000)));
    setLlmClient(llmReturning(MOCK_LLM_OUTPUT_OPUS));
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-5b',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
        force_path: 'main',
      },
      { skipPlanMode: true },
    );
    expect(r.decision).toBe('main');
  });
});

describe('feat-037/#5 · case 6 · force_main_over_limit', () => {
  it('refuses force=main when estimated_tokens > 200K', async () => {
    setLogFetchAdapter(adapterReturning(genLogsByTokenSize(250_000)));
    setLlmClient(llmReturning(MOCK_LLM_OUTPUT_OPUS));
    const audit: ClusterAuditEvent[] = [];
    await expect(
      handleClusterNeondbLogs(
        {
          endpoint_id: 'ep-6',
          time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
          force_path: 'main',
        },
        { emitAudit: (e) => audit.push(e), skipPlanMode: true },
      ),
    ).rejects.toThrow(/feat-037 §3.2 强制 main 上限|force_path='main'/);
    // audit fires `deny` outcome
    expect(audit.some((e) => e.outcome === 'deny')).toBe(true);
  });
});

describe('feat-037/#5 · case 7 · cache_hit (second call < real LLM)', () => {
  it('returns cached payload on second identical call · no extra LLM calls', async () => {
    setLogFetchAdapter(adapterReturning(genStandardLogs(50)));
    let llmCalls = 0;
    setLlmClient({
      call: async () => {
        llmCalls += 1;
        return {
          text: MOCK_LLM_OUTPUT_OPUS,
          inputTokens: 1200,
          outputTokens: 800,
          model: 'claude-opus-4-7',
        };
      },
    });
    const first = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-7',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      },
      { skipPlanMode: true },
    );
    const second = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-7',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      },
      { skipPlanMode: true },
    );
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(llmCalls).toBe(1);
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
        { emitAudit: (e) => audit.push(e), skipPlanMode: true },
      ),
    ).rejects.toThrow(/feat_036_not_ready/);
    expect(audit[0].outcome).toBe('deny');
    expect(audit[0].fallback_reason).toBe('feat_036_not_ready');
  });
});

// ------------------------------------------------------------------------------------------------
// Bonus · tail anomaly detection
// ------------------------------------------------------------------------------------------------

describe('feat-037/#5 · tail anomaly (FATAL preserved in backup path)', () => {
  it('tail aggregate captures FATAL severity even when forced backup', async () => {
    setLogFetchAdapter(adapterReturning(genAnomalyLogs(100)));
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-anom',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
        force_path: 'backup',
        top_n: 1,
      },
      { skipPlanMode: true },
    );
    const totalFatal =
      r.cluster.patterns.reduce((s, p) => s + p.severity_distribution.FATAL, 0) +
      r.cluster.tail_aggregate.severity_distribution.FATAL;
    expect(totalFatal).toBe(10);
  });
});

// ------------------------------------------------------------------------------------------------
// 跨 model 一致性 (#156 验收门: ≥ 80% category 一致 · ≥ 95% coverage)
// ------------------------------------------------------------------------------------------------

describe('feat-037/#5 · 跨 model 一致性 跑批', () => {
  it('opus / sonnet / haiku · category 一致 ≥ 80% · coverage ≥ 95%', async () => {
    setLogFetchAdapter(adapterReturning(genStandardLogs(100)));
    const modelOutputs: Record<RcaModelId, string> = {
      'claude-opus-4-7': MOCK_LLM_OUTPUT_OPUS,
      'claude-sonnet-4-6': MOCK_LLM_OUTPUT_SONNET,
      'claude-haiku-4-5': MOCK_LLM_OUTPUT_HAIKU,
    };
    const results: Record<RcaModelId, string[]> = {} as Record<RcaModelId, string[]>;
    const coverageByModel: Record<RcaModelId, number> = {} as Record<RcaModelId, number>;
    for (const model of Object.keys(modelOutputs) as RcaModelId[]) {
      resetRouterCache();
      setLlmClient({
        call: async () => ({
          text: modelOutputs[model],
          inputTokens: 1200,
          outputTokens: 800,
          model,
        }),
      });
      const r = await handleClusterNeondbLogs(
        {
          endpoint_id: 'ep-cross',
          time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
          model,
          cache: false,
        },
        { skipPlanMode: true },
      );
      results[model] = r.cluster.patterns.map((p) => p.semantic_category);
      const covered = r.cluster.patterns.reduce((s, p) => s + p.count, 0);
      coverageByModel[model] = covered / 100;
    }
    // category 一致性 (cluster i 的 category 在 3 model 中至少 2/3 一致 → 算 consistent)
    const k = results['claude-opus-4-7'].length;
    let consistent = 0;
    for (let i = 0; i < k; i++) {
      const set = new Set([
        results['claude-opus-4-7'][i],
        results['claude-sonnet-4-6'][i],
        results['claude-haiku-4-5'][i],
      ]);
      // 全 3 一致 → 强一致 · 2/3 一致 → 弱一致 · 取 ≥ 2 个相同算 consistent
      const counts: Record<string, number> = {};
      [
        results['claude-opus-4-7'][i],
        results['claude-sonnet-4-6'][i],
        results['claude-haiku-4-5'][i],
      ].forEach((c) => {
        counts[c] = (counts[c] ?? 0) + 1;
      });
      const maxCount = Math.max(...Object.values(counts));
      if (maxCount >= 2) consistent += 1;
    }
    const consistencyRate = consistent / k;
    expect(consistencyRate).toBeGreaterThanOrEqual(0.8);
    for (const m of Object.keys(coverageByModel) as RcaModelId[]) {
      expect(coverageByModel[m]).toBeGreaterThanOrEqual(0.95);
    }
  });
});

// ------------------------------------------------------------------------------------------------
// Plan mode integration · LLM 主路径 only
// ------------------------------------------------------------------------------------------------

describe('feat-037/#4 · plan mode (feat-027) · LLM 主路径', () => {
  it('skips plan mode on backup path (zero LLM cost)', async () => {
    setLogFetchAdapter(adapterReturning(genStandardLogs(5)));
    let planCalls = 0;
    const r = await handleClusterNeondbLogs(
      {
        endpoint_id: 'ep-plan-skip',
        time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
        force_path: 'backup',
      },
      {
        skipPlanMode: false, // 不跳过 · 但备路径自身应跳
        requestApproval: async () => {
          planCalls += 1;
          return 'approved';
        },
      },
    );
    expect(r.decision).toBe('backup');
    expect(planCalls).toBe(0);
  });

  it('denies LLM call when plan mode rejects (fail-closed)', async () => {
    setLogFetchAdapter(adapterReturning(genStandardLogs(5)));
    setLlmClient(llmReturning(MOCK_LLM_OUTPUT_OPUS));
    await expect(
      handleClusterNeondbLogs(
        {
          endpoint_id: 'ep-plan-deny',
          time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
        },
        {
          skipPlanMode: false,
          requestApproval: async () => 'rejected',
        },
      ),
    ).rejects.toThrow(/plan_mode_rejected/);
  });

  it('fail-closed deny when plan mode unavailable (default capability missing)', async () => {
    setLogFetchAdapter(adapterReturning(genStandardLogs(5)));
    setLlmClient(llmReturning(MOCK_LLM_OUTPUT_OPUS));
    await expect(
      handleClusterNeondbLogs(
        {
          endpoint_id: 'ep-plan-na',
          time_range: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
        },
        { skipPlanMode: false },
      ),
    ).rejects.toThrow(/plan_mode_unavailable/);
  });
});
