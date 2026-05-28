import { describe, it, expect, beforeEach } from 'vitest';
import { handleGetPolicy } from '../tools/handlers/get-policy';
import { __setPolicyForTest } from '../policy/loader';

describe('handleGetPolicy (feat-057 · advisory)', () => {
  beforeEach(() => {
    __setPolicyForTest({
      schema_version: 1,
      projects: {
        'rapid-art-12345': {
          autonomy_level: 'L2b',
          overrides: { 'DROP TABLE production_*': 'L1' },
          timeout_overrides: {},
        },
      },
      defaults: { autonomy_level: 'L1', shadow_mode: true },
      authServices: {},
    });
  });

  it('返回 advisory 清单: autonomy_level + ops(14 = day-one 11 + feat-028 加 VACUUM_FULL_LOCK / CLUSTER_LOCK / OTHER) + overrides + hard_deny + disclaimer', () => {
    const a = handleGetPolicy({ projectId: 'rapid-art-12345' });
    expect(a.autonomy_level).toBe('L2b');
    expect(a.advisory).toBe(true);
    expect(a.source).toBe('configured');
    // day-one 11 类 + feat-028 加 3 (VACUUM_FULL_LOCK / CLUSTER_LOCK / OTHER) = 14
    expect(a.ops).toHaveLength(14);
    expect(a.overrides).toEqual([
      { pattern: 'DROP TABLE production_*', effective_level: 'L1' },
    ]);
    expect(a.hard_deny.length).toBe(3);
    expect(a.disclaimer).toContain('advisory');
  });

  it('ops verdict 跟 §8.1 矩阵一致 (L2b): SELECT=allow · CREATE INDEX=require_plan · DROP DATABASE=deny', () => {
    const a = handleGetPolicy({ projectId: 'rapid-art-12345' });
    const v = (op: string) => a.ops.find((o) => o.op_class === op)?.verdict;
    expect(v('READ_ONLY')).toBe('allow');
    expect(v('CREATE_INDEX_CONCURRENTLY')).toBe('require_plan');
    expect(v('DROP_DATABASE_OR_TRUNCATE')).toBe('deny');
  });

  it('未配置 project → defaults(L1) advisory · source=defaults', () => {
    const a = handleGetPolicy({ projectId: 'unknown' });
    expect(a.autonomy_level).toBe('L1');
    expect(a.source).toBe('defaults');
  });
});
