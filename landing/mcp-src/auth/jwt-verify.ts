/**
 * jwt-verify.ts · feat-060/#1 (#129) · OIDC JWT 验签入口
 *
 * 设计依据: [feat-060 详设 §3 改动 + §4 4-outcome 矩阵](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-060-L2-mcp-server-claim-binding.html)
 *
 * 责任 (slice #1 边界):
 * - 接 \`(token, authServiceName)\` · 拿 policy.yaml authService 配置 · 走 jose 验签 · 返 claims 字典
 * - 错误翻译 → JwtVerifyError 7 子类 (per jwt-verify-errors.ts) · 调用方 (#130 claim-binding) catch 翻 audit
 *
 * 不做 (out of scope):
 * - 参数 override / 4-outcome 矩阵 (那是 claim-binding.ts · slice #2)
 * - audit emit (那是 claim-binding.ts · 走 feat-031 emitAuditEvent)
 * - tool dispatch 中间件接入 (那是 route.ts 集成 · slice #2)
 *
 * verify 流程 (per §3 调用链):
 *   1. authServiceName → \`getAuthService(name)\` → \`AuthServiceConfig\` (issuer / jwks_url / audience)
 *   2. token 为空 → JwtMissing (deny_missing)
 *   3. authService 名找不到 → AuthServiceUnknown (deny_missing)
 *   4. jose.jwtVerify · 验签 + 验 exp + 验 audience + 验 issuer
 *   5. 翻 jose error code 成 JwtVerifyError 子类
 *
 * jose error code 翻译表 (jose v6 \`code\` 字段):
 *   ERR_JWS_SIGNATURE_VERIFICATION_FAILED → SignatureFailed
 *   ERR_JWT_EXPIRED                       → Expired
 *   ERR_JWT_CLAIM_VALIDATION_FAILED (aud) → AudienceMismatch
 *   ERR_JWT_CLAIM_VALIDATION_FAILED (iss) → IssuerMismatch
 *   ERR_JWKS_NO_MATCHING_KEY              → SignatureFailed (找不到能 verify 的 key 当签名失败)
 *   网络 / fetch error                     → JwksUnreachable
 */
import { jwtVerify, type JWTPayload } from 'jose';
import { getAuthService } from '../policy/loader';
import { getJwksResolver } from './jwks-cache';
import {
  AudienceMismatch,
  AuthServiceUnknown,
  Expired,
  IssuerMismatch,
  JwksUnreachable,
  JwtMissing,
  JwtVerifyError,
  SignatureFailed,
} from './jwt-verify-errors';

/**
 * verify 一个 OIDC JWT · 返回已验证的 claim 字典 (e.g. \`{ sub: 42, iat: 1234567890, ... }\`)。
 *
 * 失败抛 JwtVerifyError 子类 · 调用方按 \`err.outcome\` (deny_missing | deny_invalid) 翻 audit。
 * 不抛非 JwtVerifyError 类型 (jose / 网络层错都翻译成子类 · 调用方不需要处理裸 Error)。
 *
 * @param token JWT 字符串 (e.g. \`Bearer <eyJ...>\` 的 <eyJ...> 部分 · 调用方负责剥前缀)
 * @param authServiceName policy.yaml authServices 字典里的 key (e.g. "saas-app-oidc")
 * @returns 已验证的 claim 字典 · payload.sub / .aud / .iss 都已校验过
 */
export async function verifyJWT(
  token: string,
  authServiceName: string,
): Promise<JWTPayload> {
  if (!token || token.trim().length === 0) {
    throw new JwtMissing(`token 字符串为空`);
  }
  const svc = getAuthService(authServiceName);
  if (!svc) {
    throw new AuthServiceUnknown(authServiceName);
  }
  const resolver = getJwksResolver(svc);
  try {
    const { payload } = await jwtVerify(token, resolver, {
      issuer: svc.issuer,
      audience: svc.audience,
    });
    return payload;
  } catch (err) {
    throw translateJoseError(err, svc.name);
  }
}

/**
 * jose error → JwtVerifyError 子类 翻译表 (jose v6 \`code\` 字段是稳定的).
 *
 * 不在此 log error (调用方负责 audit · log) · 此处只做类型翻译。
 */
function translateJoseError(err: unknown, authServiceName: string): Error {
  if (err instanceof JwtVerifyError) {
    // resolver 内部抛的已是子类 (e.g. jwks fetch 失败 · 由 getJwksResolver 间接传出)
    return err;
  }
  const e = err as { code?: string; message?: string; claim?: string };
  const code = e.code ?? '';
  const msg = e.message ?? String(err);

  // 签名 / key 匹配类
  if (
    code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
    code === 'ERR_JWKS_NO_MATCHING_KEY' ||
    code === 'ERR_JWS_INVALID'
  ) {
    return new SignatureFailed(`签名校验失败 (${code || msg})`);
  }

  // 过期类
  if (code === 'ERR_JWT_EXPIRED') {
    return new Expired(`JWT 已过期`);
  }

  // claim 校验类 (aud / iss / sub 等) · jose 用同一 ERR_JWT_CLAIM_VALIDATION_FAILED · 看 .claim 字段分流
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    if (e.claim === 'aud') {
      return new AudienceMismatch(`audience 不符 (${msg})`);
    }
    if (e.claim === 'iss') {
      return new IssuerMismatch(`issuer 不符 (${msg})`);
    }
    // 其他 claim 校验失败 (nbf / iat 等) 当签名失败处理 (deny_invalid)
    return new SignatureFailed(`claim 校验失败 (claim=${e.claim ?? '?'}: ${msg})`);
  }

  // 网络 / JWKS fetch 类 (jose 把 fetch 错抛成 JWKSNoMatchingKey 或 直接抛 fetch 错)
  if (
    msg.toLowerCase().includes('fetch') ||
    msg.toLowerCase().includes('econnrefused') ||
    msg.toLowerCase().includes('etimedout') ||
    msg.toLowerCase().includes('enotfound') ||
    msg.toLowerCase().includes('jwks')
  ) {
    return new JwksUnreachable(
      `authService "${authServiceName}" JWKS 不可达: ${msg}`,
    );
  }

  // 兜底: 当 deny_invalid · 严格签名失败语义 (fail-closed)
  return new SignatureFailed(`未识别的 jose 错误 (${code || 'no-code'}): ${msg}`);
}
