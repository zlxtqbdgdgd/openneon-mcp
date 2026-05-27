/**
 * confirm-token.ts · feat-026/#1 · feat-056 pipeline §8.2 第 7 步 stage
 *
 * 设计: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-026-L2-mcp-server-confirm-token-gate.html (§3 §4 §7)
 *
 * 职责 (ADR-0008 reframe):
 * - 当矩阵判 op 需 plan (matrixRequiresPlan = true) 时,本 stage 检查 ctx.confirmToken 是否
 *   存在且 valid · 不通过 fail-closed deny + 落 audit。
 * - 矩阵判 allow / deny 的 op 不需 token (READ_ONLY 等) · 本 stage 直接 null 放行下游。
 *
 * step 6 (plan-mode) 跟 step 7 (本 stage) 关系:
 * - step 6 看 ctx 无 token → 返 require_plan (orchestrator 弹 elicitation · approve 后颁发
 *   token + 重跑 pipeline)。
 * - step 6 看 ctx 有 token + source='odd-pre-approved' → 返 allow (L4 路径 · L2a 不可达 · stub throw)。
 * - step 6 看 ctx 有 token + source='plan-mode-approval' → 返 null (放行到 step 7 verify)。
 *
 * 本 stage 是 step 6 的 backstop: 即便 orchestrator 路径被改绕过 step 6 弹审批,只要 ctx 无有效
 * token + op 需 confirm → step 7 fail-closed deny (详设 §2 防绕)。
 */
import type { OpClass } from '../../protection/destructive-detector';
import type { Stage, EnforcementCtx, Verdict } from '../pipeline';
import { matrixRequiresPlan } from '../matrix';
import {
  verifyConfirmToken,
  type VerifyReason,
} from '../confirm-token-issuer';
import { getToken } from '../confirm-token-store';
import { emitConfirmTokenAudit } from '../../audit/event-types';

/**
 * 哪些 op 需要 confirm token? 跟 matrixRequiresPlan 同语义 — 矩阵判需 plan 的 op 都需要 token。
 * (单一 source: feat-056 矩阵; 不另定义 confirm 矩阵 · 详设 §3 调用链)
 */
function opNeedsConfirm(opClass: OpClass, level: EnforcementCtx['autonomyLevel']): boolean {
  return matrixRequiresPlan(opClass, level);
}

function denyVerdict(reason: VerifyReason, opClass: OpClass): Verdict {
  const reasonMsg: Record<VerifyReason, string> = {
    used: 'confirm_token 已使用 · 单次使用语义防重放',
    expired: 'confirm_token 已过期 · 重新审批',
    invalid_hmac: 'confirm_token HMAC 校验失败 · token 被篡改或 server 重启换 key',
    args_mismatch: 'confirm_token 跟当前 args 不匹配 · 防"批了 X 偷换 Y"',
    missing: 'confirm_token 缺失 · 高危 op 需先经 plan mode 审批 (fail-closed)',
  };
  return {
    action: 'deny',
    reason: `${opClass}: ${reasonMsg[reason]} (feat-026 step 7)`,
    audit_severity: 'high',
    terminal: true,
  };
}

/**
 * step 7 confirm-token stage:
 * - 无 ctx.confirmToken → null (defer 给 step 6 plan-mode · 在同一 pass 内 step 6 已返
 *   require_plan; orchestrator 接 elicitation · approve 后 issueConfirmToken + 重跑 pipeline)。
 *   仅当 orchestrator 在 approve 后**重跑** pipeline 时本 stage 才看到 ctx.confirmToken。
 * - 有 ctx.confirmToken 但 op 不需 confirm → null (容忍闲置 token · 不该有但不阻塞)
 * - 有 ctx.confirmToken 且 verify 失败 → deny + 对应 reason (used/expired/invalid_hmac/args_mismatch)
 * - 有 ctx.confirmToken 且 verify 通过 → null + audit confirm_token_verified (markUsed 已在 verify 内)
 *
 * "missing + 高危 op" 路径由 step 6 (plan-mode) 接管 require_plan · 不在本 stage 处理
 *   (避免本 pass 内 step 6/step 7 双方都对同一 missing 状态作不同决策)。
 */
export const confirmTokenStage: Stage = (ctx) => {
  if (!ctx.confirmToken) {
    return null; // 无 token · defer 给 step 6 plan-mode (本 pass) 或不需要 token (低危 op)
  }
  if (!opNeedsConfirm(ctx.opClass, ctx.autonomyLevel)) {
    return null; // 有 token 但 op 不需 confirm · 容忍闲置 token (不该有但不拦)
  }
  const result = verifyConfirmToken({
    snapshot: ctx.confirmToken,
    op_class: ctx.opClass,
    args: ctx.sql ?? '', // run_sql 路径 · sql 是 args 主体 · 跟 issuer 同 args 计算
  });
  if (!result.ok) {
    const stored = getToken(ctx.confirmToken.id);
    emitConfirmTokenAudit({
      event_type: 'confirm_token_rejected',
      token_id: ctx.confirmToken.id,
      source: ctx.confirmToken.source,
      op_class: ctx.opClass,
      principal: stored?.principal ?? '(unknown)',
      ttl_seconds: stored ? Math.round(stored.ttl_ms / 1000) : 0,
      reject_reason: result.reason,
    });
    return denyVerdict(result.reason, ctx.opClass);
  }
  // verified · 落 audit (token_id 是跨系统 join key · 详设 §3 解决场景)
  const stored = getToken(ctx.confirmToken.id);
  emitConfirmTokenAudit({
    event_type: 'confirm_token_verified',
    token_id: ctx.confirmToken.id,
    source: result.source,
    op_class: result.op_class,
    principal: result.principal,
    ttl_seconds: stored ? Math.round(stored.ttl_ms / 1000) : 0,
  });
  return null; // 通过 · 放行 step 8
};
