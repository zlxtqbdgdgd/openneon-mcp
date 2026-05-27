/**
 * rule-autovacuum-lag.ts · feat-022 (L2b) · autovacuum_lag 规则 (§3.4)。
 *
 * pg_stat_user_tables.last_autovacuum 早于 tunable threshold (default 24h · policy.yaml) 且
 * n_dead_tup > tunable threshold (default 10000) → 推荐手动 VACUUM 或调
 * autovacuum_vacuum_scale_factor。
 *
 * threshold 走 ctx.thresholds (policy.yaml.recommendation_thresholds · fixture 用例 12 tunable)。
 * dead_tup 低于阈值 → 0 rec (fixture 用例 11)。纯只读 catalog query。
 */
import type { Recommendation, RuleContext, RuleEvaluator } from './types';

const RULE_VERSION = '1';

/**
 * threshold (小时) 用 make_interval 注入 (避免字符串拼 SQL 注入 · 数值参数化)。
 * last_autovacuum IS NULL 也算 lag (从没 vacuum 过的活跃表更危险)。
 */
const AUTOVACUUM_LAG_SQL = `
  SELECT relname           AS table_name,
         last_autovacuum,
         n_dead_tup,
         n_live_tup,
         extract(epoch FROM (now() - last_autovacuum)) AS lag_seconds
  FROM pg_stat_user_tables
  WHERE (last_autovacuum IS NULL OR last_autovacuum < now() - make_interval(hours => $1::int))
    AND n_dead_tup > $2
  ORDER BY n_dead_tup DESC
`;

export const autovacuumLagRule: RuleEvaluator = {
  type: 'autovacuum_lag',
  envFlag: 'T7_AUTOVACUUM_LAG_ENABLED',

  async evaluate(ctx: RuleContext): Promise<Recommendation[]> {
    try {
      const rows = await ctx.sql.query(AUTOVACUUM_LAG_SQL, [
        ctx.thresholds.autovacuum_lag_hours,
        ctx.thresholds.autovacuum_dead_tuple_min,
      ]);
      const recs: Recommendation[] = [];
      for (const r of rows) {
        const tableName = String(r.table_name ?? '');
        const deadTup = Number(r.n_dead_tup ?? 0);
        const liveTup = Number(r.n_live_tup ?? 0);
        const denom = deadTup + liveTup;
        const deadRatio = denom > 0 ? Math.round((deadTup / denom) * 1000) / 1000 : 0;
        const lastAutovacuum =
          r.last_autovacuum == null ? null : String(r.last_autovacuum);

        recs.push({
          type: 'autovacuum_lag',
          // 高 dead ratio (膨胀严重) → high · 否则 medium。
          severity: deadRatio >= 0.2 ? 'high' : 'medium',
          target: tableName,
          evidence: {
            last_autovacuum: lastAutovacuum,
            dead_tuple_count: deadTup,
            dead_ratio: deadRatio,
            threshold_hours: ctx.thresholds.autovacuum_lag_hours,
          },
          suggested_action: `VACUUM ANALYZE ${tableName}; -- 或调 autovacuum_vacuum_scale_factor`,
          confidence: 'high',
          rule_version: RULE_VERSION,
        });
      }
      return recs;
    } catch {
      return [];
    }
  },
};
