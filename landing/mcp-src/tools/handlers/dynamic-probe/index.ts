/**
 * feat-068 dynamic-probe · 公开 entry
 *
 * 重设计 (#210 · ADR-0017): 主引擎 bpftrace+sidecar → pg_uprobe SQL 驱动 · whitelist 强制 → denylist FLOOR。
 */
export {
  attachDynamicProbeHandler,
  type AttachHandlerCtx,
  type AttachHandlerOutcome,
} from './attach-dynamic-probe';
export {
  attachDynamicProbeInputSchema,
  validateAttachInput,
  PROBE_TYPES,
  PROBE_TARGETS,
  SAFE_SYMBOL_RE,
  type AttachDynamicProbeInput,
  type ProbeView,
  type ProbeTarget,
} from './schema';
export {
  loadDenylist,
  checkDenylist,
  __resetDenylistCacheForTest,
  __setDenylistForTest,
  type Denylist,
  type DenylistCheckResult,
} from './denylist';
export {
  runProbe,
  parseTimeStat,
  type PgClientLike,
  type ProbeType,
  type RunProbeInput,
  type RunProbeResult,
  type TimeProbeResult,
  type HistProbeResult,
} from './sql-driver';
export { newAttachId } from './attach-id';
export {
  RATE_LIMITS,
  checkRateLimit,
  recordAttach,
  releaseAttach,
  __resetRateLimitForTest,
} from './rate-limit';
export { checkPostCondition } from './watchdog';
