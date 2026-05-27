/**
 * plan-store seam · feat-023/#1 (L2b) · server-enrich 第 4 个子层入口。
 *
 * 详设 §3.2: 全局单例 getPlanStore() + searchPlans(filter) + writePlan(record) + collector lifecycle。
 * backend 由 PLAN_STORE_BACKEND 选 (memory default · redis L3+ stub)。
 *
 * 消费方:
 * - feat-019 T3 handler (on-demand collector · 顺手 writePlan · non-blocking)
 * - T10 search_plans tool handler (searchPlans)
 * - background-collector (writePlan source='background')
 *
 * env (§4):
 *   PLAN_STORE_BACKEND=memory          # default · L3+ 切 redis
 *   PLAN_STORE_TTL_MS=86400000         # default 24h
 *   PLAN_BG_COLLECTOR_ENABLED=true
 *   PLAN_BG_COLLECTOR_INTERVAL_MS=300000
 *   PLAN_BG_COLLECTOR_TOP_N=50
 */

import { MemoryPlanStore } from './memory-store';
import { RedisPlanStore } from './redis-store';
import {
  startBackgroundCollector,
  type BackgroundCollectorHandle,
  type SqlRunner,
} from './background-collector';
import type { PlanFilter, PlanRecord, PlanStoreBackend } from './types';

export type {
  PlanFilter,
  PlanRecord,
  PlanStoreBackend,
} from './types';
export { computeSignature, queryTextSha256, normalizeQuery } from './signature';
export { summarizePlan, planSummaryLine } from './plan-summary';
export {
  startBackgroundCollector,
  runCollectorOnce,
} from './background-collector';
export type {
  BackgroundCollectorHandle,
  BackgroundCollectorOptions,
  SqlRunner,
} from './background-collector';

const DEFAULT_TTL_MS = 86_400_000;

function readTtlMs(): number {
  const v = Number(process.env.PLAN_STORE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

let singleton: PlanStoreBackend | null = null;

/** 全局单例 plan-store · backend 由 PLAN_STORE_BACKEND 选。 */
export function getPlanStore(): PlanStoreBackend {
  if (singleton) return singleton;
  const backend = (process.env.PLAN_STORE_BACKEND ?? 'memory').toLowerCase();
  if (backend === 'redis') {
    // L3+ stub · 第一次调用即 throw NotImplementedError (§11 OQ2)。
    singleton = new RedisPlanStore();
  } else {
    singleton = new MemoryPlanStore(readTtlMs());
  }
  return singleton;
}

/** test helper · 重置单例 (换 backend / 清状态)。 */
export function _resetPlanStoreForTests(store?: PlanStoreBackend): void {
  singleton = store ?? null;
}

/** thin convenience: 查 store (T10 handler 用)。 */
export function searchPlans(filter: PlanFilter): Promise<PlanRecord[]> {
  return getPlanStore().searchPlans(filter);
}

/** thin convenience: 写 store (on-demand / background collector 用)。 */
export function writePlan(record: PlanRecord): Promise<void> {
  return getPlanStore().writePlan(record);
}

// ──────────────────────────────────────────────────────────────
// background collector lifecycle (per projectId)
// ──────────────────────────────────────────────────────────────

const collectors = new Map<string, BackgroundCollectorHandle>();

/** PLAN_BG_COLLECTOR_ENABLED 默认 true · 显式 'false' 才关。 */
export function isBackgroundCollectorEnabled(): boolean {
  return (process.env.PLAN_BG_COLLECTOR_ENABLED ?? 'true') !== 'false';
}

function readIntervalMs(): number {
  const v = Number(process.env.PLAN_BG_COLLECTOR_INTERVAL_MS);
  return Number.isFinite(v) && v > 0 ? v : 300_000;
}

function readTopN(): number {
  const v = Number(process.env.PLAN_BG_COLLECTOR_TOP_N);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 50;
}

/**
 * 为某 projectId 启 background collector (幂等 · 已启则复用)。
 * PLAN_BG_COLLECTOR_ENABLED=false → no-op (返 null · §8 回滚: 退化为仅 on-demand)。
 *
 * 注: collector 是 per-project 的 · projectId + SqlRunner 只有进到 tool 调用才齐全 · 故由上层
 * wire-up 在带 project 上下文的只读路径惰性启动。**实际调用点**: tools.ts 的 get_neondb_explain_plans
 * handler (见 ensurePlanCollectorForProject) —— 首次对某 project 调 explain 即启动 · 之后复用。
 * 这样默认配置 (PLAN_BG_COLLECTOR_ENABLED 未设 → true) 下 collector 真会跑 · 与 README "5min 自动采集" 一致。
 */
export function ensureBackgroundCollector(
  projectId: string,
  runSql: SqlRunner,
): BackgroundCollectorHandle | null {
  if (!isBackgroundCollectorEnabled()) return null;
  const existing = collectors.get(projectId);
  if (existing) return existing;
  const handle = startBackgroundCollector({
    projectId,
    store: getPlanStore(),
    runSql,
    intervalMs: readIntervalMs(),
    topN: readTopN(),
  });
  collectors.set(projectId, handle);
  return handle;
}

/** 停某 project (或全部) 的 collector · lifecycle / 回滚 / test 用。 */
export function stopBackgroundCollector(projectId?: string): void {
  if (projectId) {
    collectors.get(projectId)?.stop();
    collectors.delete(projectId);
    return;
  }
  for (const h of collectors.values()) h.stop();
  collectors.clear();
}
