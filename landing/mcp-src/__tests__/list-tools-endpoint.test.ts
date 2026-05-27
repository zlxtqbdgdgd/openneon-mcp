import { describe, it, expect } from 'vitest';
import { GET, OPTIONS } from '../../app/api/list-tools/route';
import { validate, __setPolicyForTest } from '../policy/loader';

type ListToolsResponse = {
  grant: {
    projectId: string | null;
    scopes: string[] | null;
  };
  readOnly: boolean;
  categoryInclude: 'core' | 'all';
  agentRole?: string | null;
  warnings?: string[];
  tools: Array<{
    name: string;
    title: string;
    scope: string | null;
    readOnlySafe: boolean;
    supportsDepth: boolean;
    defaultDepth: 'shallow' | 'full' | null;
    outputFormat: string[] | null;
    description: string;
  }>;
};

async function callListTools(
  queryParams: Record<string, string | string[]> = {},
): Promise<ListToolsResponse> {
  const url = new URL('http://localhost/api/list-tools');
  for (const [key, value] of Object.entries(queryParams)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        url.searchParams.append(key, v);
      }
    } else {
      url.searchParams.set(key, value);
    }
  }
  const req = new Request(url.toString());
  const res = await GET(req);
  return res.json() as Promise<ListToolsResponse>;
}

