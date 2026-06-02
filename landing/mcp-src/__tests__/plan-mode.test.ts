import { describe, it, expect, beforeEach } from 'vitest';
import {
  planModeStage,
  buildPlanPayload,
  resolvePlanApproval,
  renderPlan,
  PLAN_ELICIT_TIMEOUT_MS,
  type ElicitFn,
  type ElicitResultLike,
  type PlanPayload,
} from '../policy/stages/plan-mode';
import { matrixRequiresPlan } from '../policy/matrix';
import {
  runPipeline,
  __resetStagesForTest,
  type EnforcementCtx,
} from '../policy/pipeline';

const ctx = (over: Partial<EnforcementCtx>): EnforcementCtx => ({
  opClass: 'READ_ONLY',
  toolName: 'run_sql',
  autonomyLevel: 'L2b',
  ...over,
});

describe('matrixRequiresPlan (feat-027/#2)', () => {
  it('require_plan 格 → true · allow/deny 格 → false', () => {
    expect(matrixRequiresPlan('DROP_TABLE_OR_INDEX', 'L2b')).toBe(true);
    expect(matrixRequiresPlan('CREATE_INDEX_CONCURRENTLY', 'L2b')).toBe(true);
    expect(matrixRequiresPlan('READ_ONLY', 'L2b')).toBe(false); // allow
    expect(matrixRequiresPlan('DROP_TABLE_OR_INDEX', 'L1')).toBe(false); // deny
    expect(matrixRequiresPlan('DROP_DATABASE_OR_TRUNCATE', 'L4')).toBe(false); // deny
  });
});

describe('buildPlanPayload (feat-027/#2 · server 事实 · 无投机)', () => {
  it('CREATE INDEX CONCURRENTLY → medium · 提对象 + CONCURRENTLY 属性 + 可逆性', () => {
    const p = buildPlanPayload(
      ctx({
        opClass: 'CREATE_INDEX_CONCURRENTLY',
        sql: 'CREATE INDEX CONCURRENTLY sales_date_idx ON sales(sale_date)',
      }),
    );
    expect(p.op_class).toBe('CREATE_INDEX_CONCURRENTLY');
    expect(p.risk_level).toBe('medium');
    expect(p.affected_objects).toContainEqual({
      type: 'index',
      name: 'sales_date_idx',
    });
    expect(p.affected_objects).toContainEqual({ type: 'table', name: 'sales' });
    expect(p.statement_properties.join(' ')).toContain('CONCURRENTLY');
    expect(p.reversibility).toContain('DROP INDEX');
  });

  it('DELETE 无 WHERE → high · 标注全表影响', () => {
    const p = buildPlanPayload(
      ctx({ opClass: 'DELETE_UPDATE_BULK', sql: 'DELETE FROM sales' }),
    );
    expect(p.risk_level).toBe('high');
    expect(p.affected_objects).toContainEqual({ type: 'table', name: 'sales' });
    expect(p.statement_properties.join(' ')).toContain('全表');
  });

  it('禁投机字段: payload 不含 estimated_p95 / 性能提升预测 (ADR-0008)', () => {
    const p = buildPlanPayload(
      ctx({ opClass: 'ALTER_TABLE_BIG_LOCK', sql: 'ALTER TABLE sales ADD COLUMN x int' }),
    );
    const keys = Object.keys(p);
    expect(keys).not.toContain('estimated_p95');
    expect(keys).not.toContain('improvement');
    // estimated_rows 为 DML EXPLAIN 估算 (server 事实) · #77 省略 (OQ3 defer)
    expect(p.estimated_rows).toBeUndefined();
    expect(JSON.stringify(p)).not.toMatch(/p95|提升|improv/i);
  });
});

describe('planModeStage (feat-027/#2 · near-pure)', () => {
  it('require_plan op → require_plan verdict (non-terminal · 带 plan · medium)', () => {
    const v = planModeStage(
      ctx({ opClass: 'DROP_TABLE_OR_INDEX', sql: 'DROP TABLE sales' }),
    );
    expect(v?.action).toBe('require_plan');
    expect(v?.terminal).toBe(false);
    expect(v?.audit_severity).toBe('medium');
    expect(v?.plan?.op_class).toBe('DROP_TABLE_OR_INDEX');
  });

  it('READ_ONLY (allow 格) → null (不弹 plan)', () => {
    expect(planModeStage(ctx({ opClass: 'READ_ONLY' }))).toBeNull();
  });

  it('deny 格 (DROP TABLE @ L1) → null (matrix stage 已 deny · 不归 plan)', () => {
    expect(
      planModeStage(ctx({ opClass: 'DROP_TABLE_OR_INDEX', autonomyLevel: 'L1' })),
    ).toBeNull();
  });
});

