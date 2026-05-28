/**
 * audit-emit.ts · feat-031/#1 · 统一 audit emission API
 *
 * feat-026 (confirm_token) / feat-027 (plan mode) / feat-029 (G1 hard-deny) / feat-060
 * (claim override) 各自的 audit emission **必须**调本 API · 不各自 implement OTLP exporter
 * (§10.2.1 重复实现 + §6 single source 防 ad-hoc emission)。
 *
 * 设计依据: feat-031 详设 §3.2 (c) + §4 schema + §6 PII redact + §7 fixture 8 用例。
 *
 * 行为:
 *   - emit 一条 OTel span (target='openneon::audit' · 让 collector 按 target 分流 audit-vs-trace)
 *   - attribute namespace `openneon.audit.*` · schema 详 feat-031 §3.2 (a) / §4
 *   - PII redact: 拒绝 `db_statement` (全文) 字段 · 仅 `db_statement_sha256`
 *   - fail-safety (§11 OQ1): OTLP collector 不可达 → BatchSpanProcessor 异步 drop · 不阻塞
 *   - local file fallback: OTEL_EXPORTER_LOCAL_FALLBACK_PATH 设了就同时落 JSONL (100MB rotate)
 *
 * **不**做 fail-closed (audit 失败 → tool deny) —— L3+ 才加 OTEL_REQUIRE_EXPORT flag (§11 OQ1)。
 */
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { createHash } from 'node:crypto';
import { promises as fsPromises, statSync, renameSync } from 'node:fs';

const TRACER_NAME = 'openneon-mcp-audit';
const AUDIT_TARGET = 'openneon::audit';
const FALLBACK_ROTATE_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * audit event 类型 enum · 跟 feat-031 §3.2 (a) attribute schema strict 对齐。
 */
export type AuditEventType =
  | 'g1_cross_project_deny'
  | 'g4_destructive_deny'
  | 'g9_rate_limit_warned'
  | 'g9_rate_limit_exceeded'
  | 'plan_mode_required'
  | 'plan_mode_approved'
  | 'plan_mode_rejected'
  | 'confirm_token_issued'
  | 'confirm_token_verified'
  | 'confirm_token_rejected'
  | 'claim_override'
  | 'destructive_classified'
  | 'ddl_executed'
  | 'compute_audit_log_record'
  // feat-024/#3 T11 search_samples · 脱敏样本检索 (filter + hits + sensitive_redact_count_total 进 extra)
  | 'search_samples_invoked'
  // feat-022 T7: agent 调 get_neondb_recommendations 拿到 enriched 推荐 (DBA 复盘审计)
  | 'recommendation_classified'
  // feat-023/#2 T10 search_plans · 主动巡检 (filter + hits + duration_ms + backend 进 extra)
  | 'search_plans_invoked'
  // feat-066/#3 T13/T14 trace 读 + 跨 tenant 安全 audit · 'trace_get_invoked' / 'trace_search_invoked' / 'cross_tenant_blocked'
  | 'trace_get_invoked'
  | 'trace_search_invoked'
  | 'cross_tenant_blocked'
  // feat-025 T12 pool_stats · pgcat/PgBouncer 连接池 snapshot 调用审计
  | 'pool_stats_invoked'
  // feat-037 cluster_neondb_logs · log pattern 聚类调用审计 (path_used + cost_estimate_usd + cache_hit + model 进 extra)
  | 'log_clustering_invoked'
  // feat-043 slot-monitor (design#53 §3.3 · system principal · 仅 audit OTel · 1h cron 双级阈值 24h/36h)
  | 'replication_slot_inactive_warn'
  | 'replication_slot_inactive_critical'
  | 'replication_slot_monitor_cron_summary'
  // feat-068 动态探针 (#143 · audit 事件流) · attach 路径全生命周期 + 三层限流 + post-condition
  | 'probe_attached'
  | 'probe_detached'
  | 'probe_overhead_exceeded'
  | 'probe_rate_limit_exceeded'
  | 'probe_attach_denied'
  | 'probe_attach_failed';

