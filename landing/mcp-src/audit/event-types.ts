/**
 * audit/event-types.ts · feat-026/#1 · audit event 类型 + feat-031 OTel 桥接
 *
 * 设计: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-026-L2-mcp-server-confirm-token-gate.html (§4 audit event schema)
 *
 * feat-031 已 ship (`emitAuditEvent` 在 main · landing/mcp-src/observability/audit-emit.ts) ·
 * 本文件把 feat-026 的 `confirm_token_*` event **桥接**到 feat-031 统一 audit sink (OTel span ·
 * `target=openneon::audit`) —— token_id 作跨系统 join key (详设 §3 解决场景 · §4 audit schema)。
 * 不再各自 implement sink (feat-031 §6 single source / §10.2.1 防重复实现)。
 *
 * 同时保留 winston structured log: 本机调试 / OTLP collector 不可达时的人读兜底
 * (emitAuditEvent 的 OTel 路径是 fire-and-forget · collector 不可达自动 drop · 详 audit-emit.ts)。
 */
import type { OpClass } from '../protection/destructive-detector';
import type { ConfirmTokenSource } from '../policy/confirm-token-store';
import type { VerifyReason } from '../policy/confirm-token-issuer';
import { logger } from '../utils/logger';
import {
  emitAuditEvent,
  type AuditOutcome,
  type AuditSeverity,
} from '../observability/audit-emit';

export type ConfirmTokenEventType =
  | 'confirm_token_issued'
  | 'confirm_token_verified'
  | 'confirm_token_rejected';

export type ConfirmTokenAuditEvent = {
  event_type: ConfirmTokenEventType;
  token_id: string;
  source: ConfirmTokenSource;
  op_class: OpClass;
  principal: string;
  ttl_seconds: number;
  reject_reason?: VerifyReason;
};

/**
 * feat-026 event_type → feat-031 AuditEvent.outcome 映射:
 * - issued   = 颁发 (审批发生过 · 放行语义)        → 'allow'
 * - verified = step 7 verify 通过 (高危 op 获批准)  → 'approved'
 * - rejected = verify 失败 (防御命中 / 重放 / 过期)  → 'rejected'
 */
const OUTCOME_BY_EVENT: Record<ConfirmTokenEventType, AuditOutcome> = {
  confirm_token_issued: 'allow',
  confirm_token_verified: 'approved',
  confirm_token_rejected: 'rejected',
};

/** rejected = 防御命中 → high · issued/verified = 正常审批链 → medium (详设 §6 安全) */
function severityFor(eventType: ConfirmTokenEventType): AuditSeverity {
  return eventType === 'confirm_token_rejected' ? 'high' : 'medium';
}

/**
 * 落 audit event · 双路:
 * 1. feat-031 `emitAuditEvent` → OTel span (跨系统 join key = token_id · 主 audit sink)。
 * 2. winston structured log (本机人读兜底 · info: issued/verified · warn: rejected)。
 *
 * feat-026 event 字段 → feat-031 AuditEvent 字段:
 * - event_type / token_id / op_class / principal → 同名直传
 * - outcome → OUTCOME_BY_EVENT 映射 · severity → severityFor
 * - source / ttl_seconds / reject_reason → 进 extra (feat-031 AuditEvent 无对应顶层字段 ·
 *   extra map 不触发 PII redact assertion · 详 audit-emit.ts assertNoRawStatement)
 *
 * **source 必须透传** (详设 §4 audit schema): 'plan-mode-approval' 区分 L1-L3 人工审批路径 ·
 * 'odd-pre-approved' 区分 L4 ODD 预审批路径。DBA 按 source 分类复盘 · 保住 token_id 跨系统
 * join key 价值 (否则无法分辨某个 token 是人审还是 ODD 预批)。用 `openneon.audit.source`
 * key 落进 extra · 与 audit namespace 一致 (extra 原样进 OTel attribute · 详 audit-emit.ts)。
 *
 * 不传任何全文 SQL (args_digest 已是 sha256 · 不在本 event 里 · 满足 feat-031 §6 PII redact)。
 */
export function emitConfirmTokenAudit(event: ConfirmTokenAuditEvent): void {
  const extra: Record<string, unknown> = {
    'openneon.audit.source': event.source,
    ttl_seconds: event.ttl_seconds,
  };
  if (event.reject_reason !== undefined) {
    extra.reject_reason = event.reject_reason;
  }
  try {
    emitAuditEvent({
      event_type: event.event_type,
      outcome: OUTCOME_BY_EVENT[event.event_type],
      severity: severityFor(event.event_type),
      op_class: event.op_class,
      principal: event.principal,
      token_id: event.token_id,
      extra,
    });
  } catch (err) {
    // emitAuditEvent 仅在 PII redact 违规时抛 (本 event 不含全文字段 · 不应触发) ·
    // 兜底防御: audit 失败绝不阻塞 confirm-token gate (fail-safety · 详 audit-emit.ts §11 OQ1)。
    logger.error('audit · confirm_token OTel emit failed (feat-026):', {
      err,
      event_type: event.event_type,
      token_id: event.token_id,
    });
  }

  // winston 兜底 (本机人读 · OTel collector 不可达时仍有 structured log)
  if (event.event_type === 'confirm_token_rejected') {
    logger.warn('audit · confirm_token_rejected (feat-026):', event);
  } else {
    logger.info(`audit · ${event.event_type} (feat-026):`, event);
  }
}
