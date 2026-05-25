import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import {
  parseShadowConfig,
  passRate,
  shouldPromote,
  decayEntry,
  decayState,
  resolveShadow,
  initEntry,
  recordDecision,
  recordApproval,
  promoteEntry,
  loadShadowState,
  saveShadowState,
  type ShadowEntry,
  type ShadowConfig,
  type ShadowState,
} from '../policy/shadow-state';

const day = (n: number) => new Date(2026, 0, n, 12, 0, 0); // 固定时钟 · 避开 DST

const entry = (over: Partial<ShadowEntry> = {}): ShadowEntry => ({
  days_remaining: 5,
  decided: 0,
  approved: 0,
  ...over,
});

const cfg = (over: Partial<ShadowConfig> = {}): ShadowConfig => ({
  enabled: true,
  days: 7,
  pass_threshold: 0.95,
  shadow_during: 'L1',
  ...over,
});

describe('parseShadowConfig (feat-056/#4)', () => {
  it('false / 缺失 / 非对象 → undefined', () => {
    expect(parseShadowConfig(false)).toBeUndefined();
    expect(parseShadowConfig(undefined)).toBeUndefined();
    expect(parseShadowConfig(null)).toBeUndefined();
    expect(parseShadowConfig('x')).toBeUndefined();
    expect(parseShadowConfig({ enabled: false })).toBeUndefined();
  });

  it('true → 全默认 (7 天 · 0.95 · shadow_during L1)', () => {
    expect(parseShadowConfig(true)).toEqual({
      enabled: true,
      days: 7,
      pass_threshold: 0.95,
      shadow_during: 'L1',
    });
  });

  it('object → 取值 + 默认兜底 (含 days_remaining 别名)', () => {
    expect(
      parseShadowConfig({
        days_remaining: 3,
        pass_threshold: 0.8,
        shadow_during: 'L2a',
      }),
    ).toEqual({ enabled: true, days: 3, pass_threshold: 0.8, shadow_during: 'L2a' });
    // 非法 pass_threshold / shadow_during → 默认
    expect(parseShadowConfig({ pass_threshold: 5, shadow_during: 'LX' })).toEqual({
      enabled: true,
      days: 7,
      pass_threshold: 0.95,
      shadow_during: 'L1',
    });
  });
});

describe('passRate / shouldPromote (feat-056/#4 · AC3 AC4)', () => {
  it('pass-rate = approved / decided · decided=0 → 0', () => {
    expect(passRate(entry({ decided: 40, approved: 39 }))).toBeCloseTo(0.975);
    expect(passRate(entry({ decided: 0, approved: 0 }))).toBe(0);
  });

  it('shouldPromote: 过期 + pass-rate≥threshold + 有数据 + 未转正', () => {
    expect(
      shouldPromote(entry({ days_remaining: 0, decided: 40, approved: 39 }), 0.95),
    ).toBe(true); // 0.975 ≥ 0.95
    // 未过期 → false
    expect(
      shouldPromote(entry({ days_remaining: 2, decided: 40, approved: 40 }), 0.95),
    ).toBe(false);
    // pass-rate 不达标 → false
    expect(
      shouldPromote(entry({ days_remaining: 0, decided: 40, approved: 30 }), 0.95),
    ).toBe(false);
    // 无数据 (decided=0) → false (不能凭空转正)
    expect(
      shouldPromote(entry({ days_remaining: 0, decided: 0, approved: 0 }), 0.95),
    ).toBe(false);
    // 已转正 → false (alert 只一次)
    expect(
      shouldPromote(
        entry({ days_remaining: 0, decided: 40, approved: 40, promoted: true }),
        0.95,
      ),
    ).toBe(false);
  });
});

describe('decayEntry / decayState (feat-056/#4 · AC2 wall-clock 递减)', () => {
  it('按整天数递减 days_remaining (floor 0) · 更新 last_decay', () => {
    const e = entry({ days_remaining: 5, last_decay: day(1).toISOString() });
    const d = decayEntry(e, day(4)); // 过 3 天
    expect(d.days_remaining).toBe(2);
    expect(new Date(d.last_decay!).getTime()).toBe(day(4).getTime());
  });

  it('递减不到负 (floor 0)', () => {
    const e = entry({ days_remaining: 2, last_decay: day(1).toISOString() });
    expect(decayEntry(e, day(10)).days_remaining).toBe(0);
  });

  it('同一天内多次 load 不重复递减', () => {
    const e = entry({ days_remaining: 5, last_decay: day(3).toISOString() });
    expect(decayEntry(e, day(3)).days_remaining).toBe(5);
  });

  it('首次无 last_decay → 设为 now · 不递减', () => {
    const e = entry({ days_remaining: 5 });
    const d = decayEntry(e, day(3));
    expect(d.days_remaining).toBe(5);
    expect(d.last_decay).toBe(day(3).toISOString());
  });

  it('decayState 全量递减', () => {
    const s: ShadowState = {
      a: entry({ days_remaining: 5, last_decay: day(1).toISOString() }),
      b: entry({ days_remaining: 1, last_decay: day(1).toISOString() }),
    };
    const out = decayState(s, day(3)); // 过 2 天
    expect(out.a.days_remaining).toBe(3);
    expect(out.b.days_remaining).toBe(0);
  });
});

