/**
 * feat-045 6 case fixtures · openneon-mcp#147 §验收门.
 *
 * 6 case:
 *   1. standard         — 4 数据源齐 → 7 节完整 markdown
 *   2. probe_degraded   — probe leg 失败 → [DATA_MISSING:probe] 占位
 *   3. token_truncated  — evidence 过大 → 截断 + [DATA_MISSING:evidence_truncated]
 *   4. cache_hit        — 同 trace_id 第二次调用零 LLM
 *   5. plan_deny        — DBA reject elicitation → throw plan_mode_rejected
 *   6. cross_model      — opus / sonnet / haiku 三轮 → 7 节结构一致 (≥ 95%)
 *
 * 每个 case 一个 self-contained scenario · 测试 import 并断言。
 */

import type {
  RcaTraceView,
  RcaProbeView,
  RcaAuditView,
  RcaValidationView,
} from '../../server-enrich/rca/types';

export const SAMPLE_TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

export const SAMPLE_TRACE: RcaTraceView = {
  spanTree: [
    { serviceName: 'proxy', operationName: 'connect', durationMs: 1, depth: 0 },
    { serviceName: 'compute', operationName: 'parse+execute', durationMs: 1480, depth: 1 },
    { serviceName: 'pageserver', operationName: 'getpage@lsn', durationMs: 1480, depth: 2 },
    { serviceName: 'pageserver', operationName: 'replay_wal', durationMs: 1100, depth: 3 },
  ],
  componentLatency: [
    { component: 'proxy', durationMs: 1, pct: 0.07 },
    { component: 'compute', durationMs: 1480, pct: 98.7 },
    { component: 'pageserver', durationMs: 1480, pct: 98.7 },
    { component: 'safekeeper', durationMs: 19, pct: 1.27 },
  ],
};

export const SAMPLE_PROBE: RcaProbeView = {
  hotspots: [
    { functionName: 'ExecutorRun', p95Ms: 1450, hotspotPct: 78.0 },
    { functionName: 'heap_hot_search_buffer', p95Ms: 1130, hotspotPct: 60.5 },
    { functionName: 'ReadBuffer_common', p95Ms: 380, hotspotPct: 21.0 },
  ],
};

export const SAMPLE_AUDIT: RcaAuditView = {
  events: [
    { deltaSeconds: 0, stage: '感知', summary: 'T4 health_signals 报 cache_hit < 85%' },
    { deltaSeconds: 10, stage: '定位', summary: 'trace 锁定 pageserver layer cache miss' },
    { deltaSeconds: 25, stage: '假设', summary: 'hypopg 建议 CREATE INDEX ON orders(user_id)' },
    { deltaSeconds: 60, stage: '修复', summary: 'plan-approved · CREATE INDEX CONCURRENTLY' },
    { deltaSeconds: 90, stage: '验证', summary: 'EXPLAIN diff 显示 seq scan → index scan' },
  ],
};

export const SAMPLE_VALIDATION: RcaValidationView = {
  beforeMs: 1500,
  afterMs: 50,
  explainDiffSha256: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
};

export type CaseName =
  | 'standard'
  | 'probe_degraded'
  | 'token_truncated'
  | 'cache_hit'
  | 'plan_deny'
  | 'cross_model';

export const CASE_NAMES: readonly CaseName[] = [
  'standard',
  'probe_degraded',
  'token_truncated',
  'cache_hit',
  'plan_deny',
  'cross_model',
] as const;
