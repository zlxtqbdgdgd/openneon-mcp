/**
 * plan-mode.ts · feat-027/#2 · feat-056 pipeline 的第一个可配 stage (§8.2 第 6 步)。
 *
 * 对矩阵判定"需 plan"的高危 ops,组 server 事实 plan → orchestrator 弹 MCP elicitInput 给 DBA 审批 ·
 * 人批才放行。**human-in-the-loop**: elicitation 响应来自 client/人,agent (LLM) 伪造不了 (OWASP LLM06)。
 *
 * 职责拆分 (ADR-0008 · feat-056 §4.3):
 * - **stage (near-pure)**: 只判定 + 组 plan payload (可做 read-only enrichment · 不做 human-blocking I/O)。
 * - **orchestrator (route.ts)**: 拿 require_plan verdict → 调 server.elicitInput → 映射审批结果。
 *   human-blocking I/O 归 orchestrator · round-trip + audit 单一权威。
 *
 * fail-closed (SPIKE feat-027/#1 · §11.1 实证): client 不支持 elicitation / 超时 / 断连 → deny ·
 * 绝不 fall-through 执行。elicitInput 在 tool-call 内阻塞 → stateless (无持久化 pending 状态)。
 *
 * plan payload 只装 **server 推导的事实** · **禁投机预测** ("p95→50ms" 那种 agent 会幻觉 · ADR-0008 /
 * narrative #3)。设计: feat-027 详设 §3 §4 · ADR-0008。
 */
import type { OpClass } from '../../protection/destructive-detector';
import type { Stage, EnforcementCtx } from '../pipeline';
import { matrixRequiresPlan } from '../matrix';

export type PlanRisk = 'low' | 'medium' | 'high';

export type AffectedObject = {
  type: 'table' | 'index' | 'database' | 'user';
  name: string;
};

/**
 * feat-042/#3 (#162) · DDL canary 证据 (DBA 复审用 · plan-mode 字段)。
 *
 * 来源: 上游 branch_canary_ddl tool 调用 · agent 把 verdict + metrics 透传到下一步 run_sql 的
 * plan-mode payload (调用方拼装 · plan-mode 自己不发起 canary)。
 * 出现时 renderPlan 会渲染额外的 "canary 证据" 段。
 */
export type CanaryEvidence = {
  /** 'low_risk_proceed' / 'high_risk_review' / 'canary_failed' / 'timeout' / 'skip_low_risk' */
  verdict: string;
  /** risk-classifier 给出的风险分类 (HARD_CANARY 6 类 或 ALTER_TABLE_LIGHT 等) */
  risk_class?: string;
  /** canary branch_id (Neon API 创建 · DBA 可登去复盘) */
  branch_id?: string;
  duration_ms?: number;
  rows_affected?: number;
  locks_acquired?: number;
  /** verdict=high_risk_review 时的触发原因 */
  risk_reasons?: string[];
  /** 失败 / 超时的错误描述 */
  error?: string;
};

/** server 事实 plan (无 speculative 预测 · 详设 §4.1)。 */
export type PlanPayload = {
  sql: string; // 原文 (复用 T6 参数化路径脱敏 · day-one 原样展示给 DBA)
  op_class: OpClass;
  risk_level: PlanRisk;
  affected_objects: AffectedObject[];
  reversibility: string;
  statement_properties: string[]; // 语句事实属性 · 如 "CONCURRENTLY：不阻塞写"
  estimated_rows?: number; // 仅 DML · T3 EXPLAIN 估算 (feat-019 · OQ3 未 ready 时省略)
  // feat-042/#3 (#162) · DDL canary 预演证据 (可选 · agent 上游 branch_canary_ddl 调用透传)
  canary_evidence?: CanaryEvidence;
};

