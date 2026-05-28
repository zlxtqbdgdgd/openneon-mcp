/**
 * feat-045/#3 cache + plan-mode unit tests · openneon-mcp#146 #147.
 *
 * - cache TTL state-aware (ongoing 60s · closed 24h)
 * - cost estimation per model
 * - plan payload shape conforms to feat-027 contract subset
 */

import { describe, it, expect } from 'vitest';
import { RcaCache, type RcaCacheEntry } from '../server-enrich/rca/cache';
import {
  estimateCostUsd,
  buildPlanPayload,
} from '../server-enrich/rca/plan-mode';
import type { RcaModelId } from '../server-enrich/rca/llm-client';

function fakeEntry(): RcaCacheEntry {
  return {
    markdown: '# md',
    generatedAt: '2026-05-28T12:00:00Z',
    inputTokens: 100,
    outputTokens: 200,
    model: 'claude-opus-4-7',
  };
}

describe('feat-045/#3 · RcaCache state-aware TTL', () => {
  it('ongoing trace expires after 60s', () => {
    let now = 0;
    const cache = new RcaCache(() => now);
    cache.set(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
      'claude-opus-4-7',
      fakeEntry(),
      'ongoing',
    );
    expect(cache.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 'claude-opus-4-7')).toBeDefined();
    now = 59_000;
    expect(cache.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 'claude-opus-4-7')).toBeDefined();
    now = 61_000;
    expect(cache.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 'claude-opus-4-7')).toBeUndefined();
  });

  it('closed trace survives 1 hour (24h TTL)', () => {
    let now = 0;
    const cache = new RcaCache(() => now);
    cache.set(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2',
      'claude-opus-4-7',
      fakeEntry(),
      'closed',
    );
    now = 60 * 60 * 1000; // 1h
    expect(cache.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2', 'claude-opus-4-7')).toBeDefined();
  });

  it('different model ids cache separately under same trace_id', () => {
    const cache = new RcaCache();
    cache.set('t1', 'claude-opus-4-7', fakeEntry(), 'closed');
    expect(cache.get('t1', 'claude-haiku-4-5')).toBeUndefined();
    expect(cache.get('t1', 'claude-opus-4-7')).toBeDefined();
  });
});

describe('feat-045/#2 · plan payload cost estimate', () => {
  const models: RcaModelId[] = [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ];

  it('every model has a non-negative cost estimate', () => {
    for (const m of models) {
      const usd = estimateCostUsd(m, 1000, 1000);
      expect(usd).toBeGreaterThan(0);
    }
  });

  it('haiku is cheaper than opus at same token counts', () => {
    const opus = estimateCostUsd('claude-opus-4-7', 1000, 1000);
    const haiku = estimateCostUsd('claude-haiku-4-5', 1000, 1000);
    expect(haiku).toBeLessThan(opus);
  });

  it('buildPlanPayload includes server facts only (no speculative prediction)', () => {
    const p = buildPlanPayload({
      traceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      model: 'claude-opus-4-7',
      estimatedInputTokens: 1500,
      estimatedMaxOutputTokens: 4500,
    });
    expect(p.tool).toBe('generate_rca_report');
    expect(p.estimatedCostUsd).toBeGreaterThan(0);
    expect(Object.keys(p)).not.toContain('predicted_p95');
    expect(Object.keys(p)).not.toContain('expected_improvement');
  });
});
