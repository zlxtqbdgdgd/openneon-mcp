/**
 * branch-canary-ddl.ts · feat-042/#3 (#162) · mcp tool `branch_canary_ddl` handler
 *
 * 设计依据: [feat-042 详设 §3 mcp tool + §3.5 plan mode](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-042-L3-mcp-server-branch-canary-ddl.html)
 *
 * 职责 (issue #162 验收门):
 *   - mcp tool `branch_canary_ddl` 注册 + zod schema
 *   - 双层输出: JSON for agent + plan mode markdown for DBA
 *   - plan mode 集成 (feat-027): 4 outcome 分流
 *     - low_risk_proceed → 绿 · agent 拿 JSON 直接 go
 *     - high_risk_review → 橙 · 出 plan markdown + risk_reasons + recommended_alternatives
 *     - canary_failed → 跳 plan (canary 本身没跑成 · 没事实可审 · 标 deny + reason)
 *     - timeout → 视为 high_risk (DDL 超时即极高风险 · 出 plan)
 *   - 跨 tenant: feat-060 claim binding 自动补 current_project_id · Neon API 前 assert (handler
 *     依赖 server 入口的 binding middleware · 此处直接读 boundArgs · 不重复实现)
 *   - audit emit `canary_completed` event via feat-031 emitAuditEvent (含 sql_sha256 不落原文)
 */

import { createHash } from 'node:crypto';

import { classifyCanaryDecision } from '../../server-enrich/canary/risk-classifier';
import {
  runCanary,
  type CanaryOutcome,
  type CanaryRunResult,
  type CanaryRunnerOptions,
} from '../../server-enrich/canary/canary-runner';
import { emitAuditEvent } from '../../observability/audit-emit';
import { recordCanaryVerdict } from '../../server-enrich/canary-evidence-store';

// ──────────────────────────────────────────────────────────────
// 公开类型 (tool input/output)
// ──────────────────────────────────────────────────────────────

export type BranchCanaryDdlInput = {
  projectId: string;
  /** 待预演 DDL · agent 传原文 (handler 内部 sha256 用 audit · 不落明文) */
  sql: string;
  /** 表 size 估算 (T1 describe_table_schema / pg_class.reltuples · agent 可选传) */
  table_size_estimate?: number;
  /** 强制 canary (DBA 谨慎模式) */
  force_canary?: boolean;
  /** DDL 执行超时秒 · 默认 1800 · 必须 30 ~ 7200 */
  timeout_seconds?: number;
  /** 源 branch (canary 从此 fork · 默认 main · 调用方传 main_branch_id) */
  parent_branch_id?: string;
};

/** 顶层判定 (agent 看的简洁层) · 跟 plan mode 输出对应。 */
export type BranchCanaryDdlVerdict =
  | 'skip_low_risk' //         risk-classifier skip · 不需 canary · agent 可直接 run_sql
  | 'low_risk_proceed' //       canary 跑了 + 测量 clean · agent 可 go
  | 'high_risk_review' //       canary 跑了 + 测量超阈值 · 需 DBA plan mode 复审
  | 'canary_failed' //          canary 本身失败 · agent 不应 go · DBA 排查
  | 'timeout'; //               canary DDL 超时 · 等同 high_risk

export type BranchCanaryDdlResponse = {
  verdict: BranchCanaryDdlVerdict;
  risk_class: string;
  reason: string;
  /** canary 测量 metrics (verdict ∈ {low_risk_proceed/high_risk_review/timeout} 有值) */
  metrics?: {
    duration_ms: number;
    rows_affected: number;
    locks_acquired: number;
    schema_summary?: string;
  };
  /** canary branch 元信息 (verdict ∈ {low_risk_proceed/high_risk_review} 有值) */
  canary_branch?: {
    branch_id: string;
    branch_name: string;
    expiry_ts: number;
  };
  /** verdict=high_risk_review 时的触发原因 (duration/rows/lock 哪条踩线) */
  risk_reasons?: string[];
  /** verdict=high_risk_review 时的备选建议 (静态规则) */
  recommended_alternatives?: string[];
  /** verdict=canary_failed/timeout 时错误信息 */
  error?: {
    kind: string;
    message: string;
  };
  /** plan mode markdown (verdict=high_risk_review/timeout 有值 · DBA 直接看) */
  plan_markdown?: string;
};

// ──────────────────────────────────────────────────────────────
// handler (依赖注入 · 单测可 mock canary-runner)
// ──────────────────────────────────────────────────────────────

export type BranchCanaryDdlDeps = {
  /** 测试可 mock · 默认走 runCanary */
  runCanaryFn?: (
    opts: CanaryRunnerOptions,
    input: { projectId: string; sql: string; parentBranchId?: string },
  ) => Promise<CanaryRunResult>;
  /** canary-runner 注入 (sqlRunner / connStringResolver) · handler 不知道具体 driver */
  runnerOptions: Omit<CanaryRunnerOptions, 'timeoutSeconds'>;
};