// op-class → 风险级 (server 事实 · hard-deny class 在此 stage 前已 terminal · 不会到这)
const RISK_BY_OP: Partial<Record<OpClass, PlanRisk>> = {
  ALTER_TABLE_BIG_LOCK: 'high',
  DROP_TABLE_OR_INDEX: 'high',
  DELETE_UPDATE_BULK: 'high',
  DROP_REPLICATION_SLOT: 'high',
  // feat-028/#109 长锁 · 阻塞 SELECT 期间用户感知极强 · high
  VACUUM_FULL_LOCK: 'high',
  CLUSTER_LOCK: 'high',
  CREATE_INDEX_CONCURRENTLY: 'medium',
  DDL_ADD_COLUMN: 'medium',
  CREATE_OR_RESTORE_BRANCH: 'low',
  // feat-068 动态探针 attach · 短时 / overhead 受限 / 自动 detach · 可控 medium
  // (DBA 审批仍要看 plan · 信息: target endpoint / duration / 预估 overhead)
  DYNAMIC_PROBE_ATTACH: 'medium',
  // feat-028/#108 fail-closed bucket · parse 失败 / 未识别 stmt · 按 high 处理 (保守)
  OTHER: 'high',
};

// op-class → 可逆性 (server 事实 · 不含投机)
const REVERSIBILITY_BY_OP: Partial<Record<OpClass, string>> = {
  ALTER_TABLE_BIG_LOCK: '取决于具体 ALTER · 部分变更 (改类型/删列) 不可逆',
  DROP_TABLE_OR_INDEX: 'DROP 不可逆 (除非有备份 / 可从分支恢复)',
  DELETE_UPDATE_BULK: '数据变更不可逆 (除非事务回滚 / 从分支恢复)',
  DROP_REPLICATION_SLOT: '删 replication slot 不可逆 (需重建)',
  VACUUM_FULL_LOCK:
    'VACUUM FULL 取 ACCESS EXCLUSIVE LOCK · 阻塞读写 · 重写表文件 · 完成不可中途回滚 · 建议低峰执行',
  CLUSTER_LOCK:
    'CLUSTER 取 ACCESS EXCLUSIVE LOCK · 阻塞读写 · 按 index 顺序重写表 · 完成不可中途回滚',
  CREATE_INDEX_CONCURRENTLY: '可 DROP INDEX 回滚 (建索引本身不改数据)',
  DDL_ADD_COLUMN: 'ADD COLUMN 可 DROP COLUMN 回滚 (新列数据丢失)',
  CREATE_OR_RESTORE_BRANCH: '分支操作不影响源 · 可删分支回滚',
  DYNAMIC_PROBE_ATTACH:
    'eBPF/USDT/uprobe attach · duration cap ≤ 5min · watchdog 超 overhead 自动 detach · sidecar 跑完自销 (不污染 compute 主进程) · 完全可逆',
  OTHER: '解析未识别 / fail-closed · 可逆性未知 · 按高危处理',
};

