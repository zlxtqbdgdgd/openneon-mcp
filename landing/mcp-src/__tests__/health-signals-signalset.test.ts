/**
 * T4 full L2a signal set + neon-extension graceful degradation · feat-020/#5 (L2a).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-020-L2-mcp-tool-t4-health-signals.html §6 §7
 *
 * Asserts: the registry covers the L2a signal set with correct flags; a missing neon extension
 * makes LFC-class signals 'unavailable' while standard signals still return (graceful · never an
 * error); storage_size is NOT baselined (monotonic · would otherwise always report high); depth
 * shallow surfaces anomalous + unavailable + key signals. DB is mocked by SQL content; baseline/SLO
 * degrade naturally (no Datadog creds in test env).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSqlQuery = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => ({ query: mockSqlQuery })),
}));

vi.mock('../tools/handlers/connection-string', () => ({
  handleGetConnectionString: vi.fn().mockResolvedValue({
    uri: 'postgresql://mock-user:mock-pass@mock-host.neon.tech/mock-db',
    computeId: 'ep-mock',
  }),
}));

vi.mock('@sentry/node', () => ({
  startSpan: vi.fn((_opts, fn) => fn()),
}));

import { handleGetHealthSignals } from '../tools/handlers/health-signals';
import { SIGNAL_REGISTRY, getSignalDef } from '../tools/signal-registry';
import type { ToolHandlerExtraParams } from '../tools/types';

const mockNeonClient = {} as unknown as Parameters<
  typeof handleGetHealthSignals
>[1];
const mockExtra = { account: undefined } as unknown as ToolHandlerExtraParams;

/** Mock the DB by SQL content (order-independent). `neonInstalled` toggles the extension gate. */
function mockDb(neonInstalled: boolean) {
  mockSqlQuery.mockImplementation(async (q: string) => {
    if (q.includes('pg_extension')) return [{ has_neon: neonInstalled }];
    if (q.includes('pg_stat_activity')) return [{ value: 10 }];
    if (q.includes('pg_stat_database')) return [{ value: 0.95 }];
    if (q.includes('pg_stat_replication')) return [{ value: null }]; // single-node → no replica
    if (q.includes('pg_database_size')) return [{ value: 8_000_000 }];
    if (q.includes('neon_stat_file_cache')) return [{ value: 0.88 }];
    return [];
  });
}

beforeEach(() => {
  mockSqlQuery.mockReset();
});

describe('signal registry · L2a set shape', () => {
  it('covers the L2a signals', () => {
    const names = SIGNAL_REGISTRY.map((s) => s.signal);
    expect(names).toEqual(
      expect.arrayContaining([
        'connections',
        'cache_hit_ratio',
        'replication_lag_seconds',
        'storage_size_bytes',
        'lfc_hit_rate',
      ]),
    );
  });

  it('storage_size is NOT baseline_applicable (monotonic · would always report high)', () => {
    expect(getSignalDef('storage_size_bytes')?.baselineApplicable).toBe(false);
  });

  it('lfc_hit_rate requires the neon extension', () => {
    expect(getSignalDef('lfc_hit_rate')?.requiresNeonExt).toBe(true);
  });

  it('every signal declares source / requiresNeonExt / baselineApplicable / sliDirection', () => {
    for (const def of SIGNAL_REGISTRY) {
      expect(typeof def.source).toBe('string');
      expect(typeof def.requiresNeonExt).toBe('boolean');
      expect(typeof def.baselineApplicable).toBe('boolean');
      expect(['high-bad', 'low-bad', 'none']).toContain(def.sliDirection);
    }
  });
});

describe('neon extension graceful degradation', () => {
  it('extension absent → LFC unavailable · standard signals still return (graceful · no error)', async () => {
    mockDb(false);
    const result = await handleGetHealthSignals(
      { projectId: 'p', depth: 'full' },
      mockNeonClient,
      mockExtra,
    );

    const lfc = result.find((s) => s.signal_type === 'lfc_hit_rate')!;
    expect(lfc.status).toBe('unavailable');
    expect(lfc.value).toBeNull();

    // Standard signals unaffected.
    expect(result.find((s) => s.signal_type === 'connections')?.status).toBe('ok');
    expect(result.find((s) => s.signal_type === 'cache_hit_ratio')?.status).toBe('ok');
    expect(result.find((s) => s.signal_type === 'storage_size_bytes')?.status).toBe('ok');
  });

  it('extension present → LFC returns its value', async () => {
    mockDb(true);
    const result = await handleGetHealthSignals(
      { projectId: 'p', depth: 'full' },
      mockNeonClient,
      mockExtra,
    );
    const lfc = result.find((s) => s.signal_type === 'lfc_hit_rate')!;
    expect(lfc.status).toBe('ok');
    expect(lfc.value).toBeCloseTo(0.88, 5);
  });

  it('replication unavailable on single-node (0 replicas) · honest, not value 0', async () => {
    mockDb(false);
    const result = await handleGetHealthSignals(
      { projectId: 'p', depth: 'full' },
      mockNeonClient,
      mockExtra,
    );
    const repl = result.find((s) => s.signal_type === 'replication_lag_seconds')!;
    expect(repl.status).toBe('unavailable');
    expect(repl.value).toBeNull();
  });
});

describe('storage_size not baselined (不误报 high)', () => {
  it('storage_size returns current value · no baseline fields · status ok', async () => {
    mockDb(false);
    const result = await handleGetHealthSignals(
      { projectId: 'p', depth: 'full' },
      mockNeonClient,
      mockExtra,
    );
    const storage = result.find((s) => s.signal_type === 'storage_size_bytes')!;
    expect(storage.status).toBe('ok');
    expect(storage.value).toBe(8_000_000);
    expect(storage.baseline_value).toBeUndefined();
    expect(storage.robust_z).toBeUndefined();
    expect(storage.label).toBeUndefined();
  });
});

describe('progressive depth over the full set', () => {
  it('shallow surfaces unavailable + key signals · full returns all', async () => {
    mockDb(false);
    const shallow = await handleGetHealthSignals(
      { projectId: 'p' }, // default shallow
      mockNeonClient,
      mockExtra,
    );
    const shallowNames = shallow.map((s) => s.signal_type);
    // key signals shown even when ok
    expect(shallowNames).toContain('connections');
    expect(shallowNames).toContain('cache_hit_ratio');
    expect(shallowNames).toContain('storage_size_bytes');
    // unavailable signals surfaced (honest)
    expect(shallowNames).toContain('lfc_hit_rate');
    expect(shallowNames).toContain('replication_lag_seconds');

    const full = await handleGetHealthSignals(
      { projectId: 'p', depth: 'full' },
      mockNeonClient,
      mockExtra,
    );
    expect(full).toHaveLength(SIGNAL_REGISTRY.length);
  });
});
