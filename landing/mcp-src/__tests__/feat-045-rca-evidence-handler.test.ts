/**
 * feat-045 end-to-end handler tests · openneon-mcp#147 · form-shift (规则 P4 · LLM-out-of-mcp).
 *
 * get_neondb_rca_evidence is deterministic: it gathers 4-leg evidence + pre-fills the 7-section
 * template + caches (template + evidence) + emits a取证 audit. It NEVER calls an LLM — the 7-section
 * narrative prose + plan mode + token-cap live in the cc skill. So these tests assert against
 * templateMarkdown + evidenceBundle (no LLM mock, no plan-mode mock).
 *
 * Covers:
 *   - standard (4 legs OK) → templateMarkdown + evidenceBundle + degradedLegs=[]
 *   - probe_degraded → [DATA_MISSING:probe] in template + degradedLegs=['probe'] + NOT cached
 *   - cache_hit → 同 trace_id 第二次 zero-fetch
 *   - audit RCA_EVIDENCE_FETCHED emission
 *   - token economy aggregator (#147 §跑批)
 */

import { describe, it, expect } from 'vitest';
import {
  handleGetNeondbRcaEvidence,
  getNeondbRcaEvidenceInputSchema,
  type GetNeondbRcaEvidenceDeps,
  type GetNeondbRcaEvidenceResult,
} from '../tools/handlers/get-neondb-rca-evidence';
import { RcaCache } from '../server-enrich/rca/cache';
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

describe('feat-045 · case standard · 4 legs OK → 预填模板 + 证据 bundle', () => {
  it('returns templateMarkdown + evidenceBundle · no degrade · cached=false · audit emitted allow', async () => {
    const audits: unknown[] = [];
    const deps: GetNeondbRcaEvidenceDeps = {
      fetcher: happyFetcher(),
      cache: new RcaCache(),
      emitAudit: (e) => audits.push(e),
    };
    const r: GetNeondbRcaEvidenceResult = await handleGetNeondbRcaEvidence(
      { trace_id: SAMPLE_TRACE_ID },
      deps,
    );
    expect(r.cached).toBe(false);
    expect(r.degradedLegs).toEqual([]);
    expect(r.templateMarkdown).toContain('RCA');
    // template skeleton carries the cc-skill attribution placeholder (mcp never writes prose)
    expect(r.templateMarkdown).toContain('[ATTRIBUTION_PENDING]');
    // raw evidence bundle is surfaced for the skill to cite
    expect(r.evidenceBundle.trace.ok).toBe(true);
    expect(r.evidenceBundle.probe.ok).toBe(true);
    expect(r.estimatedInputTokens).toBeGreaterThan(0);
    expect(audits).toHaveLength(1);
    expect((audits[0] as { event_type: string }).event_type).toBe(
      'rca_evidence_fetched',
    );
    expect((audits[0] as { outcome: string }).outcome).toBe('allow');
  });
});

describe('feat-045 · case probe_degraded · probe leg fail → [DATA_MISSING:probe]', () => {
  it('still returns template + degradedLegs=["probe"]', async () => {
    const deps: GetNeondbRcaEvidenceDeps = {
      fetcher: {
        ...happyFetcher(),
        fetchProbe: async () => {
          throw new Error('probe not attached');
        },
      },
      cache: new RcaCache(),
    };
    const r = await handleGetNeondbRcaEvidence({ trace_id: SAMPLE_TRACE_ID }, deps);
    expect(r.degradedLegs).toContain('probe');
    expect(r.templateMarkdown).toContain('[DATA_MISSING:probe]');
    expect(r.evidenceBundle.probe.ok).toBe(false);
    expect(r.cached).toBe(false);
  });

  it('NOT cached when degraded (cache.set guarded by degradedLegs.length===0)', async () => {
    const cache = new RcaCache();
    const deps: GetNeondbRcaEvidenceDeps = {
      fetcher: {
        ...happyFetcher(),
        fetchProbe: async () => {
          throw new Error('boom');
        },
      },
      cache,
    };
    await handleGetNeondbRcaEvidence({ trace_id: SAMPLE_TRACE_ID }, deps);
    // Second call: cache should miss (no entry stored on degrade) → fetcher invoked again.
    let traceCalls = 0;
    const deps2: GetNeondbRcaEvidenceDeps = {
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
    };
    await handleGetNeondbRcaEvidence({ trace_id: SAMPLE_TRACE_ID }, deps2);
    expect(traceCalls).toBe(1);
  });
});

