/**
 * canary-evidence-store.ts · feat-042 follow-up (#176) · in-memory store for
 * propagating branch_canary_ddl verdict to the next run_sql plan-mode call.
 *
 * 背景:
 *   agent 上游调 `branch_canary_ddl` 拿 verdict + metrics · 下一步调 `run_sql`
 *   执行同一条 DDL 时 · plan-mode renderPlan 需要 canary 证据段。EnforcementCtx
 *   暴露了 `canaryEvidence?: CanaryEvidence` 字段 · 但**注入路径 deferred** (PR171
 *   §模块边界 自述 · "route.ts 端把上游 branch_canary_ddl 结果注入下次 run_sql
 *   的接线 out-of-scope · 留 follow-up")。
 *
 *   本模块 ship 注入路径的存储 + helper · 让 route.ts (或当前直调 handler 的
 *   测试 path) 能透传 canary 证据。
 *
 * 设计:
 *   - 进程级 in-memory store (跟 plan-store background-collector 同 pattern · 不写文件)
 *   - key = `${project_id}:${sql_sha256}` · 跨 tenant 隔离 · DDL 文本一致才命中
 *   - TTL = 5min · agent 跑完 canary 立刻接 run_sql · 5min 足够覆盖正常使用
 *   - consume API 用一次即清 (避免 stale 证据被复用 · 一条 DDL 一次 canary)
 *   - 跨 tenant 安全: project_id 必须显式传 · 不接受 undefined (跟 G1 hard-deny 一致)
 *
 * 调用方:
 *   - `recordCanaryVerdict(...)` · branch-canary-ddl handler 在完成 verdict 后调
 *   - `consumeCanaryVerdict(...)` · route.ts orchestrator 在 run_sql 进 pipeline 前调
 *     (本 PR 仅 ship 模块 · route.ts 实际 wire 还是 deferred · 跟踪后续 sub-issue)
 *
 * 跟踪 design#52 feat-042 关闭条件之一。
 */

import { createHash } from 'node:crypto';
import type { CanaryEvidence } from '../policy/stages/plan-mode';

const TTL_MS = 5 * 60 * 1000; // 5min · agent 跑完 canary 立刻接 run_sql

type Entry = {
  evidence: CanaryEvidence;
  expiresAt: number;
};

const store = new Map<string, Entry>();

function makeKey(projectId: string, sql: string): string {
  const sha = createHash('sha256').update(sql).digest('hex');
  return `${projectId}:${sha}`;
}

function sweepExpired(now: number): void {
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}

/**
 * 记录一条 canary verdict · 跟 (project_id, sql) 关联。
 *
 * 调用方: `branch_canary_ddl` handler 在 outcome 决定后调 (verdict ∈
 * {low_risk_proceed, high_risk_review, canary_failed, timeout})。skip_low_risk
 * 不记 (本身就是"不必 canary"verdict · 下游 plan-mode 不需要证据段)。
 */
export function recordCanaryVerdict(
  projectId: string,
  sql: string,
  evidence: CanaryEvidence,
): void {
  if (!projectId || !sql) {
    return; // fail-safe · 缺 key 拒记 · 不抛 (handler 内调用 · 不影响 verdict)
  }
  const now = Date.now();
  sweepExpired(now);
  store.set(makeKey(projectId, sql), {
    evidence,
    expiresAt: now + TTL_MS,
  });
}

/**
 * 取出并清掉 (project_id, sql) 对应的 canary verdict。
 *
 * 调用方: route.ts orchestrator 在调 `runPipeline(ctx)` 之前 · 用 args.projectId
 * + args.sql 查 · 命中 → 注入 `ctx.canaryEvidence` · 让 plan-mode renderPlan
 * 渲染证据段。
 *
 * 一次性消费 · 取完即清 (防 stale 证据被另一条 DDL 误用)。
 */
export function consumeCanaryVerdict(
  projectId: string,
  sql: string,
): CanaryEvidence | undefined {
  if (!projectId || !sql) return undefined;
  const now = Date.now();
  sweepExpired(now);
  const key = makeKey(projectId, sql);
  const entry = store.get(key);
  if (!entry) return undefined;
  store.delete(key);
  return entry.evidence;
}

/** 测试用 · 重置 store (跨 case 隔离) */
export function __resetCanaryEvidenceStoreForTest(): void {
  store.clear();
}

/** 测试用 · 查询当前 store size (验证 TTL sweep) */
export function __canaryEvidenceStoreSizeForTest(): number {
  return store.size;
}
