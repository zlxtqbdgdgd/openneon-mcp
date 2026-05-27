/**
 * explain-plans.ts · feat-019/#1 · get_neondb_explain_plans —— T3 explain 的 op-class-aware 安全 gate。
 *
 * **堵上游严重坑**: 上游 `explain_sql_statement` (`handleExplainSqlStatement`) `analyze` 默认 true +
 * `EXPLAIN (ANALYZE...) <sql>` 直接执行 + branchId 可选(默认生产 main) → agent 裸调
 * `explain_sql_statement(sql="DELETE FROM users")` 会在生产**真删数据**,工具却标 readOnlyHint:true。
 *
 * feat-019/#1 wrap 它: 调上游**之前** classifyOp(内层 sql) →
 *   - READ_ONLY (SELECT/EXPLAIN) → analyze 允许 (EXPLAIN ANALYZE on 当前分支 · 只读安全)
 *   - DML/DDL                    → **强制 analyze=false** (纯 EXPLAIN 估算 · 不执行 · 无视传入的 analyze)
 * 这是**硬安全** (feature flag 也不可关 · 详设 §6/§8)。
 *
 * 上游调用经 `ExplainRunner` 注入 (analyze 已 gate) —— 既便单测 mock,又避免 import tools.ts 的循环依赖。
 *
 * feat-019/#2: parsePlanSignals (解析 EXPLAIN JSON → seq_scan / missing_index_hint / expensive_node /
 * total_cost 摘要) + progressive depth (复用 feat-007 config/depth): depth=shallow (默认) 返回 signals
 * 摘要 (< 2K token · 防 agent 在巨大嵌套 plan JSON 里幻觉读数);depth=full 返回 raw EXPLAIN JSON。
 *
 * 设计: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-019-L2-mcp-tool-t3-explain-plans.html (§3 §4 §6)
 *
 * feat-023/#1 (L2b): on-demand collector hook —— 成功 EXPLAIN 后 **non-blocking** 把 plan 摘要写
 * plan-store (source='on_demand' · pad-on-fetch · 零额外开销)。写失败 log warn **不抛**,
 * 不影响 T3 返回 (fail-safety · 跟 feat-031 audit 同源 · 详设 §3 on-demand path + §8 回滚)。
 */
import { classifySql, type OpClass } from '../../protection/destructive-detector';
import { DEFAULT_DEPTH, isValidDepth, type DepthLevel } from '../../config/depth';
import {
  getPlanStore,
  computeSignature,
  queryTextSha256,
  summarizePlan,
} from '../../server-enrich/plan-store';

export type ExplainPlansInput = {
  sql: string;
  projectId: string;
  branchId?: string;
  databaseName?: string;
  /** 请求是否 ANALYZE · op-class-gated: 非只读 (DML/DDL) sql 无视此值强制 false。 */
  analyze?: boolean;
  /** progressive disclosure (复用 feat-007): shallow (默认) = signals 摘要 · full = raw plan。 */
  depth?: DepthLevel;
};

/** parsePlanSignals 提取的防幻觉摘要信号 (详设 §4)。 */
export type PlanSignal =
  | { type: 'seq_scan'; table: string; est_rows: number }
  | { type: 'missing_index_hint'; table: string; filter_col: string }
  | { type: 'expensive_node'; node: string; cost: number };

/** 上游 handleExplainSqlStatement 返回的 MCP content 形态 (content[0].text = EXPLAIN JSON 字符串)。 */
export type RawExplainResult = {
  content: Array<{ type: 'text'; text: string }>;
};

/** 注入式上游调用 (analyze 已被 gate · 由调用方绑定 projectId/branchId/neonClient)。 */
export type ExplainRunner = (analyze: boolean) => Promise<RawExplainResult>;

export type ExplainAnnotation = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
};

