/**
 * feat-041 #1 sub · handler + zod schema + plan mode 集成 · openneon-mcp#184.
 *
 * 5 case 覆盖 sub-issue 验收门:
 *   - zod schema 校验 (有效输入 + sql 超长拒 + trace_id 非 32 hex 拒)
 *   - 跨 tenant 拒 (feat-060 claim binding · cross_tenant_blocked + sql_rewrite_denied audit)
 *   - plan mode approve (allow → LLM call → sql_rewrite_invoked audit)
 *   - plan mode deny (deny → fallback_reason='dba_denied' + sql_rewrite_denied audit)
 *   - cache hit (重复同 input → cache_hit=true · 不调 LLM)
 *
 * Out of scope for #184 (留 #185/#186):
 *   - LLM 主路径真接通 (Anthropic SDK · #185)
 *   - 4 类 risk self-validation + retry (#185)
 *   - context-builder size guard (sql_only/with_explain 路径切换 · #185)
 *   - state-aware cache TTL (closed 永久 · ongoing 1h · feat-064 ttl-cache seam · #186)
 *   - 9 case fixture + 跨 model 100 incident 跑批 (#186)
 */

import { describe, it, expect } from 'vitest';
import {
  handleRewriteNeondbSql,
  type RewriteCache,
  type RewriteCacheKey,
  type RewriteSqlDeps,
  type RewriteSqlAuditEvent,
  type RewriteContextBuilder,
  type RewriteLlmRewriter,
  type RewriteRequestApproval,
  type RewriteResponse,
  estimateRewriteCostUsd,
} from '../tools/handlers/rewrite-sql';
import { rewriteNeondbSqlInputSchema } from '../tools/toolsSchema';

// Fresh in-memory cache per test to keep the module-level default cache from
// leaking writes across cases (the production cache is #186 ttl-cache + state-aware TTL).
function makeCache(): RewriteCache {
  const store = new Map<string, RewriteResponse>();
  const key = (k: RewriteCacheKey) =>
    `${k.endpoint_id}|${k.sqlHash}|${k.explainHash ?? ''}|${k.model}`;
  return {
    get: (k) => store.get(key(k)),
    set: (k, v) => {
      store.set(key(k), v);
    },
  };
}

// -----------------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------------

const SQL_SIMPLE = 'SELECT * FROM users WHERE id = 1';
const SQL_REWRITTEN = 'SELECT id, name FROM users WHERE id = 1';
const ENDPOINT_ID = 'ep-test-001';
const PROJECT_A = 'proj-A';
const PROJECT_B = 'proj-B';

function happyContextBuilder(): RewriteContextBuilder {
  return ({ sql }) => ({ sql, explain: null, path: 'sql_only_simple' });
}

function happyLlm(): RewriteLlmRewriter {
  return async ({ context, model }) => ({
    best: {
      rewritten_sql: SQL_REWRITTEN,
      rationale: 'Limited column projection avoids returning all columns.',
      expected_improvement: '50% IO reduction',
      risks: [
        { category: 'null_handling', description: 'N/A · projection only.' },
        { category: 'case_sensitivity', description: 'N/A · projection only.' },
        { category: 'index_dependency', description: 'Reuses primary key index on users.id.' },
        {
          category: 'transaction_isolation',
          description: 'N/A · single-row read · MVCC unchanged.',
        },
      ],
      confidence: 0.92,
    },
    backups: [],
    input_tokens: Math.ceil(context.sql.length / 4),
    output_tokens: Math.ceil(SQL_REWRITTEN.length / 4),
  });
}

function recordAudit(events: RewriteSqlAuditEvent[]): RewriteSqlDeps['emitAudit'] {
  return (e) => {
    events.push(e);
  };
}

// -----------------------------------------------------------------------------
// zod schema validation
// -----------------------------------------------------------------------------

