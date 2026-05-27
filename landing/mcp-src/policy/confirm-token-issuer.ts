/**
 * confirm-token-issuer.ts · feat-026/#1 · token 颁发 + 验证 (ADR-0008 reframe)
 *
 * 设计: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-026-L2-mcp-server-confirm-token-gate.html (§3 §7)
 *
 * 两条路径:
 * - issueConfirmToken: feat-027 plan mode elicitation approve 后由 orchestrator (route.ts) 调 ·
 *   颁发 source='plan-mode-approval' token · 注入 EnforcementCtx · step 7 stage verify。
 * - issuePreApprovedToken: **L4 stub** · throw NotImplementedError · L4 ship (feat-049/051) 时
 *   实施。CI guard (check-l4-stub.test.ts) 防 body 被悄悄改成颁发真 token (详设 §6 §11 OQ8)。
 *
 * verifyConfirmToken: step 7 confirm-token stage 调 · 校 5 项 (HMAC / TTL / used / args_digest /
 * 存在性) · 通过则 markUsed · 返 reject reason 给 stage 落 audit。
 */
import type { OpClass } from '../protection/destructive-detector';
import {
  type ConfirmToken,
  type ConfirmTokenSource,
  type ConfirmTokenSnapshot,
  DEFAULT_TTL_MS,
  computeHmac,
  computeArgsDigest,
  newTokenId,
  putToken,
  getToken,
  markUsed,
} from './confirm-token-store';

export type IssueOpts = {
  op_class: OpClass;
  args: unknown;
  principal: string;
  source: ConfirmTokenSource;
  ttl_ms?: number;
};

/**
 * 颁发 ConfirmToken · 落 store · 返 snapshot (id + source · 不含 hmac · 给 orchestrator 注入 ctx)。
 * source 通常 'plan-mode-approval' (orchestrator 在 elicitation approve 后调)。
 */
export function issueConfirmToken(opts: IssueOpts): ConfirmTokenSnapshot {
  const partial: Omit<ConfirmToken, 'hmac' | 'used'> = {
    id: newTokenId(),
    source: opts.source,
    op_class: opts.op_class,
    args_digest: computeArgsDigest(opts.args),
    principal: opts.principal,
    issued_at: Date.now(),
    ttl_ms: opts.ttl_ms ?? DEFAULT_TTL_MS,
  };
  const token: ConfirmToken = {
    ...partial,
    used: false,
    hmac: computeHmac(partial),
  };
  putToken(token);
  return { id: token.id, source: token.source };
}

/**
 * **L4 stub** · throw NotImplementedError (详设 §3 §6 §11 OQ8)。L4 ODD/MRC ready (feat-049 +
 * feat-051) 时同 PR 改 body 为真 issue + 加 wired-assertion · 单独改 body 而不接 ODD/MRC = 绕
 * plan mode 主闸门 = security incident。
 *
 * CI guard: landing/mcp-src/__tests__/check-l4-stub.test.ts grep 本函数 body · 0 hit
 * "throw new NotImplementedError" 则 fail。
 */
export function issuePreApprovedToken(_opts: IssueOpts): ConfirmTokenSnapshot {
  throw new NotImplementedError(
    'L4 pre-approved token requires feat-049/051',
  );
}

/**
 * 自定 NotImplementedError · 跟 std Error 区分 · stage 可识别 throw 来源。
 * 显式 class name 'NotImplementedError' (CI guard grep 用)。
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export type VerifyReason =
  | 'used'           // 已 markUsed (replay 防御)
  | 'expired'        // issued_at + ttl_ms < now
  | 'invalid_hmac'   // hmac 比对失败 (token 字段被改 / server 重启换 key)
  | 'args_mismatch'  // ctx.args 跟 token.args_digest 不符
  | 'missing';       // ctx.confirmToken 不存在 / store 找不到该 id

export type VerifyResult =
  | { ok: true; principal: string; op_class: OpClass; source: ConfirmTokenSource }
  | { ok: false; reason: VerifyReason };

export type VerifyCtx = {
  /** orchestrator 注入到 EnforcementCtx 的 snapshot · undefined = 无 token */
  snapshot?: ConfirmTokenSnapshot;
  /** 当前 op-class · 跟 token.op_class 必须一致 (详设 §6) */
  op_class: OpClass;
  /** 当前 args · 算 sha256 first 16 hex 跟 token.args_digest 比 (详设 §6) */
  args: unknown;
};

/**
 * verify 5 项校验 · 通过 markUsed (single-use)。
 * 顺序: missing → invalid_hmac → used → expired → args_mismatch。
 * 校 hmac 在 used/expired 之前 · 防"用旧 hmac 探测 token 状态"(虽然 single server lifetime
 * 风险微 · 仍按 fail-fast on integrity 顺序排)。
 */
export function verifyConfirmToken(ctx: VerifyCtx): VerifyResult {
  if (!ctx.snapshot) return { ok: false, reason: 'missing' };
  const stored = getToken(ctx.snapshot.id);
  if (!stored) return { ok: false, reason: 'missing' };

  // 重算 hmac 跟 stored.hmac 比 (任一字段被改 / server 重启换 key 都 mismatch)
  const expectedHmac = computeHmac({
    id: stored.id,
    source: stored.source,
    op_class: stored.op_class,
    args_digest: stored.args_digest,
    principal: stored.principal,
    issued_at: stored.issued_at,
    ttl_ms: stored.ttl_ms,
  });
  if (expectedHmac !== stored.hmac) {
    return { ok: false, reason: 'invalid_hmac' };
  }

  if (stored.used) return { ok: false, reason: 'used' };

  const age = Date.now() - stored.issued_at;
  if (age > stored.ttl_ms) return { ok: false, reason: 'expired' };

  // args 比对 (详设 §6 · 防换 args 绕)
  const currentDigest = computeArgsDigest(ctx.args);
  if (currentDigest !== stored.args_digest) {
    return { ok: false, reason: 'args_mismatch' };
  }
  // op_class 一致性 (额外冗余 · args 不同 op 也不同 · 但保守再校)
  if (stored.op_class !== ctx.op_class) {
    return { ok: false, reason: 'args_mismatch' };
  }

  markUsed(stored.id);
  return {
    ok: true,
    principal: stored.principal,
    op_class: stored.op_class,
    source: stored.source,
  };
}