export type ExplainPlansResult = {
  op_class: OpClass;
  /** 实际是否 ANALYZE (写 op 被 gate → false)。 */
  analyzed: boolean;
  /** 请求了 analyze 但被 op-class gate 降级为估算。 */
  downgraded: boolean;
  /** 内层 sql 的诚实 annotation (动态 · 详设 §6 · 关联 feat-058)。 */
  annotation: ExplainAnnotation;
  /** 生效的 depth (默认 shallow)。 */
  depth: DepthLevel;
  /** depth=shallow (默认 · token 经济): 防幻觉 signals 摘要。 */
  signals?: PlanSignal[];
  /** depth=shallow: plan 根节点总 cost。 */
  total_cost?: number;
  /** depth=full: raw EXPLAIN JSON。 */
  plan?: unknown;
};

type PlanNode = Record<string, unknown>;

/** EXPLAIN (FORMAT JSON) 输出 = `[{ "Plan": {...} }]` → 取根 Plan 节点。 */
function extractRootPlan(plan: unknown): PlanNode | null {
  const first = Array.isArray(plan) && plan.length > 0 ? plan[0] : null;
  const root =
    first && typeof first === 'object'
      ? (first as PlanNode)['Plan']
      : null;
  return root && typeof root === 'object' ? (root as PlanNode) : null;
}

/**
 * Filter 表达式取第一个看似列名的标识符 (启发式 · 详设 §11 OQ2 · 需校准)。
 * 如 "(sale_date > '2020-01-01'::date)" → "sale_date"。
 */
function extractFilterColumn(filter: string): string {
  const m = filter.match(/[a-zA-Z_][a-zA-Z0-9_]*/);
  return m ? m[0] : 'unknown';
}

/**
 * 解析 EXPLAIN plan JSON → 防幻觉 signals 摘要 (详设 §4):
 * - seq_scan: 全表扫描节点 (table + est_rows)
 * - missing_index_hint: 带 Filter 的 Seq Scan → 提示该表 filter 列可能缺索引 (table + filter_col)
 * - expensive_node: 全树 Total Cost 最高的节点 (node + cost · day-one 启发式 · OQ2)
 * - total_cost: 根节点 Total Cost
 * 非法 / 非 EXPLAIN JSON → 空 signals (不抛 · 调用方降级)。
 */
export function parsePlanSignals(plan: unknown): {
  signals: PlanSignal[];
  total_cost: number;
} {
  const root = extractRootPlan(plan);
  if (!root) return { signals: [], total_cost: 0 };

  const signals: PlanSignal[] = [];
  // 全树 Total Cost 最高的节点 (用基本类型累积 · 避开闭包内 mutation 的类型收窄问题)
  let maxCost = -1;
  let maxCostNode = '';

  const visit = (node: PlanNode): void => {
    const nodeType =
      typeof node['Node Type'] === 'string' ? node['Node Type'] : '';
    const cost = typeof node['Total Cost'] === 'number' ? node['Total Cost'] : 0;

    if (nodeType === 'Seq Scan') {
      const table = String(node['Relation Name'] ?? node['Alias'] ?? 'unknown');
      const estRows =
        typeof node['Plan Rows'] === 'number' ? node['Plan Rows'] : 0;
      signals.push({ type: 'seq_scan', table, est_rows: estRows });
      const filter = node['Filter'];
      if (typeof filter === 'string' && filter.trim().length > 0) {
        signals.push({
          type: 'missing_index_hint',
          table,
          filter_col: extractFilterColumn(filter),
        });
      }
    }

    if (cost > maxCost) {
      maxCost = cost;
      maxCostNode = nodeType || 'unknown';
    }

    const children = node['Plans'];
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child && typeof child === 'object') visit(child as PlanNode);
      }
    }
  };
  visit(root);

  if (maxCost > 0) {
    signals.push({ type: 'expensive_node', node: maxCostNode, cost: maxCost });
  }

  const total_cost =
    typeof root['Total Cost'] === 'number' ? root['Total Cost'] : 0;
  return { signals, total_cost };
}

/**
 * 硬安全 gate (详设 §6/§8 · feature flag 也不可关): 内层非只读 sql → 强制 analyze=false
 * (纯 EXPLAIN 估算 · 不执行 → 防生产 DML 真执行)。READ_ONLY → 沿用请求值。
 */