export type AuditOutcome =
  | 'allow'
  | 'deny'
  | 'override'
  | 'approved'
  | 'rejected';

export type AuditSeverity = 'low' | 'medium' | 'high';

export type AuditEvent = {
  event_type: AuditEventType;
  outcome: AuditOutcome;
  op_class?: string;
  /** 'human:<id>' | 'system:<component>' (如 system:odd-mrc/system:fail-closed) | 'agent:<key-last-4>' */
  principal?: string;
  severity?: AuditSeverity;
  token_id?: string;
  key_type?: 'personal' | 'org' | 'project-scoped';
  last_4?: string;
  /** **永远 sha256** · 不可放全文 SQL (§6 PII redact) */
  db_statement_sha256?: string;
  db_user?: string;
  /** feat-060 claim_override: agent 尝试值 (默认全文 · 用户可配 redact) */
  agent_attempted_value?: unknown;
  /** feat-060 claim_override: server JWT 绑定的真实值 */
  bound_value?: unknown;
  /** USR (feat-008-011 L2b ship 后填 · L2a optional) · 全部出 openneon.usr.* namespace */
  tenant_id?: string;
  timeline_id?: string;
  endpoint_id?: string;
  shard_id?: string;
  /** project_id (feat-029 跨 project deny · audit join key) · USR 身份字段 → openneon.usr.project_id */
  project_id?: string;
  /** 其他 ad-hoc attribute (调用方按需) · 不进入 redact assertion 范围 */
  extra?: Record<string, unknown>;
};

/**
 * **runtime PII redact assertion** · 防调用方误传全文 SQL。
 *
 * 任何字段名匹配 db_statement / sql_text / statement (不含 sha256 后缀) 触发抛错。
 * 防御性: 包含 `extra` map 也要扫描。
 */
function assertNoRawStatement(event: AuditEvent): void {
  const FORBIDDEN_KEYS = ['db_statement', 'sql_text', 'statement', 'sql'];
  // top-level: 仅 db_statement_sha256 允许 · 全文型字段拒
  for (const key of FORBIDDEN_KEYS) {
    if (key in (event as Record<string, unknown>)) {
      throw new Error(
        `[audit-emit] PII redact violation: '${key}' is forbidden · use db_statement_sha256 (feat-031 §6)`,
      );
    }
  }
  if (event.extra) {
    for (const key of Object.keys(event.extra)) {
      const lower = key.toLowerCase();
      // db.statement 全文型 (含 dot 形式) · 但允许 .sha256 后缀
      if (
        (lower === 'db.statement' ||
          lower === 'db_statement' ||
          lower === 'sql' ||
          lower === 'sql_text' ||
          lower === 'statement') &&
        !lower.endsWith('sha256')
      ) {
        throw new Error(
          `[audit-emit] PII redact violation: extra.${key} forbidden · use db_statement_sha256 (feat-031 §6)`,
        );
      }
    }
  }
}

