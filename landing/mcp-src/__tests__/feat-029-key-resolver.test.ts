/**
 * feat-029 fixture · 8 用例覆盖 §7 详设独立端到端验证。
 *
 * 详设：https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-029-L2-mcp-server-token-scope-min.html#7-独立端到端验证-fixture
 *
 * 8 用例（issues #104 覆盖 1/5/6/8 · issue #105 覆盖 2/3/4/7）：
 *  1. Project-scoped Key default → 启动成功 · grant.projectId 锁定单 project · keyType='project-scoped'
 *  2. Personal Key + ALLOW=unset → fail-closed reject
 *  3. Personal Key + ALLOW=true → accept_with_warning · keyType='personal'
 *  4. Org Key + ALLOW=true → accept_with_warning · keyType='org'
 *  5. NEON_API_KEY missing (=== bearerToken 缺) → fail-closed（外层 verifyToken 已 cover · 这里测
 *     resolveKeyScope 401 路径 · 等价于 key 无效）
 *  6. Neon API 401 启动期 → fail-closed reject
 *  7. 运行期 revocation → invalidateRevokedApiKeyCache 清 cache · 让下次 fail-closed
 *  8. grant 注入 feat-056 G1 stage · 跨 project → deny + terminal + severity=high
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveKeyScope,
  KeyResolverError,
  keyLast4,
} from '../auth/key-resolver';
import {
  buildGrantFromScope,
  decideKeyAcceptance,
  isProjectScopeEnforceEnabled,
  isNonProjectKeyAllowed,
  KeyNotAcceptedError,
  mergeResolvedGrant,
} from '../auth/grant-builder';
import {
  runPipeline,
  __resetStagesForTest,
  type EnforcementCtx,
} from '../policy/pipeline';
import { DEFAULT_GRANT } from '../utils/grant-context';

// silence the logger noise during tests
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

type MockNeonClient = Parameters<typeof resolveKeyScope>[0];

/**
 * Build a mock neon API client that returns desired AuthDetails + listProjects shape.
 */
function makeMockClient(opts: {
  auth?: { auth_method: string } | (() => never);
  projects?: { id: string }[];
  pagination?: { cursor?: string };
  projectsError?: { response?: { status: number }; isAxiosError: true };
  authError?: { response?: { status: number }; isAxiosError: true };
}): MockNeonClient {
  return {
    getAuthDetails: vi.fn(async () => {
      if (opts.authError) throw opts.authError;
      if (typeof opts.auth === 'function') opts.auth();
      return {
        data: opts.auth as { auth_method: string },
      } as never;
    }),
    listProjects: vi.fn(async () => {
      if (opts.projectsError) throw opts.projectsError;
      return {
        data: {
          projects: opts.projects ?? [],
          pagination: opts.pagination,
        },
      } as never;
    }),
  } as unknown as MockNeonClient;
}

function axiosErr(status: number) {
  return {
    isAxiosError: true,
    response: { status, data: { message: `HTTP ${status}` } },
    message: `HTTP ${status}`,
  } as const;
}

beforeEach(() => {
  // baseline env: enforcement on, non-project key disallowed (= feat-029 default safe posture)
  delete process.env.ALLOW_NON_PROJECT_KEY;
  delete process.env.PROJECT_SCOPE_ENFORCE_ENABLED;
});

afterEach(() => {
  delete process.env.ALLOW_NON_PROJECT_KEY;
  delete process.env.PROJECT_SCOPE_ENFORCE_ENABLED;
});

describe('keyLast4', () => {
  it('returns last 4 chars of key', () => {
    expect(keyLast4('neon_project_abcd1234efgh')).toBe('efgh');
  });
  it('returns **** for short input', () => {
    expect(keyLast4('abc')).toBe('****');
    expect(keyLast4('')).toBe('****');
  });
});

