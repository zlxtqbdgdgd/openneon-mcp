import { describe, it, expect, beforeEach } from 'vitest';
import { lookupMatrix } from '../policy/matrix';
import { runPipeline, __resetStagesForTest } from '../policy/pipeline';
import {
  resolvePolicy,
  applyOverrides,
  validate,
  __setPolicyForTest,
} from '../policy/loader';
import type { OpClass } from '../protection/destructive-detector';
import type { AutonomyLevel } from '../policy/pipeline';

const ALL_LEVELS: AutonomyLevel[] = ['L1', 'L2a', 'L2b', 'L3', 'L4'];
const ALL_OPS: OpClass[] = [
  'READ_ONLY',
  'CREATE_OR_RESTORE_BRANCH',
  'CREATE_INDEX_CONCURRENTLY',
  'DDL_ADD_COLUMN',
  'ALTER_TABLE_BIG_LOCK',
  'DELETE_UPDATE_BULK',
  'DROP_TABLE_OR_INDEX',
  'DROP_REPLICATION_SLOT',
  'DROP_DATABASE_OR_TRUNCATE',
  'DROP_USER_OR_REVOKE',
  'CROSS_PROJECT',
];

describe('lookupMatrix (feat-056/#2 · §8.1 矩阵)', () => {
  it('READ_ONLY 所有 level → allow', () => {
    for (const lvl of ALL_LEVELS) {
      expect(lookupMatrix('READ_ONLY', lvl)).toBe('allow');
    }
  });

  it('CREATE_INDEX_CONCURRENTLY: L1=deny · L2a/L2b/L3=require_plan · L4=allow', () => {
    expect(lookupMatrix('CREATE_INDEX_CONCURRENTLY', 'L1')).toBe('deny');
    expect(lookupMatrix('CREATE_INDEX_CONCURRENTLY', 'L2a')).toBe(
      'require_plan',
    );
    expect(lookupMatrix('CREATE_INDEX_CONCURRENTLY', 'L2b')).toBe(
      'require_plan',
    );
    expect(lookupMatrix('CREATE_INDEX_CONCURRENTLY', 'L3')).toBe(
      'require_plan',
    );
    expect(lookupMatrix('CREATE_INDEX_CONCURRENTLY', 'L4')).toBe('allow');
  });

  it('hard-deny 行(DROP DATABASE)矩阵也 deny · 即便 L4(冗余安全)', () => {
    expect(lookupMatrix('DROP_DATABASE_OR_TRUNCATE', 'L4')).toBe('deny');
    expect(lookupMatrix('DROP_USER_OR_REVOKE', 'L4')).toBe('deny');
    expect(lookupMatrix('CROSS_PROJECT', 'L4')).toBe('deny');
  });

  it('矩阵全组合 11 op-class × 5 level 都有合法 cell(无 undefined)', () => {
    for (const op of ALL_OPS) {
      for (const lvl of ALL_LEVELS) {
        expect(['allow', 'deny', 'require_plan']).toContain(
          lookupMatrix(op, lvl),
        );
      }
    }
  });
});

describe('resolvePolicy + per-project verdict (feat-056/#2)', () => {
  beforeEach(() => {
    __resetStagesForTest();
    __setPolicyForTest({
      schema_version: 1,
      projects: {
        'rapid-art-12345': {
          autonomy_level: 'L2b',
          overrides: { 'DROP TABLE production_*': 'L1' },
          timeout_overrides: {},
        },
        'noisy-bird-13579': {
          autonomy_level: 'L4',
          overrides: {},
          timeout_overrides: {},
        },
      },
      defaults: { autonomy_level: 'L1', shadow_mode: true },
      authServices: {},
    });
  });

  it('同 op 不同 project 不同 level: prod=L2b · toy=L4', () => {
    expect(resolvePolicy('rapid-art-12345').autonomy_level).toBe('L2b');
    expect(resolvePolicy('noisy-bird-13579').autonomy_level).toBe('L4');
  });

  it('CREATE INDEX: prod(L2b)→require_plan · toy(L4)→allow', () => {
    expect(
      lookupMatrix(
        'CREATE_INDEX_CONCURRENTLY',
        resolvePolicy('rapid-art-12345').autonomy_level,
      ),
    ).toBe('require_plan');
    expect(
      lookupMatrix(
        'CREATE_INDEX_CONCURRENTLY',
        resolvePolicy('noisy-bird-13579').autonomy_level,
      ),
    ).toBe('allow');
  });

  it('未配置 project_id → defaults(L1) · source=defaults', () => {
    const r = resolvePolicy('unknown-xyz');
    expect(r.autonomy_level).toBe('L1');
    expect(r.source).toBe('defaults');
  });

  it('override: DROP TABLE production_* → L1(比 project default L2b 更严) · 非匹配走 default', () => {
    const r = resolvePolicy('rapid-art-12345');
    expect(applyOverrides('DROP TABLE production_orders', r)).toBe('L1');
    expect(applyOverrides('DROP TABLE staging_tmp', r)).toBe('L2b');
    expect(applyOverrides(undefined, r)).toBe('L2b');
  });

  it('整链: prod DROP TABLE production_* → runPipeline deny (override→L1→matrix deny)', () => {
    const r = resolvePolicy('rapid-art-12345');
    const lvl = applyOverrides('DROP TABLE production_orders', r); // → L1
    const v = runPipeline({
      opClass: 'DROP_TABLE_OR_INDEX',
      toolName: 'run_sql',
      autonomyLevel: lvl,
    });
    expect(v.action).toBe('deny');
  });

  it('toy(L4) CREATE INDEX → 放行 + feat-030 注入 lock_timeout (非 deny)', () => {
    const lvl = resolvePolicy('noisy-bird-13579').autonomy_level;
    const v = runPipeline({
      opClass: 'CREATE_INDEX_CONCURRENTLY',
      toolName: 'run_sql',
      autonomyLevel: lvl,
    });
    // matrix @ L4 放行 → 链跑到 feat-030 timeout stage → inject_timeout (非 deny · CONCURRENTLY 仅 lock_timeout)
    expect(v.action).toBe('inject_timeout');
    expect(v.timeouts).toEqual({ lock_timeout: '30s' });
  });
});

