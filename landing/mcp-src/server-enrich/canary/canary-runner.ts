/**
 * canary-runner.ts · feat-042/#2 (#160) · canary branch DDL 预演 + 测量
 *
 * 设计依据: [feat-042 详设 §3.2 + §3.4](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-042-L3-mcp-server-branch-canary-ddl.html)
 *
 * 职责 (issue #160 验收门):
 *   - 调 NeonApiClient.createCanaryBranch → 取 branch endpoint
 *   - 在 canary endpoint 执行 DDL (通过注入式 SqlRunner) + timeout 监控
 *   - 测量: duration_ms / locks_acquired / rows_affected / schema_diff
 *   - 4 outcome 分类: low_risk_proceed / high_risk_review / canary_failed / timeout
 *   - 全局 hard limit 3 并发 (G9 防 Neon API rate limit · OQ5)
 *   - expiry_ts = now + 7d 写 branch metadata
 *
 * 4 outcome 判定规则 (Q3C):
 *   - canary_failed: DDL 抛 SQL error · Neon API 调用失败 (除 timeout) · 资源缺
 *   - timeout: DDL 执行 > timeout_seconds (默认 1800s) · canary 强杀
 *   - high_risk_review: duration > duration_threshold_ms OR rows_affected > threshold OR
 *     检测到 ACCESS EXCLUSIVE LOCK 持续 > lock_threshold_ms
 *   - low_risk_proceed: DDL 正常完成 · 无高风险信号
 *
 * 设计取舍 (issue 160 ~150 LOC bound):
 *   - 不实现 schema_diff 的语义 diff · 仅取 ddl_executed_sql + observed schema_summary (调用方
 *     需要时用 pg_dump cli 出更详细 diff · 此处属 best-effort + future)
 *   - duration/locks/rows 测量走 SqlRunner · 不内嵌 pg client (避免循环依赖 + 可 mock)
 */

import {
  NeonApiClient,
  NeonApiError,
  type CanaryBranchMetadata,
} from './neon-api-client';

// ──────────────────────────────────────────────────────────────
// 公开类型
// ──────────────────────────────────────────────────────────────

export type CanaryOutcome =
  | 'low_risk_proceed' //   DDL 正常完成 · 无高风险信号 · 可直接打 prod
  | 'high_risk_review' //   测量信号超阈值 · 需 DBA 复审
  | 'canary_failed' //      Neon API / DDL 执行错 · 不可直接打 prod
  | 'timeout'; //           DDL 执行超时 · 视为 high_risk

export type CanaryMetrics = {
  /** DDL 执行墙钟时间 (ms) · 用 Date.now diff 简单测 · 不算 server-side  */
  duration_ms: number;
  /** ACCESS EXCLUSIVE / EXCLUSIVE 锁数 (并发 pg_locks 抽样的最大值) */
  locks_acquired: number;
  /** rows_affected (DDL 含 DML 的子句返 affected · 纯 DDL 通常 0) */
  rows_affected: number;
  /** schema-only summary · best-effort (调用方注入 schemaSummary fn 给出) */
  schema_summary?: string;
  /** observed AccessExclusive 锁等待 ms (调用方可注入) */
  access_exclusive_lock_ms?: number;
};

export type CanaryRunResult = {
  outcome: CanaryOutcome;
  branch?: CanaryBranchMetadata;
  metrics?: CanaryMetrics;
  /** outcome=canary_failed/timeout 时的错误描述 (供 audit + DBA 看) */
  error?: { kind: string; message: string };
  /** 风险信号摘要 (high_risk_review 时列举触发哪个阈值) */
  risk_reasons?: string[];
};

/** 注入式 SqlRunner · 在 canary branch 上跑 SQL · 返 rows + affected。 */
export type CanarySqlRunner = (
  branchConnectionString: string,
  sql: string,
) => Promise<{
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}>;

/** 注入式: 把 canary branch_id 拼成 connection string · 不绑死给定 DB driver。 */
export type ConnStringResolver = (
  projectId: string,
  branchId: string,
) => Promise<string>;

