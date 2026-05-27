/**
 * rule-missing-index.ts · feat-022/#3 (L2b) · missing_index 规则 (§3.1)。
 *
 * T7 5 类中最复杂的一条: hypopg 虚拟索引 + EXPLAIN cost 比对 (改善 > cost_ratio 阈值即推荐) +
 * hypopg 不可用降级路径 (confidence=medium)。
 *
 * 路径 (§3.1):
 *   1. 调 feat-019 T3 explain_plans (注入式 ExplainProbe · depth=full) → plan tree
 *   2. plan walk 找 `Seq Scan on <table>` 且 Filter 含 WHERE col
 *   3. 查 pg_indexes 看 <table>.<col> 是否已索引 → 已索引则跳过 (0 推荐重复 · fixture 用例 3)
 *   4a. hypopg 可用 (ctx.hypopgAvailable · 启动期一次性 detect 的结果):
 *       - CREATE EXTENSION IF NOT EXISTS hypopg (idempotent)
 *       - SELECT hypopg_create_index('CREATE INDEX ON <table> (<col>)') 创虚拟索引 (session-local)
 *       - 重跑原 SQL EXPLAIN → 比 cost
 *       - SELECT hypopg_reset() 清虚拟索引
 *       - cost_ratio > 阈值 → confidence=high · evidence.hypopg_cost_ratio
 *   4b. hypopg 不可用: 仅推荐 confidence=medium (无 cost diff 证据 · §5 降级)
 *
 * #111 audit 结论 (2026-05-27 · neon dev cluster PG 17.5): hypopg **未安装** (11 个可用扩展无
 * hypopg · control file 缺失) → 实际跑这条规则走 4b 降级路径。故 hypopgAvailable 默认 false ·
 * 等 Neon marketplace 启用 hypopg 后自动走 4a (detection 在 detectHypopg 里 · handler 启动期调)。
 *
 * T3 调用失败 → 整条规则跳过 (其余 4 规则照常 · §5)。
 */
import type {
  ExplainProbeResult,
  Recommendation,
  RuleContext,
  RuleEvaluator,
  RuleSqlClient,
} from './types';

const RULE_VERSION = '1';

type PlanNode = Record<string, unknown>;

function extractRootPlan(plan: unknown): PlanNode | null {
  const first = Array.isArray(plan) && plan.length > 0 ? plan[0] : null;
  const root =
    first && typeof first === 'object' ? (first as PlanNode)['Plan'] : null;
  return root && typeof root === 'object' ? (root as PlanNode) : null;
}

/**
 * Filter 表达式取第一个看似列名的标识符 (启发式 · 跟 feat-019 explain-plans.ts 的
 * extractFilterColumn 同算法 · 保持一致 · §11 OQ2 需校准)。
 * 如 "(sale_date > '2020-01-01'::date)" → "sale_date"。
 */
export function extractFilterColumn(filter: string): string {
  const m = filter.match(/[a-zA-Z_][a-zA-Z0-9_]*/);
  return m ? m[0] : 'unknown';
}

export interface SeqScanFilterHit {
  table: string;
  filter_col: string;
  est_rows: number;
}

/**
 * plan walk: 找带 Filter 的 Seq Scan (table + filter col + 估算行数)。纯函数 (便于单测)。
 * 多个则按 est_rows 去重 by table.column · 取最大行数那个 (§11 OQ5 去重思路)。
 */
