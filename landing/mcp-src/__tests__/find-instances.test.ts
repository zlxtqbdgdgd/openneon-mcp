/**
 * T1 find_neondb_instances handler unit tests (feat-001 #1 · L1 day-one ship).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-001-L1-mcp-tool-t1-find-instances.html
 *
 * Sales 剧本第 1 步入口工具 · 1 次调用拿到 project + branch + endpoint 全部必要信息·
 * agent 决定排障路径 · 不用 2-3 次串调 Neon API 浪费 token。
 *
 * Scope of #1 (this PR): handler + pool helper + zod input schema. Registry entry +
 * dispatch wiring + caching layer are separate sub-issues.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock list-projects helper before importing find-instances handler (which uses it)
vi.mock('../tools/handlers/list-projects', () => ({
  handleListProjects: vi.fn(),
}));

// Mock @sentry/node startSpan (passthrough)
vi.mock('@sentry/node', () => ({
  startSpan: vi.fn((_opts, fn) => fn()),
}));

import {
  handleFindNeondbInstances,
  pool,
} from '../tools/handlers/find-instances';
import { handleListProjects } from '../tools/handlers/list-projects';
import type { ToolHandlerExtraParams } from '../tools/types';

const mockHandleListProjects = vi.mocked(handleListProjects);
const mockExtra = { account: undefined } as unknown as ToolHandlerExtraParams;

type MockEndpoint = {
  id: string;
  type: 'read_write' | 'read_only';
  current_state: 'init' | 'active' | 'idle';
};

type MockBranch = {
  id: string;
  default: boolean;
};

// Helper returns a partial Project · cast at the mockResolvedValue boundary so individual
// tests stay terse (full Neon ProjectListItem has 16 fields most of which we don't use).
type MockProjectPartial = {
  id: string;
  name: string;
  region_id: string;
  compute_last_active_at: string;
};
function mockProject(over: Partial<MockProjectPartial> = {}): MockProjectPartial {
  return {
    id: over.id ?? 'proj-1',
    name: over.name ?? 'production',
    region_id: over.region_id ?? 'us-east-1',
    compute_last_active_at: over.compute_last_active_at ?? '2026-05-20T10:00:00Z',
  };
}
// Cast helper · convert mock projects to the full type the handler expects (handler only
// reads id/name/region_id/compute_last_active_at · other Neon ProjectListItem fields unused).
const asProjects = (ps: MockProjectPartial[]) =>
  ps as unknown as Parameters<typeof mockHandleListProjects.mockResolvedValue>[0];

function mockNeonClient(opts: {
  branchesByProject?: Record<string, MockBranch[]>;
  endpointsByProject?: Record<string, MockEndpoint[]>;
  branchesError?: string;
  endpointsError?: string;
}) {
  const branchesByProject = opts.branchesByProject ?? {};
  const endpointsByProject = opts.endpointsByProject ?? {};
  return {
    listProjectBranches: vi.fn(async ({ projectId }: { projectId: string }) => {
      if (opts.branchesError) throw new Error(opts.branchesError);
      return { data: { branches: branchesByProject[projectId] ?? [] } };
    }),
    listProjectEndpoints: vi.fn(async (projectId: string) => {
      if (opts.endpointsError) throw new Error(opts.endpointsError);
      return { data: { endpoints: endpointsByProject[projectId] ?? [] } };
    }),
  };
}

beforeEach(() => {
  mockHandleListProjects.mockReset();
});

describe('pool(items, limit, fn) · max-pool 10 并发 helper', () => {
  it('returns results in original input order', async () => {
    const result = await pool([1, 2, 3, 4, 5], 2, async (x) => x * 2);
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });

  it('respects concurrency limit (never more than `limit` in-flight at once)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await pool(items, 5, async (x) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return x;
    });
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1); // assert actual parallelism happened
  });

  it('handles empty items', async () => {
    const result = await pool([], 10, async (x) => x);
    expect(result).toEqual([]);
  });

  it('handles single item under limit', async () => {
    const result = await pool([42], 10, async (x) => x);
    expect(result).toEqual([42]);
  });
});

describe('handleFindNeondbInstances · sales 剧本入口', () => {
  const projects = [
    mockProject({ id: 'proj-1', name: 'production', region_id: 'us-east-1' }),
    mockProject({ id: 'proj-2', name: 'staging', region_id: 'us-east-1' }),
    mockProject({ id: 'proj-3', name: 'dev', region_id: 'eu-west-1' }),
  ];

  it('returns one row per project with branch/endpoint enrichment (default · no filter)', async () => {
    mockHandleListProjects.mockResolvedValue(asProjects(projects));
    const neonClient = mockNeonClient({
      branchesByProject: {
        'proj-1': [
          { id: 'br-1-main', default: true },
          { id: 'br-1-feature', default: false },
        ],
        'proj-2': [{ id: 'br-2-main', default: true }],
        'proj-3': [{ id: 'br-3-main', default: true }],
      },
      endpointsByProject: {
        'proj-1': [{ id: 'ep-1-rw', type: 'read_write', current_state: 'active' }],
        'proj-2': [{ id: 'ep-2-rw', type: 'read_write', current_state: 'idle' }],
        'proj-3': [
          { id: 'ep-3-rw', type: 'read_write', current_state: 'init' },
          { id: 'ep-3-ro', type: 'read_only', current_state: 'active' },
        ],
      },
    });

    const result = await handleFindNeondbInstances(
      {},
      neonClient as never,
      mockExtra,
    );

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      project_id: 'proj-1',
      name: 'production',
      region: 'us-east-1',
      status: 'running',
      branch_count: 2,
      active_endpoint_count: 1,
      primary_branch_id: 'br-1-main',
      primary_endpoint_id: 'ep-1-rw',
    });
  });

  it('status mapping · active→running / idle→suspended / init→creating', async () => {
    mockHandleListProjects.mockResolvedValue(asProjects(projects));
    const neonClient = mockNeonClient({
      branchesByProject: {
        'proj-1': [{ id: 'br-1', default: true }],
        'proj-2': [{ id: 'br-2', default: true }],
        'proj-3': [{ id: 'br-3', default: true }],
      },
      endpointsByProject: {
        'proj-1': [{ id: 'ep-1', type: 'read_write', current_state: 'active' }],
        'proj-2': [{ id: 'ep-2', type: 'read_write', current_state: 'idle' }],
        'proj-3': [{ id: 'ep-3', type: 'read_write', current_state: 'init' }],
      },
    });

    const result = await handleFindNeondbInstances(
      {},
      neonClient as never,
      mockExtra,
    );

    expect(result.find((r) => r.project_id === 'proj-1')?.status).toBe('running');
    expect(result.find((r) => r.project_id === 'proj-2')?.status).toBe('suspended');
    expect(result.find((r) => r.project_id === 'proj-3')?.status).toBe('creating');
  });

  it('filter.status: running · only running projects returned', async () => {
    mockHandleListProjects.mockResolvedValue(asProjects(projects));
    const neonClient = mockNeonClient({
      branchesByProject: {
        'proj-1': [{ id: 'br-1', default: true }],
        'proj-2': [{ id: 'br-2', default: true }],
        'proj-3': [{ id: 'br-3', default: true }],
      },
      endpointsByProject: {
        'proj-1': [{ id: 'ep-1', type: 'read_write', current_state: 'active' }],
        'proj-2': [{ id: 'ep-2', type: 'read_write', current_state: 'idle' }],
        'proj-3': [{ id: 'ep-3', type: 'read_write', current_state: 'init' }],
      },
    });

    const result = await handleFindNeondbInstances(
      { filter: { status: 'running' } },
      neonClient as never,
      mockExtra,
    );

    expect(result).toHaveLength(1);
    expect(result[0].project_id).toBe('proj-1');
  });

  it('filter.region: us-east-1 · only us-east-1 projects returned', async () => {
    mockHandleListProjects.mockResolvedValue(asProjects(projects));
    const neonClient = mockNeonClient({
      branchesByProject: { 'proj-1': [], 'proj-2': [], 'proj-3': [] },
      endpointsByProject: { 'proj-1': [], 'proj-2': [], 'proj-3': [] },
    });

    const result = await handleFindNeondbInstances(
      { filter: { region: 'us-east-1' } },
      neonClient as never,
      mockExtra,
    );

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.project_id).sort()).toEqual(['proj-1', 'proj-2']);
  });

  it('limit · default 100 hard cap; explicit limit honored', async () => {
    const manyProjects = Array.from({ length: 200 }, (_, i) =>
      mockProject({ id: `proj-${i}`, name: `name-${i}` }),
    );
    mockHandleListProjects.mockResolvedValue(asProjects(manyProjects));
    const neonClient = mockNeonClient({});

    const resultDefault = await handleFindNeondbInstances(
      {},
      neonClient as never,
      mockExtra,
    );
    expect(resultDefault.length).toBe(100); // default cap

    const resultLimit1 = await handleFindNeondbInstances(
      { limit: 1 },
      neonClient as never,
      mockExtra,
    );
    expect(resultLimit1.length).toBe(1);
  });

  it('limit · 500 hard ceiling (any larger request is clamped)', async () => {
    const manyProjects = Array.from({ length: 1000 }, (_, i) =>
      mockProject({ id: `proj-${i}` }),
    );
    mockHandleListProjects.mockResolvedValue(asProjects(manyProjects));
    const neonClient = mockNeonClient({});

    const result = await handleFindNeondbInstances(
      { limit: 9999 },
      neonClient as never,
      mockExtra,
    );
    expect(result.length).toBe(500);
  });

  it('primary branch derivation · `default: true` preferred, fallback to first', async () => {
    mockHandleListProjects.mockResolvedValue(asProjects([mockProject({ id: 'proj-1' })]));
    const neonClient = mockNeonClient({
      branchesByProject: {
        'proj-1': [
          { id: 'br-1-feature', default: false },
          { id: 'br-1-main', default: true }, // not first but is default
        ],
      },
      endpointsByProject: { 'proj-1': [] },
    });

    const result = await handleFindNeondbInstances(
      {},
      neonClient as never,
      mockExtra,
    );
    expect(result[0].primary_branch_id).toBe('br-1-main');
  });

  it('primary endpoint derivation · `type: read_write` preferred', async () => {
    mockHandleListProjects.mockResolvedValue(asProjects([mockProject({ id: 'proj-1' })]));
    const neonClient = mockNeonClient({
      branchesByProject: { 'proj-1': [] },
      endpointsByProject: {
        'proj-1': [
          { id: 'ep-1-ro', type: 'read_only', current_state: 'active' },
          { id: 'ep-1-rw', type: 'read_write', current_state: 'active' }, // not first but is rw
        ],
      },
    });

    const result = await handleFindNeondbInstances(
      {},
      neonClient as never,
      mockExtra,
    );
    expect(result[0].primary_endpoint_id).toBe('ep-1-rw');
  });

  it('active_endpoint_count counts only current_state === active', async () => {
    mockHandleListProjects.mockResolvedValue(asProjects([mockProject({ id: 'proj-1' })]));
    const neonClient = mockNeonClient({
      branchesByProject: { 'proj-1': [] },
      endpointsByProject: {
        'proj-1': [
          { id: 'ep-1', type: 'read_write', current_state: 'active' },
          { id: 'ep-2', type: 'read_only', current_state: 'active' },
          { id: 'ep-3', type: 'read_only', current_state: 'idle' },
          { id: 'ep-4', type: 'read_only', current_state: 'init' },
        ],
      },
    });

    const result = await handleFindNeondbInstances(
      {},
      neonClient as never,
      mockExtra,
    );
    expect(result[0].active_endpoint_count).toBe(2);
  });

  it('per-project enrichment failure · returns base fields (graceful degradation per §8)', async () => {
    mockHandleListProjects.mockResolvedValue(asProjects([mockProject({ id: 'proj-fail' })]));
    const neonClient = mockNeonClient({
      branchesByProject: {},
      endpointsByProject: {},
      branchesError: 'Neon API 503',
    });

    const result = await handleFindNeondbInstances(
      {},
      neonClient as never,
      mockExtra,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      project_id: 'proj-fail',
      name: 'production',
      region: 'us-east-1',
      // Enrichment fields null on failure
      status: null,
      branch_count: null,
      active_endpoint_count: null,
      primary_branch_id: null,
      primary_endpoint_id: null,
    });
  });

  it('empty endpoint list · status null (not "running"/"suspended")', async () => {
    mockHandleListProjects.mockResolvedValue(asProjects([mockProject({ id: 'proj-empty' })]));
    const neonClient = mockNeonClient({
      branchesByProject: { 'proj-empty': [{ id: 'br-1', default: true }] },
      endpointsByProject: { 'proj-empty': [] },
    });

    const result = await handleFindNeondbInstances(
      {},
      neonClient as never,
      mockExtra,
    );
    expect(result[0].status).toBeNull();
    expect(result[0].primary_endpoint_id).toBeNull();
    expect(result[0].active_endpoint_count).toBe(0);
  });
});