describe('resolveKeyScope · happy path', () => {
  it('用例 1: Project-scoped Key default → keyType=project-scoped · projectIds=[1] · truncated=false', async () => {
    const client = makeMockClient({
      auth: { auth_method: 'api_key_user' },
      projects: [{ id: 'proj-A' }],
    });
    const scope = await resolveKeyScope(client, 'neon_project_test_xxx1234');
    expect(scope.keyType).toBe('project-scoped');
    expect(scope.projectIds).toEqual(['proj-A']);
    expect(scope.truncated).toBe(false);
    expect(scope.last4).toBe('1234');
    expect(scope.resolvedAt).toBeGreaterThan(0);
  });

  it('Personal Key (≥2 projects) → keyType=personal · projectIds 多', async () => {
    const client = makeMockClient({
      auth: { auth_method: 'api_key_user' },
      projects: [{ id: 'proj-A' }, { id: 'proj-B' }],
      pagination: { cursor: 'next-page' },
    });
    const scope = await resolveKeyScope(client, 'neon_api_key_xxxxFFFF');
    expect(scope.keyType).toBe('personal');
    expect(scope.projectIds).toEqual(['proj-A', 'proj-B']);
    expect(scope.truncated).toBe(true);
    expect(scope.last4).toBe('FFFF');
  });

  it('Org Key (auth_method=api_key_org) → keyType=org · 即便单 project', async () => {
    const client = makeMockClient({
      auth: { auth_method: 'api_key_org' },
      projects: [{ id: 'proj-A' }],
    });
    const scope = await resolveKeyScope(client, 'neon_org_key_xxxxAAAA');
    expect(scope.keyType).toBe('org');
    expect(scope.projectIds).toEqual(['proj-A']);
  });
});

describe('resolveKeyScope · fail-closed (用例 6: Neon API 401/4xx/5xx)', () => {
  it('用例 6: getAuthDetails 401 → KeyResolverError(KEY_INVALID)', async () => {
    const client = makeMockClient({
      authError: axiosErr(401),
    });
    await expect(
      resolveKeyScope(client, 'neon_project_revoked_zzzz'),
    ).rejects.toMatchObject({
      name: 'KeyResolverError',
      code: 'KEY_INVALID',
      httpStatus: 401,
    });
  });

  it('用例 6: listProjects 403 → KeyResolverError(KEY_INVALID)', async () => {
    const client = makeMockClient({
      auth: { auth_method: 'api_key_user' },
      projectsError: axiosErr(403),
    });
    await expect(
      resolveKeyScope(client, 'neon_project_test_zzz1'),
    ).rejects.toMatchObject({
      code: 'KEY_INVALID',
      httpStatus: 403,
    });
  });

  it('Neon API 503 → KeyResolverError(NEON_API_UNAVAILABLE)', async () => {
    const client = makeMockClient({
      auth: { auth_method: 'api_key_user' },
      projectsError: axiosErr(503),
    });
    await expect(
      resolveKeyScope(client, 'neon_project_test_zzz2'),
    ).rejects.toMatchObject({
      code: 'NEON_API_UNAVAILABLE',
      httpStatus: 503,
    });
  });

  it('listProjects returns 0 + non-org auth_method → SCOPE_INDETERMINATE (fail-closed)', async () => {
    const client = makeMockClient({
      auth: { auth_method: 'api_key_user' },
      projects: [],
    });
    await expect(
      resolveKeyScope(client, 'neon_project_test_zzz3'),
    ).rejects.toMatchObject({
      code: 'SCOPE_INDETERMINATE',
    });
  });

  it('KeyResolverError instanceof KeyResolverError', async () => {
    const client = makeMockClient({ authError: axiosErr(401) });
    try {
      await resolveKeyScope(client, 'k1234');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(KeyResolverError);
    }
  });
});

describe('grant-builder · policy gate (issue #105)', () => {
  it('isProjectScopeEnforceEnabled defaults to true', () => {
    expect(isProjectScopeEnforceEnabled()).toBe(true);
  });

  it('PROJECT_SCOPE_ENFORCE_ENABLED=false → enforce off', () => {
    process.env.PROJECT_SCOPE_ENFORCE_ENABLED = 'false';
    expect(isProjectScopeEnforceEnabled()).toBe(false);
  });

  it('isNonProjectKeyAllowed defaults to false', () => {
    expect(isNonProjectKeyAllowed()).toBe(false);
  });

  it('ALLOW_NON_PROJECT_KEY=true → opt-in true', () => {
    process.env.ALLOW_NON_PROJECT_KEY = 'true';
    expect(isNonProjectKeyAllowed()).toBe(true);
  });
});

