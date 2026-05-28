/**
 * slot-checker.ts · feat-043/#2 · 双级阈值判定 + audit emit
 *
 * 设计依据: design#53 §3.2 cron workflow step 2c + §3.3 audit event schema。
 *
 * 单 slot 判定逻辑 (per-endpoint 已 resolve 阈值 · 详 policy.ts effectiveThresholdsFor):
 *   - inactive_seconds == null               → skip (PG < 16 无 inactive_since · cron 下轮再试)
 *   - inactive_seconds >= critical_seconds   → emit replication_slot_inactive_critical (high)
 *   - inactive_seconds >= warn_seconds       → emit replication_slot_inactive_warn      (low)
 *   - else                                    → skip (inactive 但未到阈值 · 健康)
 *
 * **仅 inactive_seconds 单信号** (Q4B 拍板 · L3 版) · L4 升级补 wal_lag_bytes。
 *
 * audit emit 走 **feat-031 单一 sink** `emitAuditEvent()` (§10.2.1 防重复) · attribute namespace
 * `openneon.slot_monitor.*` (feature 自有字段) + `openneon.audit.*` (基础 schema · 由 audit-emit
 * 自动注入)。principal 固定 `system:slot-monitor` · outcome 固定 `allow` (监控告警语义)。
 */

import { emitAuditEvent } from '../../observability/audit-emit';
import type { InactiveSlotRow } from './queries';
import {
  effectiveThresholdsFor,
  type SlotMonitorPolicy,
} from './policy';

export type SlotCheckOutcome =
  | { kind: 'skip'; reason: 'unknown_inactive_seconds' | 'below_threshold' }
  | { kind: 'warn'; thresholdSeconds: number }
  | { kind: 'critical'; thresholdSeconds: number };

/**
 * feat-043 follow-up (#177): per-endpoint per-process emit-once stamp.
 *
 * PG < 16 endpoint 的 `inactive_seconds == null` skip 是设计预期, 但 silent skip
 * 用户察觉不到 slot monitor 在该 endpoint 不工作 (PG 14/15 不支持 inactive_since 字段)。
 * 首次 skip 触发 1 次 `replication_slot_monitor_pg_version_unsupported` audit
 * (severity=low) · 重复 cron round 不再 emit · 防 audit 流量爆炸。
 *
 * lifecycle = process · 重启重置 (mcp 进程 restart 后 PG 仍未升级再 emit 一次提醒)。
 */
const pgVersionUnsupportedSeen = new Set<string>();

/** 测试用 · 清空 emit-once stamp · 跟 mcp 进程 restart 等效 */
export function __resetPgVersionUnsupportedStampForTest(): void {
  pgVersionUnsupportedSeen.clear();
}

export type SlotCheckContext = {
  endpoint_id: string;
  /** 来自 endpoint registry · audit attribute 用 · DBA 端 cross-tenant routing 隔离 key */
  project_id: string;
  policy: SlotMonitorPolicy;
  /** test 注入 · 默认 () => new Date().toISOString() · audit detected_at 字段 */
  nowIso?: () => string;
};

/**
 * critical: 必须先确认 consumer 真离线再 drop slot · 否则会让 logical replication 数据丢失。
 * warn: consumer 可能临时下线 · 先查 consumer 健康再判断。
 * 详 design#53 §3.3 `recommended_action`。
 */
function recommendedAction(kind: 'warn' | 'critical', slotName: string): string {
  if (kind === 'critical') {
    return (
      `consider SELECT pg_drop_replication_slot('${slotName}') ` +
      `after confirming consumer is permanently offline · ` +
      `or restart consumer to resume WAL drain`
    );
  }
  return (
    `check consumer health for slot '${slotName}' · ` +
    `if consumer is intentionally paused · escalate to ops · ` +
    `do not drop slot without confirmation`
  );
}

/**
 * 判定单 slot · 命中阈值就 emit audit event · 返回 outcome 供 cron 统计 warn/critical 计数。
 *
 * **不 throw**: emit 失败由 emitAuditEvent fire-and-forget 内部 swallow (feat-031 fail-safety
 * §11 OQ1) · 本函数也不抛 · cron loop 调用方零 try/catch 负担。
 */
