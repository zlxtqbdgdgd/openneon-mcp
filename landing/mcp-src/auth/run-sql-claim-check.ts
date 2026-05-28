/**
 * run-sql-claim-check.ts · feat-060/#3 (#131) · run_sql 专用 · 把 fromClaim binding 跟 libpg-query 接起来
 *
 * 调用顺序 (在 route.ts tool dispatch 串):
 *   1. bindClaims (auth/claim-binding.ts) - 通用 fromClaim 4-outcome · expected_user_filter.value 被 JWT.sub 覆盖
 *   2. **本 module** - 仅 tool=run_sql 时调 · 检查 args.sql 中含 \`WHERE <column> = <value>\` 谓词
 *      不匹配 → 抛 outcome=deny_invalid (audit high) · 阻 dispatch
 *   3. feat-056 pipeline - 政策矩阵 / hard-deny / rate / plan mode
 *   4. tool handler - handleRunSql
 *
 * 为啥不直接进 bindClaims?
 *   - bindClaims 是 schema scanner · 不解析 SQL · 不应纠缠 SQL 语义 (单一职责)
 *   - 本 module 只跑 1 tool (run_sql) · 不污染通用路径
 *
 * 检查的具体语义 (per [#131 acceptance criteria](https://github.com/zlxtqbdgdgd/openneon-mcp/issues/131)):
 *   args.expected_user_filter = { column: 'user_id', value: <bound-from-JWT.sub> }
 *   args.sql = "SELECT ... WHERE user_id = X..."
 *   X === bound value → pass
 *   X !== bound value → deny_invalid (audit high · 'SQL_FILTER_MISMATCH')
 *   缺 WHERE 谓词 → deny_invalid (audit high · 'SQL_FILTER_MISSING')
 */
import { hasUserFilterPredicate } from './sql-where-filter-check';
import { emitAuditEvent } from '../observability/audit-emit';

export type RunSqlClaimCheckResult =
  | { ok: true }
  | { ok: false; code: 'SQL_FILTER_MISMATCH' | 'SQL_FILTER_MISSING'; message: string };

/**
 * args 中的 expected_user_filter 已经经过 bindClaims override · value 是 JWT.sub。
 * 本函数验 sql 的 WHERE 谓词跟 expected_user_filter 一致。
 *
 * args.expected_user_filter 未声明 → 完全旁路 · 维持 feat-029-only 行为 (返 ok=true)。
 * column / value 缺 → fail-closed 返 SQL_FILTER_MISSING。
 * SQL 谓词不匹配 → 返 SQL_FILTER_MISMATCH。
 *
 * @param args run_sql 的 args (post-bindClaims) · 含 sql + 可选 expected_user_filter
 * @param principal audit 用 (e.g. agent:<key-last-4>)
 * @param projectId audit USR · feat-008-011 跨组件追溯锚点
 */
export function checkRunSqlClaim(args: {
  sql?: string;
  expected_user_filter?: {
    column?: string;
    value?: string | number;
  };
}, ctx: {
  principal: string;
  projectId: string | undefined;
}): RunSqlClaimCheckResult {
  const filter = args.expected_user_filter;
  if (!filter) {
    // 未声明 · 完全旁路 (向后兼容 · feat-029-only 路径)
    return { ok: true };
  }
  const sql = args.sql;
  const column = filter.column;
  const value = filter.value;
  if (
    typeof column !== 'string' ||
    column.length === 0 ||
    (typeof value !== 'string' && typeof value !== 'number') ||
    typeof sql !== 'string' ||
    sql.length === 0
  ) {
    const msg = `expected_user_filter / sql 不完整 · column=${String(column)} value=${String(value)} sql 长度=${sql?.length ?? 0}`;
    emitRunSqlClaimAudit({
      ...ctx,
      code: 'SQL_FILTER_MISSING',
      column: column ?? '(missing)',
      expectedValue: value ?? '(missing)',
      message: msg,
    });
    return { ok: false, code: 'SQL_FILTER_MISSING', message: msg };
  }

  if (!hasUserFilterPredicate(sql, column, value)) {
    const msg = `run_sql 缺 WHERE ${column} = ${value} 谓词 (或所有语句不一致 · 或 parse 失败)`;
    emitRunSqlClaimAudit({
      ...ctx,
      code: 'SQL_FILTER_MISMATCH',
      column,
      expectedValue: value,
      message: msg,
    });
    return { ok: false, code: 'SQL_FILTER_MISMATCH', message: msg };
  }

  return { ok: true };
}

/**
 * audit event · 走 feat-031 emitAuditEvent · event_type=\`claim_override\` · outcome=\`deny\` · severity=\`high\`。
 *
 * 跟 bindClaims 的 deny 走同一 event_type (claim_override) · 便于 collector 统一聚合 SQL/claim 不一致事件 ·
 * 用 extra.reason 区分子类 (SQL_FILTER_MISMATCH vs JWT_EXPIRED 等)。
 */
function emitRunSqlClaimAudit(ev: {
  principal: string;
  projectId: string | undefined;
  code: string;
  column: string;
  expectedValue: string | number;
  message: string;
}): void {
  emitAuditEvent({
    event_type: 'claim_override',
    outcome: 'deny',
    severity: 'high',
    principal: ev.principal,
    project_id: ev.projectId,
    extra: {
      tool: 'run_sql',
      reason: ev.code,
      column: ev.column,
      expected_value: String(ev.expectedValue),
      message: ev.message,
    },
  });
}
