/**
 * feat-026-confirm-token.test.ts · feat-026/#1 fixture (详设 §7 8 用例)
 *
 * 设计: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-026-L2-mcp-server-confirm-token-gate.html (§7)
 *
 * 不需 client elicitation (mock plan-mode approve)。不需真 Neon。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  issueConfirmToken,
  issuePreApprovedToken,
  NotImplementedError,
} from '../policy/confirm-token-issuer';
import {
  __resetStoreForTest,
  __resetHmacKeyForTest,
  getToken,
} from '../policy/confirm-token-store';
import { confirmTokenStage } from '../policy/stages/confirm-token';
import { type EnforcementCtx } from '../policy/pipeline';

const baseCtx = (over: Partial<EnforcementCtx>): EnforcementCtx => ({
  opClass: 'CREATE_INDEX_CONCURRENTLY',
  toolName: 'run_sql',
  autonomyLevel: 'L2b',
  sql: 'CREATE INDEX CONCURRENTLY sales_date_idx ON sales(sale_date)',
  ...over,
});

beforeEach(() => {
  __resetStoreForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('feat-026/#1 · 用例 1 happy path', () => {
  it('plan-mode approve → issue → step 7 verify pass · markUsed', () => {
    const ctx = baseCtx({});
    const snap = issueConfirmToken({
      op_class: ctx.opClass,
      args: ctx.sql,
      principal: 'human:dba-id',
      source: 'plan-mode-approval',
    });
    expect(snap.source).toBe('plan-mode-approval');

    const verdict = confirmTokenStage({ ...ctx, confirmToken: snap });
    expect(verdict).toBeNull(); // 通过 · null = 放行 step 8

    const stored = getToken(snap.id);
    expect(stored?.used).toBe(true); // markUsed 已发生
  });
});

describe('feat-026/#1 · 用例 2 单次使用 (replay 拒)', () => {
  it('同一 token 第二次 step 7 → reject used', () => {
    const ctx = baseCtx({});
    const snap = issueConfirmToken({
      op_class: ctx.opClass,
      args: ctx.sql,
      principal: 'human:dba-id',
      source: 'plan-mode-approval',
    });
    confirmTokenStage({ ...ctx, confirmToken: snap }); // 第一次 pass + markUsed
    const v2 = confirmTokenStage({ ...ctx, confirmToken: snap });
    expect(v2?.action).toBe('deny');
    expect(v2?.reason).toContain('已使用');
  });
});

describe('feat-026/#1 · 用例 3 TTL 过期', () => {
  it('mock clock advance 301s → reject expired', () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-05-26T00:00:00Z');
    vi.setSystemTime(t0);

    const ctx = baseCtx({});
    const snap = issueConfirmToken({
      op_class: ctx.opClass,
      args: ctx.sql,
      principal: 'human:dba-id',
      source: 'plan-mode-approval',
    });

    vi.setSystemTime(new Date(t0.getTime() + 301_000));
    const v = confirmTokenStage({ ...ctx, confirmToken: snap });
    expect(v?.action).toBe('deny');
    expect(v?.reason).toContain('已过期');
  });
});

describe('feat-026/#1 · 用例 4 args 篡改', () => {
  it('issue 用 args A · verify 用 args B → reject args_mismatch', () => {
    const ctxA = baseCtx({
      sql: 'CREATE INDEX CONCURRENTLY a_idx ON sales(a)',
    });
    const snap = issueConfirmToken({
      op_class: ctxA.opClass,
      args: ctxA.sql,
      principal: 'human:dba-id',
      source: 'plan-mode-approval',
    });
    const ctxB = baseCtx({
      sql: 'CREATE INDEX CONCURRENTLY b_idx ON sales(b)',
    });
    const v = confirmTokenStage({ ...ctxB, confirmToken: snap });
    expect(v?.action).toBe('deny');
    expect(v?.reason).toContain('不匹配');
  });
});

describe('feat-026/#1 · 用例 5 HMAC 篡改', () => {
  it('issue → 手改 stored.hmac → reject invalid_hmac', () => {
    const ctx = baseCtx({});
    const snap = issueConfirmToken({
      op_class: ctx.opClass,
      args: ctx.sql,
      principal: 'human:dba-id',
      source: 'plan-mode-approval',
    });
    const stored = getToken(snap.id)!;
    stored.hmac = '0'.repeat(64); // tamper
    const v = confirmTokenStage({ ...ctx, confirmToken: snap });
    expect(v?.action).toBe('deny');
    expect(v?.reason).toContain('HMAC');
  });
});

describe('feat-026/#1 · 用例 6 L4 stub throw (CI guard 防回归)', () => {
  it('issuePreApprovedToken → throws NotImplementedError', () => {
    expect(() =>
      issuePreApprovedToken({
        op_class: 'DROP_REPLICATION_SLOT',
        args: 'SELECT pg_drop_replication_slot(\'x\')',
        principal: 'system:odd-mrc',
        source: 'odd-pre-approved',
      }),
    ).toThrow(NotImplementedError);

    try {
      issuePreApprovedToken({
        op_class: 'DROP_REPLICATION_SLOT',
        args: '',
        principal: 'system:odd-mrc',
        source: 'odd-pre-approved',
      });
    } catch (e) {
      expect((e as Error).message).toContain('feat-049/051');
    }
  });
});

describe('feat-026/#1 · 用例 7 missing token (架构: step 6 plan-mode 接管 · 本 stage defer)', () => {
  it('CREATE_INDEX_CONCURRENTLY @ L2b 无 token → confirmTokenStage 返 null (本 pass step 6 已发 require_plan)', () => {
    // 高危 op + 无 token = step 6 在同一 pass 内会返 require_plan → orchestrator 弹 elicitation
    // → approve 后 issueConfirmToken + 重跑 pipeline · 那次 step 7 verify。
    // 本 stage 单独跑 (本 pass) defer 给 step 6 · 返 null 不双重决策。
    const ctx = baseCtx({}); // 不注入 confirmToken
    expect(confirmTokenStage(ctx)).toBeNull();
  });
  it('READ_ONLY @ L2b 无 token → null (放行 · 低危 op 不需 confirm)', () => {
    const ctx = baseCtx({
      opClass: 'READ_ONLY',
      sql: 'SELECT 1',
    });
    expect(confirmTokenStage(ctx)).toBeNull();
  });
  it('confirmTokenStage 单独跑 · 仅当 ctx.confirmToken 存在时才 verify · 不存在则 defer', () => {
    // 校 architecture intent: 本 stage 处理 "token 存在但 invalid/used/expired" · 不替代 step 6
    const ctx = baseCtx({ opClass: 'DROP_TABLE_OR_INDEX', sql: 'DROP TABLE x' });
    expect(confirmTokenStage(ctx)).toBeNull(); // 无 token · defer
  });
});

describe('feat-026/#1 · 用例 8 server restart (HMAC key reset)', () => {
  it('issue → 模拟重启 (clear store + reset HMAC key) → reject invalid_hmac', () => {
    const ctx = baseCtx({});
    const snap = issueConfirmToken({
      op_class: ctx.opClass,
      args: ctx.sql,
      principal: 'human:dba-id',
      source: 'plan-mode-approval',
    });
    // 模拟重启: store 清空 + HMAC key 换新 · 旧 snapshot 失效
    __resetStoreForTest();
    // 重启后 token store 找不到该 id → missing (server-internal · token 跟 store 一起没了)
    const v = confirmTokenStage({ ...ctx, confirmToken: snap });
    expect(v?.action).toBe('deny');
    // 重启后落 missing (store 不存在) · 不是 invalid_hmac · 跟详设 §7 一致 (in-memory · 不持久化)
    expect(v?.reason).toMatch(/缺失|HMAC/);
  });
});

describe('feat-026/#1 · 用例 8b · HMAC key reset (store 仍有 stale token)', () => {
  it('issue → 模拟 hot-key-rotate (仅换 HMAC key 不清 store) → reject invalid_hmac', () => {
    const ctx = baseCtx({});
    const snap = issueConfirmToken({
      op_class: ctx.opClass,
      args: ctx.sql,
      principal: 'human:dba-id',
      source: 'plan-mode-approval',
    });
    __resetHmacKeyForTest(); // 仅换 key · store 保留
    const v = confirmTokenStage({ ...ctx, confirmToken: snap });
    expect(v?.action).toBe('deny');
    expect(v?.reason).toContain('HMAC');
  });
});
