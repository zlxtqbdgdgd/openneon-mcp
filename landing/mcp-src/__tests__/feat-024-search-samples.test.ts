/**
 * feat-024-search-samples.test.ts · feat-024/#3 · T11 handler + collector + role 隐藏 (§7 用例 14-20)。
 *
 * 覆盖: T11 filter 经 handler · sensitive_redact_count_total · audit emit · auto_explain collector
 * 强制脱敏 · feat-059 customer-service role 隐藏 / data-analyst 可见。
 *
 * 铁律: 本仓不跑测试 · 本文件写出即可。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { MemorySamplesStore } from '../server-enrich/samples-store/memory-store';
import {
  _resetSamplesStoreForTests,
  getSamplesStore,
} from '../server-enrich/samples-store';
import { obfuscate } from '../server-enrich/samples-store/obfuscator';
import { makeRawSample } from '../server-enrich/samples-store/raw-sample';
import { runAutoExplainCollectorOnce } from '../server-enrich/samples-store/auto-explain-collector';
import { handleSearchSamples } from '../tools/handlers/search-samples';
import { filterToolsByRole } from '../tools/role-toolsets';
import * as auditEmit from '../observability/audit-emit';

const PROJECT = 'rapid-art-12345';

function writeObf(
  store: MemorySamplesStore,
  rawQuery: string,
  rawParams: unknown[],
  over: { duration_ms?: number; captured_at?: number; signature?: string } = {},
) {
  const s = obfuscate(
    makeRawSample({
      duration_ms: over.duration_ms ?? 1000,
      raw_plan: '{}',
      raw_query: rawQuery,
      raw_params: rawParams,
      captured_at: over.captured_at ?? Date.now(),
    }),
    PROJECT,
    'strict',
  );
  return store.writeSample(over.signature ? { ...s, signature: over.signature } : s);
}

let store: MemorySamplesStore;

beforeEach(() => {
  store = new MemorySamplesStore(86_400_000, () => Date.now());
  _resetSamplesStoreForTests(store);
});
afterEach(() => {
  _resetSamplesStoreForTests(undefined);
  vi.restoreAllMocks();
});

describe('feat-024/#3 · T11 handler', () => {
  it('用例14 · filter signature 经 handler', async () => {
    await writeObf(store, "SELECT * FROM orders WHERE id=1", [1], { signature: 'AAAAAAAAAAAAAAAA' });
    await writeObf(store, "SELECT * FROM users WHERE id=2", [2], { signature: 'BBBBBBBBBBBBBBBB' });
    const r = await handleSearchSamples({ projectId: PROJECT, signature: 'AAAAAAAAAAAAAAAA' });
    expect(r.hits).toBe(1);
  });

  it('用例16 · filter duration_min_ms', async () => {
    await writeObf(store, 'SELECT 1', [], { duration_ms: 2340, signature: 's1'.padEnd(16, '0') });
    await writeObf(store, 'SELECT 2', [], { duration_ms: 100, signature: 's2'.padEnd(16, '0') });
    const r = await handleSearchSamples({ projectId: PROJECT, duration_min_ms: 1000 });
    expect(r.hits).toBe(1);
  });

  it('用例17 · sensitive_redact_count_total 累计', async () => {
    await writeObf(store, "SELECT * FROM o WHERE id=1 AND status='open'", [1, 'open']);
    const r = await handleSearchSamples({ projectId: PROJECT });
    expect(r.sensitive_redact_count_total).toBe(2);
  });

  it('用例 · T11 输出全脱敏 · CSV row 不含 raw value', async () => {
    await writeObf(store, "SELECT * FROM orders WHERE id=42 AND email='alice@acme.com'", [42, 'alice@acme.com']);
    const r = await handleSearchSamples({ projectId: PROJECT });
    expect(r.rows[0].query_obfuscated).toBe('SELECT * FROM orders WHERE id=$1 AND email=$2');
    expect(r.rows[0].query_obfuscated).not.toContain('alice@acme.com');
  });

  it('用例 · depth full 仍脱敏', async () => {
    await writeObf(store, "WHERE id=1", [1]);
    const r = await handleSearchSamples({ projectId: PROJECT, depth: 'full' });
    expect(r.depth).toBe('full');
    expect(r.full).toBeDefined();
    expect(r.full?.[0].__brand).toBe('obfuscated');
  });

  it('用例18 · audit emit search_samples_invoked 含 redact_count', async () => {
    const spy = vi.spyOn(auditEmit, 'emitAuditEvent').mockImplementation(() => {});
    await writeObf(store, "WHERE id=1 AND s='open'", [1, 'open']);
    await handleSearchSamples({ projectId: PROJECT });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'search_samples_invoked', project_id: PROJECT }),
    );
    expect(spy.mock.calls[0][0].extra).toMatchObject({
      hits: 1,
      sensitive_redact_count_total: 2,
      backend: 'memory',
    });
  });

  it('empty store · 0 hit', async () => {
    const r = await handleSearchSamples({ projectId: PROJECT });
    expect(r.hits).toBe(0);
  });
});

describe('feat-024/#3 · auto_explain collector 强制脱敏', () => {
  it('用例 · collector parse → obfuscate (必经) → writeSample · store 0 raw', async () => {
    const logEntry = JSON.stringify({
      duration: 2340,
      plan: {
        'Query Text': "SELECT * FROM orders WHERE id=42 AND email='alice@acme.com'",
        Plan: { 'Node Type': 'Seq Scan' },
      },
    });
    const written = await runAutoExplainCollectorOnce({
      projectId: PROJECT,
      store: getSamplesStore(),
      logSource: async () => [logEntry],
      warn: () => {},
    });
    expect(written).toBe(1);
    const hits = await getSamplesStore().searchSamples({ projectId: PROJECT });
    expect(hits[0].query_text_obfuscated).toBe(
      'SELECT * FROM orders WHERE id=$1 AND email=$2',
    );
    expect(hits[0].query_text_obfuscated).not.toContain('alice@acme.com');
  });

  it('用例 · log source 不可用 (auto_explain 未启) → graceful 0 写', async () => {
    const written = await runAutoExplainCollectorOnce({
      projectId: PROJECT,
      store: getSamplesStore(),
      logSource: async () => {
        throw new Error('no log file');
      },
      warn: () => {},
    });
    expect(written).toBe(0);
  });
});

describe('feat-024/#3 · feat-059 role 隐藏 (§7 用例 19-20)', () => {
  const tools = [
    { name: 'find_neondb_instances' },
    { name: 'get_neondb_query_samples' }, // T11
    { name: 'get_neondb_explain_plans' },
  ];

  it('用例19 · customer-service role · tools/list 不见 T11', () => {
    const visible = filterToolsByRole(tools, 'customer-service').map((t) => t.name);
    expect(visible).not.toContain('get_neondb_query_samples');
  });

  it('用例20 · data-analyst role · T11 在 listing', () => {
    const visible = filterToolsByRole(tools, 'data-analyst').map((t) => t.name);
    expect(visible).toContain('get_neondb_query_samples');
  });

  it('用例20b · ops / sre role · T11 在 listing', () => {
    for (const role of ['ops', 'sre'] as const) {
      const visible = filterToolsByRole(tools, role).map((t) => t.name);
      expect(visible).toContain('get_neondb_query_samples');
    }
  });
});