export function gateAnalyze(opClass: OpClass, requestedAnalyze: boolean): boolean {
  return opClass === 'READ_ONLY' ? requestedAnalyze : false;
}

/**
 * 动态 annotation (详设 §6 · 关联 feat-058): 内层 sql 诚实反映 destructive ——
 * 非只读 sql 的 EXPLAIN (即便被 gate 降级) annotation 也标 destructive,不沿用上游误导的 readOnly:true。
 */
export function explainAnnotationFor(opClass: OpClass): ExplainAnnotation {
  return opClass === 'READ_ONLY'
    ? { readOnlyHint: true, destructiveHint: false }
    : { readOnlyHint: false, destructiveHint: true };
}

/**
 * feat-023/#1 on-demand collector hook: 把成功 EXPLAIN 的 plan 摘要写 plan-store
 * (source='on_demand')。**non-blocking · 写失败仅 log warn 不抛** —— 任何异常都吞掉,
 * 绝不影响 T3 返回 (详设 §3 on-demand path · fail-safety)。
 */
function writeOnDemandPlan(
  projectId: string,
  sql: string,
  plan: unknown,
): void {
  // fire-and-forget · 包一层 try 防同步构造抛 (如 getPlanStore() 在 redis backend 即 throw)。
  try {
    const summary = summarizePlan(plan);
    void getPlanStore()
      .writePlan({
        signature: computeSignature(sql),
        query_text_sha256: queryTextSha256(sql),
        plan_json: summary.plan_json,
        captured_at: Date.now(),
        source: 'on_demand',
        cost_total: summary.cost_total,
        has_seq_scan: summary.has_seq_scan,
        has_nested_loop_big: summary.has_nested_loop_big,
        projectId,
      })
      .catch((err) => {
        console.warn(
          '[explain-plans] on-demand plan-store write failed (non-blocking · T3 unaffected):',
          err,
        );
      });
  } catch (err) {
    console.warn(
      '[explain-plans] on-demand plan-store write skipped (non-blocking · T3 unaffected):',
      err,
    );
  }
}

/**
 * T3 explain wrapper: classifyOp(内层 sql) → gate analyze → 调上游 (注入的 runExplain) →
 * 按 depth 结构化返回 (shallow=signals 摘要 / full=raw plan)。
 *
 * feat-023/#1: 解析出 plan 后顺手 non-blocking 写 plan-store (on-demand collector)。
 */
export async function handleExplainPlans(
  args: ExplainPlansInput,
  runExplain: ExplainRunner,
): Promise<ExplainPlansResult> {
  const opClass = classifySql(args.sql);
  const requestedAnalyze = args.analyze ?? true; // 上游 explain_sql_statement analyze 默认 true
  const analyzed = gateAnalyze(opClass, requestedAnalyze);
  const depth: DepthLevel = isValidDepth(args.depth) ? args.depth : DEFAULT_DEPTH;

  const raw = await runExplain(analyzed);
  const text = raw.content[0]?.text ?? 'null';
  let plan: unknown;
  try {
    plan = JSON.parse(text);
  } catch {
    plan = text; // 解析失败 → 原文 (depth=full 透传 · shallow 下 parsePlanSignals 返回空 signals)
  }

  // feat-023/#1 on-demand collector: 顺手写 plan-store (non-blocking · 失败不影响 T3 返回)。
  writeOnDemandPlan(args.projectId, args.sql, plan);

  const base = {
    op_class: opClass,
    analyzed,
    downgraded: requestedAnalyze && !analyzed,
    annotation: explainAnnotationFor(opClass),
    depth,
  };

  if (depth === 'full') {
    return { ...base, plan };
  }
  // shallow (默认 · token 经济): 只回 signals 摘要 · 不回巨大 raw plan
  const { signals, total_cost } = parsePlanSignals(plan);
  return { ...base, signals, total_cost };
}
