/**
 * feat-060-claim-binding.test.ts · feat-060/#2 (#130) · claim-binding 4-outcome 矩阵 8 用例
 *
 * per [feat-060 详设 §7 fixture](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-060-L2-mcp-server-claim-binding.html):
 *
 *  1. 正路径 · agent 传一致值 → pass · 用 42 调 tool · audit low
 *  2. 正路径 · agent 不传     → pass · server 注入 42 调 tool
 *  3. 越权 · agent 传不一致   → override · 用 42 调 tool · audit high (attempted=999/bound=42)
 *  4. JWT 缺失                → deny_missing · audit medium
 *  5. JWT 过期                → deny_invalid · audit high
 *  6. 签名失败                → deny_invalid · audit high
 *  7. audience 不符           → deny_invalid · audit high
 *  8. JWKS 不可达 + cache 过期 → deny_invalid · audit high (不 stale 兜底)
 *
 * 跟 #129 (jwt-verify) 测试边界:
 * - #129 测 verify 自身 (signature / aud / exp / JWKS) · 7 用例
 * - #130 (本文件) 测 4-outcome 矩阵的整体决策 + audit emit + boundArgs override
 *   verify 失败的 case 由 #129 已保证抛对的 error · 本文件只验 claim-binding catch 后翻译对了 outcome
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateKeyPair,
  SignJWT,
  type CryptoKey,
} from 'jose';
import { bindClaims, type ToolInputSchema } from '../auth/claim-binding';
import { __resetJwksCacheForTest } from '../auth/jwks-cache';
import { __setPolicyForTest, type PolicyConfig } from '../policy/loader';

// ============================================================================
// jose + audit mocks
// ============================================================================

let mockPublicKey: CryptoKey | null = null;
let mockJwksReachable = true;

vi.mock('jose', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('jose');
  return {
    ...actual,
    createRemoteJWKSet: vi.fn((_url: URL) => {
      return async (
        _h: import('jose').JWSHeaderParameters,
        _t: import('jose').FlattenedJWSInput,
      ): Promise<CryptoKey> => {
        if (!mockJwksReachable) {
          throw new Error('fetch failed: ECONNREFUSED (mock JWKS unreachable)');
        }
        if (!mockPublicKey) {
          throw new Error('mock publicKey not set in test setup');
        }
        return mockPublicKey;
      };
    }),
  };
});

// audit-emit mock · 验 emit 调用 + 入参
const auditEvents: Array<Record<string, unknown>> = [];
vi.mock('../observability/audit-emit', () => ({
  emitAuditEvent: vi.fn((event: Record<string, unknown>) => {
    auditEvents.push(event);
  }),
  sha256Hex: (s: string) => `sha256:${s.slice(0, 8)}`,
}));

// ============================================================================
// helpers
// ============================================================================

const PROJECT_ID = 'rapid-art-12345';
const AUTH_SERVICE = 'test-oidc';

function policyWithAuthService(): PolicyConfig {
  return {
    projects: {
      [PROJECT_ID]: {
        autonomy_level: 'L2b',
        overrides: {},
        timeout_overrides: {},
        rate_counter: undefined as never,
        authServices: [AUTH_SERVICE],
      },
    },
    defaults: { autonomy_level: 'L1', shadow_mode: true },
    authServices: {
      [AUTH_SERVICE]: {
        name: AUTH_SERVICE,
        issuer: 'https://auth.test.example/',
        jwks_url: 'https://auth.test.example/.well-known/jwks.json',
        audience: 'openneon-mcp',
        jwks_cache_ttl_seconds: 600,
      },
    },
  };
}

async function signJwt(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  opts: { audience?: string; expSec?: number } = {},
): Promise<string> {
  const builder = new SignJWT(claims as Record<string, string | number>)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt()
    .setIssuer('https://auth.test.example/')
    .setAudience(opts.audience ?? 'openneon-mcp');
  if (opts.expSec !== undefined) {
    builder.setExpirationTime(opts.expSec);
  } else {
    builder.setExpirationTime('1h');
  }
  return builder.sign(privateKey);
}

const mockToolSchema: ToolInputSchema = {
  properties: {
    user_id: {
      type: 'integer',
      fromClaim: { service: AUTH_SERVICE, field: 'sub' },
    },
    date_range: {
      type: 'string',
    },
  },
};

function headersWithJwt(jwt: string): Record<string, string> {
  return { [`mcp-auth-${AUTH_SERVICE}`]: jwt };
}

const principal = 'agent:abcd';

// ============================================================================
// tests
// ============================================================================

describe('feat-060/#2 claim-binding · 4-outcome 矩阵 8 用例', () => {
  let validKp: { privateKey: CryptoKey; publicKey: CryptoKey };
  let wrongKp: { privateKey: CryptoKey; publicKey: CryptoKey };

  beforeEach(async () => {
    __resetJwksCacheForTest();
    mockJwksReachable = true;
    auditEvents.length = 0;
    validKp = await generateKeyPair('RS256', { extractable: true });
    wrongKp = await generateKeyPair('RS256', { extractable: true });
    mockPublicKey = validKp.publicKey;
    __setPolicyForTest(policyWithAuthService());
  });

  // ───────────────────────── 1. pass · agent 传一致值 ─────────────────────────
  it('用例 1 · pass: agent 传 user_id=42 + JWT.sub=42 → outcome=pass · boundArgs.user_id=42 · audit low', async () => {
    const jwt = await signJwt(validKp.privateKey, { sub: 42 as unknown as string });
    const result = await bindClaims({
      toolName: 'get_user_orders',
      toolSchema: mockToolSchema,
      args: { user_id: 42, date_range: 'last-7-days' },
      headers: headersWithJwt(jwt),
      projectId: PROJECT_ID,
      principal,
    });
    expect(result.outcome).toBe('pass');
    expect(result.boundArgs?.user_id).toBe(42);
    expect(result.boundArgs?.date_range).toBe('last-7-days');
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].outcome).toBe('allow');
    expect(auditEvents[0].severity).toBe('low');
  });

  // ───────────────────────── 2. pass · agent 不传 → 注入 ─────────────────────────
  it('用例 2 · pass: agent 不传 user_id + JWT.sub=42 → boundArgs.user_id=42 (server 注入)', async () => {
    const jwt = await signJwt(validKp.privateKey, { sub: 42 as unknown as string });
    const result = await bindClaims({
      toolName: 'get_user_orders',
      toolSchema: mockToolSchema,
      args: { date_range: 'last-7-days' },
      headers: headersWithJwt(jwt),
      projectId: PROJECT_ID,
      principal,
    });
    expect(result.outcome).toBe('pass');
    expect(result.boundArgs?.user_id).toBe(42);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].outcome).toBe('allow');
  });

  // ───────────────────────── 3. override · agent 传不一致 ─────────────────────────
  it('用例 3 · override: agent user_id=999 + JWT.sub=42 → outcome=override · boundArgs=42 · audit high (attempted=999/bound=42)', async () => {
    const jwt = await signJwt(validKp.privateKey, { sub: 42 as unknown as string });
    const result = await bindClaims({
      toolName: 'get_user_orders',
      toolSchema: mockToolSchema,
      args: { user_id: 999, date_range: 'last-7-days' },
      headers: headersWithJwt(jwt),
      projectId: PROJECT_ID,
      principal,
    });
    expect(result.outcome).toBe('override');
    expect(result.boundArgs?.user_id).toBe(42); // server JWT.sub 强制覆盖
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].outcome).toBe('override');
    expect(auditEvents[0].severity).toBe('high');
    expect(auditEvents[0].agent_attempted_value).toBe(999);
    expect(auditEvents[0].bound_value).toBe(42);
  });

  // ───────────────────────── 4. deny_missing · JWT 缺失 ─────────────────────────
  it('用例 4 · deny_missing: tool 声明 fromClaim 但 header 不带 JWT → outcome=deny_missing · audit medium', async () => {
    const result = await bindClaims({
      toolName: 'get_user_orders',
      toolSchema: mockToolSchema,
      args: { user_id: 42, date_range: 'last-7-days' },
      headers: {}, // 没 JWT
      projectId: PROJECT_ID,
      principal,
    });
    expect(result.outcome).toBe('deny_missing');
    expect(result.boundArgs).toBeUndefined();
    expect(result.denyDetail?.code).toBe('JWT_MISSING');
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].outcome).toBe('deny');
    expect(auditEvents[0].severity).toBe('medium');
  });

  // ───────────────────────── 5. deny_invalid · JWT 过期 ─────────────────────────
  it('用例 5 · deny_invalid: exp 已过 → outcome=deny_invalid · audit high', async () => {
    // 已过期 token (exp = 1 小时前)
    const expiredJwt = await new SignJWT({ sub: 42 as unknown as string })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .setIssuer('https://auth.test.example/')
      .setAudience('openneon-mcp')
      .sign(validKp.privateKey);
    const result = await bindClaims({
      toolName: 'get_user_orders',
      toolSchema: mockToolSchema,
      args: { user_id: 42 },
      headers: headersWithJwt(expiredJwt),
      projectId: PROJECT_ID,
      principal,
    });
    expect(result.outcome).toBe('deny_invalid');
    expect(result.denyDetail?.code).toBe('JWT_EXPIRED');
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].severity).toBe('high');
  });

  // ───────────────────────── 6. deny_invalid · 签名失败 ─────────────────────────
  it('用例 6 · deny_invalid: 用 wrong keypair 签 → outcome=deny_invalid · audit high', async () => {
    const jwt = await signJwt(wrongKp.privateKey, { sub: 42 as unknown as string });
    const result = await bindClaims({
      toolName: 'get_user_orders',
      toolSchema: mockToolSchema,
      args: { user_id: 42 },
      headers: headersWithJwt(jwt),
      projectId: PROJECT_ID,
      principal,
    });
    expect(result.outcome).toBe('deny_invalid');
    expect(result.denyDetail?.code).toBe('JWT_SIGNATURE_FAILED');
    expect(auditEvents[0].severity).toBe('high');
  });

  // ───────────────────────── 7. deny_invalid · audience 不符 ─────────────────────────
  it('用例 7 · deny_invalid: aud=other-app → outcome=deny_invalid · audit high', async () => {
    const jwt = await signJwt(validKp.privateKey, { sub: 42 as unknown as string }, {
      audience: 'other-app',
    });
    const result = await bindClaims({
      toolName: 'get_user_orders',
      toolSchema: mockToolSchema,
      args: { user_id: 42 },
      headers: headersWithJwt(jwt),
      projectId: PROJECT_ID,
      principal,
    });
    expect(result.outcome).toBe('deny_invalid');
    expect(result.denyDetail?.code).toBe('JWT_AUDIENCE_MISMATCH');
    expect(auditEvents[0].severity).toBe('high');
  });

  // ───────────────────────── 8. deny_invalid · JWKS 不可达 ─────────────────────────
  it('用例 8 · deny_invalid: JWKS 不可达 + cache 过期 → outcome=deny_invalid · 不 stale 兜底 · audit high', async () => {
    mockJwksReachable = false;
    const jwt = await signJwt(validKp.privateKey, { sub: 42 as unknown as string });
    const result = await bindClaims({
      toolName: 'get_user_orders',
      toolSchema: mockToolSchema,
      args: { user_id: 42 },
      headers: headersWithJwt(jwt),
      projectId: PROJECT_ID,
      principal,
    });
    expect(result.outcome).toBe('deny_invalid');
    expect(result.denyDetail?.code).toBe('JWKS_UNREACHABLE');
    expect(auditEvents[0].severity).toBe('high');
  });

  // ───────────────────────── 边界 · tool 未声明 fromClaim ─────────────────────────
  it('边界 · tool 未声明 fromClaim → 完全旁路 · outcome=pass · 不 verify · 不发 audit', async () => {
    const result = await bindClaims({
      toolName: 'list_projects',
      toolSchema: { properties: { limit: { type: 'integer' } } },
      args: { limit: 10 },
      headers: {},
      projectId: PROJECT_ID,
      principal,
    });
    expect(result.outcome).toBe('pass');
    expect(result.boundArgs?.limit).toBe(10);
    expect(auditEvents).toHaveLength(0); // 旁路 · 不发 audit
  });

  // ───────────────────────── 边界 · project 未配 authServices ─────────────────────────
  it('边界 · project 没配 authServices 但 tool 声明 fromClaim → deny_missing (PROJECT_HAS_NO_AUTH_SERVICE)', async () => {
    __setPolicyForTest({
      projects: {
        [PROJECT_ID]: {
          autonomy_level: 'L2b',
          overrides: {},
          timeout_overrides: {},
          rate_counter: undefined as never,
          // authServices undefined!
        },
      },
      defaults: { autonomy_level: 'L1', shadow_mode: true },
      authServices: {
        [AUTH_SERVICE]: {
          name: AUTH_SERVICE,
          issuer: 'https://auth.test.example/',
          jwks_url: 'https://auth.test.example/.well-known/jwks.json',
          audience: 'openneon-mcp',
          jwks_cache_ttl_seconds: 600,
        },
      },
    });
    const jwt = await signJwt(validKp.privateKey, { sub: 42 as unknown as string });
    const result = await bindClaims({
      toolName: 'get_user_orders',
      toolSchema: mockToolSchema,
      args: { user_id: 42 },
      headers: headersWithJwt(jwt),
      projectId: PROJECT_ID,
      principal,
    });
    expect(result.outcome).toBe('deny_missing');
    expect(result.denyDetail?.code).toBe('PROJECT_HAS_NO_AUTH_SERVICE');
  });
});