/** helper: SHA-256 hex 哈希 (调用方可用 · 防自己写错) */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** OTel attribute key 转换 (event 字段 → `openneon.audit.*` namespace) */
function toOtelAttributes(event: AuditEvent): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    target: AUDIT_TARGET,
    'openneon.audit.event_type': event.event_type,
    'openneon.audit.outcome': event.outcome,
  };
  if (event.op_class !== undefined)
    attrs['openneon.audit.op_class'] = event.op_class;
  if (event.principal !== undefined)
    attrs['openneon.audit.principal'] = event.principal;
  if (event.severity !== undefined)
    attrs['openneon.audit.severity'] = event.severity;
  if (event.token_id !== undefined)
    attrs['openneon.audit.token_id'] = event.token_id;
  if (event.key_type !== undefined)
    attrs['openneon.audit.key_type'] = event.key_type;
  if (event.last_4 !== undefined) attrs['openneon.audit.last_4'] = event.last_4;
  if (event.db_statement_sha256 !== undefined) {
    attrs['db.system'] = 'postgresql';
    attrs['db.statement.sha256'] = event.db_statement_sha256;
  }
  if (event.db_user !== undefined) attrs['db.user'] = event.db_user;
  // project_id 跟 tenant/timeline/endpoint/shard 同属 USR 身份字段 → openneon.usr.*
  // namespace (跟 neon 内核侧 compute_tools audit_otel.rs 统一 · 详 docs/audit-otel-schema.md)。
  if (event.project_id !== undefined)
    attrs['openneon.usr.project_id'] = event.project_id;
  if (event.agent_attempted_value !== undefined)
    attrs['openneon.audit.agent_attempted_value'] = stringify(
      event.agent_attempted_value,
    );
  if (event.bound_value !== undefined)
    attrs['openneon.audit.bound_value'] = stringify(event.bound_value);
  // USR (L2b ship 后填)
  if (event.tenant_id !== undefined)
    attrs['openneon.usr.tenant_id'] = event.tenant_id;
  if (event.timeline_id !== undefined)
    attrs['openneon.usr.timeline_id'] = event.timeline_id;
  if (event.endpoint_id !== undefined)
    attrs['openneon.usr.endpoint_id'] = event.endpoint_id;
  if (event.shard_id !== undefined)
    attrs['openneon.usr.shard_id'] = event.shard_id;
  if (event.extra) {
    for (const [k, v] of Object.entries(event.extra)) {
      attrs[k] = stringify(v);
    }
  }
  return attrs;
}

function stringify(value: unknown): string | number | boolean {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** local file fallback · best-effort · 失败不抛 (audit-of-audit 死循环防御)。 */
async function writeLocalFallback(
  path: string,
  event: AuditEvent,
): Promise<void> {
  try {
    // 100 MB rotate (size check + rename `.1`)
    try {
      const st = statSync(path);
      if (st.size >= FALLBACK_ROTATE_BYTES) {
        renameSync(path, `${path}.1`);
      }
    } catch {
      // 文件不存在 / stat 失败 = 第一次写 · 跳过 rotate
    }
    const line =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ...event,
      }) + '\n';
    await fsPromises.appendFile(path, line, 'utf8');
  } catch (err) {
    // 落盘失败 (磁盘满 / 权限错) · 仅 stderr · 不影响 tool
    console.warn('[audit-emit] local fallback write failed:', err);
  }
}

/**
 * emit 一条 audit event · fire-and-forget。
 *
 * - PII redact assertion: 全文 SQL 字段触发抛错 (调用方 bug · throws · audit-of-audit 不 emit)
 * - OTel span: 通过 BatchSpanProcessor 异步 export · collector 不可达自动 drop · 不阻塞 caller
 * - local file fallback: OTEL_EXPORTER_LOCAL_FALLBACK_PATH set 时同时落 JSONL (best-effort)
 * - OTEL_SDK_DISABLED=true: span 仍创建但走 no-op tracer (本机不出口 · local fallback 还会落)
 */
export function emitAuditEvent(event: AuditEvent): void {
  // PII redact 是 invariant · 违反就 throw (bug · 比静默丢 audit 危险)
  assertNoRawStatement(event);

  const attrs = toOtelAttributes(event);

  // tracer.startSpan() 即使 OTel 未 init 也安全 (返回 no-op span · OTel api 保证)
  const tracer = trace.getTracer(TRACER_NAME);
  const spanName = `audit.${event.event_type}`;
  try {
    const span = tracer.startSpan(spanName, {
      attributes: attrs as Record<string, string | number | boolean>,
    });
    if (event.outcome === 'deny' || event.outcome === 'rejected') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: event.outcome });
    }
    span.end();
  } catch (err) {
    // OTel span 创建/end 失败 · 不阻塞 (fail-safety §11 OQ1)
    console.warn('[audit-emit] OTel span emit failed:', err);
  }

  // local file fallback (异步 best-effort · 不 await)
  const fallbackPath = process.env.OTEL_EXPORTER_LOCAL_FALLBACK_PATH;
  if (fallbackPath) {
    void writeLocalFallback(fallbackPath, event);
  }
}
