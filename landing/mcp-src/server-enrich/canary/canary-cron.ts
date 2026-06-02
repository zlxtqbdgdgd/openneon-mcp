/**
 * canary-cron.ts · feat-042/#4 (#163) · 7d retention 自动清理 canary branch
 *
 * 设计依据: [feat-042 详设 §3.6 cron](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-042-L3-mcp-server-branch-canary-ddl.html)
 *
 * 职责 (issue #163 验收门):
 *   - 24h cron 周期 (CANARY_CRON_INTERVAL_MS · 默认 86_400_000)
 *   - 扫所有 project 下 purpose=canary 的 branch · expiry_ts < now → 调 Neon API DELETE
 *   - audit emit `canary_branch_purged` (feat-031 emitAuditEvent)
 *   - policy.yaml `canary.auto_purge` (默认 true) · `canary.retention_days` (默认 7) 暴露
 *   - 非阻塞 · 任一 project 失败 log warn + 继续 (其它 project 不连坐)
 *
 * 复用 pattern:
 *   - 跟 feat-023/#1 background-collector setInterval lifecycle 完全一致
 *   - audit emit 走 feat-031 emitAuditEvent (不写 console.log · 不写文件)
 *
 * 注意 (跟 feat-038 scheduler 实例的关系):
 *   - issue 163 说"复用 feat-038 scheduler 实例" · feat-038 现仅 baseline 模块用 setInterval
 *     模式 · 没有独立 scheduler 抽象 · 此处遵循同 pattern (setInterval + stop handle)
 *   - 后续 feat-038 抽出统一 scheduler 时再迁 · 当前 ship setInterval 与 plan-store / baseline
 *     同源
 */

import type { BranchProvider, NeonBranchListItem } from './branch-provider';
import { emitAuditEvent } from '../../observability/audit-emit';

// ──────────────────────────────────────────────────────────────
// 配置 (env-based · policy.yaml canary.* 占位)
// ──────────────────────────────────────────────────────────────

const DEFAULT_CRON_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;

export function isCanaryAutoPurgeEnabled(): boolean {
  // policy.yaml `canary.auto_purge` 占位 · env 未设 → true (issue 163 默认 on)
  const raw = process.env.CANARY_AUTO_PURGE;
  if (raw === undefined) return true;
  return raw !== 'false' && raw !== '0';
}

export function getCanaryRetentionDays(): number {
  const raw = process.env.CANARY_RETENTION_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(n);
}

export function getCanaryCronIntervalMs(): number {
  const raw = process.env.CANARY_CRON_INTERVAL_MS;
  if (!raw) return DEFAULT_CRON_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CRON_INTERVAL_MS;
  return Math.floor(n);
}

// ──────────────────────────────────────────────────────────────
// 主入口 · runOnce + start (setInterval lifecycle)
// ──────────────────────────────────────────────────────────────

export type CanaryCronHandle = {
  stop(): void;
};

export type CanaryCronOptions = {
  client: BranchProvider;
  /** project_id list 提供器 · 注入避免 cron 直接耦合 control-plane */
  listProjectIds: () => Promise<string[]>;
  intervalMs?: number;
  now?: () => number;
  /** warn log 注入 · 默认 console.warn · 测试可截 */
  warn?: (msg: string, err?: unknown) => void;
};

/**
 * 跑一轮 purge (启动期一次性 + 每个 interval 一次)。
 *
 * @returns 本轮删除的 branch 总数 (跨 project · 测试断言用)。
 */
export async function runCanaryCronOnce(
  opts: CanaryCronOptions,
): Promise<number> {
  if (!isCanaryAutoPurgeEnabled()) return 0;

  const now = (opts.now ?? Date.now)();
  const warn =
    opts.warn ?? ((m: string, e?: unknown) => console.warn(m, e));

  let projects: string[];
  try {
    projects = await opts.listProjectIds();
  } catch (err) {
    warn('[canary-cron] listProjectIds failed · skip round', err);
    return 0;
  }

  let purged = 0;
  for (const projectId of projects) {
    try {
      const branches: NeonBranchListItem[] =
        await opts.client.listCanaryBranches(projectId);
      for (const b of branches) {
        const expiry = Number(b.annotations?.expiry_ts ?? 0);
        if (!Number.isFinite(expiry) || expiry === 0) continue;
        if (expiry >= now) continue;

        try {
          await opts.client.deleteBranch(projectId, b.id);
          purged++;
          emitAuditEvent({
            event_type: 'canary_branch_purged',
            outcome: 'allow',
            severity: 'low',
            project_id: projectId,
            extra: {
              branch_id: b.id,
              branch_name: b.name,
              expiry_ts_ms: expiry,
              age_ms: now - expiry,
            },
          });
        } catch (err) {
          warn(
            `[canary-cron] deleteBranch project=${projectId} branch=${b.id} failed`,
            err,
          );
        }
      }
    } catch (err) {
      warn(
        `[canary-cron] listCanaryBranches project=${projectId} failed · skip this project`,
        err,
      );
    }
  }
  return purged;
}

/**
 * 启动 24h cron · 启动期立即跑一次 + 每 interval 跑一次。
 * 返 handle · stop() 清 setInterval (生产 mcp 重启 / 测试 teardown 用)。
 */
export function startCanaryCron(opts: CanaryCronOptions): CanaryCronHandle {
  const interval = opts.intervalMs ?? getCanaryCronIntervalMs();

  // 启动期一次性跑 (fire and forget · 失败已 warn 不抛)
  void runCanaryCronOnce(opts).catch((err) =>
    (opts.warn ?? console.warn)('[canary-cron] startup run failed', err),
  );

  const handle = setInterval(() => {
    void runCanaryCronOnce(opts).catch((err) =>
      (opts.warn ?? console.warn)('[canary-cron] interval run failed', err),
    );
  }, interval);

  return {
    stop() {
      clearInterval(handle);
    },
  };
}
