import { describe, it, expect } from 'vitest';
import {
  filterToolsForGrant,
  getAvailableTools,
  getAccessControlWarnings,
  injectProjectId,
} from '../tools/grant-filter';
import type { GrantContext, ScopeCategory } from '../utils/grant-context';
import { NEON_TOOLS } from '../tools/definitions';

function grant(overrides: Partial<GrantContext> = {}): GrantContext {
  return {
    projectId: null,
    scopes: null,
    ...overrides,
  };
}

describe('filterToolsForGrant', () => {
  it('returns all tools when no scopes and no project id', () => {
    const tools = filterToolsForGrant(NEON_TOOLS, grant());
    expect(tools).toHaveLength(NEON_TOOLS.length);
  });

  it('filters by scope categories', () => {
    const tools = filterToolsForGrant(
      NEON_TOOLS,
      grant({ scopes: ['querying'] }),
    );
    const names = tools.map((t) => t.name);
    expect(tools).toHaveLength(21); // 10 upstream + 2 day-one (T6 · T2) + feat-019 explain_plans + feat-020 T4 + feat-021 T5 + feat-025 T12 + feat-066/#2 trace get/search · all scope='querying'
    expect(names).toContain('run_sql');
    expect(names).toContain('search');
    expect(names).toContain('fetch');
    expect(names).toContain('get_neondb_query_statement'); // T6 day-one
    expect(names).not.toContain('create_project');
  });

  it('returns only always-available tools when scopes are empty', () => {
    const tools = filterToolsForGrant(NEON_TOOLS, grant({ scopes: [] }));
    expect(tools.map((t) => t.name).sort()).toEqual(['fetch', 'search']);
  });

  it('hides project-agnostic tools in project-scoped mode', () => {
    const tools = filterToolsForGrant(
      NEON_TOOLS,
      grant({ projectId: 'proj-123', scopes: null }),
    );
    const names = tools.map((t) => t.name);
    expect(tools).toHaveLength(37); // 24 upstream + 3 day-one (T6/T8/T2) + feat-057 get_policy + feat-019 explain_plans + feat-020 T4 + feat-021 T5 + feat-025 T12 + feat-066/#2 trace get/search (require projectId · T1 hidden)
    expect(names).not.toContain('list_projects');
    expect(names).not.toContain('create_project');
    expect(names).not.toContain('search');
    expect(names).not.toContain('fetch');
    expect(names).toContain('describe_project');
    expect(names).toContain('get_neondb_query_statement'); // T6 day-one
    expect(names).toContain('get_neondb_schemas'); // T8 day-one
  });

  it('combines scope and project filtering', () => {
    const tools = filterToolsForGrant(
      NEON_TOOLS,
      grant({ projectId: 'proj-123', scopes: ['querying'] }),
    );
    expect(tools).toHaveLength(19); // 8 upstream + 2 day-one (T6/T2) + feat-019 explain_plans + feat-020 T4 + feat-021 T5 + feat-025 T12 + feat-066/#2 trace get/search · scope='querying' + require projectId
    const names = tools.map((t) => t.name);
    expect(names).toContain('run_sql');
    expect(names).toContain('get_neondb_query_statement'); // T6 day-one
    expect(names).not.toContain('search');
    expect(names).not.toContain('fetch');
  });
});

describe('getAvailableTools', () => {
  it('applies read-only filter after grant filtering', () => {
    const tools = getAvailableTools(grant({ scopes: ['querying'] }), true);
    expect(tools).toHaveLength(17); // 6 upstream + 2 day-one (T6/T2) + feat-019 explain_plans + feat-020 T4 + feat-021 T5 + feat-025 T12 + feat-066/#2 trace get/search · scope='querying' + readOnlySafe
    for (const tool of tools) {
      expect(tool.readOnlySafe).toBe(true);
    }
  });

  it('keeps full toolset when readOnly is false', () => {
    const tools = getAvailableTools(grant(), false);
    expect(tools).toHaveLength(NEON_TOOLS.length);
  });

  it('appends read-only notice to tool descriptions when read-only is enabled', () => {
    const tools = getAvailableTools(grant(), true);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.description).toContain(
        'configured with read-only permissions',
      );
      expect(tool.description).toContain('<notice>');
    }
  });

  it('appends project-scoped notice with project id to tool descriptions', () => {
    const tools = getAvailableTools(grant({ projectId: 'proj-123' }), false);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.description).toContain(
        'configured and scoped to one project only (proj-123)',
      );
    }
  });
});

