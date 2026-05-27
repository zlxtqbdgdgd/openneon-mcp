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
 * 落 audit event · L2a 走 winston structured log · feat-031 OTel ship 后接同 sink。
 * info level: issued/verified · warn level: rejected (异常 / 防御命中)。
 */
export function emitConfirmTokenAudit(event: ConfirmTokenAuditEvent): void {
  if (event.event_type === 'confirm_token_rejected') {
    logger.warn('audit · confirm_token_rejected (feat-026):', event);
  } else {
    logger.info(`audit · ${event.event_type} (feat-026):`, event);
  }
}
