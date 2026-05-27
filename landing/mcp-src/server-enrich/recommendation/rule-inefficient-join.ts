/**
 * rule-inefficient-join.ts · feat-022 (L2b) · inefficient_join 规则 (§3.5)。
 *
 * 调 feat-019 T3 explain_plans (注入式 ExplainProbe · depth=full 拿 raw plan) → plan walk 找
 * Nested Loop 且 outer (第一个子节点) 估算行数 > tunable threshold (default 10000) → 推荐改
 * hash/merge join 或 ANALYZE。小表 nested loop (outer 行数小) 合理 → 0 rec (fixture 用例 14)。
 *
 * T3 调用失败 → 跳过 (其余规则照常 · §5)。需要 querySignature/sql 才能 explain · 否则跳过。
 */
import type {
  ExplainProbeResult,
  Recommendation,
  RuleContext,
  RuleEvaluator,
} from './types';

const RULE_VERSION = '1';

type PlanNode = Record<string, unknown>;

/** EXPLAIN (FORMAT JSON) = `[{ "Plan": {...} }]` → 根 Plan 节点。 */
function extractRootPlan(plan: unknown): PlanNode | null {
  const first = Array.isArray(plan) && plan.length > 0 ? plan[0] : null;
  const root =
    first && typeof first === 'object' ? (first as PlanNode)['Plan'] : null;
  return root && typeof root === 'object' ? (root as PlanNode) : null;
}

/** Nested Loop 节点的 outer = 第一个子 plan (PG 约定 plan[0] 是 outer/driving side)。 */
function outerPlanRows(node: PlanNode): number {
  const children = node['Plans'];
  if (Array.isArray(children) && children.length > 0) {
    const outer = children[0] as PlanNode;
    const rows = outer?.['Plan Rows'];
    return typeof rows === 'number' ? rows : 0;
  }
  return 0;
}

export interface InefficientJoinHit {
  outer_rows: number;
  inner_rows: number;
  total_cost: number;
}

/**
 * plan walk: 找 outer rows 超阈值的 Nested Loop · 返回最严重 (outer rows 最大) 的那个。
 * 纯函数 · 便于单测 (fixture 用例 13/14)。
 */
export function findInefficientNestedLoop(
  plan: unknown,
  outerRowsThreshold: number,
): InefficientJoinHit | null {
  const root = extractRootPlan(plan);
  if (!root) return null;
  let worst: InefficientJoinHit | null = null;

  const visit = (node: PlanNode): void => {
    const nodeType =
      typeof node['Node Type'] === 'string' ? node['Node Type'] : '';
    if (nodeType === 'Nested Loop') {
      const outerRows = outerPlanRows(node);
      if (outerRows > outerRowsThreshold) {
        const children = Array.isArray(node['Plans'])
          ? (node['Plans'] as PlanNode[])
          : [];
        const innerRows =
          children.length > 1 && typeof children[1]['Plan Rows'] === 'number'
            ? (children[1]['Plan Rows'] as number)
            : 0;
        const totalCost =
          typeof node['Total Cost'] === 'number' ? node['Total Cost'] : 0;
        if (!worst || outerRows > worst.outer_rows) {
          worst = {
            outer_rows: outerRows,
            inner_rows: innerRows,
            total_cost: totalCost,
          };
        }
      }
    }
    const children = node['Plans'];
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child && typeof child === 'object') visit(child as PlanNode);
      }
    }
  };
  visit(root);
  return worst;
}

export const inefficientJoinRule: RuleEvaluator = {
  type: 'inefficient_join',
  envFlag: 'T7_INEFFICIENT_JOIN_ENABLED',

  async evaluate(ctx: RuleContext): Promise<Recommendation[]> {
    // 需要 T3 explain + 一个具体 query (querySignature) 才能 walk plan。缺任一 → 跳过 (§5)。
    if (!ctx.explain || !ctx.querySignature) return [];
    try {
      const res: ExplainProbeResult = await ctx.explain({
        sql: '',
        querySignature: ctx.querySignature,
      });
      const hit = findInefficientNestedLoop(
        res.plan,
        ctx.thresholds.inefficient_join_outer_rows,
      );
      if (!hit) return [];
      return [
        {
          type: 'inefficient_join',
          severity: 'medium',
          target: ctx.querySignature,
          evidence: {
            join_op: 'Nested Loop',
            outer_rows: hit.outer_rows,
            inner_rows: hit.inner_rows,
            total_cost: hit.total_cost,
          },
          suggested_action:
            '考虑 hash join (set enable_nestloop=off 测试) · 或 ANALYZE 相关表让 planner 选 hash/merge',
          confidence: 'high',
          rule_version: RULE_VERSION,
        },
      ];
    } catch {
      // T3 调用失败 → 跳过 (其余规则照常 · §5)。
      return [];
    }
  },
};
