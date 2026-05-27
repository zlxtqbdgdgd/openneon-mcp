/**
 * query signature · feat-023/#1 (L2b)。
 *
 * 详设 §3.2 数据契约 + §11 OQ7: signature 算法跟 feat-019 T3 / feat-022 T7 统一 ——
 * `sha256(normalized_query)` 取前 16 hex。
 *
 * 现状对齐 (实施前 grep 结论 · 见 PR 说明): feat-019 T3 handler 本身**没有**沉淀 query signature
 * 实现 (handleExplainPlans 只解析 plan signals · 不算 query 维度的 signature) · feat-022 T7
 * query_signature 是入参 (由上游/调用方给)。因此**本子层是 signature 算法的首个落地点** ·
 * 统一在此定义 normalize + sha256(first 16 hex) · 后续 T3/T7 若要算 signature 复用本 helper
 * (single source · §11 OQ7 "不一致就 align")。
 *
 * normalize 规则 (day-one · 轻量 · 不依赖 AST · pg_stat_statements 已给 normalized query 时直接用):
 * - 折叠所有空白为单空格 + trim
 * - 大小写统一为小写 (SQL keyword / identifier 习惯)
 * - 去掉结尾分号
 * 注: pg_stat_statements 的 query 已 $1/$2 normalize (无字面量) · 直接喂本函数即可。
 * on-demand path (feat-019 T3 原始 SQL · 含字面量) 走同 normalize · day-one 不做字面量参数化
 * (字面量参数化是 feat-024 obfuscator 的职责 · plan signature 接受"含字面量时 signature 偏细")。
 */
import { createHash } from 'node:crypto';

/** 轻量 normalize (详见文件头)。 */
export function normalizeQuery(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;+\s*$/, '')
    .toLowerCase();
}

/** signature = sha256(normalize(sql)) 前 16 hex (§4 · 跟 T3/T7 统一)。 */
export function computeSignature(sql: string): string {
  return createHash('sha256')
    .update(normalizeQuery(sql))
    .digest('hex')
    .slice(0, 16);
}

/** query_text_sha256 = sha256(原文 SQL) 全长 hex · for T11 (feat-024) 联动区分 (§4)。 */
export function queryTextSha256(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}