describe('rewriteNeondbSqlInputSchema · zod 校验', () => {
  it('parses valid input (all optional fields supplied)', () => {
    const parsed = rewriteNeondbSqlInputSchema.parse({
      sql: SQL_SIMPLE,
      endpoint_id: ENDPOINT_ID,
      trace_id: 'a'.repeat(32),
      context_level: 'auto',
      model: 'claude-sonnet-4-6',
      cache: true,
      trace_state: 'closed',
    });
    expect(parsed.sql).toBe(SQL_SIMPLE);
    expect(parsed.trace_id).toBe('a'.repeat(32));
    expect(parsed.model).toBe('claude-sonnet-4-6');
  });

  it('parses minimal input (only sql + endpoint_id required)', () => {
    const parsed = rewriteNeondbSqlInputSchema.parse({
      sql: SQL_SIMPLE,
      endpoint_id: ENDPOINT_ID,
    });
    expect(parsed.sql).toBe(SQL_SIMPLE);
    expect(parsed.trace_id).toBeUndefined();
    expect(parsed.model).toBeUndefined();
  });

  it('rejects sql > 20000 chars (token cap guard)', () => {
    const tooLong = 'X'.repeat(20001);
    expect(() =>
      rewriteNeondbSqlInputSchema.parse({
        sql: tooLong,
        endpoint_id: ENDPOINT_ID,
      }),
    ).toThrow();
  });

  it('rejects sql == empty string', () => {
    expect(() =>
      rewriteNeondbSqlInputSchema.parse({ sql: '', endpoint_id: ENDPOINT_ID }),
    ).toThrow();
  });

  it('rejects trace_id that is not 32 hex chars', () => {
    expect(() =>
      rewriteNeondbSqlInputSchema.parse({
        sql: SQL_SIMPLE,
        endpoint_id: ENDPOINT_ID,
        trace_id: 'nothex',
      }),
    ).toThrow();
  });

  it('rejects invalid model enum value', () => {
    expect(() =>
      rewriteNeondbSqlInputSchema.parse({
        sql: SQL_SIMPLE,
        endpoint_id: ENDPOINT_ID,
        model: 'gpt-4', // intentional invalid enum · runtime parse rejects
      }),
    ).toThrow();
  });
});

// -----------------------------------------------------------------------------
// Cross-tenant guard (feat-060 claim binding)
// -----------------------------------------------------------------------------

describe('handleRewriteNeondbSql · 跨 tenant 拒 (feat-060)', () => {
  it('blocks when endpoint project ≠ current project · emits sql_rewrite_denied audit · no LLM call', async () => {
    const audits: RewriteSqlAuditEvent[] = [];
    let llmCalled = false;
    const deps: RewriteSqlDeps = {
      currentProjectId: PROJECT_A,
      resolveEndpointProject: () => PROJECT_B,
      llmRewriter: async () => {
        llmCalled = true;
        throw new Error('LLM should not be called on cross-tenant block');
      },
      emitAudit: recordAudit(audits),
      cache: makeCache(),
      skipPlanMode: true,
    };

    const res = await handleRewriteNeondbSql(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID },
      deps,
    );

    expect(res.best).toBeNull();
    expect(res.fallback_reason).toBe('cross_tenant_blocked');
    expect(res.cache_hit).toBe(false);
    expect(llmCalled).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0].event_type).toBe('sql_rewrite_denied');
    expect(audits[0].outcome).toBe('deny');
    expect(audits[0].fallback_reason).toBe('cross_tenant_blocked');
    expect(audits[0].project_id).toBe(PROJECT_A);
    expect(audits[0].endpoint_id).toBe(ENDPOINT_ID);
  });

  it('allows when endpoint project == current project', async () => {
    const audits: RewriteSqlAuditEvent[] = [];
    const deps: RewriteSqlDeps = {
      currentProjectId: PROJECT_A,
      resolveEndpointProject: () => PROJECT_A,
      contextBuilder: happyContextBuilder(),
      llmRewriter: happyLlm(),
      emitAudit: recordAudit(audits),
      cache: makeCache(),
      skipPlanMode: true,
    };

    const res = await handleRewriteNeondbSql(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID, cache: false },
      deps,
    );

    expect(res.fallback_reason).toBeUndefined();
    expect(res.best?.rewritten_sql).toBe(SQL_REWRITTEN);
    expect(audits).toHaveLength(1);
    expect(audits[0].event_type).toBe('sql_rewrite_invoked');
    expect(audits[0].outcome).toBe('allow');
  });
});

// -----------------------------------------------------------------------------
// Plan mode (feat-027 elicitation) approve / deny
// -----------------------------------------------------------------------------