describe('decideKeyAcceptance · §7 fixture 用例 2/3/4', () => {
  const scopeOf = (keyType: 'personal' | 'org' | 'project-scoped') => ({
    keyType,
    projectIds: keyType === 'project-scoped' ? ['proj-A'] : ['proj-A', 'proj-B'],
    last4: '1234',
    resolvedAt: 1,
    truncated: false,
  });

  it('用例 1: Project-scoped Key default → accept', () => {
    const decision = decideKeyAcceptance(scopeOf('project-scoped'));
    expect(decision.kind).toBe('accept');
  });

  it('用例 2: Personal Key + ALLOW=unset → reject', () => {
    const decision = decideKeyAcceptance(scopeOf('personal'));
    expect(decision.kind).toBe('reject');
    if (decision.kind === 'reject') {
      expect(decision.reason.toLowerCase()).toContain('personal');
      expect(decision.reason).toContain('ALLOW_NON_PROJECT_KEY');
    }
  });

  it('用例 3: Personal Key + ALLOW=true → accept_with_warning', () => {
    const decision = decideKeyAcceptance(scopeOf('personal'), {
      allowNonProjectKey: true,
    });
    expect(decision.kind).toBe('accept_with_warning');
    if (decision.kind === 'accept_with_warning') {
      expect(decision.reason).toContain('blast radius');
    }
  });

  it('用例 4: Org Key + ALLOW=true → accept_with_warning', () => {
    const decision = decideKeyAcceptance(scopeOf('org'), {
      allowNonProjectKey: true,
    });
    expect(decision.kind).toBe('accept_with_warning');
  });

  it('Org Key + ALLOW=false → reject', () => {
    const decision = decideKeyAcceptance(scopeOf('org'));
    expect(decision.kind).toBe('reject');
  });

  it('escape hatch · PROJECT_SCOPE_ENFORCE_ENABLED=false + personal → accept_with_warning', () => {
    const decision = decideKeyAcceptance(scopeOf('personal'), {
      enforceProjectScope: false,
    });
    expect(decision.kind).toBe('accept_with_warning');
    if (decision.kind === 'accept_with_warning') {
      expect(decision.reason).toContain('audit-only');
    }
  });
});

describe('buildGrantFromScope', () => {
  it('用例 1: project-scoped → ResolvedGrant.projectId 锁定单 project · keyType 字段在', () => {
    const grant = buildGrantFromScope({
      keyType: 'project-scoped',
      projectIds: ['proj-A'],
      last4: '1234',
      resolvedAt: 100,
      truncated: false,
    });
    expect(grant.projectId).toBe('proj-A');
    expect(grant.keyType).toBe('project-scoped');
    expect(grant.last4).toBe('1234');
    expect(grant.scopes).toBeNull();
  });

  it('用例 2: personal + ALLOW=false → throws KeyNotAcceptedError', () => {
    expect(() =>
      buildGrantFromScope({
        keyType: 'personal',
        projectIds: ['proj-A', 'proj-B'],
        last4: '1234',
        resolvedAt: 100,
        truncated: false,
      }),
    ).toThrow(KeyNotAcceptedError);
  });

  it('KeyNotAcceptedError carries outcome=reject_personal_key', () => {
    try {
      buildGrantFromScope({
        keyType: 'personal',
        projectIds: ['proj-A'],
        last4: '1234',
        resolvedAt: 100,
        truncated: false,
      });
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(KeyNotAcceptedError);
      expect((e as KeyNotAcceptedError).outcome).toBe('reject_personal_key');
      expect((e as KeyNotAcceptedError).keyType).toBe('personal');
      expect((e as KeyNotAcceptedError).last4).toBe('1234');
    }
  });

  it('KeyNotAcceptedError carries outcome=reject_org_key for org keys', () => {
    try {
      buildGrantFromScope({
        keyType: 'org',
        projectIds: ['proj-A'],
        last4: 'aaaa',
        resolvedAt: 100,
        truncated: false,
      });
      throw new Error('should throw');
    } catch (e) {
      expect((e as KeyNotAcceptedError).outcome).toBe('reject_org_key');
    }
  });

  it('用例 3: personal + ALLOW=true → projectId=null (= G1 不锁单 project · 期待 ALLOW=true 的用户配套)', () => {
    process.env.ALLOW_NON_PROJECT_KEY = 'true';
    const grant = buildGrantFromScope({
      keyType: 'personal',
      projectIds: ['proj-A', 'proj-B'],
      last4: '1234',
      resolvedAt: 100,
      truncated: false,
    });
    expect(grant.projectId).toBeNull();
    expect(grant.keyType).toBe('personal');
  });

  it('用例 4: org + ALLOW=true → projectId=null', () => {
    process.env.ALLOW_NON_PROJECT_KEY = 'true';
    const grant = buildGrantFromScope({
      keyType: 'org',
      projectIds: ['proj-A'],
      last4: 'aaaa',
      resolvedAt: 100,
      truncated: false,
    });
    expect(grant.projectId).toBeNull();
    expect(grant.keyType).toBe('org');
  });
});