describe('getAccessControlWarnings', () => {
  it('warns when no valid scope categories are set', () => {
    const warnings = getAccessControlWarnings(grant({ scopes: [] }), false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('No valid scope categories');
  });

  it('warns with no-tools message when project-scoped and scopes are invalid', () => {
    const warnings = getAccessControlWarnings(
      grant({ projectId: 'proj-123', scopes: [] }),
      false,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('No tools are available.');
  });

  it('returns no warnings for null or valid scopes when no access restrictions are set', () => {
    expect(getAccessControlWarnings(grant({ scopes: null }), false)).toEqual(
      [],
    );
    expect(
      getAccessControlWarnings(grant({ scopes: ['schema'] }), false),
    ).toEqual([]);
  });
});

describe('injectProjectId', () => {
  it('injects project id when grant is project-scoped', () => {
    const args = { branchId: 'br-1' };
    expect(injectProjectId(args, grant({ projectId: 'proj-123' }))).toEqual({
      branchId: 'br-1',
      projectId: 'proj-123',
    });
  });

  it('returns args unchanged when not project-scoped', () => {
    const args = { projectId: 'proj-keep', branchId: 'br-1' };
    expect(injectProjectId(args, grant())).toEqual(args);
  });
});

describe('getAvailableTools categoryInclude filter (feat-005 #3)', () => {
  it('categoryInclude="core" filters to day-one core tools only (T1/T2/T6/T8 · day-one core 满)', () => {
    const tools = getAvailableTools(grant(), false, 'core');
    const names = tools.map((t) => t.name);
    expect(names).toContain('find_neondb_instances'); // T1 core
    expect(names).toContain('get_neondb_calling_services'); // T2 core
    expect(names).toContain('get_neondb_query_statement'); // T6 core
    expect(names).toContain('get_neondb_schemas'); // T8 core
    expect(names).not.toContain('run_sql'); // upstream optional
    expect(names).not.toContain('list_projects'); // upstream optional
    expect(names).not.toContain('delete_branch'); // upstream optional
  });

  it('categoryInclude="all" returns full toolset (no category filter)', () => {
    const tools = getAvailableTools(grant(), false, 'all');
    expect(tools).toHaveLength(NEON_TOOLS.length);
  });

  it('categoryInclude omitted → defaults to "all" (backward-compat for non-HTTP callers · prod routes pass explicit)', () => {
    const tools = getAvailableTools(grant(), false);
    expect(tools).toHaveLength(NEON_TOOLS.length);
  });

  it('categoryInclude="core" + readOnly: only core tools that are readOnlySafe', () => {
    const tools = getAvailableTools(grant(), true, 'core');
    const names = tools.map((t) => t.name);
    // T6 + T8 both readOnlySafe → both survive
    expect(names).toContain('get_neondb_query_statement');
    expect(names).toContain('get_neondb_schemas');
    for (const tool of tools) {
      expect(tool.readOnlySafe).toBe(true);
    }
  });

  it('categoryInclude="core" + project-scoped grant: T6/T8 survive (both require projectId · already in core listing)', () => {
    const tools = getAvailableTools(
      grant({ projectId: 'proj-123' }),
      false,
      'core',
    );
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_neondb_query_statement');
    expect(names).toContain('get_neondb_schemas');
    // project-agnostic excluded already
    expect(names).not.toContain('list_projects');
  });

  it('core listing budget invariant · ≤ 4 tools (feat-005 §5 · keeps ~26 ecosystem slots)', () => {
    const tools = getAvailableTools(grant(), false, 'core');
    expect(tools.length).toBeLessThanOrEqual(4);
  });
});

describe('scope coverage sanity', () => {
  it('all declared scope categories produce a deterministic result', () => {
    const categories: ScopeCategory[] = [
      'projects',
      'branches',
      'schema',
      'querying',
      'neon_auth',
      'data_api',
      'docs',
    ];

    for (const category of categories) {
      const tools = filterToolsForGrant(
        NEON_TOOLS,
        grant({ scopes: [category] }),
      );
      expect(tools.length).toBeGreaterThanOrEqual(2);
    }
  });
});