describe('runPipeline plan mode 集成 (feat-027/#2)', () => {
  beforeEach(() => __resetStagesForTest());

  it('CREATE INDEX CONCURRENTLY @ L2b → pipeline 返回 require_plan + plan', () => {
    const v = runPipeline(
      ctx({
        opClass: 'CREATE_INDEX_CONCURRENTLY',
        autonomyLevel: 'L2b',
        sql: 'CREATE INDEX CONCURRENTLY i ON sales(d)',
      }),
    );
    expect(v.action).toBe('require_plan');
    expect(v.plan?.op_class).toBe('CREATE_INDEX_CONCURRENTLY');
  });

  it('READ_ONLY → allow (不进 plan)', () => {
    expect(runPipeline(ctx({ opClass: 'READ_ONLY' })).action).toBe('allow');
  });
});

describe('resolvePlanApproval (feat-027/#2 · orchestrator elicitation · fail-closed)', () => {
  const plan: PlanPayload = {
    sql: 'DROP TABLE sales',
    op_class: 'DROP_TABLE_OR_INDEX',
    risk_level: 'high',
    affected_objects: [{ type: 'table', name: 'sales' }],
    reversibility: 'DROP 不可逆',
    statement_properties: [],
  };

  const elicitReturning =
    (result: ElicitResultLike): ElicitFn =>
    async () =>
      result;

  it('accept + approved=true → approved (放行)', async () => {
    const r = await resolvePlanApproval(
      elicitReturning({ action: 'accept', content: { approved: true } }),
      plan,
    );
    expect(r.approved).toBe(true);
    expect(r.failClosed).toBe(false);
  });

  it('accept + approved=false → deny (DBA 表单未批 · 非 failClosed)', async () => {
    const r = await resolvePlanApproval(
      elicitReturning({
        action: 'accept',
        content: { approved: false, reason: '风险太高' },
      }),
      plan,
    );
    expect(r.approved).toBe(false);
    expect(r.failClosed).toBe(false);
    expect(r.reason).toBe('风险太高');
  });

  it('decline → deny (DBA 拒 · 非 failClosed)', async () => {
    const r = await resolvePlanApproval(
      elicitReturning({ action: 'decline' }),
      plan,
    );
    expect(r.approved).toBe(false);
    expect(r.failClosed).toBe(false);
  });

  it('cancel → deny', async () => {
    const r = await resolvePlanApproval(
      elicitReturning({ action: 'cancel' }),
      plan,
    );
    expect(r.approved).toBe(false);
  });

  it('client 无 capability (elicit undefined) → fail-closed deny', async () => {
    const r = await resolvePlanApproval(undefined, plan);
    expect(r.approved).toBe(false);
    expect(r.failClosed).toBe(true);
  });

  it('elicit 抛错 (超时 / 断连) → fail-closed deny', async () => {
    const throwing: ElicitFn = async () => {
      throw new Error('timeout');
    };
    const r = await resolvePlanApproval(throwing, plan);
    expect(r.approved).toBe(false);
    expect(r.failClosed).toBe(true);
    expect(r.reason).toContain('fail-closed');
  });

  it('用 300s 超时 + 只 approve/reject schema 调 elicit', async () => {
    let seenTimeout = -1;
    let seenSchema: Record<string, unknown> = {};
    const spy: ElicitFn = async (_msg, schema, timeoutMs) => {
      seenTimeout = timeoutMs;
      seenSchema = schema;
      return { action: 'accept', content: { approved: true } };
    };
    await resolvePlanApproval(spy, plan);
    expect(seenTimeout).toBe(PLAN_ELICIT_TIMEOUT_MS);
    expect((seenSchema.required as string[]) ?? []).toContain('approved');
  });

  it('relatedRequestId 透传给 elicit (streamable-HTTP 把审批绑回发起的 POST 流)', async () => {
    let seenRelated: unknown = 'UNSET';
    const spy: ElicitFn = async (_m, _s, _t, relatedRequestId) => {
      seenRelated = relatedRequestId;
      return { action: 'accept', content: { approved: true } };
    };
    await resolvePlanApproval(spy, plan, 'req-abc-123');
    expect(seenRelated).toBe('req-abc-123');
  });
});

describe('renderPlan (feat-027/#2 · 人类可读 · 纯 server 事实)', () => {
  it('含 op-class / SQL / 受影响对象 / 可逆性 · 不含投机预测', () => {
    const text = renderPlan({
      sql: 'CREATE INDEX CONCURRENTLY i ON sales(d)',
      op_class: 'CREATE_INDEX_CONCURRENTLY',
      risk_level: 'medium',
      affected_objects: [{ type: 'table', name: 'sales' }],
      reversibility: '可 DROP INDEX 回滚',
      statement_properties: ['CONCURRENTLY：不阻塞读写'],
    });
    expect(text).toContain('CREATE_INDEX_CONCURRENTLY');
    expect(text).toContain('CREATE INDEX CONCURRENTLY i ON sales(d)');
    expect(text).toContain('table sales');
    expect(text).toContain('可 DROP INDEX 回滚');
    expect(text).not.toMatch(/p95|提升 \d/);
  });
});