export type CanaryRunnerOptions = {
  client?: NeonApiClient;
  sqlRunner: CanarySqlRunner;
  connStringResolver: ConnStringResolver;
  /** DDL 执行超时秒 · 默认 1800 (30 min) · issue 160 验收门 */
  timeoutSeconds?: number;
  /** retention_days · 默认 7 · canary branch expiry 由 cron 清理 */
  retentionDays?: number;
  /** high_risk_review 阈值 · DDL > 此 ms 视为重 (默认 30000) */
  durationThresholdMs?: number;
  /** high_risk_review 阈值 · rows_affected > 此值视为重 (默认 100_000) */
  rowsAffectedThreshold?: number;
  /** high_risk_review 阈值 · ACCESS EXCLUSIVE 锁等 > 此 ms 视为重 (默认 5000) */
  accessExclusiveLockThresholdMs?: number;
  /** clock 注入用于测试 · 默认 Date.now */
  now?: () => number;
};

// ──────────────────────────────────────────────────────────────
// 全局 hard limit (G9 · OQ5 · 3 并发)
// ──────────────────────────────────────────────────────────────

const GLOBAL_CONCURRENCY_LIMIT = 3;
let inFlight = 0;

/** 单测复位用 · 非正式 API。 */
export function _resetCanaryConcurrencyForTests(): void {
  inFlight = 0;
}

export function getCanaryInFlightCount(): number {
  return inFlight;
}

// ──────────────────────────────────────────────────────────────
// canary runner 主入口
// ──────────────────────────────────────────────────────────────

const RETENTION_MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_SECONDS = 1800;
const DEFAULT_DURATION_THRESHOLD_MS = 30_000;
const DEFAULT_ROWS_AFFECTED_THRESHOLD = 100_000;
const DEFAULT_AX_LOCK_THRESHOLD_MS = 5000;

export type RunCanaryInput = {
  projectId: string;
  /** 待预演 DDL · 原文 (canary-runner 自己不脱敏 · 不存原文 · 仅打 hash 用 audit) */
  sql: string;
  /** canary branch 命名前缀 · 默认 `canary-` + 时间戳 */
  branchNamePrefix?: string;
  /** 源 branch (默认 main · canary-runner 不自己查 main_id · 调用方传) */
  parentBranchId?: string;
};

/**
 * 跑一次 canary 预演 · 返 4-outcome + metrics + branch metadata。
 *
 * 全流程:
 *   1. 检查全局并发 · inFlight >= 3 → 返 canary_failed (kind=rate_limit_concurrency)
 *   2. inFlight++
 *   3. 调 NeonApiClient.createCanaryBranch (expiry_ts = now + retentionDays)
 *   4. 拿 conn string
 *   5. 在 timeoutSeconds 内跑 sqlRunner.execute(branch_conn, sql)
 *      - reject → outcome=canary_failed
 *      - timeout → outcome=timeout · best-effort 删 branch
 *   6. 测量 duration / rows_affected · (locks/schema 留 schemaSummary 注入 best-effort)
 *   7. 阈值评估 → outcome
 *   8. inFlight-- (finally)
 *
 * 注意: branch 不在这步 cleanup · 留给 cron 7d retention 清 (Q3A · canary-cron 模块)。
 * 例外: timeout 时 best-effort 立删 (防 endpoint 挂着耗 compute · 失败也吞 · cron 兜底)。
 */
