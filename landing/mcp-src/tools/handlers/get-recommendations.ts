/**
 * get-recommendations.ts · feat-022 (L2b) · get_neondb_recommendations —— T7 handler。
 *
 * 详设: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-022-L2b-mcp-server-enrich-recommendation-rule-set.html (§3 调用链 + §4 + §6)
 *
 * 调用链 (§3): connection string → 建一个 SqlClient (5 规则 + 探针共用 · session-local hypopg
 * 虚拟索引必须同 session) → 启动期一次性 hypopg detect → 构造探针 (T3 explain / feat-016 baseline /
 * feat-064 history) → recommend() 并发跑 5 规则 + severity 排序 → feat-031 emitAuditEvent
 * (recommendation_classified) → 返结构化结果 (CSV 渲染在 tools.ts handler 包装层)。
 *
 * 探针注入: 规则层 (server-enrich/recommendation) 不碰 neonClient/connection · 全部经 RuleContext
 * 注入 (便于单测 · §7)。本 handler 是「composition root」: 把 mcp 资源接到纯逻辑层。
 */
import type { Api } from '@neondatabase/api-client';
import { startSpan } from '@sentry/node';
import { handleGetConnectionString } from './connection-string';
import { createSqlClient } from './sql-driver';
import { handleGetQueryStatement } from './query-statement';
import {
  handleExplainPlans,
  type ExplainRunner,
} from './explain-plans';
import { baseline } from '../../server-enrich/baseline/baseline';
import { getMetricHistory, isMetricHistoryError } from '../../server-enrich/metrics-history';
import { emitAuditEvent } from '../../observability/audit-emit';
import type { ToolHandlerExtraParams } from '../types';
import {
  recommend,
  resolveThresholds,
  detectHypopg,
  type Recommendation,
  type RecommendationType,
  type RuleContext,
  type BaselineProbe,
  type HistoryProbe,
  type ExplainProbe,
} from '../../server-enrich/recommendation';

const DEFAULT_DATABASE = 'neondb';

export type GetRecommendationsInput = {
  projectId: string;
  branchId?: string;
  databaseName?: string;
  computeId?: string;
  scope?: 'all' | 'recent_slow_queries' | 'all_indexes' | 'all_tables';
  /** 限定到单 query (missing_index / inefficient_join 用 · 是 pg_stat_statements queryid)。 */
  query_signature?: string;
  /** 默认全 5 类。 */
  recommendation_types?: RecommendationType[];
};

export type GetRecommendationsResult = {
  recommendations: Recommendation[];
  types_returned: RecommendationType[];
  hypopg_available: boolean;
  history_seam_available: boolean;
  duration_ms: number;
};

/**
 * 上游 explain_sql_statement 的注入式调用工厂 (analyze 已由 handleExplainPlans gate · 由 tools.ts
 * 包装层绑定 projectId/branchId/sql/neonClient)。这样 get-recommendations.ts 不 import tools.ts
 * (避免循环依赖 · 跟 get_neondb_explain_plans 同模式)。
 */
export type ExplainSqlRunnerFactory = (input: {
  sql: string;
  projectId: string;
  branchId?: string;
  databaseName?: string;
}) => ExplainRunner;

/** 默认 history window (feat-064 seam · coverage 不足时探针返 null → 规则降级)。 */
const DEFAULT_BASELINE_WINDOW = { last: '7d' } as const;
const DEFAULT_BASELINE_BUCKET = '5m';

/**
 * 构造 baseline 探针 (feat-016/017 · oversized_temp 用)。包 baseline() · 把三态结果映射成
 * 规则层要的 { median, upper, label } · status≠ok / 无 deviation → null (规则降级跳过)。
 */
