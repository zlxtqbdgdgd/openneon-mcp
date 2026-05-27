import { describe, it, expect, beforeEach } from 'vitest';
import {
  runPipeline,
  __resetStagesForTest,
  type EnforcementCtx,
} from '../policy/pipeline';
import {
  recordAndCheckRateLimit,
  isRateLimitedOp,
  __resetRateLimitForTest,
  RATE_LIMIT_CONFIG,
  DEFAULT_RATE_COUNTER_CONFIG,
} from '../policy/rate-limiter';

describe('G1 跨 project (feat-056/#76 · §8.2 第 1 步)', () => {
  beforeEach(() => {
    __resetStagesForTest();
    __resetRateLimitForTest();
  });

  const ctx = (over: Partial<EnforcementCtx>): EnforcementCtx => ({
    opClass: 'READ_ONLY',
    toolName: 'run_sql',
    autonomyLevel: 'L4',
    ...over,
  });

  it('请求 projectId ≠ key scope → deny + alert(high)', () => {
    const v = runPipeline(
      ctx({ requestedProjectId: 'projB', grant: { projectId: 'projA' } }),
    );
    expect(v.action).toBe('deny');
    expect(v.audit_severity).toBe('high');
    expect(v.reason).toContain('跨 project');
  });

  it('请求 projectId == key scope → G1 放行(续 matrix · READ_ONLY allow)', () => {
    const v = runPipeline(
      ctx({ requestedProjectId: 'projA', grant: { projectId: 'projA' } }),
    );
    expect(v.action).toBe('allow');
  });

  it('key 无 scope(非 project-scoped) → G1 不拦', () => {
    const v = runPipeline(
      ctx({ requestedProjectId: 'projB', grant: { projectId: null } }),
    );
    expect(v.action).toBe('allow');
  });

  it('跨 project 即便 L4 也拦(hard-deny 不受 autonomy_level)', () => {
    const v = runPipeline(
      ctx({
        requestedProjectId: 'projB',
        grant: { projectId: 'projA' },
        autonomyLevel: 'L4',
      }),
    );
    expect(v.action).toBe('deny');
  });
});

describe('G9 rate-limit (feat-056/#76 · §8.2 第 3 步)', () => {
  beforeEach(() => {
    __resetStagesForTest();
    __resetRateLimitForTest();
  });

  it('isRateLimitedOp: DROP TABLE/DELETE/ALTER 计 · READ_ONLY/CREATE INDEX 不计', () => {
    expect(isRateLimitedOp('DROP_TABLE_OR_INDEX')).toBe(true);
    expect(isRateLimitedOp('DELETE_UPDATE_BULK')).toBe(true);
    expect(isRateLimitedOp('ALTER_TABLE_BIG_LOCK')).toBe(true);
    expect(isRateLimitedOp('READ_ONLY')).toBe(false);
    expect(isRateLimitedOp('CREATE_INDEX_CONCURRENTLY')).toBe(false);
  });

  it('recordAndCheckRateLimit: 前 N 个不超(非 EXCEEDED) · 第 N+1 超(EXCEEDED)', () => {
    // breaking change: 旧 (key, now)=>boolean 升级为结构化 ({projectId, opClass, config, now})=>Verdict。
    // 默认 config maxUnits=5 · DROP_TABLE 权重 1 · 故 weightedCount = 第几次调用。
    const projectId = 'projA';
    const now = Date.now();
    for (let i = 0; i < RATE_LIMIT_CONFIG.MAX_DESTRUCTIVE; i++) {
      const v = recordAndCheckRateLimit({
        projectId,
        opClass: 'DROP_TABLE_OR_INDEX',
        config: DEFAULT_RATE_COUNTER_CONFIG,
        now,
      });
      expect(v.outcome).not.toBe('EXCEEDED'); // 前 5 次 weighted<=5 · 不超
    }
    // 第 N+1 次:weighted=6 > maxUnits=5 → EXCEEDED
    const exceeded = recordAndCheckRateLimit({
      projectId,
      opClass: 'DROP_TABLE_OR_INDEX',
      config: DEFAULT_RATE_COUNTER_CONFIG,
      now,
    });
    expect(exceeded.outcome).toBe('EXCEEDED');
  });

  it('滑窗: 超窗旧记录不计', () => {
    const projectId = 'projB';
    const t0 = 1_000_000;
    for (let i = 0; i < RATE_LIMIT_CONFIG.MAX_DESTRUCTIVE; i++) {
      recordAndCheckRateLimit({
        projectId,
        opClass: 'DROP_TABLE_OR_INDEX',
        config: DEFAULT_RATE_COUNTER_CONFIG,
        now: t0,
      });
    }
    // 跨过整个窗后再来一次:旧 5 条全过期 · 仅本次计入 → weighted=1 · OK
    const v = recordAndCheckRateLimit({
      projectId,
      opClass: 'DROP_TABLE_OR_INDEX',
      config: DEFAULT_RATE_COUNTER_CONFIG,
      now: t0 + RATE_LIMIT_CONFIG.WINDOW_MS + 1,
    });
    expect(v.outcome).toBe('OK');
  });

  it('runPipeline: DROP TABLE 连发超限 → G9 deny(速率超限 · 在 matrix 前)', () => {
    const c: EnforcementCtx = {
      opClass: 'DROP_TABLE_OR_INDEX',
      toolName: 'run_sql',
      autonomyLevel: 'L4',
      grant: { projectId: 'projX' },
    };
    let last;
    for (let i = 0; i <= RATE_LIMIT_CONFIG.MAX_DESTRUCTIVE; i++) {
      last = runPipeline(c);
    }
    expect(last?.action).toBe('deny');
    // 新 G9 stage 的 deny reason 串 (旧串 '速率超限' 已随 breaking change 改掉)
    expect(last?.reason).toContain('G9 rate limit exceeded');
  });
});
