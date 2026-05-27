/**
 * elicitation-probe.ts · feat-027/#74 SPIKE · MCP client elicitation capability 探测
 *
 * 设计: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-027-L2-mcp-server-plan-mode-enforcement.html (§11.1 OQ1 SPIKE)
 * 矩阵文档: dev-notes/feat-027-elicitation-capability-matrix.md
 *
 * 用途 (SPIKE AC1/AC2):
 * - 给定一个已 initialize 的 `McpServer`,**非破坏性**判定其连接的 client 是否声明 elicitation
 *   capability,以及子能力 (form / url) —— 不发任何 `elicitation/create` 请求 (探测纯读
 *   `getClientCapabilities()` 快照 · 不弹窗 · 不阻塞)。
 * - 给定一次 `elicitInput` 抛出的 Error,分类失败形态 (capability 缺失 / 超时 / 其他) ·
 *   供 orchestrator fail-closed 决策与 audit 归因。
 *
 * 为什么需要它:
 * - SPIKE AC1 要"client × elicitation 支持矩阵";真实矩阵靠人在真 client 跑 (见矩阵文档),
 *   但 server 侧能在**运行时**自报"我现在连的这个 client 到底声明了什么"——这就是本 probe 的
 *   产物: 把 SDK 内部 `_clientCapabilities` 的归一化规则 (1.25.3 `ElicitationCapabilitySchema`
 *   的 z.preprocess: 空 `elicitation:{}` → `{form:{}}`) 显式化成可测、可日志、可 audit 的判定。
 * - **不取代** route.ts 现有 fail-closed 主路径 (那里故意不预检 · 直接 attempt + catch · 因
 *   mcp-handler streamable HTTP 下 getClientCapabilities 快照可能为 null)。本 probe 是**诊断/
 *   可观测**工具: 探测、日志、矩阵实测取证、capability-cache 命中后的复核。
 *
 * 注意 (与 route.ts 主路径的关系):
 * - 生产 fail-closed gate 仍以 `resolvePlanApproval` 的 try/catch 为准 (plan-mode.ts) ·
 *   probe 返回 'supported' 不等于"一定能弹窗成功" (传输/session 仍可能丢 capability ·
 *   见 issue #100 + 矩阵文档 §传输前提)。probe 的 'none' 才是确定性结论 (确定 fail-closed)。
 */
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';

/** 探测到的 elicitation 支持档位。 */
export type ElicitationSupport =
  | 'form' // 声明 elicitation.form (或空 elicitation:{} 被 SDK 归一化成 form)
  | 'url' // 声明 elicitation.url (URL 模式 · 罕见)
  | 'form+url' // 同时声明 form 与 url
  | 'none' // 未声明 elicitation capability → 确定 fail-closed
  | 'unknown'; // capability 快照尚不可得 (未 initialize / 传输丢失) → 保守按 fail-closed 处理

export type ElicitationProbeResult = {
  support: ElicitationSupport;
  /** capability 快照是否拿到 (false = getClientCapabilities() 返 undefined/null · 见 issue #100) */
  capabilitiesPresent: boolean;
  /** 是否应放行 elicitation attempt (true: form/url/form+url · false: none/unknown → fail-closed) */
  canElicit: boolean;
  /** 原始 capability 快照 (日志/audit 取证用 · 可能为 undefined) */
  raw?: ClientCapabilities;
};

/**
 * 归一化 elicitation capability · 复刻 SDK 1.25.3 `ElicitationCapabilitySchema` 的 z.preprocess:
 * client 声明的**空 `elicitation: {}` 被归一化成 `{ form: {} }`** (稳定版 spec 2025-06-18 兼容)。
 * → 只声明 `elicitation: {}` 的 client 不会被误判为不支持 (SPIKE §11.1 B 已实证)。
 *
 * 注: 我们在 probe 侧重做归一化 · 不依赖 SDK 是否已归一化过 (getClientCapabilities 返回的
 * 可能是 SDK 已 normalize 的 · 也可能是我们经 capability-cache 注回的原始声明 · 两者都覆盖)。
 */
export function classifyElicitation(
  caps: ClientCapabilities | undefined | null,
): ElicitationProbeResult {
  if (!caps || Object.keys(caps).length === 0) {
    return {
      support: 'unknown',
      capabilitiesPresent: false,
      canElicit: false,
      raw: caps ?? undefined,
    };
  }

  const elicitation = (caps as { elicitation?: unknown }).elicitation;
  if (elicitation === undefined || elicitation === null) {
    // capability 快照存在但**明确没有** elicitation 字段 = 确定不支持 → fail-closed。
    return {
      support: 'none',
      capabilitiesPresent: true,
      canElicit: false,
      raw: caps,
    };
  }

  // elicitation 存在 · 判子能力。空对象 {} 按 SDK 归一化视作 form。
  const sub = elicitation as Record<string, unknown>;
  const hasForm = 'form' in sub || Object.keys(sub).length === 0;
  const hasUrl = 'url' in sub;

  let support: ElicitationSupport;
  if (hasForm && hasUrl) support = 'form+url';
  else if (hasUrl) support = 'url';
  else support = 'form'; // form 或 空对象归一化

  return {
    support,
    capabilitiesPresent: true,
    canElicit: true,
    raw: caps,
  };
}

/**
 * 运行时探测: 从一个 `McpServer.server` 读 capability 快照并分类。**非破坏性** (纯读 · 不发请求)。
 *
 * @param serverLike 暴露 `getClientCapabilities()` 的对象 (SDK `Server` · 即 `mcpServer.server`)。
 *
 * 用法 (orchestrator / 诊断端点):
 *   const probe = probeElicitation(server.server);
 *   logger.info('elicitation probe', probe);
 *   if (!probe.canElicit) // → 该连接确定 fail-closed · 高危 op 走 deny-only
 */
export function probeElicitation(serverLike: {
  getClientCapabilities?: () => ClientCapabilities | undefined;
}): ElicitationProbeResult {
  const caps = serverLike.getClientCapabilities?.();
  return classifyElicitation(caps);
}

// ───────────────────────── 失败形态分类 (SPIKE AC2) ─────────────────────────

/** `elicitInput` 抛错时的失败形态 (供 fail-closed audit 归因 · 详矩阵文档 §失败形态)。 */
export type ElicitFailureKind =
  | 'capability_missing' // SDK 同步抛 "Client does not support [form] elicitation" (capability 缺失)
  | 'timeout' // RequestOptions timeout 触发 · request reject
  | 'transport' // 连接断 / 传输错
  | 'other'; // 其他异常 (保守也按 fail-closed)

/**
 * 把 `elicitInput` 抛出的 Error 归类为失败形态 (SPIKE AC2)。SDK 1.25.3 对 capability 缺失是
 * **同步抛 Error** (请求根本不发出):
 *   - form 模式: throw new Error('Client does not support form elicitation.')
 *   - 通用守卫 assertCapabilityForMethod: throw new Error('Client does not support elicitation ...')
 *
 * 任何归类结果都 → fail-closed deny (本函数只做 audit 归因 · 不改变 deny 决策)。
 */
export function classifyElicitFailure(err: unknown): ElicitFailureKind {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes('does not support') && lower.includes('elicitation')) {
    return 'capability_missing';
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return 'timeout';
  }
  if (
    lower.includes('connection') ||
    lower.includes('closed') ||
    lower.includes('econnreset') ||
    lower.includes('transport')
  ) {
    return 'transport';
  }
  return 'other';
}
