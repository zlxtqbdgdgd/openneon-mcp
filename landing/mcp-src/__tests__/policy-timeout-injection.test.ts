import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_TIMEOUTS,
  timeoutFor,
  timeoutInjectionStage,
  isValidPgTimeoutValue,
  type TimeoutSpec,
} from '../policy/stages/timeout-injection';
import {
  runPipeline,
  __resetStagesForTest,
  type EnforcementCtx,
} from '../policy/pipeline';
import { validate, resolvePolicy, __setPolicyForTest } from '../policy/loader';

describe('timeoutFor (feat-030/#79 · op-class → timeout 映射 · 详设 §4.1)', () => {
  it('ALTER/DDL/DELETE/DROP → lock_timeout=30s + statement_timeout=5min', () => {
    for (const op of [
      'ALTER_TABLE_BIG_LOCK',
      'DDL_ADD_COLUMN',
      'DELETE_UPDATE_BULK',
      'DROP_TABLE_OR_INDEX',
    ] as const) {
      expect(timeoutFor(op)).toEqual({
        lock_timeout: '30s',
        statement_timeout: '5min',
      });
    }
  });

  it('CREATE_INDEX_CONCURRENTLY → 仅 lock_timeout (豁免 statement_timeout · 否则误杀大表建索引)', () => {
    const t = timeoutFor('CREATE_INDEX_CONCURRENTLY');
    expect(t).toEqual({ lock_timeout: '30s' });
    expect(t?.statement_timeout).toBeUndefined();
  });

  it('READ_ONLY / 分支 / hard-deny / slot → null (不注入)', () => {
    expect(timeoutFor('READ_ONLY')).toBeNull();
    expect(timeoutFor('CREATE_OR_RESTORE_BRANCH')).toBeNull();
    expect(timeoutFor('DROP_DATABASE_OR_TRUNCATE')).toBeNull();
    expect(timeoutFor('DROP_USER_OR_REVOKE')).toBeNull();
    expect(timeoutFor('CROSS_PROJECT')).toBeNull();
    expect(timeoutFor('DROP_REPLICATION_SLOT')).toBeNull();
  });

  it('override 覆盖默认值 (per-project timeout_overrides)', () => {
    const overrides: Partial<Record<string, TimeoutSpec>> = {
      ALTER_TABLE_BIG_LOCK: { lock_timeout: '10s', statement_timeout: '2min' },
    };
    expect(timeoutFor('ALTER_TABLE_BIG_LOCK', overrides)).toEqual({
      lock_timeout: '10s',
      statement_timeout: '2min',
    });
    // 未被 override 的 op-class 仍用默认
    expect(timeoutFor('DDL_ADD_COLUMN', overrides)).toEqual(
      DEFAULT_TIMEOUTS.DDL_ADD_COLUMN,
    );
  });
});

describe('timeoutInjectionStage (feat-030/#79 · pure stage)', () => {
  it('ALTER → non-terminal inject_timeout verdict · info severity', () => {
    const v = timeoutInjectionStage({
      opClass: 'ALTER_TABLE_BIG_LOCK',
      toolName: 'run_sql',
      autonomyLevel: 'L4',
    });
    expect(v).not.toBeNull();
    expect(v?.action).toBe('inject_timeout');
    expect(v?.terminal).toBe(false);
    expect(v?.audit_severity).toBe('info');
    expect(v?.timeouts).toEqual({
      lock_timeout: '30s',
      statement_timeout: '5min',
    });
  });

  it('CONCURRENTLY → inject_timeout 仅 lock_timeout', () => {
    const v = timeoutInjectionStage({
      opClass: 'CREATE_INDEX_CONCURRENTLY',
      toolName: 'run_sql',
      autonomyLevel: 'L4',
    });
    expect(v?.timeouts).toEqual({ lock_timeout: '30s' });
    expect(v?.timeouts?.statement_timeout).toBeUndefined();
  });

  it('READ_ONLY → null (不注入 · pipeline 继续)', () => {
    expect(
      timeoutInjectionStage({
        opClass: 'READ_ONLY',
        toolName: 'run_sql',
        autonomyLevel: 'L4',
      }),
    ).toBeNull();
  });

  it('ctx.timeoutOverrides 透传到 timeoutFor', () => {
    const v = timeoutInjectionStage({
      opClass: 'ALTER_TABLE_BIG_LOCK',
      toolName: 'run_sql',
      autonomyLevel: 'L4',
      timeoutOverrides: {
        ALTER_TABLE_BIG_LOCK: { lock_timeout: '5s' },
      },
    });
    expect(v?.timeouts).toEqual({ lock_timeout: '5s' });
  });
});

