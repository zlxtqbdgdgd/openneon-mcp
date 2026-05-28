/**
 * RCA data-fetcher · feat-045/#2 (L3) · `Promise.allSettled` 并行拉 4 数据源.
 *
 * Detail design: zlxtqbdgdgd/openneon-design#18 §依赖 + openneon-mcp#146 §验收门 (4 mcp tool
 * 并行拉数据 + 任一失败 [DATA_MISSING:*] degrade).
 *
 * 4 数据源 (按 issue contract 编程 · A6 / feat-068 真实接口随后接通):
 *   1. **feat-066 `get_neondb_trace(trace_id)`** (A6 · openneon-mcp#139 contract) —— 全栈 span
 *   2. **feat-068 dynamic probe 结果** (B2 · 函数级 p95/p99 + 热点栈 · 可选 degrade)
 *   3. **feat-031 `query_audit_events`** (feat-044 状态机时间线)
 *   4. **feat-019 `compute_explain_diff`** (修复前后对比 + 性能改善)
 *
 * **fail-closed per leg**: any leg failure → `FetchLeg.ok=false` + reason → renderer emits
 * `[DATA_MISSING:<leg>]` · 整体 RCA 报告不阻塞 (§3.3 spec / issue body).
 *
 * **fetcher 依赖注入**: 真实 handler (`handleGetNeondbTrace` 等) 由 caller (handler.ts) 注入,
 * 这样在 A6 / B2 真接通前可用 mock 完整跑测,且生产 wiring 时只动 handler.ts 注入点 ·
 * fetcher 本身无依赖 import (避免 contract drift 时改一处影响全模块)。
 */

import type {
  RcaDataBundle,
  RcaTraceView,
  RcaProbeView,
  RcaAuditView,
  RcaValidationView,
  FetchLeg,
  FetchLegStatus,
} from './types';

/** Fetcher contracts · caller binds these to real mcp tool handlers / mocks. */
export type RcaFetcherDeps = {
  /** A6 · openneon-mcp#139 · `get_neondb_trace(trace_id)` */
  fetchTrace: (traceId: string) => Promise<RcaTraceView>;
  /** B2 · feat-068 dynamic probe result */
  fetchProbe: (traceId: string) => Promise<RcaProbeView>;
  /** feat-031 · `query_audit_events` filtered to this trace_id */
  fetchAudit: (traceId: string) => Promise<RcaAuditView>;
  /** feat-019 · `compute_explain_diff` for the implicated query */
  fetchValidation: (traceId: string) => Promise<RcaValidationView>;
};

function legFromSettled<T>(
  result: PromiseSettledResult<T>,
  defaultReason: FetchLegStatus = 'unavailable',
): FetchLeg<T> {
  if (result.status === 'fulfilled') {
    return { ok: true, data: result.value };
  }
  const err = result.reason;
  const reason = classifyFetchError(err) ?? defaultReason;
  return { ok: false, reason, detail: err instanceof Error ? err.message : String(err) };
}

function classifyFetchError(err: unknown): FetchLegStatus | undefined {
  if (!(err instanceof Error)) return undefined;
  const msg = err.message.toLowerCase();
  if (msg.includes('unauth') || msg.includes('forbidden')) return 'auth';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  return undefined;
}

/**
 * Pull all 4 legs in parallel · `Promise.allSettled` so one leg's failure cannot poison the
 * others. Each leg is wrapped into a structured `FetchLeg` discriminated union; the renderer
 * then maps `ok=false` → `[DATA_MISSING:<leg>]`.
 */
export async function fetchRcaBundle(
  traceId: string,
  deps: RcaFetcherDeps,
): Promise<RcaDataBundle> {
  const [traceR, probeR, auditR, validationR] = await Promise.allSettled([
    deps.fetchTrace(traceId),
    deps.fetchProbe(traceId),
    deps.fetchAudit(traceId),
    deps.fetchValidation(traceId),
  ]);
  return {
    trace: legFromSettled(traceR),
    probe: legFromSettled(probeR),
    audit: legFromSettled(auditR),
    validation: legFromSettled(validationR),
  };
}