describe('resolveShadow (feat-056/#4 · AC1 decide-high/execute-low · AC5 降级立即)', () => {
  it('AC1: shadow 期 (L4 目标 · shadow_during L1) → effectiveLevel=L1 (低 · plan-gated) · shadowLevel=L4', () => {
    const d = resolveShadow(
      cfg({ shadow_during: 'L1' }),
      'L4',
      entry({ days_remaining: 5 }),
    );
    expect(d.inShadow).toBe(true);
    expect(d.effectiveLevel).toBe('L1'); // 执行按低 L
    expect(d.shadowLevel).toBe('L4'); // agent 决策按高 L
  });

  it('AC5 降级立即: shadow_during 不比目标更严 (L4 during · L2a 目标) → 不 shadow · effectiveLevel=目标', () => {
    const d = resolveShadow(cfg({ shadow_during: 'L4' }), 'L2a', entry());
    expect(d.inShadow).toBe(false);
    expect(d.effectiveLevel).toBe('L2a');
  });

  it('shadow_during == 目标 → 不 shadow (非升级)', () => {
    const d = resolveShadow(cfg({ shadow_during: 'L3' }), 'L3', entry());
    expect(d.inShadow).toBe(false);
    expect(d.effectiveLevel).toBe('L3');
  });

  it('未配 / 未 enabled → 不 shadow · effectiveLevel=目标', () => {
    expect(resolveShadow(undefined, 'L3', entry()).inShadow).toBe(false);
    expect(
      resolveShadow(cfg({ enabled: false }), 'L3', entry()).effectiveLevel,
    ).toBe('L3');
  });

  it('过期 (days_remaining=0) → 不再 shadow · effectiveLevel=目标 (转正后按目标执行)', () => {
    const d = resolveShadow(cfg(), 'L3', entry({ days_remaining: 0 }));
    expect(d.inShadow).toBe(false);
    expect(d.effectiveLevel).toBe('L3');
  });

  it('过期 + pass-rate 达标 → promote=true', () => {
    const d = resolveShadow(
      cfg({ pass_threshold: 0.9 }),
      'L3',
      entry({ days_remaining: 0, decided: 10, approved: 10 }),
    );
    expect(d.promote).toBe(true);
  });
});

describe('record / promote (feat-056/#4)', () => {
  it('initEntry 用 config.days + 0/0 计数', () => {
    const e = initEntry(cfg({ days: 14 }), day(1));
    expect(e.days_remaining).toBe(14);
    expect(e.decided).toBe(0);
    expect(e.approved).toBe(0);
    expect(e.last_decay).toBe(day(1).toISOString());
  });

  it('recordDecision / recordApproval 累加', () => {
    let e = entry();
    e = recordDecision(e);
    e = recordDecision(e);
    e = recordApproval(e);
    expect(e.decided).toBe(2);
    expect(e.approved).toBe(1);
    expect(passRate(e)).toBe(0.5);
  });

  it('promoteEntry 标 promoted + days_remaining=0 (alert · resolveShadow 之后不再 shadow)', () => {
    const e = promoteEntry(entry({ days_remaining: 0, decided: 10, approved: 10 }), 'p1');
    expect(e.promoted).toBe(true);
    expect(e.days_remaining).toBe(0);
    expect(resolveShadow(cfg(), 'L3', e).inShadow).toBe(false);
  });
});

describe('文件 I/O 跨重启保持 (feat-056/#4 · AC2)', () => {
  const tmpPath = join(tmpdir(), `shadow-state-test-${process.pid}.json`);
  afterEach(() => {
    if (existsSync(tmpPath)) rmSync(tmpPath);
  });

  it('save → load round-trip + load 时 wall-clock 递减 (跨重启)', () => {
    // 写于 day(1) · 5 天剩余
    saveShadowState(
      { p1: entry({ days_remaining: 5, last_decay: day(1).toISOString() }) },
      tmpPath,
    );
    // 模拟重启后 day(4) load → 过 3 天 → 剩 2
    const loaded = loadShadowState(tmpPath, day(4));
    expect(loaded.p1.days_remaining).toBe(2);
    expect(loaded.p1.decided).toBe(0);
  });

  it('缺失文件 → 空 state (fail-safe)', () => {
    expect(loadShadowState(join(tmpdir(), 'nonexistent-xyz.json'))).toEqual({});
  });

  it('坏 JSON → 空 state (fail-safe · 不 crash)', () => {
    writeFileSync(tmpPath, '{not json', 'utf8');
    expect(loadShadowState(tmpPath)).toEqual({});
  });
});
