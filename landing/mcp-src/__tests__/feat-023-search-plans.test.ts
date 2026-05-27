/**
 * feat-023-search-plans.test.ts · feat-023 §7 fixture (15 用例)。
 *
 * 覆盖: 5 filter (pattern / time_range / cost_min / has_seq_scan / signature_list) + AND 组合 +
 * limit cap + sort captured_at DESC + depth shallow/full + empty store + on-demand T3 写 integration +
 * background collector + TTL evict + audit emit。
 *
 * 用 MemoryPlanStore 直接灌 record · 不起真 PG / 不跑 EXPLAIN (background collector 用 mock SqlRunner)。
 * 铁律: 本仓不跑测试 —— 本文件是 fixture · 写出即可。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { MemoryPlanStore } from '../server-enrich/plan-store/memory-store';
import {
  _resetPlanStoreForTests,
  getPlanStore,
  type PlanRecord,
} from '../server-enrich/plan-store';
import { runCollectorOnce } from '../server-enrich/plan-store/background-collector';
import { handleSearchPlans } from '../tools/handlers/search-plans';
import * as auditEmit from '../observability/audit-emit';

const PROJECT = 'rapid-art-12345';

function rec(over: Partial<PlanRecord>): PlanRecord {
  return {
    signature: 'sig0000000000000',
    plan_json: { Plan: { 'Node Type': 'Index Scan', 'Total Cost': 100 } },
    captured_at: Date.now(),
    source: 'background',
    cost_total: 100,
    has_seq_scan: false,
    has_nested_loop_big: false,
    projectId: PROJECT,
    ...over,
  };
}

const seqScanPlan = {
  Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'sales', 'Total Cost': 15420, 'Plan Rows': 1_200_000 },
};

let store: MemoryPlanStore;

beforeEach(() => {
  store = new MemoryPlanStore(86_400_000, () => Date.now());
  _resetPlanStoreForTests(store);
});
afterEach(() => {
  _resetPlanStoreForTests(undefined);
  vi.restoreAllMocks();
});

describe('feat-023 · T10 search_plans', () => {
  it('用例1 · pattern filter "*Seq Scan*" · 5 records 中 3 含 seq scan → 3 hit', async () => {
    for (let i = 0; i < 3; i++)
      await store.writePlan(rec({ signature: `seq${i}`.padEnd(16, '0'), plan_json: seqScanPlan, has_seq_scan: true }));
    for (let i = 0; i < 2; i++)
      await store.writePlan(rec({ signature: `idx${i}`.padEnd(16, '0') }));
    const r = await handleSearchPlans({ projectId: PROJECT, pattern: '*Seq Scan*' });
    expect(r.hits).toBe(3);
  });

  it('用例2 · time_range last 24h · 10 records 中 5 captured > 24h ago → 5 hit', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) await store.writePlan(rec({ captured_at: now - 1000 }));
    for (let i = 0; i < 5; i++) await store.writePlan(rec({ captured_at: now - 25 * 3600_000 }));
    const r = await handleSearchPlans({ projectId: PROJECT, time_range: 'last 24h' });
    expect(r.hits).toBe(5);
  });

  it('用例3 · cost_min=10000 · 5 records 中 2 cost > 10000 → 2 hit', async () => {
    await store.writePlan(rec({ cost_total: 15420 }));
    await store.writePlan(rec({ cost_total: 20000 }));
    for (let i = 0; i < 3; i++) await store.writePlan(rec({ cost_total: 100 }));
    const r = await handleSearchPlans({ projectId: PROJECT, cost_min: 10000 });
    expect(r.hits).toBe(2);
  });

  it('用例4 · has_seq_scan=true · 5 records 中 3 true → 3 hit', async () => {
    for (let i = 0; i < 3; i++) await store.writePlan(rec({ has_seq_scan: true }));
    for (let i = 0; i < 2; i++) await store.writePlan(rec({ has_seq_scan: false }));
    const r = await handleSearchPlans({ projectId: PROJECT, has_seq_scan: true });
    expect(r.hits).toBe(3);
  });

  it('用例5 · signature_list=[A,B] · 10 records → 仅 A/B', async () => {
    await store.writePlan(rec({ signature: 'AAAAAAAAAAAAAAAA' }));
    await store.writePlan(rec({ signature: 'BBBBBBBBBBBBBBBB' }));
    for (let i = 0; i < 8; i++) await store.writePlan(rec({ signature: `oth${i}`.padEnd(16, '0') }));
    const r = await handleSearchPlans({
      projectId: PROJECT,
      signature_list: ['AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB'],
    });
    expect(r.hits).toBe(2);
    expect(r.rows.every((x) => ['AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB'].includes(x.signature))).toBe(true);
  });

  it('用例6 · AND 组合 pattern + cost_min + last 24h', async () => {
    const now = Date.now();
    await store.writePlan(rec({ plan_json: seqScanPlan, has_seq_scan: true, cost_total: 15420, captured_at: now - 1000 }));
    // seq scan 但 cost 低 → 被 cost_min 滤掉
    await store.writePlan(rec({ plan_json: seqScanPlan, has_seq_scan: true, cost_total: 100, captured_at: now - 1000 }));
    // seq scan 高 cost 但过期 → 被 time_range 滤掉
    await store.writePlan(rec({ plan_json: seqScanPlan, has_seq_scan: true, cost_total: 99999, captured_at: now - 25 * 3600_000 }));
    const r = await handleSearchPlans({
      projectId: PROJECT,
      pattern: '*Seq Scan*',
      cost_min: 10000,
      time_range: 'last 24h',
    });
    expect(r.hits).toBe(1);
  });

  it('用例7 · limit cap · 100 records limit=50 → 50 hit', async () => {
    for (let i = 0; i < 100; i++)
      await store.writePlan(rec({ signature: `s${i}`.padEnd(16, '0'), captured_at: Date.now() - i }));
    const r = await handleSearchPlans({ projectId: PROJECT, limit: 50 });
    expect(r.hits).toBe(50);
  });

  it('用例7b · limit 硬上限 200', async () => {
    for (let i = 0; i < 300; i++)
      await store.writePlan(rec({ signature: `s${i}`.padEnd(16, '0'), captured_at: Date.now() - i }));
    const r = await handleSearchPlans({ projectId: PROJECT, limit: 999 });
    expect(r.hits).toBe(200);
  });

  it('用例8 · sort by captured_at DESC · 最新在前', async () => {
    const now = Date.now();
    await store.writePlan(rec({ signature: 'old0000000000000', captured_at: now - 5000 }));
    await store.writePlan(rec({ signature: 'new0000000000000', captured_at: now - 100 }));
    const r = await handleSearchPlans({ projectId: PROJECT });
    expect(r.rows[0].signature).toBe('new0000000000000');
  });

  it('用例9 · depth shallow · CSV plan_summary 不含 full plan_json', async () => {
    await store.writePlan(rec({ plan_json: seqScanPlan, has_seq_scan: true, cost_total: 15420 }));
    const r = await handleSearchPlans({ projectId: PROJECT, depth: 'shallow' });
    expect(r.depth).toBe('shallow');
    expect(r.full).toBeUndefined();
    expect(r.rows[0].plan_summary).toContain('Seq Scan');
  });

  it('用例10 · depth full · progressive disclosure 拉 plan_json', async () => {
    await store.writePlan(rec({ plan_json: seqScanPlan, has_seq_scan: true }));
    const r = await handleSearchPlans({ projectId: PROJECT, depth: 'full' });
    expect(r.depth).toBe('full');
    expect(r.full).toBeDefined();
    expect(r.full?.[0].plan_json).toEqual(seqScanPlan);
  });

  it('用例11 · empty store → 0 hit', async () => {
    const r = await handleSearchPlans({ projectId: PROJECT });
    expect(r.hits).toBe(0);
    expect(r.rows).toHaveLength(0);
  });

  it('用例11b · multi-project 隔离 · 别的 project 不串', async () => {
    await store.writePlan(rec({ projectId: 'other-proj' }));
    const r = await handleSearchPlans({ projectId: PROJECT });
    expect(r.hits).toBe(0);
  });

  it('用例12 · feat-019 T3 on-demand 写 store integration', async () => {
    // 模拟 T3 handler 内 writeOnDemandPlan 的等价路径: 经 getPlanStore().writePlan source=on_demand。
    await getPlanStore().writePlan(rec({ source: 'on_demand', plan_json: seqScanPlan, has_seq_scan: true }));
    const r = await handleSearchPlans({ projectId: PROJECT });
    expect(r.hits).toBe(1);
    expect(r.rows[0].source).toBe('on_demand');
  });

  it('用例13 · background collector · mock pg_stat_statements 返 3 query → 3 records source=background', async () => {
    const runSql = vi.fn(async (sql: string) => {
      if (sql.includes('pg_extension')) return [{ ok: true }];
      if (sql.includes('pg_stat_statements'))
        return [
          { queryid: '1', query: 'SELECT * FROM a', total_exec_time: 9 },
          { queryid: '2', query: 'SELECT * FROM b', total_exec_time: 8 },
          { queryid: '3', query: 'SELECT * FROM c', total_exec_time: 7 },
        ];
      // EXPLAIN
      return [{ 'QUERY PLAN': JSON.stringify(seqScanPlan) }];
    });
    const written = await runCollectorOnce({ projectId: PROJECT, store, runSql, topN: 50, warn: () => {} });
    expect(written).toBe(3);
    const r = await handleSearchPlans({ projectId: PROJECT });
    expect(r.hits).toBe(3);
    expect(r.rows.every((x) => x.source === 'background')).toBe(true);
  });

  it('用例13b · pg_stat_statements 缺 → graceful skip (0 写 · 不抛)', async () => {
    const runSql = vi.fn(async (sql: string) => {
      if (sql.includes('pg_extension')) return [{ ok: false }];
      return [];
    });
    const written = await runCollectorOnce({ projectId: PROJECT, store, runSql, warn: () => {} });
    expect(written).toBe(0);
  });

  it('用例14 · TTL evict · 25h 前的 record · TTL=24h · evict 清掉', async () => {
    const ttlStore = new MemoryPlanStore(86_400_000, () => Date.now());
    await ttlStore.writePlan(rec({ captured_at: Date.now() - 25 * 3600_000 }));
    await ttlStore.writePlan(rec({ captured_at: Date.now() - 1000 }));
    const evicted = await ttlStore.evictExpired();
    expect(evicted).toBe(1);
    expect(ttlStore.size()).toBe(1);
  });

  it('用例15 · audit emit · T10 invoke → emitAuditEvent search_plans_invoked', async () => {
    const spy = vi.spyOn(auditEmit, 'emitAuditEvent').mockImplementation(() => {});
    await store.writePlan(rec({ plan_json: seqScanPlan, has_seq_scan: true }));
    await handleSearchPlans({ projectId: PROJECT, pattern: '*Seq Scan*' });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'search_plans_invoked',
        outcome: 'allow',
        project_id: PROJECT,
      }),
    );
    const call = spy.mock.calls[0][0];
    expect(call.extra).toMatchObject({ hits: 1, backend: 'memory' });
  });
});