describe('handleRewriteNeondbSql · plan mode 集成 (feat-027)', () => {
  it('approve → LLM called → sql_rewrite_invoked audit', async () => {
    const audits: RewriteSqlAuditEvent[] = [];
    const approve: RewriteRequestApproval = () => 'allow';
    const deps: RewriteSqlDeps = {
      currentProjectId: PROJECT_A,
      contextBuilder: happyContextBuilder(),
      llmRewriter: happyLlm(),
      requestApproval: approve,
      emitAudit: recordAudit(audits),
      cache: makeCache(),
    };

    const res = await handleRewriteNeondbSql(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID, cache: false },
      deps,
    );

    expect(res.fallback_reason).toBeUndefined();
    expect(res.best?.rewritten_sql).toBe(SQL_REWRITTEN);
    expect(res.tokens_used).toBeGreaterThan(0);
    expect(audits).toHaveLength(1);
    expect(audits[0].event_type).toBe('sql_rewrite_invoked');
    expect(audits[0].outcome).toBe('allow');
    expect(audits[0].fallback_reason).toBeNull();
  });

  it('deny → fallback_reason=dba_denied · no LLM call · sql_rewrite_denied audit', async () => {
    const audits: RewriteSqlAuditEvent[] = [];
    let llmCalled = false;
    const deny: RewriteRequestApproval = () => 'deny';
    const deps: RewriteSqlDeps = {
      currentProjectId: PROJECT_A,
      contextBuilder: happyContextBuilder(),
      llmRewriter: async () => {
        llmCalled = true;
        throw new Error('LLM should not be called on plan mode deny');
      },
      requestApproval: deny,
      emitAudit: recordAudit(audits),
      cache: makeCache(),
    };

    const res = await handleRewriteNeondbSql(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID, cache: false },
      deps,
    );

    expect(res.best).toBeNull();
    expect(res.fallback_reason).toBe('dba_denied');
    expect(llmCalled).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0].event_type).toBe('sql_rewrite_denied');
    expect(audits[0].outcome).toBe('deny');
    expect(audits[0].fallback_reason).toBe('dba_denied');
  });

  it('unavailable → fail-closed deny (default DEFAULT_REWRITE_REQUEST_APPROVAL)', async () => {
    const audits: RewriteSqlAuditEvent[] = [];
    const deps: RewriteSqlDeps = {
      currentProjectId: PROJECT_A,
      contextBuilder: happyContextBuilder(),
      llmRewriter: happyLlm(),
      // no requestApproval · falls back to DEFAULT_REWRITE_REQUEST_APPROVAL (unavailable → deny)
      emitAudit: recordAudit(audits),
      cache: makeCache(),
    };

    const res = await handleRewriteNeondbSql(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID, cache: false },
      deps,
    );

    expect(res.fallback_reason).toBe('dba_denied');
    expect(audits[0].event_type).toBe('sql_rewrite_denied');
  });

  it('skipPlanMode=true → bypasses elicitation entirely', async () => {
    const audits: RewriteSqlAuditEvent[] = [];
    const deps: RewriteSqlDeps = {
      currentProjectId: PROJECT_A,
      contextBuilder: happyContextBuilder(),
      llmRewriter: happyLlm(),
      // requestApproval would return unavailable but skipPlanMode bypasses it.
      emitAudit: recordAudit(audits),
      cache: makeCache(),
      skipPlanMode: true,
    };

    const res = await handleRewriteNeondbSql(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID, cache: false },
      deps,
    );

    expect(res.fallback_reason).toBeUndefined();
    expect(res.best?.rewritten_sql).toBe(SQL_REWRITTEN);
    expect(audits[0].event_type).toBe('sql_rewrite_invoked');
  });
});

// -----------------------------------------------------------------------------
// Cache lookup (placeholder · #186 will swap in feat-064 ttl-cache)
// -----------------------------------------------------------------------------

