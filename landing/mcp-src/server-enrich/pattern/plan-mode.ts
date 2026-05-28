/**
 * Plan-mode integration for cluster_neondb_logs · feat-037/#4 · feat-027 elicitation.
 *
 * Detail design: openneon-mcp#154 §验收门 (LLM 主路径 plan mode 集成 · DBA approve / deny).
 *
 * 跟 feat-045 rca/plan-mode.ts 同 pattern · 但 plan payload 是 cluster-specific:
 *   - tool 字段 'cluster_neondb_logs' (不复用 generate_rca_report)
 *   - 多一个 totalLines · DBA 看到 "这次要让 LLM 看 N 行 log · 估 USD"
 *
 * **fail-closed**: elicitation 失败 (capability 缺失 / timeout) → deny · 绝不 fall-through。
 *
 * **备路径 Drain3 不走 plan mode**: 零 LLM 成本 · DBA 不必 approve · 直接跑。
 * 调用方 (cluster-neondb-logs handler) 只在 willCallLlm=true 时调本模块。
 */

import type { RcaModelId } from '../rca/llm-client';

export type ClusterPlanPayload = {
  tool: 'cluster_neondb_logs';
  endpointId: string;
  model: RcaModelId;
  estimatedInputTokens: number;
  estimatedMaxOutputTokens: number;
  totalLines: number;
  /** USD · 跟 feat-045 estimateCostUsd 同源价目表 (per 1M token) */
  estimatedCostUsd: number;
};

const PRICE_TABLE: Record<RcaModelId, { inputPer1M: number; outputPer1M: number }> = {
  'claude-opus-4-7': { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5': { inputPer1M: 0.8, outputPer1M: 4 },
};

export function estimateClusterCostUsd(
  model: RcaModelId,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICE_TABLE[model];
  const usd =
    (inputTokens / 1_000_000) * price.inputPer1M +
    (outputTokens / 1_000_000) * price.outputPer1M;
  return Math.round(usd * 10_000) / 10_000;
}

export function buildClusterPlanPayload(args: {
  endpointId: string;
  model: RcaModelId;
  estimatedInputTokens: number;
  estimatedMaxOutputTokens: number;
  totalLines: number;
}): ClusterPlanPayload {
  return {
    tool: 'cluster_neondb_logs',
    endpointId: args.endpointId,
    model: args.model,
    estimatedInputTokens: args.estimatedInputTokens,
    estimatedMaxOutputTokens: args.estimatedMaxOutputTokens,
    totalLines: args.totalLines,
    estimatedCostUsd: estimateClusterCostUsd(
      args.model,
      args.estimatedInputTokens,
      args.estimatedMaxOutputTokens,
    ),
  };
}

export type ClusterPlanDecision = 'approved' | 'rejected' | 'unavailable';

export type ClusterRequestApproval = (plan: ClusterPlanPayload) => Promise<ClusterPlanDecision>;

/** fail-closed default → unavailable · prod 由 feat-027 elicitation orchestrator 覆盖. */
export const DEFAULT_CLUSTER_REQUEST_APPROVAL: ClusterRequestApproval = async () => 'unavailable';
