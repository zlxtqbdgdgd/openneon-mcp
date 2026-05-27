/**
 * sql-ident.ts · feat-022 (L2b) · #127 fix · SQL 标识符安全工具。
 *
 * 推荐规则的 suggested_action 把表名/索引名/列名拼进可执行 SQL 模板 (CREATE INDEX / DROP INDEX /
 * VACUUM ...) · 这些对象名来自 pg catalog / EXPLAIN 解析 · 可能含逗号/引号/空格/混合大小写。若裸拼:
 *   1. 产出的 SQL 非法或语义错 (如 `DROP INDEX foo,bar` 被当多对象);
 *   2. 含逗号/引号/换行的对象名写进 CSV 列时破坏 CSV 结构 (CSV 注入)。
 *
 * 统一走 quoteIdent: 等价 Postgres `quote_ident` · 双引号包裹 + 内部 `"` → `""`。产出永远是单个
 * 合法标识符 token · 既保证 SQL 正确 · 也保证整段 suggested_action 在 CSV 序列化层 (csv-stringify ·
 * RFC4180 自动给含逗号/引号/换行的字段加引号转义) 之上不会被对象名结构破坏。
 */

/** Postgres quote_ident 等价: 双引号包裹标识符 · 内部双引号转义成两个。 */
export function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}
