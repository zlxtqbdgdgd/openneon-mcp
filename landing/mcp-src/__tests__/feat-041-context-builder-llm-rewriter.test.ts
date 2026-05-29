/**
 * feat-041 #2 sub · context-builder + llm-rewriter · openneon-mcp#185.
 *
 * 覆盖 sub-issue 验收门:
 *   - context size guard: simple query (< 100 char OR 不涉表) skip EXPLAIN (path='sql_only_simple')
 *   - 含表查询 (≥ 100 char + FROM/JOIN/...) 调注入 explainRunner 拉 EXPLAIN (path='with_explain')
 *   - feat-024 T11 obfuscator 强制脱敏 EXPLAIN 文本 (raw 字面量绝不进 LLM context)
 *   - level=sql_only / with_explain 显式覆盖 size guard
 *   - EXPLAIN fetch 失败 (null/空) → 降级 sql_only_simple (不抛)
 *   - 4 类 risk 漏列 → self-validation 拒 + 单次 retry · retry 补齐 → 成功
 *   - retry 仍缺 → fallback_reason='self_validation_failed'
 *   - confidence 越界 / 空字段 → 拒 + retry
 *   - LLM client error → fallback_reason='llm_timeout'
 *   - input token 超 5000 cap → 不裸调 · fallback
 *   - 复用 feat-045 llm-client seam (setLlmClient/resetLlmClient mock · 不真打 Anthropic)
 *
 * Out of scope (留 #186): state-aware cache TTL · 9 case fixture · 跨 model 100 incident 跑批.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setLlmClient,
  resetLlmClient,
  type LlmClient,
  type LlmCallResult,
} from '../server-enrich/rca/llm-client';
import {
  buildRewriteContext,
  needsExplain,
  type ExplainContextRunner,
} from '../server-enrich/sql-rewrite/context-builder';
import {
  rewriteWithLlm,
  parseAndValidate,
  buildRewriteUserPayload,
  REQUIRED_RISK_CATEGORIES,
  REWRITE_MAX_INPUT_TOKENS,
  type RewriteOutput,
} from '../server-enrich/sql-rewrite/llm-rewriter';
import type { RewriteContext } from '../server-enrich/sql-rewrite/context-builder';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const ENDPOINT_ID = 'ep-test-001';

// simple query · < 100 char (after trim) → size guard skips EXPLAIN.
const SQL_SIMPLE = 'SELECT 1';

// query with no table op (no FROM/JOIN/UPDATE/DELETE/INSERT) · long but skips EXPLAIN.
const SQL_NO_TABLE = `SELECT ${'a + '.repeat(40)}1`; // > 100 char · still no FROM

// complex table query · ≥ 100 char + FROM → size guard pulls EXPLAIN.
const SQL_COMPLEX =
  "SELECT u.id, u.name, o.total FROM users u JOIN orders o ON o.user_id = u.id WHERE u.created_at > '2020-01-01' AND o.status = 'paid' ORDER BY o.total DESC";

// raw EXPLAIN text carrying a literal that MUST be obfuscated before reaching the LLM.
const RAW_EXPLAIN =
  "Seq Scan on users (cost=0.00..431.00 rows=1 width=64) Filter: (email = 'leak@example.com')";

function runnerReturning(text: string | null): ExplainContextRunner {
  return async () => text;
}

function validOutput(overrides: Partial<RewriteOutput> = {}): RewriteOutput {
  return {
    rewritten_sql: 'SELECT u.id, u.name, o.total FROM users u JOIN orders o ON o.user_id = u.id',
    rationale: 'Drops ORDER BY DESC scan; relies on existing index on orders.total.',
    expected_improvement: 'index scan replaces seq scan · ~60% cost reduction',
    risks: REQUIRED_RISK_CATEGORIES.map((category) => ({
      category,
      description: `N/A · this rewrite does not affect ${category}`,
    })),
    confidence: 0.85,
    ...overrides,
  };
}

function jsonClient(payloads: string[]): LlmClient {
  // Returns each payload in sequence (one per .call) so we can model retry.
  let i = 0;
  return {
    call: async (): Promise<LlmCallResult> => {
      const text = payloads[Math.min(i, payloads.length - 1)];
      i += 1;
      return { text, inputTokens: 1200, outputTokens: 300, model: 'claude-opus-4-7' };
    },
  };
}

// -----------------------------------------------------------------------------
// context-builder · size guard
// -----------------------------------------------------------------------------

describe('context-builder · size guard (needsExplain)', () => {
  it('auto: SQL < 100 char → skip EXPLAIN', () => {
    expect(needsExplain(SQL_SIMPLE, 'auto')).toBe(false);
  });

  it('auto: ≥ 100 char but no FROM/JOIN/UPDATE/DELETE/INSERT → skip EXPLAIN', () => {
    expect(SQL_NO_TABLE.length).toBeGreaterThanOrEqual(100);
    expect(needsExplain(SQL_NO_TABLE, 'auto')).toBe(false);
  });

  it('auto: ≥ 100 char + FROM/JOIN → pull EXPLAIN', () => {
    expect(SQL_COMPLEX.length).toBeGreaterThanOrEqual(100);
    expect(needsExplain(SQL_COMPLEX, 'auto')).toBe(true);
  });

  it('sql_only: always skip EXPLAIN regardless of complexity', () => {
    expect(needsExplain(SQL_COMPLEX, 'sql_only')).toBe(false);
  });

  it('with_explain: always pull EXPLAIN even for trivial SQL', () => {
    expect(needsExplain(SQL_SIMPLE, 'with_explain')).toBe(true);
  });

  it('detects DML table ops (UPDATE/DELETE/INSERT)', () => {
    const upd =
      "UPDATE accounts SET balance = balance - 100 WHERE id = 42 AND status = 'active' AND region = 'us-east-1'";
    expect(upd.length).toBeGreaterThanOrEqual(100);
    expect(needsExplain(upd, 'auto')).toBe(true);
  });
});

describe('context-builder · buildRewriteContext', () => {
  it('simple query → path=sql_only_simple · explain=null · runner NOT called', async () => {
    let runnerCalled = false;
    const ctx = await buildRewriteContext(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID, level: 'auto' },
      {
        explainRunner: async () => {
          runnerCalled = true;
          return RAW_EXPLAIN;
        },
      },
    );
    expect(ctx.path).toBe('sql_only_simple');
    expect(ctx.explain).toBeNull();
    expect(runnerCalled).toBe(false);
  });

  it('complex query → path=with_explain · runner called · EXPLAIN obfuscated', async () => {
    const ctx = await buildRewriteContext(
      { sql: SQL_COMPLEX, endpoint_id: ENDPOINT_ID, level: 'auto' },
      { explainRunner: runnerReturning(RAW_EXPLAIN) },
    );
    expect(ctx.path).toBe('with_explain');
    expect(ctx.explain).not.toBeNull();
    // feat-024 T11 obfuscator MUST have scrubbed the raw literal.
    expect(ctx.explain).not.toContain('leak@example.com');
    // structural keywords preserved (identifier/keyword non-PII).
    expect(ctx.explain).toContain('Seq Scan');
    expect(ctx.explain).toContain('users');
  });

  it('EXPLAIN fetch returns null → degrade to sql_only_simple (no throw)', async () => {
    const ctx = await buildRewriteContext(
      { sql: SQL_COMPLEX, endpoint_id: ENDPOINT_ID, level: 'auto' },
      { explainRunner: runnerReturning(null) },
    );
    expect(ctx.path).toBe('sql_only_simple');
    expect(ctx.explain).toBeNull();
  });

  it('EXPLAIN fetch returns empty string → degrade to sql_only_simple', async () => {
    const ctx = await buildRewriteContext(
      { sql: SQL_COMPLEX, endpoint_id: ENDPOINT_ID, level: 'auto' },
      { explainRunner: runnerReturning('   ') },
    );
    expect(ctx.path).toBe('sql_only_simple');
    expect(ctx.explain).toBeNull();
  });

  it('level=with_explain forces EXPLAIN even for trivial SQL', async () => {
    const ctx = await buildRewriteContext(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID, level: 'with_explain' },
      { explainRunner: runnerReturning(RAW_EXPLAIN) },
    );
    expect(ctx.path).toBe('with_explain');
    expect(ctx.explain).not.toBeNull();
  });

  it('level=sql_only forces skip even for complex SQL', async () => {
    let runnerCalled = false;
    const ctx = await buildRewriteContext(
      { sql: SQL_COMPLEX, endpoint_id: ENDPOINT_ID, level: 'sql_only' },
      {
        explainRunner: async () => {
          runnerCalled = true;
          return RAW_EXPLAIN;
        },
      },
    );
    expect(ctx.path).toBe('sql_only_simple');
    expect(runnerCalled).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// llm-rewriter · self-validation
// -----------------------------------------------------------------------------

describe('llm-rewriter · parseAndValidate (self-validation §3.5)', () => {
  it('accepts a fully-valid output with all 4 risk categories', () => {
    const text = JSON.stringify({ best: validOutput(), backups: [] });
    const r = parseAndValidate(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.best.risks).toHaveLength(4);
      expect(r.value.backups).toHaveLength(0);
    }
  });

  it('rejects when a risk category is missing', () => {
    const risks = REQUIRED_RISK_CATEGORIES.slice(0, 3).map((category) => ({
      category,
      description: 'x',
    }));
    const text = JSON.stringify({ best: validOutput({ risks }), backups: [] });
    const r = parseAndValidate(text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing.some((m) => m.includes('transaction_isolation'))).toBe(true);
    }
  });

  it('rejects confidence out of [0,1]', () => {
    const text = JSON.stringify({
      best: validOutput({ confidence: 1.5 }),
      backups: [],
    });
    const r = parseAndValidate(text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing.some((m) => m.includes('confidence'))).toBe(true);
    }
  });

  it('rejects empty rewritten_sql / rationale / expected_improvement', () => {
    const text = JSON.stringify({
      best: validOutput({ rewritten_sql: '', rationale: '   ' }),
      backups: [],
    });
    const r = parseAndValidate(text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toContain('best.rewritten_sql');
      expect(r.missing).toContain('best.rationale');
    }
  });

  it('rejects unparseable JSON', () => {
    const r = parseAndValidate('not json at all');
    expect(r.ok).toBe(false);
  });

  it('tolerates ```json fenced output (RULE 1 says no fence · we still parse it)', () => {
    const text = '```json\n' + JSON.stringify({ best: validOutput(), backups: [] }) + '\n```';
    const r = parseAndValidate(text);
    expect(r.ok).toBe(true);
  });

  it('keeps only valid backups (≤ 2) · drops malformed backups without failing best', () => {
    const text = JSON.stringify({
      best: validOutput(),
      backups: [validOutput({ confidence: 0.5 }), { junk: true }, validOutput()],
    });
    const r = parseAndValidate(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // slice(0,2) then drop the malformed one → 1 valid backup survives.
      expect(r.value.backups).toHaveLength(1);
    }
  });
});

// -----------------------------------------------------------------------------
// llm-rewriter · rewriteWithLlm (LLM call + retry · feat-045 seam mock)
// -----------------------------------------------------------------------------

describe('llm-rewriter · rewriteWithLlm', () => {
  beforeEach(() => {
    resetLlmClient();
  });

  const simpleContext: RewriteContext = {
    sql: SQL_COMPLEX,
    explain: 'Seq Scan on users',
    path: 'with_explain',
  };

  it('valid first response → success · no fallback · best returned', async () => {
    setLlmClient(jsonClient([JSON.stringify({ best: validOutput(), backups: [] })]));
    const res = await rewriteWithLlm({ context: simpleContext, model: 'claude-opus-4-7' });
    expect(res.fallback_reason).toBeUndefined();
    expect(res.best.risks).toHaveLength(4);
    expect(res.input_tokens).toBeGreaterThan(0);
    expect(res.output_tokens).toBeGreaterThan(0);
  });

  it('4-class risk missing first → retry → second response complete → success', async () => {
    let calls = 0;
    const incomplete = JSON.stringify({
      best: validOutput({
        risks: REQUIRED_RISK_CATEGORIES.slice(0, 2).map((category) => ({
          category,
          description: 'x',
        })),
      }),
      backups: [],
    });
    const complete = JSON.stringify({ best: validOutput(), backups: [] });
    setLlmClient({
      call: async () => {
        calls += 1;
        return {
          text: calls === 1 ? incomplete : complete,
          inputTokens: 1000,
          outputTokens: 250,
          model: 'claude-opus-4-7',
        };
      },
    });

    const res = await rewriteWithLlm({ context: simpleContext, model: 'claude-opus-4-7' });
    expect(calls).toBe(2); // first rejected → single retry
    expect(res.fallback_reason).toBeUndefined();
    expect(res.best.risks).toHaveLength(4);
  });

  it('retry STILL missing risk → fallback_reason=self_validation_failed', async () => {
    const incomplete = JSON.stringify({
      best: validOutput({
        risks: REQUIRED_RISK_CATEGORIES.slice(0, 1).map((category) => ({
          category,
          description: 'x',
        })),
      }),
      backups: [],
    });
    let calls = 0;
    setLlmClient({
      call: async () => {
        calls += 1;
        return {
          text: incomplete,
          inputTokens: 1000,
          outputTokens: 200,
          model: 'claude-opus-4-7',
        };
      },
    });

    const res = await rewriteWithLlm({ context: simpleContext, model: 'claude-opus-4-7' });
    expect(calls).toBe(2); // initial + single retry · no third attempt
    expect(res.fallback_reason).toBe('self_validation_failed');
    expect(res.best.rewritten_sql).toBe('');
  });

  it('LLM client error → fallback_reason=llm_timeout · no retry on transport error', async () => {
    let calls = 0;
    setLlmClient({
      call: async () => {
        calls += 1;
        return { error: { reason: 'rate_limited', detail: '429' } };
      },
    });
    const res = await rewriteWithLlm({ context: simpleContext, model: 'claude-opus-4-7' });
    expect(calls).toBe(1); // transport error short-circuits · validation retry not triggered
    expect(res.fallback_reason).toBe('llm_timeout');
  });

  it('not-configured client (default) → fallback_reason=llm_timeout', async () => {
    // resetLlmClient() in beforeEach leaves NOT_CONFIGURED_CLIENT active.
    const res = await rewriteWithLlm({ context: simpleContext, model: 'claude-sonnet-4-6' });
    expect(res.fallback_reason).toBe('llm_timeout');
  });

  it('input over token cap → fallback without calling LLM', async () => {
    let called = false;
    setLlmClient({
      call: async () => {
        called = true;
        return { text: '{}', inputTokens: 0, outputTokens: 0, model: 'claude-opus-4-7' };
      },
    });
    const hugeSql = 'SELECT x FROM t WHERE ' + 'a = 1 OR '.repeat(6000);
    const ctx: RewriteContext = { sql: hugeSql, explain: null, path: 'sql_only_simple' };
    // sanity: payload exceeds the cap
    expect(buildRewriteUserPayload(ctx).length / 4).toBeGreaterThan(REWRITE_MAX_INPUT_TOKENS);
    const res = await rewriteWithLlm({ context: ctx, model: 'claude-opus-4-7' });
    expect(called).toBe(false);
    expect(res.fallback_reason).toBe('self_validation_failed');
  });
});

// -----------------------------------------------------------------------------
// user payload · [DATA_MISSING:explain] placeholder (三原则 RULE 3)
// -----------------------------------------------------------------------------

describe('llm-rewriter · buildRewriteUserPayload', () => {
  it('emits [DATA_MISSING:explain] when EXPLAIN absent', () => {
    const ctx: RewriteContext = { sql: SQL_SIMPLE, explain: null, path: 'sql_only_simple' };
    const payload = buildRewriteUserPayload(ctx);
    expect(payload).toContain('[DATA_MISSING:explain]');
    expect(payload).toContain(SQL_SIMPLE);
  });

  it('inlines obfuscated EXPLAIN when present', () => {
    const ctx: RewriteContext = {
      sql: SQL_COMPLEX,
      explain: 'Seq Scan on users (cost=$1..$2)',
      path: 'with_explain',
    };
    const payload = buildRewriteUserPayload(ctx);
    expect(payload).not.toContain('[DATA_MISSING:explain]');
    expect(payload).toContain('Seq Scan on users');
  });
});