describe('validate fail-safe (feat-056/#2 · 坏 config 抛错 → loadPolicy 保守不应用)', () => {
  it('非法 autonomy_level 抛错', () => {
    expect(() =>
      validate({ projects: { p1: { autonomy_level: 'L9' } }, defaults: {} }),
    ).toThrow();
  });

  it('顶层非 object 抛错', () => {
    expect(() => validate('not an object')).toThrow();
    expect(() => validate(null)).toThrow();
  });

  it('合法 config 通过 · 缺 defaults.autonomy_level 落 L1', () => {
    const c = validate({
      projects: { p1: { autonomy_level: 'L2b' } },
      defaults: {},
    });
    expect(c.projects.p1.autonomy_level).toBe('L2b');
    expect(c.defaults.autonomy_level).toBe('L1');
  });
});

describe('baseline.min_valid_samples per-project 覆盖 (feat-040 follow-up · #175)', () => {
  it('合法值通过 + resolvePolicy 暴露 baseline_min_valid_samples', () => {
    __setPolicyForTest(
      validate({
        projects: {
          p1: {
            autonomy_level: 'L3',
            baseline: { min_valid_samples: 200 },
          },
        },
        defaults: { autonomy_level: 'L1' },
      }),
    );
    expect(resolvePolicy('p1').baseline_min_valid_samples).toBe(200);
  });

  it('缺 baseline 段 → resolvePolicy baseline_min_valid_samples=undefined (走 DEFAULT 兜底)', () => {
    __setPolicyForTest(
      validate({
        projects: { p1: { autonomy_level: 'L3' } },
        defaults: { autonomy_level: 'L1' },
      }),
    );
    expect(resolvePolicy('p1').baseline_min_valid_samples).toBeUndefined();
  });

  it('越上界 500 → clamp 到 500 (跟 BASELINE_MIN_VALID_SAMPLES_BOUNDS 一致)', () => {
    const c = validate({
      projects: {
        p1: {
          autonomy_level: 'L3',
          baseline: { min_valid_samples: 9999 },
        },
      },
      defaults: { autonomy_level: 'L1' },
    });
    expect(c.projects.p1.baseline?.min_valid_samples).toBe(500);
  });

  it('越下界 50 → clamp 到 50', () => {
    const c = validate({
      projects: {
        p1: {
          autonomy_level: 'L3',
          baseline: { min_valid_samples: 10 },
        },
      },
      defaults: { autonomy_level: 'L1' },
    });
    expect(c.projects.p1.baseline?.min_valid_samples).toBe(50);
  });

  it('非整数 / 负数 / 0 抛错 (fail-safe · 跟 timeout_overrides 同风格)', () => {
    expect(() =>
      validate({
        projects: {
          p1: {
            autonomy_level: 'L3',
            baseline: { min_valid_samples: -1 },
          },
        },
        defaults: { autonomy_level: 'L1' },
      }),
    ).toThrow();
    expect(() =>
      validate({
        projects: {
          p1: {
            autonomy_level: 'L3',
            baseline: { min_valid_samples: 1.5 },
          },
        },
        defaults: { autonomy_level: 'L1' },
      }),
    ).toThrow();
    expect(() =>
      validate({
        projects: {
          p1: {
            autonomy_level: 'L3',
            baseline: { min_valid_samples: 'not a number' as unknown as number },
          },
        },
        defaults: { autonomy_level: 'L1' },
      }),
    ).toThrow();
  });

  it('baseline 不是 object 抛错', () => {
    expect(() =>
      validate({
        projects: {
          p1: {
            autonomy_level: 'L3',
            baseline: 'not an object' as unknown as Record<string, unknown>,
          },
        },
        defaults: { autonomy_level: 'L1' },
      }),
    ).toThrow();
  });
});
