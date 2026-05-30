import { describe, it, expect } from 'vitest';
import {
  gateAnalyze,
  explainAnnotationFor,
  handleExplainPlans,
  parsePlanSignals,
  type ExplainRunner,
  type RawExplainResult,
} from '../tools/handlers/explain-plans';

// mock runner: 记录被传入的 analyze · 回一个最小 EXPLAIN JSON
function makeRunner(
  planObj: unknown = [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Seq Scan' } }] }],
): { runner: ExplainRunner; calls: boolean[] } {
  const calls: boolean[] = [];
  const runner: ExplainRunner = async (analyze) => {
    calls.push(analyze);
    return {
      content: [{ type: 'text', text: JSON.stringify(planObj) }],
    } satisfies RawExplainResult;
  };
  return { runner, calls };
}

describe('gateAnalyze (feat-019/#1 · 硬安全 · DML/DDL 强制 analyze=false)', () => {
  it('READ_ONLY → 沿用请求值', () => {
    expect(gateAnalyze('READ_ONLY', true)).toBe(true);
    expect(gateAnalyze('READ_ONLY', false)).toBe(false);
  });

  it('写 op (DML/DDL) → 无视请求强制 false', () => {
    expect(gateAnalyze('DELETE_UPDATE_BULK', true)).toBe(false);
    expect(gateAnalyze('ALTER_TABLE_BIG_LOCK', true)).toBe(false);
    expect(gateAnalyze('DDL_ADD_COLUMN', true)).toBe(false);
    expect(gateAnalyze('DROP_TABLE_OR_INDEX', true)).toBe(false);
    expect(gateAnalyze('CREATE_INDEX_CONCURRENTLY', true)).toBe(false);
  });
});

describe('explainAnnotationFor (feat-019/#1 · 动态 annotation · 诚实 destructive)', () => {
  it('READ_ONLY → readOnlyHint:true', () => {
    expect(explainAnnotationFor('READ_ONLY')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  it('写 op → destructiveHint:true (非上游误导的 readOnly:true)', () => {
    expect(explainAnnotationFor('DELETE_UPDATE_BULK')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(explainAnnotationFor('ALTER_TABLE_BIG_LOCK').destructiveHint).toBe(
      true,
    );
  });
});

describe('handleExplainPlans (feat-019/#1 · wrapper + gate)', () => {
  it('SELECT + analyze=true → 真 ANALYZE (analyzed=true · 未降级 · annotation readOnly)', async () => {
    const { runner, calls } = makeRunner();
    const r = await handleExplainPlans(
      { sql: 'SELECT count(*) FROM sales', projectId: 'p1', analyze: true },
      runner,
    );
    expect(calls).toEqual([true]); // runner 收到 analyze=true
    expect(r.op_class).toBe('READ_ONLY');
    expect(r.analyzed).toBe(true);
    expect(r.downgraded).toBe(false);
    expect(r.annotation).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it('DELETE + analyze=true → 强制 analyze=false (analyzed=false · downgraded · annotation destructive)', async () => {
    const { runner, calls } = makeRunner();
    const r = await handleExplainPlans(
      {
        sql: 'DELETE FROM sales WHERE id < 100',
        projectId: 'p1',
        analyze: true,
      },
      runner,
    );
    expect(calls).toEqual([false]); // runner 收到 gate 后的 analyze=false → 纯 EXPLAIN 不执行
    expect(r.op_class).toBe('DELETE_UPDATE_BULK');
    expect(r.analyzed).toBe(false);
    expect(r.downgraded).toBe(true);
    expect(r.annotation.destructiveHint).toBe(true);
  });

  it('ALTER (DDL) + analyze=true → 强制 false', async () => {
    const { runner, calls } = makeRunner();
    const r = await handleExplainPlans(
      { sql: 'ALTER TABLE sales ADD COLUMN region text', projectId: 'p1' },
      runner,
    );
    expect(calls).toEqual([false]);
    expect(r.analyzed).toBe(false);
    expect(r.downgraded).toBe(true);
  });

  it('analyze 默认 true (不传) · SELECT → analyzed=true', async () => {
    const { runner } = makeRunner();
    const r = await handleExplainPlans(
      { sql: 'SELECT 1', projectId: 'p1' },
      runner,
    );
    expect(r.analyzed).toBe(true);
  });

  it('SELECT + analyze=false → analyzed=false 但未降级 (downgraded=false · 请求本就 false)', async () => {
    const { runner } = makeRunner();
    const r = await handleExplainPlans(
      { sql: 'SELECT 1', projectId: 'p1', analyze: false },
      runner,
    );
    expect(r.analyzed).toBe(false);
    expect(r.downgraded).toBe(false);
  });

  it('depth=full: plan 合法 JSON → 解析为对象 · 非 JSON → 原文兜底', async () => {
    const parsed = await handleExplainPlans(
      { sql: 'SELECT 1', projectId: 'p1', depth: 'full' },
      makeRunner([{ Plan: { 'Node Type': 'Result' } }]).runner,
    );
    expect(parsed.depth).toBe('full');
    expect(parsed.plan).toEqual([{ Plan: { 'Node Type': 'Result' } }]);
    expect(parsed.signals).toBeUndefined();

    const rawText: ExplainRunner = async () => ({
      content: [{ type: 'text', text: 'not-json-plan' }],
    });
    const fallback = await handleExplainPlans(
      { sql: 'SELECT 1', projectId: 'p1', depth: 'full' },
      rawText,
    );
    expect(fallback.plan).toBe('not-json-plan');
  });

  it('CTE 内嵌 DML (WITH ... DELETE) → 归 DML → 强制 analyze=false (保守)', async () => {
    const { runner, calls } = makeRunner();
    const r = await handleExplainPlans(
      {
        sql: 'WITH x AS (DELETE FROM sales RETURNING *) SELECT * FROM x',
        projectId: 'p1',
        analyze: true,
      },
      runner,
    );
    expect(calls).toEqual([false]);
    expect(r.analyzed).toBe(false);
  });
});

// 慢 SELECT 无索引的典型 plan: Aggregate → Seq Scan on sales (带 Filter)
const SLOW_SELECT_PLAN = [
  {
    Plan: {
      'Node Type': 'Aggregate',
      'Total Cost': 20000.5,
      Plans: [
        {
          'Node Type': 'Seq Scan',
          'Relation Name': 'sales',
          'Total Cost': 18000.25,
          'Plan Rows': 1000000,
          Filter: "(sale_date > '2020-01-01'::date)",
        },
      ],
    },
  },
];

describe('parsePlanSignals (feat-019/#2 · 防幻觉摘要 · 详设 §4)', () => {
  it('Seq Scan → seq_scan(table+est_rows) + missing_index_hint(table+filter_col)', () => {
    const { signals } = parsePlanSignals(SLOW_SELECT_PLAN);
    expect(signals).toContainEqual({
      type: 'seq_scan',
      table: 'sales',
      est_rows: 1000000,
    });
    expect(signals).toContainEqual({
      type: 'missing_index_hint',
      table: 'sales',
      filter_col: 'sale_date',
    });
  });

  it('expensive_node = 全树 Total Cost 最高节点 · total_cost = 根节点 cost', () => {
    const { signals, total_cost } = parsePlanSignals(SLOW_SELECT_PLAN);
    expect(total_cost).toBe(20000.5);
    expect(signals).toContainEqual({
      type: 'expensive_node',
      node: 'Aggregate',
      cost: 20000.5,
    });
  });

  it('#202: run_sql 列包装形态 [{ "QUERY PLAN": [{ Plan }] }] 也提取 signals + total_cost (此前 extractRootPlan 只认裸形态 → 真数据恒 0)', () => {
    const wrapped = [{ 'QUERY PLAN': SLOW_SELECT_PLAN }];
    const { signals, total_cost } = parsePlanSignals(wrapped);
    expect(total_cost).toBe(20000.5);
    expect(signals).toContainEqual({
      type: 'seq_scan',
      table: 'sales',
      est_rows: 1000000,
    });
    expect(signals).toContainEqual({
      type: 'expensive_node',
      node: 'Aggregate',
      cost: 20000.5,
    });
  });

  it('Seq Scan 无 Filter → 不出 missing_index_hint', () => {
    const { signals } = parsePlanSignals([
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 't',
          'Total Cost': 10,
          'Plan Rows': 5,
        },
      },
    ]);
    expect(signals.some((s) => s.type === 'missing_index_hint')).toBe(false);
    expect(signals).toContainEqual({ type: 'seq_scan', table: 't', est_rows: 5 });
  });

  it('非法 / 非 EXPLAIN JSON → 空 signals (不抛)', () => {
    expect(parsePlanSignals(null)).toEqual({ signals: [], total_cost: 0 });
    expect(parsePlanSignals('garbage')).toEqual({ signals: [], total_cost: 0 });
    expect(parsePlanSignals([])).toEqual({ signals: [], total_cost: 0 });
  });
});

describe('handleExplainPlans depth (feat-019/#2 · progressive disclosure)', () => {
  it('depth 默认 shallow → 返回 signals 摘要 · 无 raw plan (token 经济)', async () => {
    const { runner } = makeRunner(SLOW_SELECT_PLAN);
    const r = await handleExplainPlans(
      { sql: 'SELECT count(*) FROM sales WHERE sale_date > $1', projectId: 'p1' },
      runner,
    );
    expect(r.depth).toBe('shallow');
    expect(r.plan).toBeUndefined();
    expect(r.total_cost).toBe(20000.5);
    expect(r.signals).toContainEqual({
      type: 'seq_scan',
      table: 'sales',
      est_rows: 1000000,
    });
    expect(r.signals).toContainEqual({
      type: 'missing_index_hint',
      table: 'sales',
      filter_col: 'sale_date',
    });
  });

  it('depth=full → 返回 raw plan · 无 signals', async () => {
    const { runner } = makeRunner(SLOW_SELECT_PLAN);
    const r = await handleExplainPlans(
      { sql: 'SELECT 1', projectId: 'p1', depth: 'full' },
      runner,
    );
    expect(r.depth).toBe('full');
    expect(r.plan).toEqual(SLOW_SELECT_PLAN);
    expect(r.signals).toBeUndefined();
  });

  it('非法 depth 值 → 落默认 shallow', async () => {
    const { runner } = makeRunner(SLOW_SELECT_PLAN);
    const r = await handleExplainPlans(
      {
        sql: 'SELECT 1',
        projectId: 'p1',
        depth: 'deep' as unknown as 'shallow',
      },
      runner,
    );
    expect(r.depth).toBe('shallow');
    expect(r.signals).toBeDefined();
  });
});