/** 从 SQL 提取受影响对象 (启发式 · best-effort · 详设校准点)。 */
function extractAffectedObjects(sql: string): AffectedObject[] {
  const objs: AffectedObject[] = [];
  const s = sql.replace(/\s+/g, ' ').trim();
  const push = (type: AffectedObject['type'], name?: string) => {
    if (name) objs.push({ type, name: name.replace(/["'`;]/g, '') });
  };
  // CREATE/DROP INDEX [CONCURRENTLY] <name> [ON <table>]
  const idx = /\b(?:CREATE|DROP)\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([\w."]+)/i.exec(
    s,
  );
  if (idx) push('index', idx[1]);
  const onTable = /\bON\s+([\w."]+)/i.exec(s);
  if (onTable) push('table', onTable[1]);
  // ALTER/DROP TABLE <table> · DELETE FROM <table> · UPDATE <table>
  const tbl =
    /\b(?:ALTER\s+TABLE|DROP\s+TABLE|DELETE\s+FROM|UPDATE)\s+(?:IF\s+EXISTS\s+)?([\w."]+)/i.exec(
      s,
    );
  if (tbl) push('table', tbl[1]);
  return objs;
}

/** 从 SQL + op-class 提取语句事实属性 (verifiable · 非投机)。 */
function statementProperties(sql: string, opClass: OpClass): string[] {
  const props: string[] = [];
  if (/\bCONCURRENTLY\b/i.test(sql)) {
    props.push('CONCURRENTLY：不阻塞读写 · 但不能在事务块内执行 · 失败留 INVALID 索引需清理');
  }
  if (opClass === 'ALTER_TABLE_BIG_LOCK') {
    props.push('ALTER TABLE 默认取 ACCESS EXCLUSIVE 锁 · 等锁期间阻塞该表读写');
  }
  if (opClass === 'VACUUM_FULL_LOCK') {
    props.push('VACUUM FULL 取 ACCESS EXCLUSIVE 锁 · 阻塞 SELECT/INSERT/UPDATE/DELETE · 大表期间业务停摆');
  }
  if (opClass === 'CLUSTER_LOCK') {
    props.push('CLUSTER 取 ACCESS EXCLUSIVE 锁 · 阻塞 SELECT/INSERT/UPDATE/DELETE · 按 index 顺序重写表');
  }
  if (opClass === 'DELETE_UPDATE_BULK' && !/\bWHERE\b/i.test(sql)) {
    props.push('无 WHERE 子句：影响全表行');
  }
  return props;
}

/** 组 server 事实 plan payload (near-pure · 详设 §4.1)。 */
export function buildPlanPayload(ctx: EnforcementCtx): PlanPayload {
  const sql = ctx.sql ?? '';
  return {
    sql,
    op_class: ctx.opClass,
    risk_level: RISK_BY_OP[ctx.opClass] ?? 'medium',
    affected_objects: extractAffectedObjects(sql),
    reversibility: REVERSIBILITY_BY_OP[ctx.opClass] ?? '未知 · 按高危处理',
    statement_properties: statementProperties(sql, ctx.opClass),
    // estimated_rows: OQ3 · feat-019 EXPLAIN 估算 defer (避免 plan 生成 I/O) · 省略
    // feat-042/#3 (#162) · 上游 branch_canary_ddl 透传的 canary 证据 (可选 · ctx.canaryEvidence
    // 在 orchestrator 拼装 EnforcementCtx 时由 route.ts 注入 · 缺省 undefined)。
    canary_evidence: ctx.canaryEvidence,
  };
}

/**
 * plan mode stage (near-pure): 矩阵判定需 plan → 返回 require_plan + payload (non-terminal ·
 * orchestrator 接管 elicitation)。否则 null (只读 / allow / 已 deny 终止 不到这)。
 *
 * feat-026/#1: 若 ctx.confirmToken.source === 'odd-pre-approved' (L4 路径 · ODD/MRC 自动颁发 ·
 *   L2a stub throw 不可达 · feat-049/051 ship 后才接通) → skip elicitation · 返 null 放行 step 7
 *   verify token + audit (详设 §3 L4 调用链)。
 * feat-026/#1: 若 ctx.confirmToken.source === 'plan-mode-approval' (orchestrator 在前一轮 approve
 *   后已颁发 + 重跑 pipeline) → 也 skip elicitation (避免二次弹窗) · step 7 verify。
 */
export const planModeStage: Stage = (ctx) => {
  if (!matrixRequiresPlan(ctx.opClass, ctx.autonomyLevel)) return null;
  // feat-026/#1: 已有 token → skip elicitation (L4 odd-pre-approved 或 L1-L3 plan-mode-approval
  // 重跑路径) · 放行到 step 7 (confirmTokenStage) verify。
  if (ctx.confirmToken) return null;
  return {
    action: 'require_plan',
    plan: buildPlanPayload(ctx),
    reason: `${ctx.opClass} @ ${ctx.autonomyLevel} 高危 ops 需 DBA 审批 (plan mode)`,
    audit_severity: 'medium',
    terminal: false,
  };
};

// ───────────────────────── orchestrator 侧 (route.ts 调) ─────────────────────────

/** elicitation 超时 (§4.2 · OQ2 · 5min · 超时 fail-closed)。 */
export const PLAN_ELICIT_TIMEOUT_MS = 300_000;

/** MCP ElicitResult 形态 (SDK ElicitResult · action 三态 + 可选 content)。 */
export type ElicitResultLike = {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
};

/** 注入式 elicit 调用 (route.ts 绑 server.server.elicitInput)。undefined = client 无 capability → fail-closed。 */
export type ElicitFn = (
  message: string,
  requestedSchema: Record<string, unknown>,
  timeoutMs: number,
) => Promise<ElicitResultLike>;

export type PlanApproval = {
  approved: boolean;
  reason?: string;
  /** true = 因 capability 缺失 / 超时 / 异常 而 fail-closed deny (非 DBA 主动拒)。 */
  failClosed: boolean;
};

/** 渲染 plan 给人看 (human-readable · 纯 server 事实)。 */
export function renderPlan(plan: PlanPayload): string {
  const objs =
    plan.affected_objects.length > 0
      ? plan.affected_objects.map((o) => `${o.type} ${o.name}`).join(', ')
      : '(未解析出具体对象)';
  const props =
    plan.statement_properties.length > 0
      ? plan.statement_properties.map((p) => `\n  - ${p}`).join('')
      : ' 无';
  return [
    `高危操作需审批 (op-class: ${plan.op_class} · 风险: ${plan.risk_level})`,
    ``,
    `SQL:\n${plan.sql}`,
    ``,
    `受影响对象: ${objs}`,
    `可逆性: ${plan.reversibility}`,
    plan.estimated_rows !== undefined
      ? `EXPLAIN 估算影响行数: ${plan.estimated_rows}`
      : ``,
    `语句属性:${props}`,
    plan.canary_evidence ? renderCanaryEvidence(plan.canary_evidence) : ``,
    ``,
    `批准执行?`,
  ]
    .filter((line) => line !== ``)
    .join('\n');
}

/** feat-042/#3 · 渲染 canary 证据段 (DBA 在 plan mode 看到上游 canary 跑了什么)。 */
function renderCanaryEvidence(c: CanaryEvidence): string {
  const lines: string[] = [];
  lines.push(``);
  lines.push(`DDL canary 证据 (上游 branch_canary_ddl 预演结果):`);
  lines.push(`  - verdict: ${c.verdict}`);
  if (c.risk_class) lines.push(`  - risk_class: ${c.risk_class}`);
  if (c.branch_id) lines.push(`  - branch_id: ${c.branch_id} (DBA 可登 canary 复盘)`);
  if (c.duration_ms !== undefined)
    lines.push(`  - duration_ms: ${c.duration_ms}`);
  if (c.rows_affected !== undefined)
    lines.push(`  - rows_affected: ${c.rows_affected}`);
  if (c.locks_acquired !== undefined)
    lines.push(`  - locks_acquired: ${c.locks_acquired}`);
  if (c.risk_reasons && c.risk_reasons.length > 0) {
    lines.push(`  - 触发原因:`);
    for (const r of c.risk_reasons) lines.push(`    · ${r}`);
  }
  if (c.error) lines.push(`  - error: ${c.error}`);
  return lines.join('\n');
}

/** elicitation 请求 schema (只 approve/reject · 不让 DBA 改写 SQL · §4.2)。 */
export const PLAN_ELICIT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    approved: { type: 'boolean', description: '批准执行该高危操作?' },
    reason: { type: 'string', description: '审批 / 拒绝理由 (可选 · 进 audit)' },
  },
  required: ['approved'],
};

/**
 * orchestrator 处理 require_plan: 弹 elicitation → 映射审批 (详设 §3.2)。**fail-closed**:
 * - elicit 缺失 (client 无 capability) → deny (failClosed)
 * - action !== 'accept' (decline/cancel) → deny (DBA 拒 · 非 failClosed)
 * - accept + content.approved===true → 放行
 * - accept + approved!==true → deny (DBA 在表单里选了不批)
 * - 抛错 (超时 / 断连 / 异常) → deny (failClosed)
 */
export async function resolvePlanApproval(
  elicit: ElicitFn | undefined,
  plan: PlanPayload,
): Promise<PlanApproval> {
  if (!elicit) {
    return {
      approved: false,
      reason: 'client 不支持 elicitation · fail-closed deny',
      failClosed: true,
    };
  }
  try {
    const result = await elicit(
      renderPlan(plan),
      PLAN_ELICIT_SCHEMA,
      PLAN_ELICIT_TIMEOUT_MS,
    );
    if (result.action !== 'accept') {
      return {
        approved: false,
        reason: `DBA ${result.action} (未批准)`,
        failClosed: false,
      };
    }
    const approved = result.content?.approved === true;
    const reason =
      typeof result.content?.reason === 'string'
        ? result.content.reason
        : undefined;
    return {
      approved,
      reason: reason ?? (approved ? 'DBA 批准' : 'DBA 表单未批准'),
      failClosed: false,
    };
  } catch (err) {
    return {
      approved: false,
      reason: `elicitation 失败 (fail-closed): ${(err as Error).message}`,
      failClosed: true,
    };
  }
}