describe('/api/list-tools endpoint', () => {
  it('returns core listing by default (feat-005 #3 · ~26 slots reserved for ecosystem MCPs)', async () => {
    const body = await callListTools();
    expect(body.categoryInclude).toBe('core');
    // Day-one core: T1 + T2 + T6 + T8 (full · sales 4-step 完整 demo 链可跑)
    expect(body.tools.map((t) => t.name).sort()).toEqual([
      'find_neondb_instances',
      'get_neondb_calling_services',
      'get_neondb_query_statement',
      'get_neondb_schemas',
    ]);
    expect(body.readOnly).toBe(false);
    expect(body.grant).toEqual({
      projectId: null,
      scopes: null,
    });
  });

  it('returns 42 tools when include=all (full listing opt-in · backward-compat for clients wanting upstream tools)', async () => {
    const body = await callListTools({ include: 'all' });
    expect(body.categoryInclude).toBe('all');
    expect(body.tools).toHaveLength(42); // 31 upstream + 4 day-one (T1/T2/T6/T8) + feat-057 get_policy + feat-019 explain_plans + feat-020 T4 + feat-021 T5 + feat-024 T11
  });

  it('filters by scopes when category param is present (with include=all to isolate grant filter)', async () => {
    const body = await callListTools({ category: 'querying', include: 'all' });
    expect(body.grant.scopes).toEqual(['querying']);
    expect(body.tools).toHaveLength(18); // 10 upstream + 2 day-one (T6/T2) + feat-019 explain_plans + feat-020 T4 + feat-021 T5 + feat-024 T11 · scope='querying'
  });

  it('returns only always-available tools when scopes are all invalid (with include=all)', async () => {
    const body = await callListTools({ category: 'foo,bar', include: 'all' });
    expect(body.grant.scopes).toEqual([]);
    expect(body.tools.map((t) => t.name).sort()).toEqual(['fetch', 'search']);
    expect(body.warnings?.[0]).toContain('No valid scope categories');
  });

  it('filters project-agnostic tools in project-scoped mode (with include=all)', async () => {
    const body = await callListTools({
      projectId: 'proj-123',
      include: 'all',
    });
    expect(body.grant.projectId).toBe('proj-123');
    expect(body.tools).toHaveLength(34); // 24 upstream + 3 day-one (T6/T8/T2) + feat-057 get_policy + feat-019 explain_plans + feat-020 T4 + feat-021 T5 + feat-024 T11 (require projectId · T1 hidden)
    const names = body.tools.map((t) => t.name);
    expect(names).not.toContain('list_projects');
    expect(names).not.toContain('create_project');
    expect(names).not.toContain('search');
    expect(names).not.toContain('fetch');
  });

  it('filters to readOnlySafe tools with readonly=true (with include=all)', async () => {
    const body = await callListTools({ readonly: 'true', include: 'all' });
    expect(body.readOnly).toBe(true);
    expect(body.tools).toHaveLength(30); // 19 upstream + 4 day-one (T1/T2/T6/T8) + feat-057 get_policy + feat-019 explain_plans + feat-020 T4 + feat-021 T5 + feat-024 T11 · all readOnlySafe
    for (const tool of body.tools) {
      expect(tool.readOnlySafe).toBe(true);
    }
  });

  it('supports legacy x-read-only header (with include=all to test header path)', async () => {
    const url = new URL('http://localhost/api/list-tools');
    url.searchParams.set('include', 'all');
    const req = new Request(url.toString(), {
      headers: { 'x-read-only': 'true' },
    });
    const res = await GET(req);
    const body = (await res.json()) as ListToolsResponse;
    expect(body.readOnly).toBe(true);
    expect(body.tools).toHaveLength(30); // 19 upstream + 4 day-one (T1/T2/T6/T8) + feat-057 + feat-019 explain_plans + feat-020 T4 + feat-021 T5 + feat-024 T11 · readOnlySafe
  });

  it('readonly query param takes precedence over x-read-only header (with include=all)', async () => {
    const url = new URL('http://localhost/api/list-tools');
    url.searchParams.set('readonly', 'false');
    url.searchParams.set('include', 'all');
    const req = new Request(url.toString(), {
      headers: { 'x-read-only': 'true' },
    });
    const res = await GET(req);
    const body = (await res.json()) as ListToolsResponse;
    expect(body.readOnly).toBe(false);
    expect(body.tools).toHaveLength(42); // 31 upstream + 4 day-one (T1/T2/T6/T8) + feat-057 get_policy + feat-019 explain_plans + feat-020 T4 + feat-021 T5 + feat-024 T11
  });

  it('include=core explicit returns the same as default (4 day-one core tools · full · sales 4-step 完整)', async () => {
    const body = await callListTools({ include: 'core' });
    expect(body.categoryInclude).toBe('core');
    expect(body.tools.map((t) => t.name).sort()).toEqual([
      'find_neondb_instances',
      'get_neondb_calling_services',
      'get_neondb_query_statement',
      'get_neondb_schemas',
    ]);
  });

  it('include=invalid falls back to core default (strict whitelist)', async () => {
    const body = await callListTools({ include: 'optional' });
    expect(body.categoryInclude).toBe('core');
    expect(body.tools).toHaveLength(4); // T1 + T2 + T6 + T8 (day-one core 满)
  });

  it('advertises supportsDepth + defaultDepth (feat-007 #4 · T6/T8 support depth · T1/T2 do not)', async () => {
    const body = await callListTools({ include: 'all' });
    const byName = Object.fromEntries(body.tools.map((t) => [t.name, t]));

    // T6 + T8 support progressive disclosure depth
    expect(byName['get_neondb_query_statement'].supportsDepth).toBe(true);
    expect(byName['get_neondb_query_statement'].defaultDepth).toBe('shallow');
    expect(byName['get_neondb_schemas'].supportsDepth).toBe(true);
    expect(byName['get_neondb_schemas'].defaultDepth).toBe('shallow');

    // T1/T2 + upstream tools do NOT support depth → defaultDepth null
    expect(byName['find_neondb_instances'].supportsDepth).toBe(false);
    expect(byName['find_neondb_instances'].defaultDepth).toBeNull();
    expect(byName['get_neondb_calling_services'].supportsDepth).toBe(false);
    expect(byName['run_sql'].supportsDepth).toBe(false);
    expect(byName['run_sql'].defaultDepth).toBeNull();
  });

  it('advertises outputFormat (feat-006 #3 · T1/T2/T6/T8 accept ?format= · upstream null)', async () => {
    const body = await callListTools({ include: 'all' });
    const byName = Object.fromEntries(body.tools.map((t) => [t.name, t]));

    // day-one openneon tools route through formatToolResponse → accept ?format=
    for (const name of [
      'find_neondb_instances',
      'get_neondb_calling_services',
      'get_neondb_query_statement',
      'get_neondb_schemas',
    ]) {
      expect(byName[name].outputFormat).toEqual(['csv', 'json', 'tsv']);
    }
    // upstream Neon tools don't have the format param
    expect(byName['run_sql'].outputFormat).toBeNull();
    expect(byName['list_projects'].outputFormat).toBeNull();
  });

  it('OPTIONS returns expected CORS allow-headers', () => {
    const res = OPTIONS();
    const allowed = res.headers.get('Access-Control-Allow-Headers') ?? '';
    expect(allowed).toBe('x-read-only');
  });

  it('returns valid responses across repeated mixed-param requests', async () => {
    const paramSets: Record<string, string | string[]>[] = [
      {},
      { projectId: 'proj-123' },
      { category: 'querying' },
      { readonly: 'true' },
      {
        projectId: 'proj-123',
        category: 'querying,schema',
      },
      { category: 'not-a-real-scope' },
    ];

    const runs = Array.from({ length: 200 }, (_, i) =>
      callListTools(paramSets[i % paramSets.length]),
    );

    const bodies = await Promise.all(runs);
    expect(bodies).toHaveLength(200);

    for (const body of bodies) {
      expect(Array.isArray(body.tools)).toBe(true);
      expect(typeof body.readOnly).toBe('boolean');
      expect(body.grant).toBeDefined();
      expect(
        body.grant.projectId === null ||
          typeof body.grant.projectId === 'string',
      ).toBe(true);
      expect(
        body.grant.scopes === null || Array.isArray(body.grant.scopes),
      ).toBe(true);
    }
  });
});

