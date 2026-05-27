/**
 * feat-024-obfuscator.test.ts · feat-024/#2 · obfuscator 脱敏单测 (§7 用例 1-9)。
 *
 * 覆盖: numeric / string / UUID / timestamp 替换 · keyword/table/column/operator 保留 ·
 * CTE 内替换 · strict vs moderate enum 区别 · sensitive_redact_count。
 *
 * 铁律: 本仓不跑测试 · 本文件写出即可。
 */
import { describe, it, expect } from 'vitest';
import {
  obfuscateText,
  obfuscate,
} from '../server-enrich/samples-store/obfuscator';
import { makeRawSample } from '../server-enrich/samples-store/raw-sample';

describe('feat-024/#2 · obfuscator strict mode (§7 用例 1-7,9)', () => {
  it('用例1 · numeric → $N', () => {
    expect(obfuscateText('SELECT * FROM u WHERE id=12345', 'strict').text).toBe(
      'SELECT * FROM u WHERE id=$1',
    );
  });

  it('用例2 · string → $N', () => {
    expect(obfuscateText("WHERE name='alice'", 'strict').text).toBe('WHERE name=$1');
  });

  it('用例3 · UUID (字符串字面量) → $N', () => {
    expect(
      obfuscateText("WHERE id='550e8400-e29b-41d4-a716-446655440000'", 'strict').text,
    ).toBe('WHERE id=$1');
  });

  it('用例4 · timestamp (字符串字面量) → $N', () => {
    expect(
      obfuscateText("WHERE created_at='2026-05-27 08:00:00'", 'strict').text,
    ).toBe('WHERE created_at=$1');
  });

  it('用例5 · 保留 keyword + table name', () => {
    expect(obfuscateText('SELECT * FROM users', 'strict').text).toBe(
      'SELECT * FROM users',
    );
  });

  it('用例6 · 保留 operators · numeric 替换', () => {
    expect(
      obfuscateText('WHERE x > 100 AND y < 200', 'strict').text,
    ).toBe('WHERE x > $1 AND y < $2');
  });

  it('用例7 · strict 全替换 enum string', () => {
    expect(obfuscateText("WHERE status='open'", 'strict').text).toBe(
      'WHERE status=$1',
    );
  });

  it('用例9 · CTE 内字面量都替换', () => {
    const sql =
      "WITH t AS (SELECT * FROM o WHERE amount > 500 AND tag='vip') SELECT * FROM t WHERE id=7";
    const r = obfuscateText(sql, 'strict');
    expect(r.text).toBe(
      'WITH t AS (SELECT * FROM o WHERE amount > $1 AND tag=$2) SELECT * FROM t WHERE id=$3',
    );
    expect(r.redactCount).toBe(3);
  });

  it('附 · 不把 identifier 内数字误当字面量 (col1 / md5)', () => {
    expect(obfuscateText('SELECT col1, md5(x) FROM t', 'strict').text).toBe(
      'SELECT col1, md5(x) FROM t',
    );
  });

  it('附 · 双引号 quoted identifier 保留 · 已有 $1 占位符不动', () => {
    expect(
      obfuscateText(`SELECT "weird col" FROM t WHERE a=$1 AND b='x'`, 'strict').text,
    ).toBe(`SELECT "weird col" FROM t WHERE a=$1 AND b=$2`);
  });
});

describe('feat-024/#2 · obfuscator moderate mode (§7 用例 8)', () => {
  it('用例8 · moderate 保留 enum-like 短串', () => {
    expect(obfuscateText("WHERE status='open'", 'moderate').text).toBe(
      "WHERE status='open'",
    );
  });

  it('用例8b · moderate 保留 numeric', () => {
    expect(obfuscateText('WHERE x > 100', 'moderate').text).toBe('WHERE x > 100');
  });

  it('用例8c · moderate 仍替换 email / 长串 (PII 风险)', () => {
    expect(obfuscateText("WHERE email='alice@acme.com'", 'moderate').text).toBe(
      'WHERE email=$1',
    );
  });
});

describe('feat-024/#2 · obfuscate(raw) → QuerySample', () => {
  it('用例17 · sensitive_redact_count = 字面量数 · brand=obfuscated · 0 raw', () => {
    const raw = makeRawSample({
      duration_ms: 2340,
      raw_plan: '{}',
      raw_query: "SELECT * FROM orders WHERE id=42 AND status='cancelled'",
      raw_params: [42, 'cancelled'],
      captured_at: 1_700_000_000_000,
    });
    const sample = obfuscate(raw, 'proj-1', 'strict');
    expect(sample.__brand).toBe('obfuscated');
    expect(sample.query_text_obfuscated).toBe(
      'SELECT * FROM orders WHERE id=$1 AND status=$2',
    );
    expect(sample.sensitive_redact_count).toBe(2);
    expect(sample.params_obfuscated).toEqual(['$1', '$2']);
    expect(sample.duration_ms).toBe(2340);
    expect(sample.projectId).toBe('proj-1');
    // 不含任何 raw 字符串值 (numeric 已变 $N · 字符串字面量已脱敏)
    expect(sample.query_text_obfuscated).not.toContain('cancelled');
    expect(sample.query_text_obfuscated).not.toMatch(/=42\b/);
  });
});