function makeBaselineProbe(dimensions: Record<string, string>): BaselineProbe {
  return async ({ signal, currentValue }) => {
    try {
      const b = await baseline({
        signal,
        dimensions,
        window: DEFAULT_BASELINE_WINDOW,
        bucket: DEFAULT_BASELINE_BUCKET,
        current_value: currentValue,
      });
      if (b.status === 'ok' && b.band && b.deviation) {
        return {
          median: b.band.median,
          // BaselineBand 上界字段名是 `hi` (median + k·MAD)。
          upper: b.band.hi,
          label: b.deviation.label,
        };
      }
      return null;
    } catch {
      return null;
    }
  };
}

/**
 * 构造 history 探针 (feat-064 metrics-history seam · unused_index 30d / oversized_temp 1h)。
 * coverage 不足 / error → sufficient=false (规则按降级处理)。sustained 判定: 全部数据点都满足
 * 「非零 / 超阈值」—— 这里用简化判据: 有覆盖且无明显间隙即视为 sustained (day-one · 详细持续性
 * 判定 §11 留 calibration)。seam 整体不可用 (adapter 抛) → 返 null。
 */
function makeHistoryProbe(dimensions: Record<string, string>): HistoryProbe {
  return async ({ signal, window }) => {
    try {
      const res = await getMetricHistory({
        signal,
        dimensions,
        window: { last: window },
        bucket: window === '30d' ? '1d' : '5m',
      });
      if (isMetricHistoryError(res)) return null;
      // points: Array<[unix_ts, value | null]> · coverage: actual/expected_points (无 ratio 字段)。
      const points = res.points ?? [];
      const cov = res.coverage;
      const ratio =
        cov && cov.expected_points > 0
          ? cov.actual_points / cov.expected_points
          : 0;
      const sufficient = ratio >= 0.8;
      // sustained: 所有非空数据点都「满足条件」(value 持续 > 0)。day-one 简化判据 · §11 calibration。
      const nonNull = points.filter(([, v]) => v != null);
      const sustained =
        nonNull.length > 0 && nonNull.every(([, v]) => Number(v) > 0);
      return {
        sufficient,
        sustained,
        windowDays: window === '30d' ? 30 : undefined,
      };
    } catch {
      return null;
    }
  };
}

/**
 * 构造 explain 探针 (feat-019 T3 · missing_index / inefficient_join 用)。给 querySignature →
 * 先 T6 query-statement 解析出 SQL (full depth · 拿完整 SQL) → 调 T3 handleExplainPlans
 * (depth=full · 拿 raw plan 供 plan walk) → 返 { total_cost, plan }。任一步失败 → 抛
 * (规则层 catch 降级 · §5)。
 */
function makeExplainProbe(
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
  base: { projectId: string; branchId?: string; databaseName?: string; computeId?: string },
  explainSqlRunner: ExplainSqlRunnerFactory,
): ExplainProbe {
  return async ({ querySignature }) => {
    if (!querySignature) {
      throw new Error('explain probe requires querySignature');
    }
    // T6: query_signature → 完整 SQL 文本 (full depth · 不截断 · EXPLAIN 需完整语句)。
    const stmt = await handleGetQueryStatement(
      {
        query_signature: querySignature,
        projectId: base.projectId,
        branchId: base.branchId,
        databaseName: base.databaseName,
        computeId: base.computeId,
        depth: 'full',
      },
      neonClient,
      extra,
    );
    // T3: op-class-gated safe explain · depth=full → raw plan JSON (plan walk 用)。上游
    // explain_sql_statement 经注入 runner 调 (避免 import tools.ts · gate 仍在 handleExplainPlans)。
    const res = await handleExplainPlans(
      {
        sql: stmt.query,
        projectId: base.projectId,
        branchId: base.branchId,
        databaseName: base.databaseName,
        depth: 'full',
      },
      explainSqlRunner({
        sql: stmt.query,
        projectId: base.projectId,
        branchId: base.branchId,
        databaseName: base.databaseName,
      }),
    );
    // depth=full → res.plan 是 raw EXPLAIN JSON。total_cost 从根节点取 (full 下 parsePlanSignals
    // 不跑 · 自己抽)。
    const total_cost = extractTotalCost(res.plan);
    return { total_cost, plan: res.plan };
  };
}