/**
 * handler 主入口 · 调用方 (tools.ts NEON_HANDLERS) 应:
 *   1. 经过 feat-060 claim-binding middleware · projectId 已被 bound (override 写入 boundArgs)
 *   2. 经过 feat-029 API key check
 *   3. 不需要再走 feat-056 pipeline (canary 本身就是 plan mode 触发器 · 上游 plan mode 是给 DDL
 *      实际执行用的 · 此 tool 只是预演 · 不修 prod)
 *
 * 双层输出: 返 BranchCanaryDdlResponse · top-level verdict 给 agent · plan_markdown 给 DBA。
 */
export async function handleBranchCanaryDdl(
  input: BranchCanaryDdlInput,
  deps: BranchCanaryDdlDeps,
): Promise<BranchCanaryDdlResponse> {
  const sqlSha256 = sha256Hex(input.sql);
  const decision = classifyCanaryDecision({
    sql: input.sql,
    table_size_estimate: input.table_size_estimate,
    force_canary: input.force_canary,
  });

  // 短路: skip · 不跑 canary
  if (!decision.requires_canary) {
    emitCanaryAudit({
      projectId: input.projectId,
      sqlSha256,
      verdict: 'skip_low_risk',
      riskClass: decision.risk_class,
      reason: decision.reason,
    });
    return {
      verdict: 'skip_low_risk',
      risk_class: decision.risk_class,
      reason: `risk-classifier 判定 skip (${decision.reason})`,
    };
  }

  // 跑 canary
  const runCanaryFn = deps.runCanaryFn ?? runCanary;
  const timeoutSec = clampTimeoutSeconds(input.timeout_seconds);
  const result = await runCanaryFn(
    { ...deps.runnerOptions, timeoutSeconds: timeoutSec },
    {
      projectId: input.projectId,
      sql: input.sql,
      parentBranchId: input.parent_branch_id,
    },
  );

  const verdict = mapOutcomeToVerdict(result.outcome);
  const response: BranchCanaryDdlResponse = {
    verdict,
    risk_class: decision.risk_class,
    reason: explainVerdict(verdict, decision.reason, result),
  };
  if (result.branch) {
    response.canary_branch = {
      branch_id: result.branch.branch_id,
      branch_name: result.branch.branch_name,
      expiry_ts: result.branch.expiry_ts,
    };
  }
  if (result.metrics) {
    response.metrics = {
      duration_ms: result.metrics.duration_ms,
      rows_affected: result.metrics.rows_affected,
      locks_acquired: result.metrics.locks_acquired,
      schema_summary: result.metrics.schema_summary,
    };
  }
  if (result.risk_reasons) {
    response.risk_reasons = result.risk_reasons;
    response.recommended_alternatives = suggestAlternatives(
      decision.risk_class,
      result.risk_reasons,
    );
  }
  if (result.error) {
    response.error = result.error;
  }
  if (verdict === 'high_risk_review' || verdict === 'timeout') {
    response.plan_markdown = renderCanaryPlanMarkdown(response, input.sql);
  }

  emitCanaryAudit({
    projectId: input.projectId,
    sqlSha256,
    verdict,
    riskClass: decision.risk_class,
    reason: response.reason,
    durationMs: result.metrics?.duration_ms,
    rowsAffected: result.metrics?.rows_affected,
    errorKind: result.error?.kind,
  });

  // feat-042 follow-up (#176): 记录 verdict 到 canary-evidence-store · 下一步 run_sql
  // 同条 DDL 时 · route.ts orchestrator 调 consumeCanaryVerdict 注入 EnforcementCtx.canaryEvidence ·
  // plan-mode renderPlan 渲染 canary 证据段给 DBA · 闭合 agent 自然流程的 plan-mode loop。
  // skip_low_risk 不记 (本身就是"不必 canary"verdict · 下游 plan-mode 不需要证据段)。
  if (verdict !== 'skip_low_risk') {
    recordCanaryVerdict(input.projectId, input.sql, {
      verdict,
      risk_class: decision.risk_class,
      branch_id: result.branch?.branch_id,
      duration_ms: result.metrics?.duration_ms,
      rows_affected: result.metrics?.rows_affected,
      locks_acquired: result.metrics?.locks_acquired,
      risk_reasons: result.risk_reasons,
      error: result.error?.message,
    });
  }

  return response;
}

// ──────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────

function clampTimeoutSeconds(s: number | undefined): number {
  if (s === undefined || !Number.isFinite(s)) return 1800;
  if (s < 30) return 30;
  if (s > 7200) return 7200;
  return Math.floor(s);
}

function mapOutcomeToVerdict(o: CanaryOutcome): BranchCanaryDdlVerdict {
  switch (o) {
    case 'low_risk_proceed':
      return 'low_risk_proceed';
    case 'high_risk_review':
      return 'high_risk_review';
    case 'canary_failed':
      return 'canary_failed';
    case 'timeout':
      return 'timeout';
    default:
      return 'high_risk_review';
  }
}

