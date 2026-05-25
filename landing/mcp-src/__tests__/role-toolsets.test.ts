import { describe, it, expect } from 'vitest';
import {
  ROLE_TOOLSETS,
  isAgentRole,
  filterToolsByRole,
} from '../tools/role-toolsets';
import { validate, resolvePolicy, __setPolicyForTest } from '../policy/loader';

// 轻量 tool 形态 (filterToolsByRole 只看 name)
const tool = (name: string) => ({ name });
const ALL = [
  'find_neondb_instances',
  'get_neondb_query_statement',
  'get_neondb_schemas',
  'get_neondb_calling_services',
  'get_neondb_policy',
  'get_neondb_explain_plans',
  'list_slow_queries',
  'run_sql',
  'run_sql_transaction',
  'create_branch',
  'delete_project',
].map(tool);

const WRITE_TOOLS = [
  'run_sql',
  'run_sql_transaction',
  'prepare_database_migration',
  'complete_database_migration',
  'create_branch',
  'delete_branch',
];

describe('ROLE_TOOLSETS (feat-059/#1 · 4 套预设)', () => {
  it('定义 4 个 role: customer-service / data-analyst / ops / sre', () => {
    expect(Object.keys(ROLE_TOOLSETS).sort()).toEqual([
      'customer-service',
      'data-analyst',
      'ops',
      'sre',
    ]);
  });

  it('customer-service = 只读查询 · 无 run_sql · 无任何写 tool', () => {
    const cs = ROLE_TOOLSETS['customer-service'];
    expect(cs.has('find_neondb_instances')).toBe(true);
    expect(cs.has('get_neondb_query_statement')).toBe(true);
    expect(cs.has('get_neondb_schemas')).toBe(true);
    expect(cs.has('run_sql')).toBe(false);
    for (const w of WRITE_TOOLS) {
      expect(cs.has(w), `customer-service 不该含写 tool ${w}`).toBe(false);
    }
  });

  it('data-analyst = 客服 ∪ 只读诊断 (explain/slow queries) · 仍无 run_sql', () => {
    const da = ROLE_TOOLSETS['data-analyst'];
    // 客服全集是子集
    for (const t of ROLE_TOOLSETS['customer-service']) {
      expect(da.has(t)).toBe(true);
    }
    expect(da.has('get_neondb_explain_plans')).toBe(true);
    expect(da.has('list_slow_queries')).toBe(true);
    expect(da.has('run_sql')).toBe(false);
  });

  it('ops = data-analyst ∪ 写 op (含 run_sql / branch / 迁移)', () => {
    const ops = ROLE_TOOLSETS.ops;
    for (const t of ROLE_TOOLSETS['data-analyst']) {
      expect(ops.has(t)).toBe(true);
    }
    expect(ops.has('run_sql')).toBe(true);
    expect(ops.has('run_sql_transaction')).toBe(true);
    expect(ops.has('create_branch')).toBe(true);
    expect(ops.has('prepare_database_migration')).toBe(true);
  });

  it('sre ⊇ ops (应急 Fallback · L4 MRC 后扩)', () => {
    for (const t of ROLE_TOOLSETS.ops) {
      expect(ROLE_TOOLSETS.sre.has(t)).toBe(true);
    }
  });
});

describe('isAgentRole', () => {
  it('4 个内置 role → true', () => {
    for (const r of ['customer-service', 'data-analyst', 'ops', 'sre']) {
      expect(isAgentRole(r)).toBe(true);
    }
  });
  it('未知 / 非字符串 → false', () => {
    expect(isAgentRole('dba')).toBe(false);
    expect(isAgentRole(undefined)).toBe(false);
    expect(isAgentRole(null)).toBe(false);
    expect(isAgentRole(42)).toBe(false);
  });
});

describe('filterToolsByRole (feat-059/#1 · 软 listing 过滤)', () => {
  it('customer-service → 裁掉 run_sql + 写 tool (listing 只剩只读)', () => {
    const out = filterToolsByRole(ALL, 'customer-service').map((t) => t.name);
    expect(out).toContain('find_neondb_instances');
    expect(out).toContain('get_neondb_query_statement');
    expect(out).not.toContain('run_sql');
    expect(out).not.toContain('create_branch');
    expect(out).not.toContain('delete_project');
  });

  it('ops → 保留 run_sql + branch (写 tool 可见)', () => {
    const out = filterToolsByRole(ALL, 'ops').map((t) => t.name);
    expect(out).toContain('run_sql');
    expect(out).toContain('create_branch');
  });

  it('无 role (undefined) → 不过滤 · 原样返回 (退 feat-005 category-only listing)', () => {
    expect(filterToolsByRole(ALL, undefined)).toBe(ALL);
  });

  it('未知 role → 不过滤 (软 · forward-compat 自定义 role)', () => {
    expect(filterToolsByRole(ALL, 'totally-made-up')).toBe(ALL);
  });

  it('软 · 纯过滤: 不修改入参 · 只产出子集 (不拦调用 · 真权威是 feat-056)', () => {
    const before = ALL.map((t) => t.name);
    const out = filterToolsByRole(ALL, 'customer-service');
    expect(ALL.map((t) => t.name)).toEqual(before); // 入参未变
    expect(out.length).toBeLessThan(ALL.length);
    expect(out.every((t) => ALL.includes(t))).toBe(true); // 子集
  });
});

describe('policy.yaml agent_role (feat-059/#1 · loader validate + resolve)', () => {
  it('validate 解析 per-project agent_role', () => {
    const cfg = validate({
      projects: {
        'rapid-art-12345': {
          autonomy_level: 'L2a',
          agent_role: 'customer-service',
        },
      },
      defaults: { autonomy_level: 'L1' },
    });
    expect(cfg.projects['rapid-art-12345'].agent_role).toBe('customer-service');
  });

  it('未知 role 不抛错 (软 · 解析存下 · 过滤时 no-op · forward-compat OQ4)', () => {
    const cfg = validate({
      projects: {
        p1: { autonomy_level: 'L2a', agent_role: 'custom-thing' },
      },
      defaults: { autonomy_level: 'L1' },
    });
    expect(cfg.projects.p1.agent_role).toBe('custom-thing');
    expect(isAgentRole(cfg.projects.p1.agent_role)).toBe(false);
  });

  it('resolvePolicy 返回 agent_role · 未配 → undefined', () => {
    __setPolicyForTest(
      validate({
        projects: {
          'rapid-art-12345': { autonomy_level: 'L2a', agent_role: 'ops' },
        },
        defaults: { autonomy_level: 'L1' },
      }),
    );
    expect(resolvePolicy('rapid-art-12345').agent_role).toBe('ops');
    expect(resolvePolicy('unknown-project').agent_role).toBeUndefined();
  });

  it('resolvePolicy.agent_role 接 filterToolsByRole 端到端 (ops 见 run_sql · 客服不见)', () => {
    __setPolicyForTest(
      validate({
        projects: {
          'ops-proj': { autonomy_level: 'L2a', agent_role: 'ops' },
          'cs-proj': { autonomy_level: 'L1', agent_role: 'customer-service' },
        },
        defaults: { autonomy_level: 'L1' },
      }),
    );
    const opsRole = resolvePolicy('ops-proj').agent_role;
    const csRole = resolvePolicy('cs-proj').agent_role;
    expect(filterToolsByRole(ALL, opsRole).map((t) => t.name)).toContain(
      'run_sql',
    );
    expect(filterToolsByRole(ALL, csRole).map((t) => t.name)).not.toContain(
      'run_sql',
    );
  });
});
