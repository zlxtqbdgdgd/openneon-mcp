/**
 * background plan collector · feat-023/#1 (L2b)。
 *
 * 详设 §3 调用链 (plan-store 写入 · background path) + §5 + §11 OQ3/OQ5:
 * 周期 (default 5min · PLAN_BG_COLLECTOR_INTERVAL_MS) 从 pg_stat_statements 拉 top-N
 * (default 50 · PLAN_BG_COLLECTOR_TOP_N) 慢 query · 对每条跑 EXPLAIN (FORMAT JSON, ANALYZE false) ·
 * 摘要化 → 写 store (source='background')。
 *
 * 非阻塞 (§5): 每条 query 之间 setImmediate 让出事件循环 · 不阻塞 mcp 主线程。
 * 启动期一次性跑 + setInterval 周期 (§11 OQ5)。
 * pg_stat_statements 缺 (用户 disable) → log warn + 跳过本轮 · 不抛 · on-demand T3 仍工作 (§5 降级)。
 *
 * 依赖注入 (避免 import tools.ts 循环依赖 + 可 mock):
 * - runStatements: 跑一条 SQL 返 rows (pg_stat_statements 查询 · EXPLAIN 查询)
 * - store: PlanStoreBackend (写入)
 */

import type { PlanStoreBackend } from './types';
import { computeSignature, queryTextSha256 } from './signature';
import { summarizePlan } from './plan-summary';

/** 注入式 SQL 执行 (返回 row 数组 · 由调用方绑 projectId/connection)。 */
export type SqlRunner = (
  sql: string,
  params?: unknown[],
) => Promise<Array<Record<string, unknown>>>;

export interface BackgroundCollectorOptions {
  projectId: string;
  store: PlanStoreBackend;
  runSql: SqlRunner;
  /** default 5min。 */
  intervalMs?: number;
  /** pg_stat_statements LIMIT · default 50。 */
  topN?: number;
  /** stderr/log 注入 (默认 console.warn) · 测试可截。 */
  warn?: (msg: string, err?: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 300_000;
const DEFAULT_TOP_N = 50;

/** collector 句柄 · stop() 清 setInterval。 */
export interface BackgroundCollectorHandle {
  stop(): void;
}

/**
 * 跑一轮收集 (启动期一次性 + 每个 interval 各调一次)。
 * 任何一步失败都 log warn + return (本轮跳过) · 不抛 (fail-safety §5)。
 *
 * @returns 本轮写入 store 的 record 数 (测试断言用)。
 */
export async function runCollectorOnce(
  opts: BackgroundCollectorOptions,
): Promise<number> {
  const warn = opts.warn ?? ((m: string, e?: unknown) => console.warn(m, e));
  const topN = opts.topN ?? DEFAULT_TOP_N;

  // 1. pg_stat_statements 缺 → 跳过 (on-demand T3 仍工作)。
  let rows: Array<Record<string, unknown>>;
  try {
    const extCheck = await opts.runSql(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS ok`,
    );
    if (!extCheck[0]?.ok) {
      warn(
        '[plan-store bg-collector] pg_stat_statements not installed · skipping this round (on-demand T3 still populates store)',
      );
      return 0;
    }
    rows = await opts.runSql(
      `SELECT queryid::text AS queryid, query, total_exec_time
         FROM pg_stat_statements
        ORDER BY total_exec_time DESC NULLS LAST
        LIMIT $1`,
      [topN],
    );
  } catch (err) {
    warn('[plan-store bg-collector] pg_stat_statements query failed · skipping round', err);
    return 0;
  }

  let written = 0;
  for (const row of rows) {
    const queryText = String(row.query ?? '');
    if (queryText.trim() === '') continue;
    // 每条之间让出事件循环 · 不阻塞主线程 (§5)。
    await new Promise<void>((resolve) => setImmediate(resolve));

    // pg_stat_statements 的 query 已被 PG 参数化成含 `$1`/`$2` 占位符的形态。对含 `$N` 的 query
    // 直接 `EXPLAIN <q>` 会报 `ERROR: there is no parameter $1` —— 这是参数化 query 收不到 plan 的根因。
    // 修 (别静默吞): 含 `$N` 时走 PG16+ 的 `EXPLAIN (GENERIC_PLAN)` (为占位符生成通用计划 · 不需绑值) ·
    // GENERIC_PLAN 不能与 ANALYZE 同用 (本就不 ANALYZE · 无冲突)。
    const hasParamPlaceholder = /\$\d+/.test(queryText);
    const explainPrefix = hasParamPlaceholder
      ? 'EXPLAIN (GENERIC_PLAN, FORMAT JSON)'
      : 'EXPLAIN (FORMAT JSON, ANALYZE false)';
    try {
      // 纯估算 · 不执行 query。
      let explainRows: Array<Record<string, unknown>>;
      try {
        explainRows = await opts.runSql(`${explainPrefix} ${queryText}`);
      } catch (explainErr) {
        if (hasParamPlaceholder) {
          // GENERIC_PLAN 失败大概率是 PG < 16 (不支持该选项)。不静默吞 · 显式 warn 说明该参数化
          // query 在当前 PG 版本下收不到 background plan (升级到 PG16+ 或靠 on-demand T3 覆盖)。
          warn(
            `[plan-store bg-collector] parameterized query ($N) skipped · EXPLAIN (GENERIC_PLAN) failed (likely PG<16 · upgrade to PG16+ for background plans on parameterized queries · on-demand T3 still covers it)`,
            explainErr,
          );
          continue;
        }
        throw explainErr;
      }
      // EXPLAIN 输出在第一行第一列 (列名因 driver 而异 · 取第一个值)。
      const planRaw = explainRows[0]
        ? Object.values(explainRows[0])[0]
        : undefined;
      const plan =
        typeof planRaw === 'string' ? safeParse(planRaw) : planRaw;
      const summary = summarizePlan(plan);
      await opts.store.writePlan({
        signature: computeSignature(queryText),
        query_text_sha256: queryTextSha256(queryText),
        plan_json: summary.plan_json,
        captured_at: Date.now(),
        source: 'background',
        cost_total: summary.cost_total,
        has_seq_scan: summary.has_seq_scan,
        has_nested_loop_big: summary.has_nested_loop_big,
        projectId: opts.projectId,
      });
      written += 1;
    } catch (err) {
      // 单条 EXPLAIN 失败 (语法 / 权限 / prepared stmt 占位符) → 跳过该条 · 不中断整轮。
      warn(`[plan-store bg-collector] EXPLAIN failed for one query · skipping`, err);
    }
  }
  return written;
}

/**
 * 启动后台 collector: 立即跑一轮 (启动期一次性 §11 OQ5) + setInterval 周期。
 * 返回 handle · stop() 清 timer。collector 内部 fail-safe · 永不抛到 caller。
 */
export function startBackgroundCollector(
  opts: BackgroundCollectorOptions,
): BackgroundCollectorHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  // 启动期一次性 (不 await · fire-and-forget · 失败已内部 warn)。
  void runCollectorOnce(opts).catch(() => {});

  const timer = setInterval(() => {
    void runCollectorOnce(opts).catch(() => {});
  }, intervalMs);
  // 不阻止进程退出。
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