describe('runPipeline surfaces inject_timeout (feat-030/#79 · AC1 注册进 §8.2)', () => {
  beforeEach(() => __resetStagesForTest());

  const ctx = (over: Partial<EnforcementCtx>): EnforcementCtx => ({
    opClass: 'READ_ONLY',
    toolName: 'run_sql',
    autonomyLevel: 'L4',
    ...over,
  });

  // matrix @ L4: DDL_ADD_COLUMN / CREATE_INDEX_CONCURRENTLY = allow → matrix stage 返回 null →
  // 链跑到 timeoutInjectionStage → 返回 inject_timeout。证明 stage 已注册进 pipeline 末步。
  it('allow 的写 op (DDL @ L4) → pipeline 返回 inject_timeout 携 timeouts', () => {
    const v = runPipeline(ctx({ opClass: 'DDL_ADD_COLUMN' }));
    expect(v.action).toBe('inject_timeout');
    expect(v.terminal).toBe(false);
    expect(v.timeouts).toEqual({ lock_timeout: '30s', statement_timeout: '5min' });
  });

  it('CONCURRENTLY @ L4 → inject_timeout 仅 lock_timeout', () => {
    const v = runPipeline(ctx({ opClass: 'CREATE_INDEX_CONCURRENTLY' }));
    expect(v.action).toBe('inject_timeout');
    expect(v.timeouts).toEqual({ lock_timeout: '30s' });
  });

  it('READ_ONLY → allow (无 inject_timeout · 不注入)', () => {
    const v = runPipeline(ctx({ opClass: 'READ_ONLY' }));
    expect(v.action).toBe('allow');
    expect(v.timeouts).toBeUndefined();
  });

  it('hard-deny / matrix deny 优先于 inject_timeout (terminal 短路)', () => {
    // DROP DATABASE → G4 hard-deny terminal · 永远不到 timeout stage
    expect(runPipeline(ctx({ opClass: 'DROP_DATABASE_OR_TRUNCATE' })).action).toBe(
      'deny',
    );
    // ALTER @ L2a = require_plan → matrix fail-closed deny terminal (#77 前)
    expect(
      runPipeline(ctx({ opClass: 'ALTER_TABLE_BIG_LOCK', autonomyLevel: 'L2a' }))
        .action,
    ).toBe('deny');
  });

  it('timeoutOverrides 经 pipeline ctx 流到注入值 (AC6)', () => {
    const v = runPipeline(
      ctx({
        opClass: 'DDL_ADD_COLUMN',
        timeoutOverrides: {
          DDL_ADD_COLUMN: { lock_timeout: '10s', statement_timeout: '2min' },
        },
      }),
    );
    expect(v.timeouts).toEqual({ lock_timeout: '10s', statement_timeout: '2min' });
  });
});

describe('isValidPgTimeoutValue (feat-030/#79 · 防 SQL 注入白名单 · 详设 §6)', () => {
  it('接受合法 PG interval 字面量', () => {
    for (const v of ['30s', '5min', '500ms', '2min', '1h', '1d', '0', '30000', '50us']) {
      expect(isValidPgTimeoutValue(v)).toBe(true);
    }
  });

  it('拒绝注入 / 非法字面量', () => {
    for (const v of [
      "30s'; DROP TABLE x; --",
      '999 years',
      'abc',
      '',
      '30 s; SELECT 1',
      undefined,
      null,
      30,
    ]) {
      expect(isValidPgTimeoutValue(v as unknown)).toBe(false);
    }
  });
});

describe('loader timeout_overrides (feat-030/#79 · validate + resolve · 详设 §4.2)', () => {
  it('validate 解析合法 timeout_overrides', () => {
    const cfg = validate({
      projects: {
        'rapid-art-12345': {
          autonomy_level: 'L2a',
          timeout_overrides: {
            ALTER_TABLE_BIG_LOCK: {
              lock_timeout: '10s',
              statement_timeout: '2min',
            },
            CREATE_INDEX_CONCURRENTLY: { lock_timeout: '15s' },
          },
        },
      },
      defaults: { autonomy_level: 'L1' },
    });
    expect(cfg.projects['rapid-art-12345'].timeout_overrides).toEqual({
      ALTER_TABLE_BIG_LOCK: { lock_timeout: '10s', statement_timeout: '2min' },
      CREATE_INDEX_CONCURRENTLY: { lock_timeout: '15s' },
    });
  });

  it('validate 拒绝非法 interval (fail-safe · 不 fail-open)', () => {
    expect(() =>
      validate({
        projects: {
          p1: {
            autonomy_level: 'L2a',
            timeout_overrides: {
              ALTER_TABLE_BIG_LOCK: { lock_timeout: "30s'; DROP TABLE x" },
            },
          },
        },
        defaults: { autonomy_level: 'L1' },
      }),
    ).toThrow(/lock_timeout 非法/);
  });

  it('validate 拒绝非法 statement_timeout', () => {
    expect(() =>
      validate({
        projects: {
          p1: {
            autonomy_level: 'L2a',
            timeout_overrides: {
              DDL_ADD_COLUMN: { lock_timeout: '30s', statement_timeout: '5 mins' },
            },
          },
        },
        defaults: { autonomy_level: 'L1' },
      }),
    ).toThrow(/statement_timeout 非法/);
  });

  it('resolvePolicy 返回 per-project timeout_overrides · 未配置 → 空', () => {
    __setPolicyForTest(
      validate({
        projects: {
          'rapid-art-12345': {
            autonomy_level: 'L2a',
            timeout_overrides: {
              ALTER_TABLE_BIG_LOCK: { lock_timeout: '10s' },
            },
          },
        },
        defaults: { autonomy_level: 'L1' },
      }),
    );
    expect(resolvePolicy('rapid-art-12345').timeout_overrides).toEqual({
      ALTER_TABLE_BIG_LOCK: { lock_timeout: '10s' },
    });
    // 未配置 project → defaults → 空 override (用 DEFAULT_TIMEOUTS)
    expect(resolvePolicy('unknown-project').timeout_overrides).toEqual({});
  });
});
