/**
 * feat-068 dynamic-probe · 公开 entry
 *
 * 注:本 sub-issue scope 只到 handler 层 + 8 case fixture · MCP NEON_TOOLS 注册留给后续 PR
 * (需配 grant-scope mapping + role-toolsets + tools.ts dispatch case · 跨文件改动大 ·
 * 详设 §4 已划定但 ship 节奏分 issue)。
 */
export {
  attachDynamicProbeHandler,
  type AttachHandlerCtx,
  type AttachHandlerOutcome,
} from './attach-dynamic-probe';
export {
  attachDynamicProbeInputSchema,
  validateAttachInput,
  loadWhitelist,
  checkWhitelist,
  __resetWhitelistCacheForTest,
  __setWhitelistForTest,
  type AttachDynamicProbeInput,
  type Whitelist,
} from './schema';
export {
  TEMPLATE_NAMES,
  TEMPLATES,
  renderTemplate,
  type TemplateName,
  type TemplateInputs,
} from './templates';
export {
  RATE_LIMITS,
  checkRateLimit,
  recordAttach,
  releaseAttach,
  __resetRateLimitForTest,
} from './rate-limit';
export {
  MockDispatcher,
  K8sDispatcher,
  newAttachId,
  type Dispatcher,
  type AttachRequest,
  type AttachResult,
  type SidecarCapability,
} from './sidecar';
export {
  runWatchdog,
  checkPostCondition,
  WATCHDOG_POLL_MS,
} from './watchdog';
