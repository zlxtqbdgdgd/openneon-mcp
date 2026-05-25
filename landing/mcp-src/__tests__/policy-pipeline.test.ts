import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyOp,
  classifySql,
  isDestructiveSql,
  isDestructiveToolName,
} from '../protection/destructive-detector';
import { isHardDenied } from '../policy/hard-deny';
import {
  runPipeline,
  registerStage,
  __resetStagesForTest,
  type EnforcementCtx,
} from '../policy/pipeline';

describe('classifyOp (feat-056/#1 · ADR-0005 单一源)', () => {
  it('专用只读 tool → READ_ONLY (T1-T12)', () => {
    expect(classifyOp('get_neondb_schemas')).toBe('READ_ONLY');
    expect(classifyOp('find_neondb_instances')).toBe('READ_ONLY');
    expect(classifyOp('get_neondb_query_statement')).toBe('READ_ONLY');
  });

  it('run_sql DROP DATABASE / TRUNCATE → DROP_DATABASE_OR_TRUNCATE (hard-deny)', () => {
    expect(classifyOp('run_sql', 'DROP DATABASE prod')).toBe(
      'DROP_DATABASE_OR_TRUNCATE',
    );
    expect(classifyOp('run_sql', 'truncate table sales')).toBe(
      'DROP_DATABASE_OR_TRUNCATE',
    );
  });

  it('run_sql DROP USER / REVOKE → DROP_USER_OR_REVOKE (hard-deny)', () => {
    expect(classifyOp('run_sql', 'DROP USER bob')).toBe('DROP_USER_OR_REVOKE');
    expect(classifyOp('run_sql', 'REVOKE ALL ON sales FROM bob')).toBe(
      'DROP_USER_OR_REVOKE',
    );
  });

  it('run_sql DROP TABLE / INDEX → DROP_TABLE_OR_INDEX (非 hard-deny · 走 plan+confirm)', () => {
    expect(classifyOp('run_sql', 'DROP TABLE sales')).toBe(
      'DROP_TABLE_OR_INDEX',
    );
    expect(classifyOp('run_sql', 'drop index sales_idx')).toBe(
      'DROP_TABLE_OR_INDEX',
    );
  });

  it('CREATE INDEX CONCURRENTLY 区别于普通建索引', () => {
    expect(
      classifyOp(
        'run_sql',
        'CREATE INDEX CONCURRENTLY sidx ON sales(sale_date)',
      ),
    ).toBe('CREATE_INDEX_CONCURRENTLY');
    expect(classifyOp('run_sql', 'CREATE INDEX sidx ON sales(sale_date)')).toBe(
      'DDL_ADD_COLUMN',
    );
  });

  it('ALTER TABLE → ALTER_TABLE_BIG_LOCK · DELETE/UPDATE → DELETE_UPDATE_BULK', () => {
    expect(
      classifyOp('run_sql', 'ALTER TABLE sales ADD COLUMN region text'),
    ).toBe('ALTER_TABLE_BIG_LOCK');
    expect(classifyOp('run_sql', 'DELETE FROM sales WHERE id < 100')).toBe(
      'DELETE_UPDATE_BULK',
    );
    expect(classifyOp('run_sql', 'UPDATE sales SET x = 1')).toBe(
      'DELETE_UPDATE_BULK',
    );
  });

  it('SELECT / 空 sql → READ_ONLY', () => {
    expect(classifyOp('run_sql', 'SELECT AVG(amount) FROM sales')).toBe(
      'READ_ONLY',
    );
    expect(classifyOp('run_sql', '')).toBe('READ_ONLY');
    expect(classifyOp('run_sql')).toBe('READ_ONLY');
  });

  it('多语句 (run_sql_transaction join) 取最危险', () => {
    expect(classifySql('SELECT 1; DROP DATABASE prod; SELECT 2')).toBe(
      'DROP_DATABASE_OR_TRUNCATE',
    );
  });

  it('isDestructiveToolName / isDestructiveSql', () => {
    expect(isDestructiveToolName('run_sql')).toBe(true);
    expect(isDestructiveToolName('get_neondb_schemas')).toBe(false);
    expect(isDestructiveSql('DROP TABLE sales')).toBe(true);
    expect(isDestructiveSql('SELECT 1')).toBe(false);
  });
});

describe('hard-deny (feat-056/#1 · ADR-0007 · 编译期常量)', () => {
  it('DROP DATABASE / DROP USER 类命中 hard-deny', () => {
    expect(isHardDenied('DROP_DATABASE_OR_TRUNCATE')).toBe(true);
    expect(isHardDenied('DROP_USER_OR_REVOKE')).toBe(true);
  });
  it('READ_ONLY / DROP TABLE 不命中 hard-deny (#73 只 G4 · DROP TABLE 走 plan+confirm 在 #75)', () => {
    expect(isHardDenied('READ_ONLY')).toBe(false);
    expect(isHardDenied('DROP_TABLE_OR_INDEX')).toBe(false);
  });
});

describe('runPipeline (feat-056/#1 · §8.2 短路)', () => {
  beforeEach(() => __resetStagesForTest());

  const ctx = (over: Partial<EnforcementCtx>): EnforcementCtx => ({
    opClass: 'READ_ONLY',
    toolName: 'run_sql',
    autonomyLevel: 'L1',
    ...over,
  });

  it('DROP DATABASE → deny terminal high (hard-deny G4)', () => {
    const v = runPipeline(ctx({ opClass: 'DROP_DATABASE_OR_TRUNCATE' }));
    expect(v.action).toBe('deny');
    expect(v.terminal).toBe(true);
    expect(v.audit_severity).toBe('high');
  });

  it('SELECT (READ_ONLY) → allow', () => {
    expect(runPipeline(ctx({ opClass: 'READ_ONLY' })).action).toBe('allow');
  });

  it('DROP TABLE @ L1 → deny (#75 matrix: L1 write = deny · human-only)', () => {
    expect(runPipeline(ctx({ opClass: 'DROP_TABLE_OR_INDEX' })).action).toBe(
      'deny',
    );
  });

  it('DROP TABLE @ L2b → require_plan (feat-027/#2: planModeStage 接管 · 非 fail-closed deny)', () => {
    const v = runPipeline(
      ctx({ opClass: 'DROP_TABLE_OR_INDEX', autonomyLevel: 'L2b' }),
    );
    expect(v.action).toBe('require_plan');
    expect(v.terminal).toBe(false);
    expect(v.plan?.op_class).toBe('DROP_TABLE_OR_INDEX');
    expect(v.reason).toContain('plan mode');
  });

  it('hard-deny 不受 autonomy_level 影响: 即便 L4 也拦 DROP DATABASE', () => {
    const v = runPipeline(
      ctx({ opClass: 'DROP_DATABASE_OR_TRUNCATE', autonomyLevel: 'L4' }),
    );
    expect(v.action).toBe('deny');
  });

  it('registerStage 注册的 stage 也跑 · terminal 短路', () => {
    registerStage(() => ({
      action: 'deny',
      reason: 'test stage',
      audit_severity: 'medium',
      terminal: true,
    }));
    const v = runPipeline(ctx({ opClass: 'READ_ONLY' }));
    expect(v.action).toBe('deny');
    expect(v.reason).toBe('test stage');
  });
});