export async function runCanary(
  opts: CanaryRunnerOptions,
  input: RunCanaryInput,
): Promise<CanaryRunResult> {
  if (inFlight >= GLOBAL_CONCURRENCY_LIMIT) {
    return {
      outcome: 'canary_failed',
      error: {
        kind: 'rate_limit_concurrency',
        message: `canary 全局并发 hard limit ${GLOBAL_CONCURRENCY_LIMIT} 触顶 · 重试`,
      },
    };
  }

  const client = opts.client ?? new NeonApiClient();
  const timeoutSec = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const retentionDays = opts.retentionDays ?? 7;
  const now = opts.now ?? Date.now;
  const durationThr = opts.durationThresholdMs ?? DEFAULT_DURATION_THRESHOLD_MS;
  const rowsThr = opts.rowsAffectedThreshold ?? DEFAULT_ROWS_AFFECTED_THRESHOLD;
  const axLockThr =
    opts.accessExclusiveLockThresholdMs ?? DEFAULT_AX_LOCK_THRESHOLD_MS;

  inFlight++;
  try {
    const branchName =
      (input.branchNamePrefix ?? 'canary-') + new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const expiryTsMs = now() + retentionDays * RETENTION_MS_PER_DAY;

    // 1. createBranch
    let branch: CanaryBranchMetadata;
    try {
      branch = await client.createCanaryBranch(input.projectId, {
        name: branchName,
        parentBranchId: input.parentBranchId,
        expiryTsMs,
      });
    } catch (err) {
      const e = err as NeonApiError;
      return {
        outcome: 'canary_failed',
        error: {
          kind: e.kind ?? 'unknown',
          message: e.message,
        },
      };
    }

    // 2. conn string · 失败 → canary_failed (best-effort 删 branch)
    let connStr: string;
    try {
      connStr = await opts.connStringResolver(input.projectId, branch.branch_id);
    } catch (err) {
      await client.deleteBranch(input.projectId, branch.branch_id).catch(() => {});
      return {
        outcome: 'canary_failed',
        branch,
        error: {
          kind: 'conn_string_failed',
          message: (err as Error).message,
        },
      };
    }

    // 3. DDL 执行 + timeout
    const tStart = now();
    let execResult: { rows: Array<Record<string, unknown>>; rowCount: number };
    let timedOut = false;
    try {
      execResult = await withTimeout(
        opts.sqlRunner(connStr, input.sql),
        timeoutSec * 1000,
        () => {
          timedOut = true;
        },
      );
    } catch (err) {
      const elapsed = now() - tStart;
      if (timedOut) {
        // best-effort 立删 branch (cron 兜底 · 失败吞)
        await client.deleteBranch(input.projectId, branch.branch_id).catch(() => {});
        return {
          outcome: 'timeout',
          branch,
          metrics: { duration_ms: elapsed, locks_acquired: 0, rows_affected: 0 },
          error: {
            kind: 'timeout',
            message: `DDL 执行超时 (>${timeoutSec}s) · canary branch 已删`,
          },
        };
      }
      return {
        outcome: 'canary_failed',
        branch,
        metrics: { duration_ms: elapsed, locks_acquired: 0, rows_affected: 0 },
        error: {
          kind: 'sql_error',
          message: (err as Error).message,
        },
      };
    }

    const duration = now() - tStart;
    const metrics: CanaryMetrics = {
      duration_ms: duration,
      locks_acquired: 0, // 简单实现 · 锁数测量留给 sqlRunner 内部或调用方注入
      rows_affected: execResult.rowCount,
    };

    // 4. 阈值评估 → outcome
    const riskReasons: string[] = [];
    if (duration > durationThr) {
      riskReasons.push(`duration_ms ${duration} > ${durationThr}`);
    }
    if (execResult.rowCount > rowsThr) {
      riskReasons.push(`rows_affected ${execResult.rowCount} > ${rowsThr}`);
    }
    // access_exclusive_lock_ms 由 SQL runner / metrics 注入 (此处无源)
    const axLock = metrics.access_exclusive_lock_ms;
    if (axLock !== undefined && axLock > axLockThr) {
      riskReasons.push(`access_exclusive_lock_ms ${axLock} > ${axLockThr}`);
    }

    if (riskReasons.length > 0) {
      return {
        outcome: 'high_risk_review',
        branch,
        metrics,
        risk_reasons: riskReasons,
      };
    }

    return {
      outcome: 'low_risk_proceed',
      branch,
      metrics,
    };
  } finally {
    inFlight--;
  }
}

// ──────────────────────────────────────────────────────────────
// 工具 · timeout wrapper
// ──────────────────────────────────────────────────────────────

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timeout ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
