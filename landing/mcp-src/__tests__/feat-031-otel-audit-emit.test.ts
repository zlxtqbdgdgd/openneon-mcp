/**
 * feat-031-otel-audit-emit.test.ts · feat-031 详设 §7 fixture (mcp 侧 8 用例 · §7 fixture 中 1-4/7-9)
 *
 * 用 InMemorySpanExporter 替换 BatchSpanProcessor 出口 · 不起真 HTTP server。
 * 不用 nock/msw (避免新装一个 dev dep) · 拦截 span 出口足以验证 attribute schema。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { trace, type TracerProvider } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { promises as fsPromises, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { emitAuditEvent, sha256Hex } from '../observability/audit-emit';

// OTel API global state 一次性: setGlobalTracerProvider 第二次返 false (no-op)
// → 用 suite-level 单 provider + 每 case reset exporter。
const memExporter = new InMemorySpanExporter();
const suiteProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(memExporter)],
});

const TMP_FALLBACK = path.join(
  os.tmpdir(),
  `feat-031-fallback-${process.pid}.jsonl`,
);

function getSpans(): ReadableSpan[] {
  return memExporter.getFinishedSpans();
}

beforeAll(() => {
  trace.setGlobalTracerProvider(suiteProvider);
});

beforeEach(() => {
  memExporter.reset();
  delete process.env.OTEL_SDK_DISABLED;
  delete process.env.OTEL_EXPORTER_LOCAL_FALLBACK_PATH;
  if (existsSync(TMP_FALLBACK)) unlinkSync(TMP_FALLBACK);
});

afterEach(() => {
  if (existsSync(TMP_FALLBACK)) unlinkSync(TMP_FALLBACK);
  delete process.env.OTEL_SDK_DISABLED;
  delete process.env.OTEL_EXPORTER_LOCAL_FALLBACK_PATH;
});

describe('feat-031 · emitAuditEvent · happy paths', () => {
  it('1. confirm_token_verified · span attributes 含 event_type / token_id / principal', () => {
    emitAuditEvent({
      event_type: 'confirm_token_verified',
      outcome: 'approved',
      op_class: 'CREATE_INDEX_CONCURRENTLY',
      principal: 'human:dba-id',
      token_id: 'confirm_abc123def4',
      severity: 'low',
      db_statement_sha256: sha256Hex('CREATE INDEX CONCURRENTLY ON t(x)'),
    });
    const spans = getSpans();
    expect(spans).toHaveLength(1);
    const s = spans[0];
    expect(s.name).toBe('audit.confirm_token_verified');
    expect(s.attributes['openneon.audit.event_type']).toBe(
      'confirm_token_verified',
    );
    expect(s.attributes['openneon.audit.outcome']).toBe('approved');
    expect(s.attributes['openneon.audit.token_id']).toBe('confirm_abc123def4');
    expect(s.attributes['openneon.audit.principal']).toBe('human:dba-id');
    expect(s.attributes['openneon.audit.op_class']).toBe(
      'CREATE_INDEX_CONCURRENTLY',
    );
    expect(s.attributes['db.system']).toBe('postgresql');
    expect(typeof s.attributes['db.statement.sha256']).toBe('string');
    expect(s.attributes['target']).toBe('openneon::audit');
  });

  it('2. g1_cross_project_deny · attributes 含 outcome=deny / severity=high / key_type / last_4', () => {
    emitAuditEvent({
      event_type: 'g1_cross_project_deny',
      outcome: 'deny',
      severity: 'high',
      key_type: 'project-scoped',
      last_4: 'a1b2',
      project_id: 'project-x',
      principal: 'agent:c0de',
    });
    const s = getSpans()[0];
    expect(s.attributes['openneon.audit.event_type']).toBe(
      'g1_cross_project_deny',
    );
    expect(s.attributes['openneon.audit.outcome']).toBe('deny');
    expect(s.attributes['openneon.audit.severity']).toBe('high');
    expect(s.attributes['openneon.audit.key_type']).toBe('project-scoped');
    expect(s.attributes['openneon.audit.last_4']).toBe('a1b2');
    expect(s.attributes['openneon.audit.project_id']).toBe('project-x');
  });

  it('3. claim_override · attempted=999/bound=42 · outcome=override', () => {
    emitAuditEvent({
      event_type: 'claim_override',
      outcome: 'override',
      principal: 'system:odd-mrc',
      agent_attempted_value: 999,
      bound_value: 42,
    });
    const s = getSpans()[0];
    expect(s.attributes['openneon.audit.event_type']).toBe('claim_override');
    expect(s.attributes['openneon.audit.outcome']).toBe('override');
    expect(s.attributes['openneon.audit.agent_attempted_value']).toBe(999);
    expect(s.attributes['openneon.audit.bound_value']).toBe(42);
  });

  it('4. plan_mode_approved · principal=human:dba-id / op_class', () => {
    emitAuditEvent({
      event_type: 'plan_mode_approved',
      outcome: 'approved',
      principal: 'human:dba-id',
      op_class: 'CREATE_INDEX_CONCURRENTLY',
      severity: 'medium',
    });
    const s = getSpans()[0];
    expect(s.attributes['openneon.audit.event_type']).toBe(
      'plan_mode_approved',
    );
    expect(s.attributes['openneon.audit.principal']).toBe('human:dba-id');
    expect(s.attributes['openneon.audit.op_class']).toBe(
      'CREATE_INDEX_CONCURRENTLY',
    );
  });
});

describe('feat-031 · PII redact assertion (§6)', () => {
  it('5. 设 db_statement 全文 → 抛 PII redact violation', () => {
    expect(() =>
      emitAuditEvent({
        event_type: 'ddl_executed',
        outcome: 'allow',
        // @ts-expect-error 故意触发 redact assertion
        db_statement: "DROP TABLE users; -- email='alice@example.com'",
      }),
    ).toThrow(/PII redact violation/);
  });

  it('5b. 设 extra.sql / extra["db.statement"] → 抛 PII redact violation', () => {
    expect(() =>
      emitAuditEvent({
        event_type: 'ddl_executed',
        outcome: 'allow',
        extra: { sql: 'DROP TABLE secret' },
      }),
    ).toThrow(/PII redact violation/);
    expect(() =>
      emitAuditEvent({
        event_type: 'ddl_executed',
        outcome: 'allow',
        extra: { 'db.statement': 'SELECT * FROM users' },
      }),
    ).toThrow(/PII redact violation/);
  });

  it('5c. db_statement_sha256 (合法 redact 字段) 不抛 · 落 attribute', () => {
    const hash = sha256Hex('SELECT * FROM users');
    emitAuditEvent({
      event_type: 'ddl_executed',
      outcome: 'allow',
      db_statement_sha256: hash,
    });
    const s = getSpans()[0];
    expect(s.attributes['db.statement.sha256']).toBe(hash);
    // 关键: 不能含全文
    for (const v of Object.values(s.attributes)) {
      if (typeof v === 'string') {
        expect(v).not.toContain('SELECT * FROM users');
      }
    }
  });
});

describe('feat-031 · fail-safety (§11 OQ1)', () => {
  it('6. 即使 tracer.startSpan 抛错 · emit 不 throw / 不阻塞 caller', () => {
    // simulate OTel SDK 损坏: 临时替换 suiteProvider.getTracer 返回一个会抛的 tracer。
    // setGlobalTracerProvider 第二次是 no-op · 所以改 provider instance 自己。
    const original = suiteProvider.getTracer.bind(suiteProvider);
    suiteProvider.getTracer = () =>
      ({
        startSpan() {
          throw new Error('tracer broken (simulated collector / SDK 故障)');
        },
        startActiveSpan() {
          throw new Error('not used');
        },
      }) as unknown as ReturnType<TracerProvider['getTracer']>;
    try {
      // 不抛 (fail-safety) · 即使 OTel layer 完全坏
      expect(() =>
        emitAuditEvent({
          event_type: 'g4_destructive_deny',
          outcome: 'deny',
        }),
      ).not.toThrow();
    } finally {
      suiteProvider.getTracer = original;
    }
  });
});

describe('feat-031 · local file fallback', () => {
  it('7. OTEL_EXPORTER_LOCAL_FALLBACK_PATH set · 落 JSONL 一行 · schema 完整', async () => {
    process.env.OTEL_EXPORTER_LOCAL_FALLBACK_PATH = TMP_FALLBACK;
    emitAuditEvent({
      event_type: 'g1_cross_project_deny',
      outcome: 'deny',
      severity: 'high',
      principal: 'agent:c0de',
      last_4: 'a1b2',
    });
    // fallback 是异步 fire-and-forget · 等一小拍
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(TMP_FALLBACK)).toBe(true);
    const content = await fsPromises.readFile(TMP_FALLBACK, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.event_type).toBe('g1_cross_project_deny');
    expect(rec.outcome).toBe('deny');
    expect(rec.severity).toBe('high');
    expect(rec.last_4).toBe('a1b2');
    expect(typeof rec.timestamp).toBe('string');
  });

  it('7b. fallback unset · 不落盘', async () => {
    delete process.env.OTEL_EXPORTER_LOCAL_FALLBACK_PATH;
    emitAuditEvent({
      event_type: 'g4_destructive_deny',
      outcome: 'deny',
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(TMP_FALLBACK)).toBe(false);
  });
});

describe('feat-031 · OTEL_SDK_DISABLED', () => {
  it('8. OTEL_SDK_DISABLED=true · initOtel 返回 false (no-op) · emit 仍不抛', async () => {
    process.env.OTEL_SDK_DISABLED = 'true';
    // 注意 otel-init.ts 顶层有 module-scoped `started` state · 若其他 test 先 init 过
    // 它仍是 started=true · 但 OTEL_SDK_DISABLED check 在 started check 之前 · 始终 short-circuit。
    const { initOtel, __shutdownOtelForTest } = await import(
      '../observability/otel-init'
    );
    await __shutdownOtelForTest();
    expect(initOtel()).toBe(false);

    // emit 不抛 · attribute schema 落到 (可能 stub 的) tracer
    expect(() =>
      emitAuditEvent({
        event_type: 'destructive_classified',
        outcome: 'allow',
      }),
    ).not.toThrow();
  });
});
