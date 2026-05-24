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
 * 设计: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-019-L2-mcp-tool-t3-explain-plans.html (§3 §6)
 * 注: parsePlanSignals + progressive depth (signals 摘要 / token 经济) 是 feat-019/#2。
 */
import { classifySql, type OpClass } from '../../protection/destructive-detector';

export type ExplainPlansInput = {
  sql: string;
  projectId: string;
  branchId?: string;
  databaseName?: string;
  /** 请求是否 ANALYZE · op-class-gated: 非只读 (DML/DDL) sql 无视此值强制 false。 */
  analyze?: boolean;
};

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
  /** raw EXPLAIN JSON (depth=full 等价 · #2 加 shallow signals 摘要)。 */
  plan: unknown;
};

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
 * T3 explain wrapper: classifyOp(内层 sql) → gate analyze → 调上游 (注入的 runExplain) → 结构化返回。
 */
export async function handleExplainPlans(
  args: ExplainPlansInput,
  runExplain: ExplainRunner,
): Promise<ExplainPlansResult> {
  const opClass = classifySql(args.sql);
  const requestedAnalyze = args.analyze ?? true; // 上游 explain_sql_statement analyze 默认 true
  const analyzed = gateAnalyze(opClass, requestedAnalyze);

  const raw = await runExplain(analyzed);
  const text = raw.content[0]?.text ?? 'null';
  let plan: unknown;
  try {
    plan = JSON.parse(text);
  } catch {
    plan = text; // 解析失败 → 原文 (不阻断 · #2 加 signals/depth 摘要)
  }

  return {
    op_class: opClass,
    analyzed,
    downgraded: requestedAnalyze && !analyzed,
    annotation: explainAnnotationFor(opClass),
    plan,
  };
}
