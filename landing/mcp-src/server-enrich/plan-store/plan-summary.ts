/**
 * plan 摘要化 + plan walk 信号 · feat-023/#1 (L2b)。
 *
 * 详设 §11 OQ6: 复杂 plan 可达 100KB · 50000 records × 100KB = 5GB 超内存 ——
 * **写入时摘要化**: 只保留 root + Seq Scan / Index Scan / Nested Loop 关键 node ·
 * 不保 buffer / cache hit / 估算细节。depth=full 需要时再原始 EXPLAIN 拉一次。
 * 目标: 单 record 平均 < 5KB (§非功能要求 + acceptance)。
 *
 * 同时算 PlanRecord 派生字段: cost_total / has_seq_scan / has_nested_loop_big (§4)。
 */

type PlanNode = Record<string, unknown>;

/** nested loop 的 outer rows 超过它即算"大 nested loop" (§4 has_nested_loop_big)。 */
const NESTED_LOOP_BIG_ROWS = 10000;

/** EXPLAIN (FORMAT JSON) 输出 = `[{ "Plan": {...} }]` → 取根 Plan 节点。 */
function extractRootPlan(plan: unknown): PlanNode | null {
  const first = Array.isArray(plan) && plan.length > 0 ? plan[0] : null;
  const root =
    first && typeof first === 'object' ? (first as PlanNode)['Plan'] : null;
  return root && typeof root === 'object' ? (root as PlanNode) : null;
}

/** 摘要化保留的 node 字段白名单 (不含 buffer/cache 细节)。 */
const KEEP_KEYS: readonly string[] = [
  'Node Type',
  'Relation Name',
  'Alias',
  'Index Name',
  'Total Cost',
  'Plan Rows',
  'Filter',
  'Index Cond',
  'Join Type',
  'Hash Cond',
];

/** 关键 node 类型 (其余 node 折叠 · 仅在 children 链路上保留以反映结构)。 */
const KEY_NODE_TYPES: ReadonlySet<string> = new Set([
  'Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Nested Loop',
  'Hash Join',
  'Merge Join',
]);

function summarizeNode(node: PlanNode): PlanNode {
  const out: PlanNode = {};
  for (const k of KEEP_KEYS) {
    if (node[k] !== undefined) out[k] = node[k];
  }
  const children = node['Plans'];
  if (Array.isArray(children)) {
    const kids = children
      .filter((c): c is PlanNode => !!c && typeof c === 'object')
      .map((c) => summarizeNode(c));
    if (kids.length > 0) out['Plans'] = kids;
  }
  return out;
}

/**
 * plan tree → 摘要化 plan_json (object · 写 store) + 派生字段。
 * 非法 / 非 EXPLAIN JSON → 空 plan + 全 false (不抛 · 调用方降级)。
 */
export function summarizePlan(plan: unknown): {
  plan_json: object;
  cost_total: number;
  has_seq_scan: boolean;
  has_nested_loop_big: boolean;
} {
  const root = extractRootPlan(plan);
  if (!root) {
    return {
      plan_json: {},
      cost_total: 0,
      has_seq_scan: false,
      has_nested_loop_big: false,
    };
  }

  let hasSeqScan = false;
  let hasNestedLoopBig = false;

  const visit = (node: PlanNode): void => {
    const nodeType =
      typeof node['Node Type'] === 'string' ? (node['Node Type'] as string) : '';
    if (nodeType === 'Seq Scan') hasSeqScan = true;
    if (nodeType === 'Nested Loop') {
      const planRows =
        typeof node['Plan Rows'] === 'number' ? (node['Plan Rows'] as number) : 0;
      if (planRows > NESTED_LOOP_BIG_ROWS) hasNestedLoopBig = true;
    }
    void KEY_NODE_TYPES; // 关键 node 集合保留以便后续扩展过滤策略
    const children = node['Plans'];
    if (Array.isArray(children)) {
      for (const c of children) {
        if (c && typeof c === 'object') visit(c as PlanNode);
      }
    }
  };
  visit(root);

  const cost_total =
    typeof root['Total Cost'] === 'number' ? (root['Total Cost'] as number) : 0;

  return {
    plan_json: { Plan: summarizeNode(root) },
    cost_total,
    has_seq_scan: hasSeqScan,
    has_nested_loop_big: hasNestedLoopBig,
  };
}

/**
 * 一行 plan_summary 文本 (CSV plan_summary 列 · §4 / §11 OQ9):
 * "Seq Scan on sales · cost 15420 · est_rows 1.2M" 这类。
 */
export function planSummaryLine(record: {
  plan_json: object;
  cost_total: number;
  has_seq_scan: boolean;
}): string {
  const root = (record.plan_json as { Plan?: PlanNode }).Plan;
  if (!root) return `cost ${record.cost_total}`;
  const nodeType =
    typeof root['Node Type'] === 'string' ? (root['Node Type'] as string) : 'Plan';
  const rel =
    (typeof root['Relation Name'] === 'string' && root['Relation Name']) ||
    (typeof root['Alias'] === 'string' && root['Alias']) ||
    '';
  const rows =
    typeof root['Plan Rows'] === 'number' ? (root['Plan Rows'] as number) : null;
  const parts = [rel ? `${nodeType} on ${rel}` : nodeType];
  parts.push(`cost ${record.cost_total}`);
  if (rows !== null) parts.push(`est_rows ${rows}`);
  if (record.has_seq_scan && nodeType !== 'Seq Scan') parts.push('has seq scan');
  return parts.join(' · ');
}
