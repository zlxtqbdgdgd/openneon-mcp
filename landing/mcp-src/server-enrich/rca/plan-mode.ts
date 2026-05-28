/**
 * RCA plan-mode integration · feat-045/#2 (L3) · feat-027 elicitation 集成.
 *
 * Detail design: openneon-mcp#146 §验收门 (feat-027 plan mode 集成 · DBA approve / deny).
 *
 * 集成形态 (contract-first · feat-027 stage 真实接口在 m4-approval 分支未合 main):
 *   - tool 调用前 server 估算 cost (input/output token × model price) → 组 `RcaPlanPayload`
 *   - orchestrator 通过注入的 `requestApproval` callback 弹 elicitInput 给 DBA
 *   - DBA approve → 继续 LLM 调用 · DBA deny → 拒并 audit (caller 端 emit `plan_mode_rejected`)
 *
 * **fail-closed**: elicitation 失败 (capability 缺失 / timeout) → deny · 绝不 fall-through。
 *   这跟 feat-027 stage 行为对齐 (m4-approval/landing/mcp-src/policy/stages/plan-mode.ts §SPIKE 实证).
 *
 * 设计依据 ADR-0008 (server 事实 plan · 禁投机预测) · plan payload 只装 server 推导的事实
 * (model id · input/output token 估算 · cost 估算) · 不写 "RCA 写完会发现 X" 这类幻觉预测。
 */

import type { RcaModelId } from './llm-client';

/** Server 事实 plan payload (跟 feat-027 PlanPayload 形态对齐 · 此处为 RCA-specific 子类型). */
export type RcaPlanPayload = {
  tool: 'generate_rca_report';
  traceId: string;
  model: RcaModelId;
  estimatedInputTokens: number;
  estimatedMaxOutputTokens: number;
  /** USD · 按 model 价目表 · 与价目表脱钩处理 (常量在本文件 PRICE_TABLE). */
  estimatedCostUsd: number;
};

/** Per-model price (USD per 1M tokens · stable as of 2026-05 · update when Anthropic changes). */
const PRICE_TABLE: Record<RcaModelId, { inputPer1M: number; outputPer1M: number }> = {
  'claude-opus-4-7': { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5': { inputPer1M: 0.8, outputPer1M: 4 },
};

export function estimateCostUsd(
  model: RcaModelId,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICE_TABLE[model];
  const usd = (inputTokens / 1_000_000) * price.inputPer1M + (outputTokens / 1_000_000) * price.outputPer1M;
  return Math.round(usd * 10_000) / 10_000; // 4 dp
}

export function buildPlanPayload(args: {
  traceId: string;
  model: RcaModelId;
  estimatedInputTokens: number;
  estimatedMaxOutputTokens: number;
}): RcaPlanPayload {
  return {
    tool: 'generate_rca_report',
    traceId: args.traceId,
    model: args.model,
    estimatedInputTokens: args.estimatedInputTokens,
    estimatedMaxOutputTokens: args.estimatedMaxOutputTokens,
    estimatedCostUsd: estimateCostUsd(
      args.model,
      args.estimatedInputTokens,
      args.estimatedMaxOutputTokens,
    ),
  };
}

export type PlanDecision = 'approved' | 'rejected' | 'unavailable';

/** Elicitation callback injected by orchestrator · fail-closed default = unavailable. */
export type RequestApproval = (plan: RcaPlanPayload) => Promise<PlanDecision>;

/**
 * Default approval requester · returns `unavailable` → fail-closed deny.
 * Production wiring (feat-027 elicitation orchestrator) replaces this on tool-call entry.
 */
export const DEFAULT_REQUEST_APPROVAL: RequestApproval = async () => 'unavailable';