describe('/api/list-tools · feat-059 role toolset 软过滤', () => {
  function setRoles() {
    __setPolicyForTest(
      validate({
        projects: {
          'cs-proj': {
            autonomy_level: 'L1',
            agent_role: 'customer-service',
          },
          'ops-proj': { autonomy_level: 'L2a', agent_role: 'ops' },
          'no-role-proj': { autonomy_level: 'L2a' },
        },
        defaults: { autonomy_level: 'L1' },
      }),
    );
  }

  it('客服 role → listing 无 run_sql / 无写 tool · agentRole 回显', async () => {
    setRoles();
    const body = await callListTools({ projectId: 'cs-proj', include: 'all' });
    expect(body.agentRole).toBe('customer-service');
    const names = body.tools.map((t) => t.name);
    expect(names).not.toContain('run_sql');
    expect(names).not.toContain('run_sql_transaction');
    expect(names).not.toContain('create_branch');
    expect(names).not.toContain('prepare_database_migration');
  });

  it('ops role → listing 含 run_sql (写 tool 可见)', async () => {
    setRoles();
    const body = await callListTools({ projectId: 'ops-proj', include: 'all' });
    expect(body.agentRole).toBe('ops');
    expect(body.tools.map((t) => t.name)).toContain('run_sql');
  });

  it('无 agent_role → 退 category-only listing (无 role 过滤 · run_sql 仍在 all)', async () => {
    setRoles();
    const body = await callListTools({
      projectId: 'no-role-proj',
      include: 'all',
    });
    expect(body.agentRole).toBeNull();
    expect(body.tools.map((t) => t.name)).toContain('run_sql');
  });

  it('role ∩ category: 客服 + include=core → 交集 (core 4 ∩ 客服只读)', async () => {
    setRoles();
    const body = await callListTools({ projectId: 'cs-proj', include: 'core' });
    expect(body.categoryInclude).toBe('core');
    const names = body.tools.map((t) => t.name);
    // core day-one 里属于客服 toolset 的只读 tool (run_sql 不在 core 也不在客服)
    expect(names).not.toContain('run_sql');
    expect(names.every((n) => typeof n === 'string')).toBe(true);
  });
});