describe('handleRewriteNeondbSql · cache hit', () => {
  it('repeats with cache=true → second call hits cache · LLM not re-invoked', async () => {
    const audits: RewriteSqlAuditEvent[] = [];
    let llmCalls = 0;
    const deps: RewriteSqlDeps = {
      currentProjectId: PROJECT_A,
      contextBuilder: happyContextBuilder(),
      llmRewriter: async (args) => {
        llmCalls += 1;
        const r = await happyLlm()(args);
        return r;
      },
      emitAudit: recordAudit(audits),
      cache: makeCache(),
      skipPlanMode: true,
    };

    const first = await handleRewriteNeondbSql(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID, cache: true },
      deps,
    );
    expect(first.cache_hit).toBe(false);
    expect(llmCalls).toBe(1);

    const second = await handleRewriteNeondbSql(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID, cache: true },
      deps,
    );
    expect(second.cache_hit).toBe(true);
    expect(second.best?.rewritten_sql).toBe(SQL_REWRITTEN);
    expect(llmCalls).toBe(1); // not re-invoked
    expect(audits).toHaveLength(2);
    expect(audits[1].cache_hit).toBe(true);
  });

  it('cache=false skips both lookup and write', async () => {
    let llmCalls = 0;
    const deps: RewriteSqlDeps = {
      currentProjectId: PROJECT_A,
      contextBuilder: happyContextBuilder(),
      llmRewriter: async (args) => {
        llmCalls += 1;
        return happyLlm()(args);
      },
      cache: makeCache(),
      skipPlanMode: true,
    };

    await handleRewriteNeondbSql(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID, cache: false },
      deps,
    );
    await handleRewriteNeondbSql(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID, cache: false },
      deps,
    );
    expect(llmCalls).toBe(2); // both miss because cache=false
  });
});

// -----------------------------------------------------------------------------
// LLM fallback paths · fallback_reason propagation
// -----------------------------------------------------------------------------

describe('handleRewriteNeondbSql · LLM fallback paths', () => {
  it('llm fallback_reason=self_validation_failed → best is null · cache not written', async () => {
    let llmCalls = 0;
    const deps: RewriteSqlDeps = {
      currentProjectId: PROJECT_A,
      contextBuilder: happyContextBuilder(),
      llmRewriter: async () => {
        llmCalls += 1;
        return {
          best: {
            rewritten_sql: '',
            rationale: '',
            expected_improvement: '',
            risks: [],
            confidence: 0,
          },
          backups: [],
          input_tokens: 100,
          output_tokens: 0,
          fallback_reason: 'self_validation_failed' as const,
        };
      },
      cache: makeCache(),
      skipPlanMode: true,
    };

    const first = await handleRewriteNeondbSql(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID, cache: true },
      deps,
    );
    expect(first.fallback_reason).toBe('self_validation_failed');
    expect(first.best).toBeNull();

    // Cache should NOT be written on fallback · second call re-invokes LLM.
    await handleRewriteNeondbSql(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID, cache: true },
      deps,
    );
    expect(llmCalls).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// Cost estimator (used by plan mode payload)
// -----------------------------------------------------------------------------

describe('estimateRewriteCostUsd', () => {
  it('matches Opus per-1M pricing (input 15 / output 75)', () => {
    // 1M input + 1M output Opus = $15 + $75 = $90
    expect(estimateRewriteCostUsd('claude-opus-4-7', 1_000_000, 1_000_000)).toBe(
      90,
    );
  });

  it('matches Haiku per-1M pricing (input 0.8 / output 4)', () => {
    expect(
      estimateRewriteCostUsd('claude-haiku-4-5', 1_000_000, 1_000_000),
    ).toBe(4.8);
  });

  it('rounds to 4 decimal places', () => {
    const v = estimateRewriteCostUsd('claude-sonnet-4-6', 1234, 567);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(Number(v.toFixed(4))).toBe(v);
  });
});

// -----------------------------------------------------------------------------
// Type sanity (RewriteResponse shape)
// -----------------------------------------------------------------------------

describe('RewriteResponse shape', () => {
  it('always includes path_used / cache_hit / tokens_used / audit_event_id', async () => {
    const deps: RewriteSqlDeps = {
      currentProjectId: PROJECT_A,
      contextBuilder: happyContextBuilder(),
      llmRewriter: happyLlm(),
      cache: makeCache(),
      skipPlanMode: true,
    };
    const res: RewriteResponse = await handleRewriteNeondbSql(
      { sql: SQL_SIMPLE, endpoint_id: ENDPOINT_ID, cache: false },
      deps,
    );
    expect(res.path_used).toBe('sql_only_simple');
    expect(typeof res.cache_hit).toBe('boolean');
    expect(typeof res.tokens_used).toBe('number');
    expect(typeof res.audit_event_id).toBe('string');
    expect(res.audit_event_id.length).toBeGreaterThan(0);
  });
});
