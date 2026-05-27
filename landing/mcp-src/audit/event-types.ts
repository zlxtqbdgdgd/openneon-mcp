/**
 * audit/event-types.ts · feat-026/#1 · audit event 类型 (feat-031 OTel 集成预留)
 *
 * 设计: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-026-L2-mcp-server-confirm-token-gate.html (§4 audit event schema)
 *
 * L2a 期: 仅类型定义 + 经 winston logger 走 structured log。feat-031 ship 后 OTel exporter
 * 消费同一 event payload (token_id 是跨系统 join key · 详设 §3 解决场景)。
 */
import type { OpClass } from '../protection/destructive-detector';
import type { ConfirmTokenSource } from '../policy/confirm-token-store';
import type { VerifyReason } from '../policy/confirm-token-issuer';
import { logger } from '../utils/logger';
import {
  emitAuditEvent,
  type AuditEventType,
  type AuditOutcome,
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
 * confirm_token event_type → feat-031 §3.2 (a) `openneon.audit.outcome`。
 * issued/verified = approved · rejected = rejected (collector 端按 outcome 分流)。
 */
function confirmTokenOutcome(eventType: ConfirmTokenEventType): AuditOutcome {
  return eventType === 'confirm_token_rejected' ? 'rejected' : 'approved';
}

/**
 * 落 audit event (feat-026 confirm_token)。
 *
 * **single source (feat-031 §6)**: 本函数是 feat-026 audit 的唯一出口 ·
 *   - winston structured log (本机可 grep · 紧急 unblock / OTEL_SDK_DISABLED 时仍可见)
 *   - **+ feat-031 `emitAuditEvent`** (OTel span · target='openneon::audit' · 出口到用户 OTLP collector)
 *
 * 两者共用同一 event payload (token_id 是跨系统 join key · 详设 §3 解决场景) · 调用方不直接
 * 调 emitAuditEvent / 不各自 implement exporter (§10.2.1 重复 + CI guard 防 ad-hoc)。
 * info level: issued/verified · warn level: rejected (异常 / 防御命中)。
 */
export function emitConfirmTokenAudit(event: ConfirmTokenAuditEvent): void {
  if (event.event_type === 'confirm_token_rejected') {
    logger.warn('audit · confirm_token_rejected (feat-026):', event);
  } else {
    logger.info(`audit · ${event.event_type} (feat-026):`, event);
  }
  // feat-031: 同 payload 出 OTel (best-effort · 不阻塞 · 不抛 · 详 audit-emit.ts)
  // op_class 是必填四件套之一 · 防调用方 (松类型 / runtime) 传进 undefined 漏字段 →
  // 兜 'OTHER' (OpClass fail-closed bucket) 保证 emitAuditEvent required 字段不缺。
  emitAuditEvent({
    event_type: event.event_type as AuditEventType,
    outcome: confirmTokenOutcome(event.event_type),
    op_class: event.op_class ?? 'OTHER',
    principal: event.principal,
    token_id: event.token_id,
    severity: event.event_type === 'confirm_token_rejected' ? 'high' : 'low',
    extra: {
      'openneon.audit.token_source': event.source,
      'openneon.audit.ttl_seconds': event.ttl_seconds,
      ...(event.reject_reason
        ? { 'openneon.audit.reject_reason': event.reject_reason }
        : {}),
    },
  });
}
