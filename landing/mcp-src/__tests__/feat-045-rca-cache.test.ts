/**
 * feat-045/#3 cache unit tests · openneon-mcp#147 · form-shift (规则 P4 · LLM-out-of-mcp).
 *
 * The RCA cache stores the deterministic取证 product (pre-filled template + raw evidence bundle),
 * keyed by trace_id alone (form-shift dropped model selection from the mcp tool). Plan-mode + cost
 * estimation moved out of mcp (they belong to the cc skill), so this file only exercises the cache.
 *
 * - cache key = trace_id (no model bucket anymore)
 * - state-aware TTL (ongoing 60s default · closed 24h)
 * - entry carries templateMarkdown + evidenceBundle + estimatedInputTokens + degradedLegs
 */

import { describe, it, expect } from 'vitest';
import { RcaCache, type RcaCacheEntry } from '../server-enrich/rca/cache';
import type { RcaDataBundle } from '../server-enrich/rca/types';
import {
  SAMPLE_TRACE,
  SAMPLE_PROBE,
  SAMPLE_AUDIT,
  SAMPLE_VALIDATION,
} from './fixtures/feat-045-rca-cases';

function fakeBundle(): RcaDataBundle {
  return {
    trace: { ok: true, data: SAMPLE_TRACE },
    probe: { ok: true, data: SAMPLE_PROBE },
    audit: { ok: true, data: SAMPLE_AUDIT },
    validation: { ok: true, data: SAMPLE_VALIDATION },
  };
}

function fakeEntry(): RcaCacheEntry {
  return {
    templateMarkdown: '# RCA · trace_id=t · 2026-05-28T12:00:00Z',
    evidenceBundle: fakeBundle(),
    generatedAt: '2026-05-28T12:00:00Z',
    estimatedInputTokens: 1500,
    degradedLegs: [],
  };
}

describe('feat-045/#3 · RcaCache state-aware TTL (keyed by trace_id)', () => {
  it('ongoing trace expires after 60s (default state)', () => {
    let now = 0;
    const cache = new RcaCache(() => now);
    cache.set('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', fakeEntry());
    expect(cache.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1')).toBeDefined();
    now = 59_000;
    expect(cache.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1')).toBeDefined();
    now = 61_000;
    expect(cache.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1')).toBeUndefined();
  });

  it('closed trace survives 1 hour (24h TTL)', () => {
    let now = 0;
    const cache = new RcaCache(() => now);
    cache.set('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2', fakeEntry(), 'closed');
    now = 60 * 60 * 1000; // 1h
    expect(cache.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2')).toBeDefined();
  });

  it('different trace_ids cache separately', () => {
    const cache = new RcaCache();
    cache.set('t1', fakeEntry(), 'closed');
    expect(cache.get('t2')).toBeUndefined();
    expect(cache.get('t1')).toBeDefined();
  });
});

describe('feat-045/#3 · cache entry carries template + evidence (no LLM markdown)', () => {
  it('round-trips templateMarkdown + evidenceBundle + estimatedInputTokens', () => {
    const cache = new RcaCache();
    const entry = fakeEntry();
    cache.set('t1', entry, 'closed');
    const got = cache.get('t1');
    expect(got?.templateMarkdown).toBe(entry.templateMarkdown);
    expect(got?.evidenceBundle).toEqual(entry.evidenceBundle);
    expect(got?.estimatedInputTokens).toBe(1500);
    expect(got?.degradedLegs).toEqual([]);
  });
});
