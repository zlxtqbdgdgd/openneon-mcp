/**
 * feat-027-elicitation-probe.test.ts · feat-027/#74 SPIKE · elicitation probe 单测
 *
 * 覆盖 classifyElicitation 对各 client capability 形态的判定 + classifyElicitFailure 失败归因。
 * 形态取自矩阵文档 (dev-notes/feat-027-elicitation-capability-matrix.md) 的实测/desk-research 声明。
 *
 * 注: 真实 client × 支持矩阵需人在真 client 跑 (见矩阵文档"需人工实测"标注) · 本单测验证的是
 * server 侧归一化/分类逻辑的正确性 (给定 capability 快照能否判对档位)。
 */
import { describe, it, expect } from 'vitest';
import {
  classifyElicitation,
  classifyElicitFailure,
  probeElicitation,
} from '../server/elicitation-probe';

describe('feat-027/#74 · classifyElicitation', () => {
  it('Claude Code 2.1.150 实测声明 {elicitation:{form:{}}, roots:{}} → form · canElicit', () => {
    const r = classifyElicitation({ elicitation: { form: {} }, roots: {} } as never);
    expect(r.support).toBe('form');
    expect(r.canElicit).toBe(true);
    expect(r.capabilitiesPresent).toBe(true);
  });

  it('空 elicitation:{} 按 SDK z.preprocess 归一化为 form (SPIKE §11.1 B)', () => {
    const r = classifyElicitation({ elicitation: {} } as never);
    expect(r.support).toBe('form');
    expect(r.canElicit).toBe(true);
  });

  it('声明 url 模式 → url', () => {
    const r = classifyElicitation({ elicitation: { url: {} } } as never);
    expect(r.support).toBe('url');
    expect(r.canElicit).toBe(true);
  });

  it('同时 form + url → form+url', () => {
    const r = classifyElicitation({ elicitation: { form: {}, url: {} } } as never);
    expect(r.support).toBe('form+url');
    expect(r.canElicit).toBe(true);
  });

  it('capability 快照存在但无 elicitation 字段 → none · fail-closed (确定不支持)', () => {
    const r = classifyElicitation({ roots: {}, sampling: {} } as never);
    expect(r.support).toBe('none');
    expect(r.canElicit).toBe(false);
    expect(r.capabilitiesPresent).toBe(true);
  });

  it('快照不可得 (undefined · 未 initialize / 传输丢 · issue #100) → unknown · fail-closed', () => {
    const r = classifyElicitation(undefined);
    expect(r.support).toBe('unknown');
    expect(r.canElicit).toBe(false);
    expect(r.capabilitiesPresent).toBe(false);
  });

  it('空对象 {} 快照 → unknown (等价快照不可得)', () => {
    const r = classifyElicitation({} as never);
    expect(r.support).toBe('unknown');
    expect(r.canElicit).toBe(false);
  });
});

describe('feat-027/#74 · probeElicitation (运行时非破坏性读)', () => {
  it('从 server.getClientCapabilities() 读并分类', () => {
    const fakeServer = {
      getClientCapabilities: () => ({ elicitation: { form: {} } }) as never,
    };
    const r = probeElicitation(fakeServer);
    expect(r.support).toBe('form');
    expect(r.canElicit).toBe(true);
  });

  it('getClientCapabilities 返 undefined → unknown · fail-closed', () => {
    const r = probeElicitation({ getClientCapabilities: () => undefined });
    expect(r.canElicit).toBe(false);
    expect(r.support).toBe('unknown');
  });

  it('无 getClientCapabilities 方法 → unknown (防御)', () => {
    const r = probeElicitation({});
    expect(r.canElicit).toBe(false);
  });
});

describe('feat-027/#74 · classifyElicitFailure (SPIKE AC2 失败归因)', () => {
  it('SDK form 模式 capability 缺失同步抛 → capability_missing', () => {
    expect(
      classifyElicitFailure(new Error('Client does not support form elicitation.')),
    ).toBe('capability_missing');
  });

  it('通用守卫 assertCapabilityForMethod → capability_missing', () => {
    expect(
      classifyElicitFailure(
        new Error('Client does not support elicitation (required for elicitation/create)'),
      ),
    ).toBe('capability_missing');
  });

  it('RequestOptions timeout → timeout', () => {
    expect(classifyElicitFailure(new Error('Request timed out'))).toBe('timeout');
  });

  it('连接断 → transport', () => {
    expect(classifyElicitFailure(new Error('connection closed (ECONNRESET)'))).toBe(
      'transport',
    );
  });

  it('未知异常 → other (仍 fail-closed)', () => {
    expect(classifyElicitFailure(new Error('boom'))).toBe('other');
    expect(classifyElicitFailure('not an error')).toBe('other');
  });
});
