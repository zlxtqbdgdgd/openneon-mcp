/**
 * feat-060-sql-where-filter.test.ts · feat-060/#3 (#131) · libpg-query 验 WHERE 谓词 4 用例
 *
 * per [#131 issue acceptance criteria](https://github.com/zlxtqbdgdgd/openneon-mcp/issues/131):
 *
 *  1. WHERE user_id=42 + 期待 42 → pass (谓词命中)
 *  2. WHERE user_id=999 + 期待 42 → deny_invalid (SQL/claim 不一致)
 *  3. SELECT 无 WHERE + 期待 42 → deny_invalid (谓词缺)
 *  4. 多语句 (SELECT WHERE 42; UPDATE WHERE 999) + 期待 42 → deny_invalid (UPDATE 缺一致 filter)
 *
 * 用真 libpg-query (跟 feat-028 同源 init) · 验 AST schema 假设正确 · 不 mock。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  hasUserFilterPredicate,
  ensurePgParserLoaded,
  __resetPgParserForTest,
} from '../auth/sql-where-filter-check';

beforeAll(async () => {
  __resetPgParserForTest();
  await ensurePgParserLoaded();
});

describe('feat-060/#3 · hasUserFilterPredicate · libpg-query WHERE 谓词验证', () => {
  // ─────────────────── 1. pass · WHERE 命中 ───────────────────
  it('用例 1 · pass: SELECT WHERE user_id=42 + 期待 42 → true', () => {
    const sql = 'SELECT * FROM orders WHERE user_id = 42';
    expect(hasUserFilterPredicate(sql, 'user_id', 42)).toBe(true);
  });

  it('用例 1a · pass: UPDATE WHERE user_id=42 → true', () => {
    const sql = "UPDATE orders SET status='shipped' WHERE user_id = 42";
    expect(hasUserFilterPredicate(sql, 'user_id', 42)).toBe(true);
  });

  it('用例 1b · pass: DELETE WHERE user_id=42 → true', () => {
    const sql = 'DELETE FROM orders WHERE user_id = 42';
    expect(hasUserFilterPredicate(sql, 'user_id', 42)).toBe(true);
  });

  // ─────────────────── 2. deny · WHERE 值不符 ───────────────────
  it('用例 2 · deny: SELECT WHERE user_id=999 + 期待 42 → false', () => {
    const sql = 'SELECT * FROM orders WHERE user_id = 999';
    expect(hasUserFilterPredicate(sql, 'user_id', 42)).toBe(false);
  });

  // ─────────────────── 3. deny · 无 WHERE ───────────────────
  it('用例 3 · deny: SELECT 无 WHERE + 期待 42 → false', () => {
    const sql = 'SELECT * FROM orders';
    expect(hasUserFilterPredicate(sql, 'user_id', 42)).toBe(false);
  });

  // ─────────────────── 4. deny · 多语句任一缺 ───────────────────
  it('用例 4 · deny: 多语句 SELECT WHERE 42; UPDATE WHERE 999 + 期待 42 → false (UPDATE 不符)', () => {
    const sql =
      "SELECT * FROM orders WHERE user_id = 42; UPDATE orders SET status='x' WHERE user_id = 999";
    expect(hasUserFilterPredicate(sql, 'user_id', 42)).toBe(false);
  });

  it('用例 4a · pass: 多语句都含 user_id=42 → true', () => {
    const sql =
      "SELECT * FROM orders WHERE user_id = 42; UPDATE orders SET status='x' WHERE user_id = 42";
    expect(hasUserFilterPredicate(sql, 'user_id', 42)).toBe(true);
  });

  // ─────────────────── 边界 ───────────────────
  it('边界 · qualified column name (table.user_id=42) → true (取最后段)', () => {
    const sql = 'SELECT * FROM orders o WHERE o.user_id = 42';
    expect(hasUserFilterPredicate(sql, 'user_id', 42)).toBe(true);
  });

  it('边界 · AND 复合 WHERE 含期待 filter → true', () => {
    const sql =
      "SELECT * FROM orders WHERE status = 'pending' AND user_id = 42";
    expect(hasUserFilterPredicate(sql, 'user_id', 42)).toBe(true);
  });

  it('边界 · 反向写 (42 = user_id) → true (两侧不区分)', () => {
    const sql = 'SELECT * FROM orders WHERE 42 = user_id';
    expect(hasUserFilterPredicate(sql, 'user_id', 42)).toBe(true);
  });

  it('边界 · 空 SQL → false (fail-closed)', () => {
    expect(hasUserFilterPredicate('', 'user_id', 42)).toBe(false);
  });

  it('边界 · parse 失败的 SQL (typo) → false (fail-closed)', () => {
    expect(hasUserFilterPredicate('SLECT * FORM x', 'user_id', 42)).toBe(false);
  });

  it('边界 · string value 类型 (user_id="alice") → true if 字符串相等', () => {
    const sql = "SELECT * FROM orders WHERE user_id = 'alice'";
    expect(hasUserFilterPredicate(sql, 'user_id', 'alice')).toBe(true);
  });

  it('边界 · DDL (CREATE TABLE) → false (不接 fromClaim)', () => {
    const sql = 'CREATE TABLE x (id integer)';
    expect(hasUserFilterPredicate(sql, 'user_id', 42)).toBe(false);
  });
});
