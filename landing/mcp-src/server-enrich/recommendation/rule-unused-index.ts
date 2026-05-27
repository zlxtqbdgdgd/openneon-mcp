/**
 * rule-unused-index.ts · feat-022 (L2b) · unused_index 规则 (§3.2)。
 *
 * pg_stat_user_indexes idx_scan=0 且 size > 阈值 → 推荐 DROP。排除 PK/UNIQUE/被 FK 引用的索引
 * (查 pg_constraint · 这类删不掉/删了破约束)。feat-064 30d history 判 idx_scan 是否持续为 0:
 *   - 30d 持续 0 → confidence=high
 *   - history seam 不可用 → 仅快照 + confidence=medium (§5 降级)
 *
 * 纯只读 catalog query · 不调 LLM (§3.3.0)。
 */
import type { Recommendation, RuleContext, RuleEvaluator } from './types';

const RULE_VERSION = '1';

/**
 * 找 idx_scan=0 且足够大的索引 · 排除约束依赖 (PK/UNIQUE/FK target)。
 *
 * - pg_stat_user_indexes: idx_scan / indexrelid。
 * - pg_index.indisunique / indisprimary: 排除 UNIQUE / PRIMARY KEY。
 * - pg_constraint conindid: 排除作为约束 (含 FK 引用 unique 索引) 的索引。
 */
const UNUSED_INDEX_SQL = `
  SELECT s.schemaname,
         s.relname        AS table_name,
         s.indexrelname   AS index_name,
         s.idx_scan,
         pg_relation_size(s.indexrelid) AS size_bytes
  FROM pg_stat_user_indexes s
  JOIN pg_index i ON i.indexrelid = s.indexrelid
  WHERE s.idx_scan = 0
    AND i.indisprimary = false
    AND i.indisunique  = false
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint c WHERE c.conindid = s.indexrelid
    )
    AND pg_relation_size(s.indexrelid) > $1
  ORDER BY size_bytes DESC
`;

export const unusedIndexRule: RuleEvaluator = {
  type: 'unused_index',
  envFlag: 'T7_UNUSED_INDEX_ENABLED',

  async evaluate(ctx: RuleContext): Promise<Recommendation[]> {
    try {
      const rows = await ctx.sql.query(UNUSED_INDEX_SQL, [
        ctx.thresholds.unused_index_min_bytes,
      ]);
      const recs: Recommendation[] = [];
      for (const r of rows) {
        const indexName = String(r.index_name ?? '');
        const tableName = String(r.table_name ?? '');
        const sizeBytes = Number(r.size_bytes ?? 0);
        const sizeMb = Math.round((sizeBytes / (1024 * 1024)) * 10) / 10;

        // feat-064 30d history: idx_scan 是否持续为 0 (sustained) → confidence=high · 否则
        // 降级 snapshot only confidence=medium (§5)。history 不可用 (probe 返 null) 同样 medium。
        let confidence: Recommendation['confidence'] = 'medium';
        let historyWindowDays: number | undefined;
        if (ctx.history) {
          try {
            const h = await ctx.history({
              signal: `index.idx_scan.${tableName}.${indexName}`,
              window: '30d',
            });
            if (h && h.sufficient && h.sustained) {
              confidence = 'high';
              historyWindowDays = h.windowDays ?? 30;
            }
          } catch {
            // history 失败 → 维持 snapshot-only medium · 不抛。
          }
        }

        const evidence: Record<string, unknown> = {
          size_mb: sizeMb,
          idx_scan: Number(r.idx_scan ?? 0),
        };
        if (historyWindowDays !== undefined) {
          evidence.history_window_days = historyWindowDays;
        }

        recs.push({
          type: 'unused_index',
          // 大索引常驻浪费空间 → high · 较小的 medium。
          severity: sizeMb >= 128 ? 'high' : 'medium',
          target: indexName,
          evidence,
          suggested_action: `DROP INDEX CONCURRENTLY ${indexName}; -- 确认非约束依赖`,
          confidence,
          rule_version: RULE_VERSION,
        });
      }
      return recs;
    } catch {
      // catalog query 失败 → 该规则跳过 · 不拖垮其余 (§5)。
      return [];
    }
  },
};
