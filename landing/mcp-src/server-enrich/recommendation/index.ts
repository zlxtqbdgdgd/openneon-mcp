/**
 * recommendation/index.ts · feat-022 (L2b) · T7 recommendations 总入口。
 *
 * 详设: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-022-L2b-mcp-server-enrich-recommendation-rule-set.html (§3 调用链 + §4 数据契约)
 *
 * `recommend(input)`: 并发跑全 5 个 RuleEvaluator → 收集 Recommendation[] → 按 severity 排序
 * (critical → high → medium → low)。每个规则内部自行 catch 降级 (一个规则失败/超时不拖垮其余 ·
 * §5)。per-rule env flag (§8 回滚) 在这里统一过滤 (关掉的规则不跑)。
 *
 * 注: 本文件不碰 neonClient / connection string / audit emit —— 那些是 handler 层 (T7 handler
 * get-recommendations.ts) 的事。这里纯逻辑层 · 依赖全部经 RuleContext 注入 (便于单测 · §7)。
 */
import type {
  Recommendation,
  RecommendationSeverity,
  RuleContext,
  RuleEvaluator,
} from './types';
import { missingIndexRule } from './rule-missing-index';
import { unusedIndexRule } from './rule-unused-index';
import { oversizedTempRule } from './rule-oversized-temp';
import { autovacuumLagRule } from './rule-autovacuum-lag';
import { inefficientJoinRule } from './rule-inefficient-join';

export type {
  Recommendation,
  RecommendationType,
  RecommendationSeverity,
  RecommendationConfidence,
  RuleEvaluator,
  RuleContext,
  RuleSqlClient,
  RecommendationThresholds,
  ExplainProbe,
  ExplainProbeResult,
  BaselineProbe,
  BaselineProbeResult,
  HistoryProbe,
  HistoryProbeResult,
} from './types';
export { DEFAULT_THRESHOLDS, resolveThresholds, __setThresholdsForTest } from './thresholds';
export { detectHypopg } from './rule-missing-index';

/** 全部规则 (固定顺序 · sort 后顺序由 severity 决定)。 */
export const ALL_RULES: readonly RuleEvaluator[] = [
  missingIndexRule,
  unusedIndexRule,
  oversizedTempRule,
  autovacuumLagRule,
  inefficientJoinRule,
] as const;

const SEVERITY_ORDER: Record<RecommendationSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** per-rule env flag (§8): 未显式设 'false' 即视为开启 (default 全 on)。 */
function ruleEnabled(rule: RuleEvaluator): boolean {
  return process.env[rule.envFlag] !== 'false';
}

/** severity 排序 (critical → low) · 稳定 (同级保持规则顺序 · 即 type 注册序)。 */
export function sortBySeverity(recs: Recommendation[]): Recommendation[] {
  return [...recs].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

export interface RecommendInput {
  ctx: RuleContext;
  /** 可选: 只跑这些 type (默认全 5 类 · 对应 T7 input.recommendation_types)。 */
  types?: RuleEvaluator['type'][];
}

export interface RecommendResult {
  recommendations: Recommendation[];
  /** 实际跑了哪些 type (audit / 调试用)。 */
  types_returned: RuleEvaluator['type'][];
}

/**
 * 总入口: 并发跑全 (或指定) 规则 → 收集 → severity 排序。
 *
 * 每个规则各自 catch 降级 (规则实现保证不抛) · 这里再包一层 Promise.allSettled 兜底
 * (即便某规则意外抛 · 其余照常返回 · §5 「不阻塞其他 rule」硬要求)。
 */
export async function recommend(input: RecommendInput): Promise<RecommendResult> {
  const { ctx, types } = input;
  const selected = ALL_RULES.filter((r) => {
    if (!ruleEnabled(r)) return false;
    if (types && types.length > 0 && !types.includes(r.type)) return false;
    return true;
  });

  const settled = await Promise.allSettled(
    selected.map((rule) => rule.evaluate(ctx)),
  );

  const all: Recommendation[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      all.push(...s.value);
    }
    // rejected → 该规则降级为 0 条 · 不影响其余 (§5)。
  }

  return {
    recommendations: sortBySeverity(all),
    types_returned: selected.map((r) => r.type),
  };
}