/** 从 raw EXPLAIN JSON (`[{ "Plan": {...} }]`) 取根 total cost。 */
function extractTotalCost(plan: unknown): number {
  const first = Array.isArray(plan) && plan.length > 0 ? plan[0] : null;
  const root =
    first && typeof first === 'object'
      ? (first as Record<string, unknown>)['Plan']
      : null;
  const cost =
    root && typeof root === 'object'
      ? (root as Record<string, unknown>)['Total Cost']
      : undefined;
  return typeof cost === 'number' ? cost : 0;
}

/**
 * T7 主入口: 跑 5 规则 → 收集推荐 → emit audit。
 *
 * §5 延迟: p99 < 3000ms (5 规则并发 + hypopg cost 评估 + catalog 扫)。§5 降级: hypopg /
 * history / baseline / T3 任一不可用都不阻塞其余规则。
 */
export async function handleGetRecommendations(
  args: GetRecommendationsInput,
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
  explainSqlRunner: ExplainSqlRunnerFactory,
): Promise<GetRecommendationsResult> {
  return await startSpan(
    { name: 'get_neondb_recommendations' },
    async () => {
      const started = Date.now();
      const databaseName = args.databaseName ?? DEFAULT_DATABASE;
      const connectionString = await handleGetConnectionString(
        {
          projectId: args.projectId,
          branchId: args.branchId,
          computeId: args.computeId,
          databaseName,
        },
        neonClient,
        extra,
      );

      // 单 SqlClient 全程共用: hypopg 虚拟索引是 session-local · create/explain/reset 必须同 session。
      const sql = await createSqlClient(connectionString.uri);
      let hypopgAvailable = false;
      let result: GetRecommendationsResult;
      try {
        hypopgAvailable = await detectHypopg(sql);

        const dimensions: Record<string, string> = {
          project_id: args.projectId,
          database: databaseName,
        };

        const ctx: RuleContext = {
          projectId: args.projectId,
          querySignature: args.query_signature,
          sql,
          explain: makeExplainProbe(
            neonClient,
            extra,
            {
              projectId: args.projectId,
              branchId: args.branchId,
              databaseName,
              computeId: args.computeId,
            },
            explainSqlRunner,
          ),
          baseline: makeBaselineProbe(dimensions),
          history: makeHistoryProbe(dimensions),
          hypopgAvailable,
          thresholds: resolveThresholds(),
        };

        const { recommendations, types_returned } = await recommend({
          ctx,
          types: args.recommendation_types,
        });

        result = {
          recommendations,
          types_returned,
          hypopg_available: hypopgAvailable,
          // history seam 是否可用: day-one 不单独探活 · 由各规则探针 null 自适应。这里报告
          // 「配置上是否接入」(env DD seam) · best-effort 标识。
          history_seam_available: !!process.env.DD_API_KEY,
          duration_ms: Date.now() - started,
        };
      } finally {
        await sql.release();
      }

      // feat-031 audit: recommendation_classified (§4 audit event schema)。fire-and-forget ·
      // emit 失败不阻塞 (audit-emit 内部 fail-safe)。
      emitAuditEvent({
        event_type: 'recommendation_classified',
        outcome: 'allow',
        project_id: args.projectId,
        principal: extra.account?.id ? `account:${extra.account.id}` : undefined,
        extra: {
          'openneon.recommendation.count': result.recommendations.length,
          'openneon.recommendation.types_returned': JSON.stringify(
            result.types_returned,
          ),
          'openneon.recommendation.hypopg_available': result.hypopg_available,
          'openneon.recommendation.history_seam_available':
            result.history_seam_available,
          'openneon.recommendation.duration_ms': result.duration_ms,
        },
      });

      return result;
    },
  );
}
