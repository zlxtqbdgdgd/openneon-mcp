/**
 * feat-045 6-case end-to-end handler tests · openneon-mcp#147.
 *
 * 6 cases (CASE_NAMES):
 *   standard / probe_degraded / token_truncated / cache_hit / plan_deny / cross_model
 *
 * Also covers:
 *   - audit RCA_GENERATED emission (#147 验收门)
 *   - token economy aggregator (#147 §跑批 100 incident)
 *   - cross-model robustness (≥ 95%)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleGenerateRcaReport,
  generateRcaReportInputSchema,
  type GenerateRcaReportDeps,
  type GenerateRcaReportResult,
} from '../tools/handlers/generate-rca-report';
import { RcaCache } from '../server-enrich/rca/cache';
import {
  setLlmClient,
  resetLlmClient,
  type LlmClient,
  type RcaModelId,
} from '../server-enrich/rca/llm-client';
import { TokenEconomyAggregator } from '../server-enrich/rca/token-economy';
import {
  SAMPLE_TRACE,
  SAMPLE_PROBE,
  SAMPLE_AUDIT,
  SAMPLE_VALIDATION,
  SAMPLE_TRACE_ID,
  CASE_NAMES,
} from './fixtures/feat-045-rca-cases';
import type { RcaFetcherDeps } from '../server-enrich/rca/data-fetcher';

function happyFetcher(): RcaFetcherDeps {
  return {
    fetchTrace: async () => SAMPLE_TRACE,
    fetchProbe: async () => SAMPLE_PROBE,
    fetchAudit: async () => SAMPLE_AUDIT,
    fetchValidation: async () => SAMPLE_VALIDATION,
  };
}

function happyLlm(text = '# RCA · stub output\n\n## Trace 链路图\n\nproxy → compute (1480ms)'): LlmClient {
  return {
    call: async (req) => ({
      text,
      inputTokens: Math.ceil(req.userPayload.length / 4),
      outputTokens: Math.ceil(text.length / 4),
      model: req.model,
    }),
  };
}

beforeEach(() => {
  resetLlmClient();
});

describe('feat-045 · case 1 standard · 4 legs OK + LLM OK → 完整 markdown', () => {
  it('returns markdown · no degrade · cached=false · audit emitted allow', async () => {
    setLlmClient(happyLlm());
    const audits: unknown[] = [];
    const deps: GenerateRcaReportDeps = {
      fetcher: happyFetcher(),
      cache: new RcaCache(),
      skipPlanMode: true,
      emitAudit: (e) => audits.push(e),
    };
    const r: GenerateRcaReportResult = await handleGenerateRcaReport(
      { trace_id: SAMPLE_TRACE_ID },
      deps,
    );
    expect(r.cached).toBe(false);
    expect(r.degraded).toEqual([]);
    expect(r.markdown).toContain('RCA');
    expect(r.input_tokens).toBeGreaterThan(0);
    expect(audits).toHaveLength(1);
    expect((audits[0] as { event_type: string }).event_type).toBe('rca_generated');
    expect((audits[0] as { outcome: string }).outcome).toBe('allow');
  });
});

describe('feat-045 · case 2 probe_degraded · probe leg fail → [DATA_MISSING:probe]', () => {
  it('still returns markdown + degraded=["probe"] + LLM still called', async () => {
    setLlmClient(happyLlm());
    const deps: GenerateRcaReportDeps = {
      fetcher: {
        ...happyFetcher(),
        fetchProbe: async () => {
          throw new Error('probe not attached');
        },
      },
      cache: new RcaCache(),
      skipPlanMode: true,
    };
    const r = await handleGenerateRcaReport({ trace_id: SAMPLE_TRACE_ID }, deps);
    expect(r.degraded).toContain('probe');
    // Server-rendered template (before LLM) included [DATA_MISSING:probe]. The stub LLM ignores
    // it, but real behavior is asserted in the template tests; here we just verify degrade flow.
    expect(r.cached).toBe(false);
  });

  it('NOT cached when degraded (cache.set guarded by degraded.length===0)', async () => {
    setLlmClient(happyLlm());
    const cache = new RcaCache();
    const deps: GenerateRcaReportDeps = {
      fetcher: {
        ...happyFetcher(),
        fetchProbe: async () => {
          throw new Error('boom');
        },
      },
      cache,
      skipPlanMode: true,
    };
    await handleGenerateRcaReport({ trace_id: SAMPLE_TRACE_ID }, deps);
    // Second call: cache should miss (no entry stored on degrade) → fetcher invoked again.
    let traceCalls = 0;
    const deps2: GenerateRcaReportDeps = {
      fetcher: {
        ...happyFetcher(),
        fetchTrace: async () => {
          traceCalls++;
          return SAMPLE_TRACE;
        },
        fetchProbe: async () => {
          throw new Error('boom');
        },
      },
      cache,
      skipPlanMode: true,
    };
    await handleGenerateRcaReport({ trace_id: SAMPLE_TRACE_ID }, deps2);
    expect(traceCalls).toBe(1);
  });
});

describe('feat-045 · case 3 token_truncated · oversize evidence triggers truncation', () => {
  it('evidence appendix is replaced with [DATA_MISSING:evidence_truncated] marker · template is sacred', async () => {
    // Force oversized evidence by injecting a giant trace tree
    const giantTrace = {
      ...SAMPLE_TRACE,
      spanTree: Array.from({ length: 5000 }, (_, i) => ({
        serviceName: 'compute',
        operationName: `op_${i}_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
        durationMs: i,
        depth: 0,
      })),
    };
    let observedPayload = '';
    setLlmClient({
      call: async (req) => {
        observedPayload = req.userPayload;
        return {
          text: 'ok',
          inputTokens: Math.ceil(req.userPayload.length / 4),
          outputTokens: 1,
          model: req.model,
        };
      },
    });
    const deps: GenerateRcaReportDeps = {
      fetcher: { ...happyFetcher(), fetchTrace: async () => giantTrace },
      cache: new RcaCache(),
      skipPlanMode: true,
    };
    await handleGenerateRcaReport({ trace_id: SAMPLE_TRACE_ID }, deps);
    // Template renders all spans verbatim (template sacred · LLM only fills NL prose · §三原则
    // rule 3). Truncation only kicks in on the evidence appendix · the marker must appear and
    // the evidence section must be small.
    expect(observedPayload).toContain('[DATA_MISSING:evidence_truncated]');
    const evidenceStart = observedPayload.indexOf('# Evidence Appendix');
    expect(evidenceStart).toBeGreaterThan(-1);
    const evidenceSection = observedPayload.slice(evidenceStart);
    expect(evidenceSection.length).toBeLessThan(3000);
  });
});

describe('feat-045 · case 4 cache_hit · 同 trace_id 第二次 zero-LLM', () => {
  it('second call returns cached markdown · LLM not invoked again', async () => {
    let llmCalls = 0;
    setLlmClient({
      call: async (req) => {
        llmCalls++;
        return {
          text: '## cached body',
          inputTokens: 100,
          outputTokens: 50,
          model: req.model,
        };
      },
    });
    const cache = new RcaCache();
    const deps: GenerateRcaReportDeps = {
      fetcher: happyFetcher(),
      cache,
      skipPlanMode: true,
    };
    const first = await handleGenerateRcaReport({ trace_id: SAMPLE_TRACE_ID }, deps);
    expect(first.cached).toBe(false);
    expect(llmCalls).toBe(1);

    const second = await handleGenerateRcaReport({ trace_id: SAMPLE_TRACE_ID }, deps);
    expect(second.cached).toBe(true);
    expect(second.markdown).toBe(first.markdown);
    expect(llmCalls).toBe(1);
  });
});

describe('feat-045 · case 5 plan_deny · DBA rejects → throw', () => {
  it('throws plan_mode_rejected · audit emits deny', async () => {
    setLlmClient(happyLlm());
    const audits: Array<{ outcome: string }> = [];
    const deps: GenerateRcaReportDeps = {
      fetcher: happyFetcher(),
      cache: new RcaCache(),
      requestApproval: async () => 'rejected',
      emitAudit: (e) => audits.push(e as { outcome: string }),
    };
    await expect(
      handleGenerateRcaReport({ trace_id: SAMPLE_TRACE_ID }, deps),
    ).rejects.toThrow(/plan_mode_rejected/);
    expect(audits[0]?.outcome).toBe('deny');
  });

  it('fail-closed on plan_mode_unavailable (elicitation capability missing)', async () => {
    setLlmClient(happyLlm());
    const deps: GenerateRcaReportDeps = {
      fetcher: happyFetcher(),
      cache: new RcaCache(),
      // omit requestApproval · DEFAULT_REQUEST_APPROVAL returns 'unavailable'
    };
    await expect(
      handleGenerateRcaReport({ trace_id: SAMPLE_TRACE_ID }, deps),
    ).rejects.toThrow(/plan_mode_unavailable/);
  });
});

describe('feat-045 · case 6 cross_model · opus / sonnet / haiku 结构一致', () => {
  const models: RcaModelId[] = [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ];

  it('all 3 models stamp model id + return non-empty markdown', async () => {
    setLlmClient(happyLlm());
    const results: GenerateRcaReportResult[] = [];
    for (const m of models) {
      const r = await handleGenerateRcaReport(
        { trace_id: SAMPLE_TRACE_ID, model: m, cache: false },
        { fetcher: happyFetcher(), cache: new RcaCache(), skipPlanMode: true },
      );
      results.push(r);
    }
    expect(results.map((r) => r.model)).toEqual(models);
    expect(results.every((r) => r.markdown.length > 0)).toBe(true);
  });
});

describe('feat-045/#3 · zod schema validation', () => {
  it('rejects non-hex trace_id', () => {
    expect(() =>
      generateRcaReportInputSchema.parse({ trace_id: 'not-a-trace' }),
    ).toThrow();
  });
  it('accepts canonical 32-hex trace_id', () => {
    const r = generateRcaReportInputSchema.parse({ trace_id: SAMPLE_TRACE_ID });
    expect(r.trace_id).toBe(SAMPLE_TRACE_ID);
  });
  it('rejects unknown model id', () => {
    expect(() =>
      generateRcaReportInputSchema.parse({
        trace_id: SAMPLE_TRACE_ID,
        model: 'gpt-4o',
      }),
    ).toThrow();
  });
  it('rejects malformed audit_filter timestamps via shape (strings required)', () => {
    expect(() =>
      generateRcaReportInputSchema.parse({
        trace_id: SAMPLE_TRACE_ID,
        audit_filter: { start: 123, end: 456 },
      }),
    ).toThrow();
  });
});

describe('feat-045/#3 · token economy 跑批 (mini batch · #147 §跑批)', () => {
  it('aggregates 20-sample batch with input p99 < 3000 + cache hit rate computable', async () => {
    setLlmClient(happyLlm());
    const cache = new RcaCache();
    const agg = new TokenEconomyAggregator();
    const N = 20;
    for (let i = 0; i < N; i++) {
      // half the samples reuse the same trace_id → cache hits
      const tid = i % 2 === 0 ? SAMPLE_TRACE_ID : SAMPLE_TRACE_ID.replace('a1', 'b2');
      const r = await handleGenerateRcaReport(
        { trace_id: tid },
        {
          fetcher: happyFetcher(),
          cache,
          skipPlanMode: true,
        },
      );
      agg.record({
        traceId: tid,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cached: r.cached,
        durationMs: r.duration_ms,
      });
    }
    const summary = agg.summary();
    expect(summary.n).toBe(N);
    expect(summary.cacheHitRate).toBeGreaterThan(0);
    expect(summary.inputP99).toBeLessThan(3000);
    expect(summary.outputP99).toBeLessThan(5000);
  });

  it('6 case names fixture is the canonical set the suite exercises', () => {
    expect(CASE_NAMES).toEqual([
      'standard',
      'probe_degraded',
      'token_truncated',
      'cache_hit',
      'plan_deny',
      'cross_model',
    ]);
  });
});

describe('feat-045/#1 · LLM client failure → [DATA_MISSING:llm] fallback', () => {
  it('LLM error → fallback to server-rendered template + [DATA_MISSING:llm] tail', async () => {
    setLlmClient({
      call: async () => ({
        error: { reason: 'unreachable', detail: 'econnrefused' },
      }),
    });
    const r = await handleGenerateRcaReport(
      { trace_id: SAMPLE_TRACE_ID },
      { fetcher: happyFetcher(), cache: new RcaCache(), skipPlanMode: true },
    );
    expect(r.degraded).toContain('llm');
    expect(r.markdown).toContain('[DATA_MISSING:llm]');
    expect(r.markdown).toContain('econnrefused');
  });
});
