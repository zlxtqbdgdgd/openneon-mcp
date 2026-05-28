/**
 * feat-045/#2 unit tests · `Promise.allSettled` 4-leg parallel fetcher.
 *
 * Detail design: openneon-mcp#146 §验收门.
 *
 * Covers:
 *   - 全部 4 leg 齐 → bundle.*.ok=true
 *   - 任一 leg reject → 对应 leg.ok=false · reason 分类
 *   - 一个 leg 慢 (delay) 不阻塞其他 leg (并行 vs 串行 时间证据)
 *   - error reason classification (auth / timeout / unavailable)
 */

import { describe, it, expect } from 'vitest';
import { fetchRcaBundle, type RcaFetcherDeps } from '../server-enrich/rca/data-fetcher';
import {
  SAMPLE_TRACE,
  SAMPLE_PROBE,
  SAMPLE_AUDIT,
  SAMPLE_VALIDATION,
  SAMPLE_TRACE_ID,
} from './fixtures/feat-045-rca-cases';

function happyDeps(): RcaFetcherDeps {
  return {
    fetchTrace: async () => SAMPLE_TRACE,
    fetchProbe: async () => SAMPLE_PROBE,
    fetchAudit: async () => SAMPLE_AUDIT,
    fetchValidation: async () => SAMPLE_VALIDATION,
  };
}

describe('feat-045/#2 · data-fetcher happy path', () => {
  it('all 4 legs ok=true when every fetcher resolves', async () => {
    const bundle = await fetchRcaBundle(SAMPLE_TRACE_ID, happyDeps());
    expect(bundle.trace.ok).toBe(true);
    expect(bundle.probe.ok).toBe(true);
    expect(bundle.audit.ok).toBe(true);
    expect(bundle.validation.ok).toBe(true);
    if (bundle.trace.ok) expect(bundle.trace.data.componentLatency.length).toBeGreaterThan(0);
  });
});

describe('feat-045/#2 · per-leg degrade', () => {
  it('probe rejection → probe.ok=false · other legs unaffected', async () => {
    const deps: RcaFetcherDeps = {
      ...happyDeps(),
      fetchProbe: async () => {
        throw new Error('probe attach timeout');
      },
    };
    const bundle = await fetchRcaBundle(SAMPLE_TRACE_ID, deps);
    expect(bundle.probe.ok).toBe(false);
    if (!bundle.probe.ok) expect(bundle.probe.reason).toBe('timeout');
    expect(bundle.trace.ok).toBe(true);
    expect(bundle.audit.ok).toBe(true);
    expect(bundle.validation.ok).toBe(true);
  });

  it('audit rejection with "unauthorized" → reason=auth', async () => {
    const deps: RcaFetcherDeps = {
      ...happyDeps(),
      fetchAudit: async () => {
        throw new Error('unauthorized: insufficient grant');
      },
    };
    const bundle = await fetchRcaBundle(SAMPLE_TRACE_ID, deps);
    expect(bundle.audit.ok).toBe(false);
    if (!bundle.audit.ok) expect(bundle.audit.reason).toBe('auth');
  });

  it('generic rejection → reason=unavailable', async () => {
    const deps: RcaFetcherDeps = {
      ...happyDeps(),
      fetchValidation: async () => {
        throw new Error('socket hang up');
      },
    };
    const bundle = await fetchRcaBundle(SAMPLE_TRACE_ID, deps);
    expect(bundle.validation.ok).toBe(false);
    if (!bundle.validation.ok) expect(bundle.validation.reason).toBe('unavailable');
  });
});

describe('feat-045/#2 · parallelism (allSettled vs serial)', () => {
  it('slow leg does not delay overall completion beyond its own duration', async () => {
    const SLOW_MS = 50;
    const deps: RcaFetcherDeps = {
      fetchTrace: async () => {
        await new Promise((r) => setTimeout(r, SLOW_MS));
        return SAMPLE_TRACE;
      },
      fetchProbe: async () => {
        await new Promise((r) => setTimeout(r, SLOW_MS));
        return SAMPLE_PROBE;
      },
      fetchAudit: async () => {
        await new Promise((r) => setTimeout(r, SLOW_MS));
        return SAMPLE_AUDIT;
      },
      fetchValidation: async () => {
        await new Promise((r) => setTimeout(r, SLOW_MS));
        return SAMPLE_VALIDATION;
      },
    };
    const t0 = Date.now();
    await fetchRcaBundle(SAMPLE_TRACE_ID, deps);
    const elapsed = Date.now() - t0;
    // serial would be 4 × SLOW_MS = 200ms · parallel should be ~50ms ± jitter.
    expect(elapsed).toBeLessThan(SLOW_MS * 3);
  });
});