function explainVerdict(
  verdict: BranchCanaryDdlVerdict,
  classifierReason: string,
  result: CanaryRunResult,
): string {
  switch (verdict) {
    case 'low_risk_proceed':
      return `canary 跑了 · ${
        result.metrics?.duration_ms ?? 0
      }ms · 测量在阈值内 · 可直接打 prod`;
    case 'high_risk_review':
      return `canary 跑了 · 测量信号超阈值 · DBA 需在 plan mode 复审 (触发: ${
        (result.risk_reasons ?? []).join(' · ') || classifierReason
      })`;
    case 'canary_failed':
      return `canary 失败 · ${result.error?.kind ?? 'unknown'} · DBA 排查后再试`;
    case 'timeout':
      return `canary 超时 · DDL 在 canary 都跑不完 · 不应直接打 prod`;
    default:
      return classifierReason;
  }
}

function suggestAlternatives(
  riskClass: string,
  riskReasons: string[],
): string[] {
  const alts: string[] = [];
  if (riskClass === 'CREATE_INDEX') {
    alts.push(
      'CREATE INDEX CONCURRENTLY (不阻塞写 · 可滚动 build · 但失败留 INVALID 索引需清理)',
    );
  }
  if (riskClass === 'ALTER_TABLE_HEAVY' && riskReasons.some((r) => r.includes('rows_affected'))) {
    alts.push(
      '拆 DDL 成多步: 先 ADD COLUMN NULLable · 然后批量 UPDATE 回填 · 最后 SET NOT NULL',
    );
  }
  if (riskClass === 'VACUUM_FULL_LOCK') {
    alts.push(
      'pg_repack / pg_squeeze 替代 VACUUM FULL · 不取 ACCESS EXCLUSIVE 锁',
    );
  }
  if (riskReasons.some((r) => r.includes('duration_ms'))) {
    alts.push('选低峰窗口 (业务流量 < 10% 峰值) 再执行 · 监控 lock_wait_count_total');
  }
  if (alts.length === 0) {
    alts.push('建议 DBA 在 plan mode 选窗口 + 监控 lock_wait_count_total 后再 approve');
  }
  return alts;
}

function renderCanaryPlanMarkdown(
  resp: BranchCanaryDdlResponse,
  sql: string,
): string {
  const lines: string[] = [];
  lines.push(`# DDL canary 复审 (verdict: ${resp.verdict})`);
  lines.push('');
  lines.push(`**风险分类**: \`${resp.risk_class}\``);
  lines.push(`**判定**: ${resp.reason}`);
  lines.push('');
  lines.push('## SQL');
  lines.push('```sql');
  lines.push(sql);
  lines.push('```');
  lines.push('');
  if (resp.metrics) {
    lines.push('## canary 测量');
    lines.push(`- duration_ms: ${resp.metrics.duration_ms}`);
    lines.push(`- rows_affected: ${resp.metrics.rows_affected}`);
    lines.push(`- locks_acquired: ${resp.metrics.locks_acquired}`);
    if (resp.metrics.schema_summary) {
      lines.push(`- schema_summary: ${resp.metrics.schema_summary}`);
    }
    lines.push('');
  }
  if (resp.risk_reasons && resp.risk_reasons.length > 0) {
    lines.push('## 触发原因');
    for (const r of resp.risk_reasons) lines.push(`- ${r}`);
    lines.push('');
  }
  if (resp.recommended_alternatives && resp.recommended_alternatives.length > 0) {
    lines.push('## 备选方案');
    for (const a of resp.recommended_alternatives) lines.push(`- ${a}`);
    lines.push('');
  }
  if (resp.canary_branch) {
    lines.push('## canary branch');
    lines.push(`- branch_id: \`${resp.canary_branch.branch_id}\``);
    lines.push(
      `- expiry_ts (ms): ${resp.canary_branch.expiry_ts} (7d retention · cron 自动清理)`,
    );
    lines.push('');
  }
  if (resp.error) {
    lines.push('## 错误');
    lines.push(`- kind: \`${resp.error.kind}\``);
    lines.push(`- message: ${resp.error.message}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('批准在 prod 执行该 DDL?');
  return lines.join('\n');
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function emitCanaryAudit(args: {
  projectId: string;
  sqlSha256: string;
  verdict: BranchCanaryDdlVerdict;
  riskClass: string;
  reason: string;
  durationMs?: number;
  rowsAffected?: number;
  errorKind?: string;
}): void {
  // verdict → audit outcome 映射
  const outcome =
    args.verdict === 'low_risk_proceed' || args.verdict === 'skip_low_risk'
      ? 'allow'
      : args.verdict === 'canary_failed'
        ? 'deny'
        : 'rejected'; // high_risk_review / timeout 当作待 DBA 决议 · audit 标 rejected (未自动放行)

  emitAuditEvent({
    event_type: 'canary_completed',
    outcome,
    severity:
      args.verdict === 'high_risk_review' || args.verdict === 'timeout'
        ? 'high'
        : args.verdict === 'canary_failed'
          ? 'medium'
          : 'low',
    op_class: args.riskClass,
    project_id: args.projectId,
    db_statement_sha256: args.sqlSha256, // §6 PII redact · 永不落原文
    extra: {
      verdict: args.verdict,
      reason: args.reason,
      duration_ms: args.durationMs,
      rows_affected: args.rowsAffected,
      error_kind: args.errorKind,
    },
  });
}
