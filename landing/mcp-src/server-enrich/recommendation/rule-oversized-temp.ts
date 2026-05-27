/**
 * rule-oversized-temp.ts · feat-022 (L2b) · oversized_temp 规则 (§3.3)。
 *
 * pg_stat_database.temp_bytes + feat-016 baseline (median+MAD) 比: 当前 temp 速率超 baseline 3σ?
 * + feat-064 history 比: 1h 持续超 baseline (避免单点尖峰误报 · fixture 用例 9)。
 *   - baseline 不可用 (feat-016 disabled / 数据不足) → 0 rec (降级跳过 · fixture 用例 8 · §5)
 *   - baseline label=high 且 (history 不可用 或 1h sustained) → 1 rec
 *
 * 推荐扩 work_mem / 查无索引大 sort。evidence 含当前 work_mem (从 SHOW work_mem 读)。
 */
import type { Recommendation, RuleContext, RuleEvaluator } from './types';

const RULE_VERSION = '1';

const TEMP_BYTES_SQL = `
  SELECT datname, temp_bytes, temp_files
  FROM pg_stat_database
  WHERE datname = current_database()
`;

export const oversizedTempRule: RuleEvaluator = {
  type: 'oversized_temp',
  envFlag: 'T7_OVERSIZED_TEMP_ENABLED',

  async evaluate(ctx: RuleContext): Promise<Recommendation[]> {
    // baseline 是这条规则的硬前提 (无 baseline = 无「超不超」的判据 · 降级跳过)。
    if (!ctx.baseline) return [];
    try {
      const rows = await ctx.sql.query(TEMP_BYTES_SQL);
      const row = rows[0];
      if (!row) return [];
      const tempBytes = Number(row.temp_bytes ?? 0);
      if (!Number.isFinite(tempBytes) || tempBytes <= 0) return [];

      const b = await ctx.baseline({
        signal: 'pg_stat_database.temp_bytes',
        currentValue: tempBytes,
      });
      // baseline 不足/不可用 → 降级跳过 (§5 · fixture 用例 8)。
      if (!b) return [];
      // 未超 baseline → 0 rec。
      if (b.label !== 'high') return [];

      // 1h 持续判定 (避免单点尖峰 · fixture 用例 9): history 可用且未 sustained → 跳过。
      if (ctx.history) {
        try {
          const h = await ctx.history({
            signal: 'pg_stat_database.temp_bytes',
            window: '1h',
            // oversized_temp 要的是「持续超 baseline」· 'high' (默认 · #127 显式标注防回归)。
            sustainedMode: 'high',
          });
          if (h && h.sufficient && !h.sustained) {
            return [];
          }
        } catch {
          // history 失败 → 不阻塞 · 按 baseline label=high 出推荐。
        }
      }

      // 读当前 work_mem (best-effort · 读失败仅 evidence 缺该字段)。
      let workMem: string | undefined;
      try {
        const wm = await ctx.sql.query('SHOW work_mem');
        const v = wm[0]?.work_mem;
        if (v != null) workMem = String(v);
      } catch {
        workMem = undefined;
      }

      const evidence: Record<string, unknown> = {
        temp_bytes_5min: tempBytes,
        baseline_p95: b.upper,
        baseline_median: b.median,
      };
      if (workMem !== undefined) evidence.work_mem_current = workMem;

      return [
        {
          type: 'oversized_temp',
          severity: 'medium',
          target: String(row.datname ?? ctx.projectId),
          evidence,
          suggested_action: `考虑扩 work_mem (当前 ${workMem ?? '未知'}) · 或检查无索引大 sort/hash`,
          confidence: 'high',
          rule_version: RULE_VERSION,
        },
      ];
    } catch {
      return [];
    }
  },
};
