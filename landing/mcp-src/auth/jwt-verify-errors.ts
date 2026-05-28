/**
 * jwt-verify-errors.ts · feat-060/#1 (#129) · 4-outcome 矩阵的 verify-side 错误类型
 *
 * 跟[feat-060 详设 §4 4-outcome 矩阵](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-060-L2-mcp-server-claim-binding.html)对位:
 *
 * | error 子类         | outcome         | audit |
 * |--------------------|-----------------|-------|
 * | JwtMissing         | deny_missing    | medium|
 * | AuthServiceUnknown | deny_missing    | medium|
 * | SignatureFailed    | deny_invalid    | high  |
 * | Expired            | deny_invalid    | high  |
 * | AudienceMismatch   | deny_invalid    | high  |
 * | IssuerMismatch     | deny_invalid    | high  |
 * | JwksUnreachable    | deny_invalid    | high  |
 *
 * 调用方(claim-binding middleware · #130) catch JwtVerifyError → 读 outcome 写 audit · 不需自己 if-else。
 *
 * 不在此判 \`override\` / \`pass\` (那是参数比对 · 在 claim-binding.ts) · 本文件只判 verify 自身成败。
 */

export type JwtDenyOutcome = 'deny_missing' | 'deny_invalid';

export class JwtVerifyError extends Error {
  /** 4-outcome 矩阵的 deny 子集 · 给 audit emit 用 */
  outcome: JwtDenyOutcome;
  /** detail code · 给日志 + 客户端错误码用 (不泄露 JWT 内部细节) */
  code: string;
  /** audit severity · 跟矩阵对位 · medium=deny_missing · high=deny_invalid */
  severity: 'medium' | 'high';

  constructor(
    code: string,
    outcome: JwtDenyOutcome,
    severity: 'medium' | 'high',
    message: string,
  ) {
    super(message);
    this.name = 'JwtVerifyError';
    this.code = code;
    this.outcome = outcome;
    this.severity = severity;
  }
}

/** JWT 缺失 (header 没带 / 字段为空) → deny_missing · medium */
export class JwtMissing extends JwtVerifyError {
  constructor(detail: string) {
    super('JWT_MISSING', 'deny_missing', 'medium', detail);
    this.name = 'JwtMissing';
  }
}

/** policy.yaml 里 authService 名找不到 → deny_missing · medium */
export class AuthServiceUnknown extends JwtVerifyError {
  constructor(serviceName: string) {
    super(
      'AUTH_SERVICE_UNKNOWN',
      'deny_missing',
      'medium',
      `authService "${serviceName}" 未在 policy.yaml 顶层 authServices 字典声明`,
    );
    this.name = 'AuthServiceUnknown';
  }
}

/** JWT 签名验证失败 (公钥不匹配 / payload 被篡改) → deny_invalid · high */
export class SignatureFailed extends JwtVerifyError {
  constructor(detail: string) {
    super('JWT_SIGNATURE_FAILED', 'deny_invalid', 'high', detail);
    this.name = 'SignatureFailed';
  }
}

/** JWT exp 已过 → deny_invalid · high */
export class Expired extends JwtVerifyError {
  constructor(detail: string) {
    super('JWT_EXPIRED', 'deny_invalid', 'high', detail);
    this.name = 'Expired';
  }
}

/** JWT aud 跟 policy 配的 audience 不符 → deny_invalid · high */
export class AudienceMismatch extends JwtVerifyError {
  constructor(detail: string) {
    super('JWT_AUDIENCE_MISMATCH', 'deny_invalid', 'high', detail);
    this.name = 'AudienceMismatch';
  }
}

/** JWT iss 跟 policy 配的 issuer 不符 → deny_invalid · high (防 token 跨 issuer 重放) */
export class IssuerMismatch extends JwtVerifyError {
  constructor(detail: string) {
    super('JWT_ISSUER_MISMATCH', 'deny_invalid', 'high', detail);
    this.name = 'IssuerMismatch';
  }
}

/** JWKS endpoint 不可达 + cache 已过期/未填充 → deny_invalid · high (**不 stale 兜底** · ADR-0008 fail-closed) */
export class JwksUnreachable extends JwtVerifyError {
  constructor(detail: string) {
    super('JWKS_UNREACHABLE', 'deny_invalid', 'high', detail);
    this.name = 'JwksUnreachable';
  }
}