describe('feat-045 · case token_estimate · estimatedInputTokens reflects template + evidence size', () => {
  it('larger evidence → larger estimatedInputTokens', async () => {
    const giantTrace = {
      ...SAMPLE_TRACE,
      spanTree: Array.from({ length: 2000 }, (_, i) => ({
        serviceName: 'compute',
        operationName: `op_${i}_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
        durationMs: i,
        depth: 0,
      })),
    };
    const small = await handleGetNeondbRcaEvidence(
      { trace_id: SAMPLE_TRACE_ID },
      { fetcher: happyFetcher(), cache: new RcaCache() },
    );
    const big = await handleGetNeondbRcaEvidence(
      { trace_id: SAMPLE_TRACE_ID },
      {
        fetcher: { ...happyFetcher(), fetchTrace: async () => giantTrace },
        cache: new RcaCache(),
      },
    );
    expect(big.estimatedInputTokens).toBeGreaterThan(small.estimatedInputTokens);
  });
});

describe('feat-045 · case cache_hit · 同 trace_id 第二次 zero-fetch', () => {
  it('second call returns cached template + evidence · fetcher not invoked again', async () => {
    let traceCalls = 0;
    const cache = new RcaCache();
    const deps: GetNeondbRcaEvidenceDeps = {
      fetcher: {
        ...happyFetcher(),
        fetchTrace: async () => {
          traceCalls++;
          return SAMPLE_TRACE;
        },
      },
      cache,
    };
    const first = await handleGetNeondbRcaEvidence({ trace_id: SAMPLE_TRACE_ID }, deps);
    expect(first.cached).toBe(false);
    expect(traceCalls).toBe(1);

    const second = await handleGetNeondbRcaEvidence({ trace_id: SAMPLE_TRACE_ID }, deps);
    expect(second.cached).toBe(true);
    expect(second.templateMarkdown).toBe(first.templateMarkdown);
    expect(second.evidenceBundle).toEqual(first.evidenceBundle);
    expect(traceCalls).toBe(1);
  });
});

describe('feat-045 · case multi_degrade · 多 leg fail → audit reflects取证 outcome', () => {
  it('multiple leg failures land in degradedLegs + audit degraded_legs', async () => {
    const audits: Array<{ degraded_legs: string[] }> = [];
    const deps: GetNeondbRcaEvidenceDeps = {
      fetcher: {
        ...happyFetcher(),
        fetchAudit: async () => {
          throw new Error('unauthorized: insufficient grant');
        },
        fetchValidation: async () => {
          throw new Error('socket hang up');
        },
      },
      cache: new RcaCache(),
      emitAudit: (e) => audits.push(e as { degraded_legs: string[] }),
    };
    const r = await handleGetNeondbRcaEvidence({ trace_id: SAMPLE_TRACE_ID }, deps);
    expect(r.degradedLegs).toEqual(expect.arrayContaining(['audit', 'validation']));
    expect(audits[0]?.degraded_legs).toEqual(
      expect.arrayContaining(['audit', 'validation']),
    );
  });
});

describe('feat-045/#3 · zod schema validation', () => {
  it('rejects non-hex trace_id', () => {
    expect(() =>
      getNeondbRcaEvidenceInputSchema.parse({ trace_id: 'not-a-trace' }),
    ).toThrow();
  });
  it('accepts canonical 32-hex trace_id', () => {
    const r = getNeondbRcaEvidenceInputSchema.parse({ trace_id: SAMPLE_TRACE_ID });
    expect(r.trace_id).toBe(SAMPLE_TRACE_ID);
  });
  it('rejects malformed audit_filter timestamps via shape (strings required)', () => {
    expect(() =>
      getNeondbRcaEvidenceInputSchema.parse({
        trace_id: SAMPLE_TRACE_ID,
        audit_filter: { start: 123, end: 456 },
      }),
    ).toThrow();
  });
  it('schema dropped LLM-era fields (no model / cache / trace_state · form-shift 规则 P4)', () => {
    // unknown keys are stripped by zod (non-strict) · the parsed shape only carries trace_id + audit_filter
    const r = getNeondbRcaEvidenceInputSchema.parse({
      trace_id: SAMPLE_TRACE_ID,
      model: 'claude-opus-4-7',
      cache: true,
      trace_state: 'closed',
    } as Record<string, unknown>);
    expect(Object.keys(r)).not.toContain('model');
    expect(Object.keys(r)).not.toContain('cache');
    expect(Object.keys(r)).not.toContain('trace_state');
  });
});

describe('feat-045/#3 · token economy 跑批 (mini batch · #147 §跑批)', () => {
  it('aggregates 20-sample batch with input p99 < 6000 + cache hit rate computable', async () => {
    const cache = new RcaCache();
    const agg = new TokenEconomyAggregator();
    const N = 20;
    for (let i = 0; i < N; i++) {
      // half the samples reuse the same trace_id → cache hits
      const tid = i % 2 === 0 ? SAMPLE_TRACE_ID : SAMPLE_TRACE_ID.replace('a1', 'b2');
      const r = await handleGetNeondbRcaEvidence(
        { trace_id: tid },
        { fetcher: happyFetcher(), cache },
      );
      agg.record({
        traceId: tid,
        inputTokens: r.estimatedInputTokens,
        // no LLM output in mcp anymore (form-shift) · output token accounting moved to the cc skill
        outputTokens: 0,
        cached: r.cached,
        durationMs: r.duration_ms,
      });
    }
    const summary = agg.summary();
    expect(summary.n).toBe(N);
    expect(summary.cacheHitRate).toBeGreaterThan(0);
    expect(summary.inputP99).toBeLessThan(6000);
  });

  it('case names fixture is the canonical deterministic set the suite exercises', () => {
    expect(CASE_NAMES).toEqual([
      'standard',
      'probe_degraded',
      'token_estimate',
      'cache_hit',
      'multi_degrade',
    ]);
  });
});
