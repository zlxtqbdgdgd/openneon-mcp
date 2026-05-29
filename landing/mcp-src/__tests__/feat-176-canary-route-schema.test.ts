/**
 * feat-176-canary-route-schema.test.ts · feat-042 follow-up (#176)
 *
 * 覆盖:
 *   1. canary-evidence-store · record / consume / TTL / 跨 tenant 隔离
 *   2. policy.yaml canary.* schema · validate + resolvePolicy 透传
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  recordCanaryVerdict,
  consumeCanaryVerdict,
  __resetCanaryEvidenceStoreForTest,
  __canaryEvidenceStoreSizeForTest,
} from '../server-enrich/canary-evidence-store';
import {
  validate,
  resolvePolicy,
  __setPolicyForTest,
} from '../policy/loader';

describe('feat-042 follow-up · canary-evidence-store (#176)', () => {
  beforeEach(() => {
    __resetCanaryEvidenceStoreForTest();
  });

  it('record + consume 来回 · 命中后清空', () => {
    recordCanaryVerdict('proj-1', 'ALTER TABLE big_table ADD COLUMN c INT', {
      verdict: 'high_risk_review',
      risk_class: 'ALTER_TABLE_HEAVY',
      branch_id: 'br_canary_abc',
      duration_ms: 12345,
      rows_affected: 0,
      locks_acquired: 1,
      risk_reasons: ['table size > 1M rows'],
    });
    expect(__canaryEvidenceStoreSizeForTest()).toBe(1);

    const got = consumeCanaryVerdict(
      'proj-1',
      'ALTER TABLE big_table ADD COLUMN c INT',
    );
    expect(got).toBeDefined();
    expect(got!.verdict).toBe('high_risk_review');
    expect(got!.branch_id).toBe('br_canary_abc');
    expect(got!.risk_reasons).toEqual(['table size > 1M rows']);
    // 取完即清
    expect(__canaryEvidenceStoreSizeForTest()).toBe(0);
  });

  it('consume 未命中 → undefined · store 不变', () => {
    expect(consumeCanaryVerdict('proj-x', 'SELECT 1')).toBeUndefined();
    expect(__canaryEvidenceStoreSizeForTest()).toBe(0);
  });

  it('跨 tenant 隔离 · 不同 projectId 不互相命中', () => {
    recordCanaryVerdict('proj-a', 'DROP TABLE t', {
      verdict: 'high_risk_review',
    });
    expect(consumeCanaryVerdict('proj-b', 'DROP TABLE t')).toBeUndefined();
    expect(__canaryEvidenceStoreSizeForTest()).toBe(1);
    // proj-a 自己能取
    expect(consumeCanaryVerdict('proj-a', 'DROP TABLE t')!.verdict).toBe(
      'high_risk_review',
    );
  });

  it('SQL 文本不一致不命中 (sha256 key)', () => {
    recordCanaryVerdict('proj-1', 'ALTER TABLE t ADD c1 INT', {
      verdict: 'low_risk_proceed',
    });
    expect(
      consumeCanaryVerdict('proj-1', 'ALTER TABLE t ADD c2 INT'),
    ).toBeUndefined();
  });

  it('空 projectId / sql · record 拒 · consume 返 undefined (fail-safe)', () => {
    recordCanaryVerdict('', 'SELECT 1', { verdict: 'low_risk_proceed' });
    recordCanaryVerdict('proj-1', '', { verdict: 'low_risk_proceed' });
    expect(__canaryEvidenceStoreSizeForTest()).toBe(0);
    expect(consumeCanaryVerdict('', 'SELECT 1')).toBeUndefined();
    expect(consumeCanaryVerdict('proj-1', '')).toBeUndefined();
  });
});

describe('feat-042 follow-up · policy.yaml canary.* schema (#176)', () => {
  it('合法 config 通过 + resolvePolicy 透传 canary', () => {
    __setPolicyForTest(
      validate({
        projects: {
          p1: {
            autonomy_level: 'L3',
            canary: {
              table_row_threshold: 500000,
              auto_purge: true,
              retention_days: 14,
            },
          },
        },
        defaults: { autonomy_level: 'L1' },
      }),
    );
    const r = resolvePolicy('p1');
    expect(r.canary?.table_row_threshold).toBe(500000);
    expect(r.canary?.auto_purge).toBe(true);
    expect(r.canary?.retention_days).toBe(14);
  });

  it('缺 canary 段 → undefined (走 env GUC 默认值)', () => {
    __setPolicyForTest(
      validate({
        projects: { p1: { autonomy_level: 'L3' } },
        defaults: { autonomy_level: 'L1' },
      }),
    );
    expect(resolvePolicy('p1').canary).toBeUndefined();
  });

  it('table_row_threshold 越上界 1e9 → clamp', () => {
    const c = validate({
      projects: {
        p1: {
          autonomy_level: 'L3',
          canary: { table_row_threshold: 9_999_999_999 },
        },
      },
      defaults: { autonomy_level: 'L1' },
    });
    expect(c.projects.p1.canary?.table_row_threshold).toBe(1_000_000_000);
  });

  it('retention_days 越上界 90 → clamp', () => {
    const c = validate({
      projects: {
        p1: {
          autonomy_level: 'L3',
          canary: { retention_days: 365 },
        },
      },
      defaults: { autonomy_level: 'L1' },
    });
    expect(c.projects.p1.canary?.retention_days).toBe(90);
  });

  it('非整数 / 负数 / 非 boolean → throw (fail-safe)', () => {
    expect(() =>
      validate({
        projects: {
          p1: {
            autonomy_level: 'L3',
            canary: { table_row_threshold: -1 },
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
            canary: { auto_purge: 'yes' as unknown as boolean },
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
            canary: { retention_days: 1.5 },
          },
        },
        defaults: { autonomy_level: 'L1' },
      }),
    ).toThrow();
  });

  it('canary 不是 object → throw', () => {
    expect(() =>
      validate({
        projects: {
          p1: {
            autonomy_level: 'L3',
            canary: 'not an object' as unknown as Record<string, unknown>,
          },
        },
        defaults: { autonomy_level: 'L1' },
      }),
    ).toThrow();
  });
});
