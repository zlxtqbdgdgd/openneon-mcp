/**
 * slot-monitor-cron.ts · feat-043/#1 · cron handler + 跨 endpoint 并发巡检 + cron_summary emit
 *
 * 设计依据: design#53 §3.2 cron workflow + §3.6 注册到 feat-038 共享调度器。
 *
 * 每 1h trigger (Q4A 拍板 · cron expression `0 * * * *`):
 *   1. 拉全量 endpoint (注入 listEndpoints · feat-001 已 ship)
 *   2. 过滤 policy.disabled_endpoints (dev/test endpoint 可关 alerts)
 *   3. 并发跨 endpoint (p-limit 5 · 跟 feat-038 同并发常量) 跑 fetchInactiveSlots + checkSlot
 *   4. 单 endpoint 失败 → 记 failed_endpoints[] · 不阻塞其他 (跨 endpoint 隔离)
 *   5. 跑完 emit `replication_slot_monitor_cron_summary` audit event
 *
 * **不**起新 node-cron 实例 · `registerCronJob` import 自 scheduler-contract (W2-A1 feat-038
 * stub · ship 后 rebase 切回 `../stl-cron` · 详 scheduler-contract.ts).
 *
 * **跨 tenant safe** (§3.4): cron 是 server 后台 · system 权限 · audit event 含 project_id ·
 * DBA 端 OTel collector routing 按 project_id 隔离 (跟 feat-031 既有 pattern 一致)。
 */

import { emitAuditEvent } from '../../observability/audit-emit';
import { fetchInactiveSlots, type PgClientLike } from './queries';
import { checkSlot } from './slot-checker';
import { type SlotMonitorPolicy } from './policy';
import {
  registerCronJob,
  type CronJobHandle,
} from './scheduler-contract';

/** feat-038 共享并发常量 · 详 design#53 §3.2 step 2 + §11 (起点 5 · 必要时 10) */
export const CRON_CONCURRENCY = 5;

/** cron 注册名 · scheduler 实例内全局唯一 · design#53 §3.6 拍板 */
export const CRON_JOB_NAME = 'replication-slot-monitor';

/** cron expression · 每小时 0 分 · 跟 cron_interval_seconds = 3600 对齐 · design#53 §3.6 拍板 */
export const CRON_EXPRESSION = '0 * * * *';

/** endpoint registry 单 entry · 来自 feat-001 listEndpoints (跨 DB code-reusable shape) */
export type EndpointInfo = {
  endpoint_id: string;
  project_id: string;
};

/**
 * 注入项 · 全 mock-able · cron handler 零 module-level singleton 依赖 (test 隔离用)。
 *
 * 生产 wire:
 *   - listEndpoints: feat-001 endpoint registry
 *   - pgClientFor: 工厂 (endpoint_id → pg.Pool · 共享连接池)
 *   - loadPolicy: 既有 policy.yaml loader (slot_monitor block + resolveSlotMonitorPolicy)
 */
export type SlotMonitorDeps = {
  listEndpoints: () => Promise<EndpointInfo[]>;
  /** 工厂 · 单 endpoint 一个 client · cron 内 await · 异常 caller catch */
  pgClientFor: (endpoint: EndpointInfo) => Promise<PgClientLike>;
  loadPolicy: () => SlotMonitorPolicy;
  /** 注入并发 limiter (默认内置简易版 · 生产可替 p-limit 复用 feat-038 实例) */
  concurrencyLimit?: number;
  nowMs?: () => number;
  nowIso?: () => string;
};

/** cron round 结果聚合 · cron handler 内部用 + cron_summary audit event 字段来源 */
export type CronRoundResult = {
  scanned_endpoints: number;
  scanned_slots: number;
  warn_emitted: number;
  critical_emitted: number;
  failed_endpoints: string[];
  duration_ms: number;
};

/**
 * 极简 p-limit 替代 · 不引新 dep (项目 day-one 无 p-limit · feat-038 W2-A1 ship 后切回真实
 * p-limit)。语义跟 p-limit 一致: 每次 limit 个并发槽 · 任务串行排队 · 单 task throw 不阻塞队列。
 */
async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await fn(items[idx]);
      }
    })(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * 跨 endpoint 巡检一轮 (cron handler 的核心 · 跟 register/audit emit 解耦 · 单测直接调)。
 *
 * 单 endpoint failure (查询 throw / pg 不可达 / 超时) → 记 failed_endpoints · 不抛 · 其他
 * endpoint 照常继续。
 */
export async function runSlotMonitorRound(
  deps: SlotMonitorDeps,
): Promise<CronRoundResult> {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const startedAt = nowMs();
  const policy = deps.loadPolicy();
  const all = await deps.listEndpoints();
  const filtered = all.filter(
    (e) => !policy.disabled_endpoints.includes(e.endpoint_id),
  );
  const limit = deps.concurrencyLimit ?? CRON_CONCURRENCY;

  let scannedSlots = 0;
  let warnEmitted = 0;
  let criticalEmitted = 0;
  const failedEndpoints: string[] = [];

  await withConcurrency(filtered, limit, async (endpoint) => {
    try {
      const pg = await deps.pgClientFor(endpoint);
      const rows = await fetchInactiveSlots(pg);
      scannedSlots += rows.length;
      for (const row of rows) {
        const outcome = checkSlot(row, {
          endpoint_id: endpoint.endpoint_id,
          project_id: endpoint.project_id,
          policy,
          nowIso,
        });
        if (outcome.kind === 'warn') warnEmitted++;
        else if (outcome.kind === 'critical') criticalEmitted++;
      }
    } catch {
      // 单 endpoint 失败不阻塞其他 · 记 failed_endpoints 进 cron_summary (DBA 端追溯)
      failedEndpoints.push(endpoint.endpoint_id);
    }
  });

  const duration_ms = nowMs() - startedAt;
  return {
    scanned_endpoints: filtered.length,
    scanned_slots: scannedSlots,
    warn_emitted: warnEmitted,
    critical_emitted: criticalEmitted,
    failed_endpoints: failedEndpoints,
    duration_ms,
  };
}

/**
 * 注册 slot-monitor cron 到 feat-038 共享 scheduler · 一次 boot 调一次。
 *
 * 行为:
 *   - 注册 cron expression `0 * * * *` (每小时 0 分)
 *   - handler 调 runSlotMonitorRound · 完毕 emit cron_summary audit event
 *   - 返回 CronJobHandle · 测试用 (生产忽略)
 *
 * **W2-A1 feat-038 rebase**: import 切回 `../stl-cron::registerCronJob` · 字段已对齐 design#47 §3.3。
 */
export function initSlotMonitorCron(deps: SlotMonitorDeps): CronJobHandle {
  return registerCronJob({
    name: CRON_JOB_NAME,
    cronExpression: CRON_EXPRESSION,
    handler: async () => {
      const result = await runSlotMonitorRound(deps);
      emitAuditEvent({
        event_type: 'replication_slot_monitor_cron_summary',
        principal: 'system:slot-monitor',
        outcome: 'allow',
        severity: 'low',
        extra: {
          'openneon.slot_monitor.scanned_endpoints': result.scanned_endpoints,
          'openneon.slot_monitor.scanned_slots': result.scanned_slots,
          'openneon.slot_monitor.warn_emitted': result.warn_emitted,
          'openneon.slot_monitor.critical_emitted': result.critical_emitted,
          'openneon.slot_monitor.failed_endpoints': JSON.stringify(
            result.failed_endpoints,
          ),
          'openneon.slot_monitor.duration_ms': result.duration_ms,
        },
      });
    },
  });
}
