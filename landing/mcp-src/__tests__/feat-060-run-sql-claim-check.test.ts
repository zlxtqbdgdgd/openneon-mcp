/**
 * feat-060-run-sql-claim-check.test.ts · feat-060/#3 (#131) · run_sql + libpg-query 集成 4 用例
 *
 * per [#131 issue acceptance criteria](https://github.com/zlxtqbdgdgd/openneon-mcp/issues/131):
 *
 *  1. WHERE user_id=42 + bound value=42 (post-claim-binding) → pass
 *  2. WHERE user_id=42 + bound value=42 (override 已经把 expected_user_filter.value 从 999 改成 42) → pass
 *  3. WHERE user_id=999 + bound value=42 (说明 SQL 跟 claim 不一致 · 比如 middleware 被绕过 or agent 写错) → deny_invalid
 *  4. SELECT 无 WHERE + 声明了 expected_user_filter → deny_invalid (谓词缺)
 *
 * 本 test 验 \`checkRunSqlClaim\` 函数 · 假定 bindClaims (#130) 已经把 expected_user_filter.value 覆盖好。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { checkRunSqlClaim } from '../auth/run-sql-claim-check';
import {
  ensurePgParserLoaded,
  __resetPgParserForTest,
} from '../auth/sql-where-filter-check';

const auditEvents: Array<Record<string, unknown>> = [];
vi.mock('../observability/audit-emit', () => ({
  emitAuditEvent: vi.fn((event: Record<string, unknown>) => {
    auditEvents.push(event);
  }),
  sha256Hex: (s: string) => `sha256:${s.slice(0, 8)}`,
}));

beforeAll(async () => {
  __resetPgParserForTest();
  await ensurePgParserLoaded();
});

beforeEach(() => {
  auditEvents.length = 0;
});

const ctx = { principal: 'agent:abcd', projectId: 'rapid-art-12345' };

describe('feat-060/#3 · checkRunSqlClaim · run_sql + libpg-query 集成 4 用例', () => {
  // ─────────────────── 用例 1 · WHERE 命中 ───────────────────
  it('用例 1 · pass: WHERE user_id=42 + bound value=42 → ok=true · 不发 audit', () => {
    const result = checkRunSqlClaim(
      {
        sql: 'SELECT * FROM orders WHERE user_id = 42',
        expected_user_filter: { column: 'user_id', value: 42 },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(auditEvents).toHaveLength(0);
  });

  // ─────────────────── 用例 2 · override 后命中 ───────────────────
  // post-bindClaims: agent 传 999 · server JWT.sub=42 强制 override expected_user_filter.value=42
  // agent 写 SQL 时已经按 JWT.sub 写 (e.g. agent 是按 user 自己的身份发的 query) → SQL 含 user_id=42
  it('用例 2 · pass: agent 传 expected_user_filter.value=999 被 #130 override 到 42 + SQL 含 user_id=42 → ok=true', () => {
    // post-bindClaims args (value 已被 override 到 42)
    const result = checkRunSqlClaim(
      {
        sql: 'SELECT * FROM orders WHERE user_id = 42',
        expected_user_filter: { column: 'user_id', value: 42 }, // already bound
      },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  // ─────────────────── 用例 3 · SQL 不一致 ───────────────────
  // 模拟 SQL 中 user_id=999 但 claim binding 已经强制 expected_user_filter.value=42 →
  // libpg-query 见 SQL 含 999 · 期待 42 · 不一致 · deny_invalid (审计 SQL_FILTER_MISMATCH)
  it('用例 3 · deny: SQL user_id=999 + bound value=42 → ok=false · SQL_FILTER_MISMATCH · audit high', () => {
    const result = checkRunSqlClaim(
      {
        sql: 'SELECT * FROM orders WHERE user_id = 999',
        expected_user_filter: { column: 'user_id', value: 42 },
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SQL_FILTER_MISMATCH');
    }
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].outcome).toBe('deny');
    expect(auditEvents[0].severity).toBe('high');
    expect((auditEvents[0].extra as Record<string, unknown>).reason).toBe(
      'SQL_FILTER_MISMATCH',
    );
  });

  // ─────────────────── 用例 4 · SELECT 无 WHERE ───────────────────
  it('用例 4 · deny: SELECT 无 WHERE + 期待 user_id=42 → SQL_FILTER_MISMATCH · audit high', () => {
    const result = checkRunSqlClaim(
      {
        sql: 'SELECT * FROM orders',
        expected_user_filter: { column: 'user_id', value: 42 },
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SQL_FILTER_MISMATCH');
    }
    expect(auditEvents).toHaveLength(1);
  });

  // ─────────────────── 边界 · 未声明 expected_user_filter ───────────────────
  it('边界 · 未声明 expected_user_filter → 完全旁路 · ok=true · 不发 audit · 维持 feat-029-only', () => {
    const result = checkRunSqlClaim(
      { sql: 'SELECT * FROM orders' }, // no expected_user_filter
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(auditEvents).toHaveLength(0);
  });

  // ─────────────────── 边界 · expected_user_filter 字段缺 ───────────────────
  it('边界 · expected_user_filter 缺 column → SQL_FILTER_MISSING · audit high · fail-closed', () => {
    const result = checkRunSqlClaim(
      {
        sql: 'SELECT * FROM orders WHERE user_id = 42',
        expected_user_filter: { value: 42 }, // column 缺
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SQL_FILTER_MISSING');
    }
  });

  // ─────────────────── 边界 · 多语句 ───────────────────
  it('边界 · 多语句任一 SQL 缺 filter → SQL_FILTER_MISMATCH', () => {
    const result = checkRunSqlClaim(
      {
        sql: 'SELECT * FROM orders WHERE user_id = 42; UPDATE orders SET status=\'x\'',
        expected_user_filter: { column: 'user_id', value: 42 },
      },
      ctx,
    );
    expect(result.ok).toBe(false);
  });
});