export function checkSlot(
  row: InactiveSlotRow,
  ctx: SlotCheckContext,
): SlotCheckOutcome {
  if (row.inactive_seconds == null) {
    // feat-043 follow-up (#177): PG < 16 endpoint 首次 skip emit warn · 防 silent skip
    if (!pgVersionUnsupportedSeen.has(ctx.endpoint_id)) {
      pgVersionUnsupportedSeen.add(ctx.endpoint_id);
      const now = (ctx.nowIso ?? (() => new Date().toISOString()))();
      emitAuditEvent({
        event_type: 'replication_slot_monitor_pg_version_unsupported',
        principal: 'system:slot-monitor',
        outcome: 'allow',
        severity: 'low',
        project_id: ctx.project_id,
        endpoint_id: ctx.endpoint_id,
        extra: {
          'openneon.slot_monitor.endpoint_id': ctx.endpoint_id,
          'openneon.slot_monitor.project_id': ctx.project_id,
          'openneon.slot_monitor.slot_name': row.slot_name,
          'openneon.slot_monitor.detected_at': now,
          'openneon.slot_monitor.reason':
            'pg_replication_slots.inactive_since 仅 PG >= 16 支持 · 本 endpoint 跳过 slot inactive 检测 · 升级 PG 16+ 后自动恢复',
        },
      });
    }
    return { kind: 'skip', reason: 'unknown_inactive_seconds' };
  }
  const thresholds = effectiveThresholdsFor(ctx.endpoint_id, ctx.policy);
  const now = (ctx.nowIso ?? (() => new Date().toISOString()))();

  if (row.inactive_seconds >= thresholds.critical_inactive_seconds) {
    emitAuditEvent({
      event_type: 'replication_slot_inactive_critical',
      principal: 'system:slot-monitor',
      outcome: 'allow',
      severity: 'high',
      project_id: ctx.project_id,
      endpoint_id: ctx.endpoint_id,
      extra: {
        'openneon.slot_monitor.endpoint_id': ctx.endpoint_id,
        'openneon.slot_monitor.project_id': ctx.project_id,
        'openneon.slot_monitor.slot_name': row.slot_name,
        'openneon.slot_monitor.inactive_seconds': row.inactive_seconds,
        'openneon.slot_monitor.threshold_seconds':
          thresholds.critical_inactive_seconds,
        'openneon.slot_monitor.threshold_kind': 'critical',
        'openneon.slot_monitor.recommended_action': recommendedAction(
          'critical',
          row.slot_name,
        ),
        'openneon.slot_monitor.detected_at': now,
      },
    });
    return {
      kind: 'critical',
      thresholdSeconds: thresholds.critical_inactive_seconds,
    };
  }

  if (row.inactive_seconds >= thresholds.warn_inactive_seconds) {
    emitAuditEvent({
      event_type: 'replication_slot_inactive_warn',
      principal: 'system:slot-monitor',
      outcome: 'allow',
      severity: 'low',
      project_id: ctx.project_id,
      endpoint_id: ctx.endpoint_id,
      extra: {
        'openneon.slot_monitor.endpoint_id': ctx.endpoint_id,
        'openneon.slot_monitor.project_id': ctx.project_id,
        'openneon.slot_monitor.slot_name': row.slot_name,
        'openneon.slot_monitor.inactive_seconds': row.inactive_seconds,
        'openneon.slot_monitor.threshold_seconds':
          thresholds.warn_inactive_seconds,
        'openneon.slot_monitor.threshold_kind': 'warn',
        'openneon.slot_monitor.recommended_action': recommendedAction(
          'warn',
          row.slot_name,
        ),
        'openneon.slot_monitor.detected_at': now,
      },
    });
    return {
      kind: 'warn',
      thresholdSeconds: thresholds.warn_inactive_seconds,
    };
  }

  return { kind: 'skip', reason: 'below_threshold' };
}
