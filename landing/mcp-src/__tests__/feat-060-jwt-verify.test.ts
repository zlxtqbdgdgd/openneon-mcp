/**
 * feat-060-jwt-verify.test.ts · feat-060/#1 (#129) · JWT verify 单元测试
 *
 * 5 用例 (per 详设 §7 fixture · 本 slice 只测 verify 自身 · 4-outcome 矩阵 + claim binding 在 #130):
 *  1. happy verify (有效 RS256 token + JWKS · 返 payload)
 *  2. expired (exp < now → Expired · deny_invalid)
 *  3. signature fail (用错 keypair 签 → SignatureFailed · deny_invalid)
 *  4. audience mismatch (aud=other-app → AudienceMismatch · deny_invalid)
 *  5. JWKS unreachable (mock fetch 抛错 + cache 过期 → JwksUnreachable · deny_invalid)
 *
 * 实现说明:
 * - 用 jose 本地 generateKeyPair + SignJWT · 不起真 OIDC server (per 详设 §7 fixture sandbox)
 * - JWKS 端用 vi.mock 拦 jose createRemoteJWKSet · 测时直接喂 publicKey
 * - authService 用 __setPolicyForTest 注入 policy (绕过 ~/.openneon/policy.yaml)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateKeyPair,
  SignJWT,
  type KeyLike,
  type JWTPayload,
  exportJWK,
} from 'jose';
import { verifyJWT } from '../auth/jwt-verify';
import {
  AudienceMismatch,
  Expired,
  JwksUnreachable,
  JwtMissing,
  AuthServiceUnknown,
  SignatureFailed,
} from '../auth/jwt-verify-errors';
import { __resetJwksCacheForTest } from '../auth/jwks-cache';
import { __setPolicyForTest, type PolicyConfig } from '../policy/loader';

// ============================================================================
// jose mock: createRemoteJWKSet 拦截 · 直接返一个 key resolver 给本地 publicKey
// ============================================================================

let mockPublicKey: KeyLike | null = null;
let mockJwksReachable = true;

vi.mock('jose', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('jose');
  return {
    ...actual,
    createRemoteJWKSet: vi.fn((_url: URL) => {
      // 返一个 callable · 模拟真 JWKS resolver · 但直接给本地 publicKey
      return async (
        _header: import('jose').JWSHeaderParameters,
        _token: import('jose').FlattenedJWSInput,
      ): Promise<KeyLike> => {
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

// ============================================================================
// helpers
// ============================================================================

function basePolicy(): PolicyConfig {
  return {
    projects: {},
    defaults: { autonomy_level: 'L1', shadow_mode: true },
    authServices: {
      'test-oidc': {
        name: 'test-oidc',
        issuer: 'https://auth.test.example/',
        jwks_url: 'https://auth.test.example/.well-known/jwks.json',
        audience: 'openneon-mcp',
        jwks_cache_ttl_seconds: 600,
      },
    },
  };
}

async function signTestJwt(
  privateKey: KeyLike,
  claims: JWTPayload,
  opts: { issuer?: string; audience?: string; expiresIn?: string } = {},
): Promise<string> {
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt()
    .setIssuer(opts.issuer ?? 'https://auth.test.example/')
    .setAudience(opts.audience ?? 'openneon-mcp');
  if (opts.expiresIn) {
    builder.setExpirationTime(opts.expiresIn);
  }
  return builder.sign(privateKey);
}

// ============================================================================
// tests
// ============================================================================

describe('feat-060/#1 jwt-verify', () => {
  let validKp: { privateKey: KeyLike; publicKey: KeyLike };
  let wrongKp: { privateKey: KeyLike; publicKey: KeyLike };

  beforeEach(async () => {
    __resetJwksCacheForTest();
    mockJwksReachable = true;
    validKp = await generateKeyPair('RS256', { extractable: true });
    wrongKp = await generateKeyPair('RS256', { extractable: true });
    mockPublicKey = validKp.publicKey;
    __setPolicyForTest(basePolicy());
  });

  it('用例 1 · happy: 有效 RS256 token + 正确 JWKS → 返 payload', async () => {
    const token = await signTestJwt(validKp.privateKey, { sub: '42' }, {
      expiresIn: '1h',
    });
    const payload = await verifyJWT(token, 'test-oidc');
    expect(payload.sub).toBe('42');
    expect(payload.aud).toBe('openneon-mcp');
    expect(payload.iss).toBe('https://auth.test.example/');
  });

  it('用例 2 · expired: exp 已过 → Expired (deny_invalid · severity high)', async () => {
    // 签一个早就过期的 token
    const token = await new SignJWT({ sub: '42' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200) // 2 小时前 issued
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600) // 1 小时前 expired
      .setIssuer('https://auth.test.example/')
      .setAudience('openneon-mcp')
      .sign(validKp.privateKey);
    await expect(verifyJWT(token, 'test-oidc')).rejects.toThrow(Expired);
    try {
      await verifyJWT(token, 'test-oidc');
    } catch (e) {
      expect((e as Expired).outcome).toBe('deny_invalid');
      expect((e as Expired).severity).toBe('high');
    }
  });

  it('用例 3 · signature fail: 用错的 keypair 签 → SignatureFailed (deny_invalid · high)', async () => {
    // 用 wrong key 签 · 但 JWKS 端给的是 valid public key → 验签必失败
    const token = await signTestJwt(wrongKp.privateKey, { sub: '42' }, {
      expiresIn: '1h',
    });
    await expect(verifyJWT(token, 'test-oidc')).rejects.toThrow(SignatureFailed);
    try {
      await verifyJWT(token, 'test-oidc');
    } catch (e) {
      expect((e as SignatureFailed).outcome).toBe('deny_invalid');
      expect((e as SignatureFailed).severity).toBe('high');
    }
  });

  it('用例 4 · audience mismatch: aud=other-app → AudienceMismatch (deny_invalid · high)', async () => {
    const token = await signTestJwt(validKp.privateKey, { sub: '42' }, {
      audience: 'other-app',
      expiresIn: '1h',
    });
    await expect(verifyJWT(token, 'test-oidc')).rejects.toThrow(
      AudienceMismatch,
    );
    try {
      await verifyJWT(token, 'test-oidc');
    } catch (e) {
      expect((e as AudienceMismatch).outcome).toBe('deny_invalid');
      expect((e as AudienceMismatch).severity).toBe('high');
    }
  });

  it('用例 5 · JWKS unreachable: mock fetch 抛 ECONNREFUSED → JwksUnreachable (deny_invalid · high)', async () => {
    // 关 JWKS · 触发 fetch fail · cache 之前已 reset (beforeEach) → 首次拉就拉不到
    mockJwksReachable = false;
    const token = await signTestJwt(validKp.privateKey, { sub: '42' }, {
      expiresIn: '1h',
    });
    await expect(verifyJWT(token, 'test-oidc')).rejects.toThrow(
      JwksUnreachable,
    );
    try {
      await verifyJWT(token, 'test-oidc');
    } catch (e) {
      expect((e as JwksUnreachable).outcome).toBe('deny_invalid');
      expect((e as JwksUnreachable).severity).toBe('high');
    }
  });

  // 边界用例: deny_missing 路径 (medium · 不进 5 主用例但需要覆盖)
  it('边界 · token 空字符串 → JwtMissing (deny_missing · medium)', async () => {
    await expect(verifyJWT('', 'test-oidc')).rejects.toThrow(JwtMissing);
    try {
      await verifyJWT('', 'test-oidc');
    } catch (e) {
      expect((e as JwtMissing).outcome).toBe('deny_missing');
      expect((e as JwtMissing).severity).toBe('medium');
    }
  });

  it('边界 · authService 名不在 policy → AuthServiceUnknown (deny_missing · medium)', async () => {
    const token = await signTestJwt(validKp.privateKey, { sub: '42' }, {
      expiresIn: '1h',
    });
    await expect(verifyJWT(token, 'nonexistent-service')).rejects.toThrow(
      AuthServiceUnknown,
    );
  });
});

// silence unused import warning if exportJWK isn't used directly in tests
void exportJWK;