describe('mergeResolvedGrant', () => {
  it('project-scoped key 的 projectId 优先于 URL param (防越权提升)', () => {
    const resolved = {
      ...DEFAULT_GRANT,
      projectId: 'proj-A',
      keyType: 'project-scoped' as const,
      last4: '1234',
      resolvedAt: 1,
    };
    const fromUrl = { projectId: 'proj-B', scopes: ['querying'] as const };
    const merged = mergeResolvedGrant(resolved, {
      projectId: fromUrl.projectId,
      scopes: ['querying'],
    });
    expect(merged.projectId).toBe('proj-A'); // key scope 优先
    expect(merged.scopes).toEqual(['querying']); // URL scopes 收窄合法
  });

  it('URL scopes 收窄合法 (用户主动用 ?category=)', () => {
    const resolved = {
      ...DEFAULT_GRANT,
      projectId: 'proj-A',
      keyType: 'project-scoped' as const,
      last4: '1234',
      resolvedAt: 1,
    };
    const merged = mergeResolvedGrant(resolved, {
      projectId: null,
      scopes: ['schema'],
    });
    expect(merged.scopes).toEqual(['schema']);
    expect(merged.projectId).toBe('proj-A');
  });
});

describe('用例 8: grant 注入 feat-056 G1 stage · 跨 project deny', () => {
  beforeEach(() => {
    __resetStagesForTest();
  });

  it('用例 8 happy: grant.projectId=A · requestedProjectId=B → deny + terminal + severity=high', () => {
    const scope = {
      keyType: 'project-scoped' as const,
      projectIds: ['projA'],
      last4: '1234',
      resolvedAt: 1,
      truncated: false,
    };
    const grant = buildGrantFromScope(scope);
    const ctx: EnforcementCtx = {
      opClass: 'READ_ONLY',
      toolName: 'run_sql',
      autonomyLevel: 'L4',
      // 模拟 route.ts 注入: G1 stage 读 grant.projectId vs requestedProjectId
      grant: { projectId: grant.projectId },
      requestedProjectId: 'projB',
    };
    const verdict = runPipeline(ctx);
    expect(verdict.action).toBe('deny');
    expect(verdict.terminal).toBe(true);
    expect(verdict.audit_severity).toBe('high');
    expect(verdict.reason).toContain('跨 project');
  });

  it('用例 8 同 project allow: grant.projectId=A · requestedProjectId=A → allow', () => {
    const scope = {
      keyType: 'project-scoped' as const,
      projectIds: ['projA'],
      last4: '1234',
      resolvedAt: 1,
      truncated: false,
    };
    const grant = buildGrantFromScope(scope);
    const ctx: EnforcementCtx = {
      opClass: 'READ_ONLY',
      toolName: 'run_sql',
      autonomyLevel: 'L4',
      grant: { projectId: grant.projectId },
      requestedProjectId: 'projA',
    };
    const verdict = runPipeline(ctx);
    expect(verdict.action).toBe('allow');
  });
});

// 用例 7（运行期 revocation · handleToolError invalidate cache）的测试在 #105 commit · 单独 file
// landing/mcp-src/__tests__/feat-029-runtime-revocation.test.ts

describe('用例 5: key 缺失 (= bearerToken undefined → verifyToken 直接拒)', () => {
  // 这一路由层兜底·resolveKeyScope 永远不会被调到
  // 这里测的是 key 无效（401 等价于 "key 不存在 / 已 revoke / 错"）
  it('resolveKeyScope on invalid key → KeyResolverError → caller 返 undefined → withMcpAuth 401', async () => {
    const client = makeMockClient({ authError: axiosErr(401) });
    let caught: unknown;
    try {
      await resolveKeyScope(client, 'invalid_key_xxxx');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KeyResolverError);
    expect((caught as KeyResolverError).code).toBe('KEY_INVALID');
  });
});