export function findSeqScanFilters(plan: unknown): SeqScanFilterHit[] {
  const root = extractRootPlan(plan);
  if (!root) return [];
  const byKey = new Map<string, SeqScanFilterHit>();

  const visit = (node: PlanNode): void => {
    const nodeType =
      typeof node['Node Type'] === 'string' ? node['Node Type'] : '';
    if (nodeType === 'Seq Scan') {
      const filter = node['Filter'];
      if (typeof filter === 'string' && filter.trim().length > 0) {
        const table = String(node['Relation Name'] ?? node['Alias'] ?? 'unknown');
        const filterCol = extractFilterColumn(filter);
        const estRows =
          typeof node['Plan Rows'] === 'number' ? node['Plan Rows'] : 0;
        const key = `${table}.${filterCol}`;
        const prev = byKey.get(key);
        if (!prev || estRows > prev.est_rows) {
          byKey.set(key, { table, filter_col: filterCol, est_rows: estRows });
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
  return [...byKey.values()];
}

/**
 * 检查 <table>.<col> 是否已被某个索引覆盖 (索引的首列即可 · §3.1 step 3 防重复推荐)。
 * 用 pg_index + pg_attribute 查首列名 (比正则扫 indexdef 文本更稳)。失败 → 保守当「未索引」
 * (宁可多推一条 medium · 不漏报)。
 */
async function columnAlreadyIndexed(
  sql: RuleSqlClient,
  table: string,
  col: string,
): Promise<boolean> {
  try {
    const rows = await sql.query(
      `
      SELECT 1
      FROM pg_index ix
      JOIN pg_class t  ON t.oid = ix.indrelid
      JOIN pg_attribute a
        ON a.attrelid = ix.indrelid
       AND a.attnum   = ix.indkey[0]      -- 索引首列
      WHERE t.relname = $1
        AND a.attname = $2
      LIMIT 1
      `,
      [table, col],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * 启动期 hypopg 可用性 detection (§3.1 · handler 启动期一次性 cache 结果 · 不在每条规则里重查)。
 * `SELECT extname FROM pg_extension WHERE extname='hypopg'` — 已 CREATE 的才算可用。失败/缺失 →
 * false (降级)。
 *
 * 注: #111 audit 表明 neon dev cluster 上 hypopg 连 available 都没有 (CREATE EXTENSION 会报
 * "extension hypopg is not available")。本函数只查 pg_extension (是否已装) · 若要更激进可先
 * 试 CREATE EXTENSION IF NOT EXISTS · 但那有副作用 · 故 detection 只做只读查询。
 */
export async function detectHypopg(sql: RuleSqlClient): Promise<boolean> {
  try {
    const rows = await sql.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'hypopg' LIMIT 1`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * hypopg cost 比对: 创虚拟索引 → 重跑 EXPLAIN → 比 cost → reset。返回 cost_ratio (before/after) ·
 * 失败返 null (调用方降级 medium)。严格 session-local · 末尾 reset 清虚拟索引 (不影响其他用户 ·
 * §6)。
 */
async function hypopgCostRatio(
  ctx: RuleContext,
  hit: SeqScanFilterHit,
  beforeCost: number,
): Promise<number | null> {
  try {
    await ctx.sql.query('CREATE EXTENSION IF NOT EXISTS hypopg');
    await ctx.sql.query(
      `SELECT hypopg_create_index($1)`,
      [`CREATE INDEX ON ${hit.table} (${hit.filter_col})`],
    );
    // 重跑原 query 的 EXPLAIN (虚拟索引现已对 planner 可见)。
    let afterCost = beforeCost;
    if (ctx.explain && ctx.querySignature) {
      const after: ExplainProbeResult = await ctx.explain({
        sql: '',
        querySignature: ctx.querySignature,
      });
      afterCost = after.total_cost;
    }
    if (afterCost > 0) {
      return Math.round((beforeCost / afterCost) * 10) / 10;
    }
    return null;
  } catch {
    return null;
  } finally {
    // 必清虚拟索引 (session-local · 防泄漏到后续 query)。失败不抛。
    try {
      await ctx.sql.query('SELECT hypopg_reset()');
    } catch {
      /* best-effort */
    }
  }
}

export const missingIndexRule: RuleEvaluator = {
  type: 'missing_index',
  envFlag: 'T7_MISSING_INDEX_ENABLED',

  async evaluate(ctx: RuleContext): Promise<Recommendation[]> {
    // 需要 T3 explain + 具体 query 才能拿 plan walk seq scan (§3.1 step 1)。缺则跳过 (§5)。
    if (!ctx.explain || !ctx.querySignature) return [];
    let res: ExplainProbeResult;
    try {
      res = await ctx.explain({ sql: '', querySignature: ctx.querySignature });
    } catch {
      // T3 调用失败 → 整条规则跳过 (其余规则照常 · §5)。
      return [];
    }

    const hits = findSeqScanFilters(res.plan);
    if (hits.length === 0) return [];

    const recs: Recommendation[] = [];
    for (const hit of hits) {
      // step 3: 已索引列跳过 (0 推荐重复 · fixture 用例 3)。
      if (await columnAlreadyIndexed(ctx.sql, hit.table, hit.filter_col)) {
        continue;
      }

      const evidence: Record<string, unknown> = {
        seq_scan_rows: hit.est_rows,
        filter_col: hit.filter_col,
      };
      let confidence: Recommendation['confidence'] = 'medium';
      let severity: Recommendation['severity'] = 'medium';

      // step 4a: hypopg 可用 → cost 比对 (§3.1)。
      if (ctx.hypopgAvailable) {
        const ratio = await hypopgCostRatio(ctx, hit, res.total_cost);
        if (ratio !== null) {
          evidence.hypopg_cost_ratio = ratio;
          if (ratio > ctx.thresholds.missing_index_cost_ratio) {
            confidence = 'high';
            severity = 'high';
          } else {
            // 有 cost 证据但改善不足阈值 → 仍报 medium (agent 自行判断)。
            confidence = 'medium';
          }
        }
        // ratio null (hypopg 路径运行失败) → 维持 medium 降级。
      }
      // step 5: hypopg 不可用 → confidence=medium · 无 cost diff (§5 降级 · fixture 用例 2)。

      recs.push({
        type: 'missing_index',
        severity,
        target: hit.table,
        evidence,
        suggested_action: `CREATE INDEX CONCURRENTLY ON ${hit.table} (${hit.filter_col});`,
        confidence,
        rule_version: RULE_VERSION,
      });
    }
    return recs;
  },
};
