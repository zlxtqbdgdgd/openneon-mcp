/**
 * pipeline.ts · feat-056 policy engine 的 enforcement pipeline (ADR-0007)
 *
 * pipeline orchestrator 拥有 §8.2 优先级链:按顺序跑 stage · 第一个 terminal Verdict 短路。
 * 5 个护栏 (feat-026/027/028/030) 作为 stage 注册进来 (registerStage) · 不各自独立拦截
 * (单一 ordering 权威 · 根治 R001 Blocker 6 "三方打架")。
 *
 * #73 (骨架 tracer bullet): 只 hard-deny G4 stage + 默认 allow。
 * 后续: #75 matrix lookup stage · #76 G1/G9 · #77 plan mode · #79/#80 timeout。
 */
import type { OpClass } from '../protection/destructive-detector';
import { isHardDenied } from './hard-deny';
import { lookupMatrix } from './matrix';
import {
  isRateLimitedOp,
  recordAndCheckRateLimit,
  DEFAULT_RATE_COUNTER_CONFIG,
  type RateCounterConfig,
} from './rate-limiter';
import {
  timeoutInjectionStage,
  type TimeoutSpec,
} from './stages/timeout-injection';
import {
  planModeStage,
  type PlanPayload,
  type CanaryEvidence,
} from './stages/plan-mode';
import { confirmTokenStage } from './stages/confirm-token';
import type { ConfirmTokenSnapshot } from './confirm-token-store';

export type AutonomyLevel = 'L1' | 'L2a' | 'L2b' | 'L3' | 'L4';

export type VerdictAction =
  | 'allow'
  | 'deny'
  | 'require_plan'
  | 'require_confirm'
  | 'inject_timeout';

export type Verdict = {
  action: VerdictAction;
  reason: string;
  audit_severity: 'info' | 'medium' | 'high';
  terminal: boolean; // true → pipeline 终止 (§8.2 先到先终止)
  // feat-030/#79: inject_timeout verdict 携带要注入的 timeout (orchestrator 执行 SQL 前 SET · 详设 §4.3)
  timeouts?: TimeoutSpec;
  // feat-027/#2: require_plan verdict 携带 server 事实 plan (orchestrator 弹 elicitInput 审批 · 详设 §4.3)
  plan?: PlanPayload;
};

export type EnforcementCtx = {
  opClass: OpClass;
  toolName: string;
  projectId?: string; // effective (injectProjectId 后 · 审计/限流 key)
  requestedProjectId?: string; // 原始 args.projectId (injectProjectId 前 · G1 检测跨 project 意图)
  autonomyLevel: AutonomyLevel;
  grant?: { projectId?: string | null }; // key 的 project scope (G1 · null = 非 project-scoped)
  // feat-030/#79: per-project op-class → timeout 覆盖 (来自 policy.yaml timeout_overrides · loader 校验过)
  timeoutOverrides?: Partial<Record<OpClass, TimeoutSpec>>;
  // feat-027/#2: 原始 SQL (run_sql 写路径 · plan-mode stage 组 plan payload 用 · 只读 op 可空)
  sql?: string;
  // feat-026/#1: confirm token snapshot (orchestrator 在 plan-mode approve 后注入 ·
  // step 7 confirm-token stage 消费 · 详 confirm-token-store.ts + ADR-0008)
  confirmToken?: ConfirmTokenSnapshot;
  // feat-055/#1: per-project G9 rate counter 配置 (来自 resolvePolicy().rate_counter · loader 已 clamp
  // 到 CONFIG_BOUNDS)· 缺省 → DEFAULT_RATE_COUNTER_CONFIG (day-one 5/5min/0.8 口径)。
  // TODO(feat-056): 从 resolvePolicy().rate_counter 注入 per-project 配置 · 接线前此字段恒为 undefined。
  rateCounterConfig?: RateCounterConfig;
  // feat-042/#3 (#162): 上游 branch_canary_ddl 调用结果透传 (verdict + metrics) · plan-mode renderPlan
  // 渲染 canary 证据段给 DBA。orchestrator 调 pipeline 时如果识别到 agent 前一步刚跑了
  // branch_canary_ddl + 当前 run_sql 是同一条 DDL · 注入此字段给 DBA 看完整证据链 · 不强制
  // (向后兼容 · 缺省 undefined · 接线侧在 route.ts · 此处只暴露字段)。
  canaryEvidence?: CanaryEvidence;
};

/** stage: 适用则返回 Verdict · 不适用返回 null (继续下一 stage) */
export type Stage = (ctx: EnforcementCtx) => Verdict | null;

// G4 hard-deny stage · 常开 (任何 autonomy_level) · 读 hard-deny.ts 编译期常量 (不读 policy)
const hardDenyG4Stage: Stage = (ctx) => {
  if (isHardDenied(ctx.opClass)) {
    return {
      action: 'deny',
      reason: `${ctx.opClass} 命中 hard-deny · 任何 L 级别都不允许 (ADR-0007)`,
      audit_severity: 'high',
      terminal: true,
    };
  }
  return null;
};

// G1 跨 project stage (feat-056/#76) · §8.2 第 1 步 · 原始请求 projectId ≠ key scope → deny+alert
// (显式拒越权 · 比 injectProjectId 静默覆盖更明确 · hard-deny · 任何 L 不可禁 · ADR-0007)
const g1CrossProjectStage: Stage = (ctx) => {
  const scope = ctx.grant?.projectId;
  if (scope && ctx.requestedProjectId && scope !== ctx.requestedProjectId) {
    return {
      action: 'deny',
      reason: `跨 project 越权: 请求 ${ctx.requestedProjectId} · key scope ${scope} (G1 hard-deny)`,
      audit_severity: 'high',
      terminal: true,
    };
  }
  return null;
};

// G9 速率限制 stage (feat-056/#76 · feat-055/#1 升级) · §8.2 第 3 步 (G4 之后) · 调 feat-055 rate counter
// 拿结构化 Verdict (OK / WARN / EXCEEDED) · EXCEEDED → 翻译成 terminal hard-deny。
// (防 agent 批量删 · R10 Cursor 9 秒删库)。注: counter 有 in-memory 副作用 (rate-limit 本质) +
// WARN/EXCEEDED 的 audit emit 在 counter 内部 (本 stage 只翻译决策 · ADR-0007 边界:counter 不拥有 deny)。
const g9RateLimitStage: Stage = (ctx) => {
  if (!isRateLimitedOp(ctx.opClass)) return null; // 只读/建索引/分支 不计
  const projectId = ctx.grant?.projectId ?? ctx.projectId ?? 'global';
  // TODO(feat-056): 从 resolvePolicy().rate_counter 注入 per-project 配置。
  // 在 feat-056 接线前 ctx.rateCounterConfig 永远是 undefined · 这里恒走 DEFAULT_RATE_COUNTER_CONFIG
  // (day-one 5/5min/0.8 口径)· per-project / policy.yaml 可调能力此前不生效。
  const config = ctx.rateCounterConfig ?? DEFAULT_RATE_COUNTER_CONFIG;
  const verdict = recordAndCheckRateLimit({
    projectId,
    opClass: ctx.opClass,
    config,
  });
  // OK / WARN 都不拦 (WARN 仅 audit 信号 · 已在 counter 内 emit) · 仅 EXCEEDED 翻译成 hard-deny。
  if (verdict.outcome === 'EXCEEDED') {
    return {
      action: 'deny',
      reason: `G9 rate limit exceeded · weighted=${verdict.weightedCount}/${verdict.maxUnits} in last ${verdict.windowMs / 60000}min · hard-deny`,
      audit_severity: 'high',
      terminal: true,
    };
  }
  return null;
};

// matrix stage (feat-056/#75) · hard-deny 之后 · 按 §8.1 矩阵 + per-project autonomy_level 判 verdict
const matrixStage: Stage = (ctx) => {
  const cell = lookupMatrix(ctx.opClass, ctx.autonomyLevel);
  if (cell === 'allow') return null; // 继续 (默认 allow)
  if (cell === 'deny') {
    return {
      action: 'deny',
      reason: `${ctx.opClass} @ ${ctx.autonomyLevel} = deny (§8.1 矩阵)`,
      audit_severity: 'medium',
      terminal: true,
    };
  }
  // cell === 'require_plan': feat-027/#2 起由 planModeStage 接管 (组 plan + orchestrator elicitation)。
  // matrix 此处放行下游 (null) · planModeStage 紧随其后产出 require_plan verdict。
  // 安全前提: planModeStage 恒在 BUILTIN_STAGES 内 (require_plan 永不漏成 allow · 且 orchestrator 对
  // require_plan 不支持/超时 fail-closed deny · ADR-0008)。
  return null;
};

// §8.2 顺序 stage 链 · 内置: G1 跨project (#76) → G4 hard-deny (#73) → G9 速率 (#76) → matrix (#75)
// → plan mode (#77 · 第 6 步 · require_plan non-terminal) → confirm-token (feat-026/#1 · 第 7 步)
// → timeout 注入 (#79 · 第 8 步 · non-terminal)。
const BUILTIN_STAGES: readonly Stage[] = [
  g1CrossProjectStage,
  hardDenyG4Stage,
  g9RateLimitStage,
  matrixStage,
  planModeStage,
  confirmTokenStage,
  timeoutInjectionStage,
];
const STAGES: Stage[] = [...BUILTIN_STAGES];

/** 注册一个 stage 到链尾 (供 feat-026/027/028/030 等护栏注册自己的 stage) */
export function registerStage(stage: Stage): void {
  STAGES.push(stage);
}

/** 测试用: 重置到只含内置 stage (清掉 registerStage 注册的 · 防测试间污染) */
export function __resetStagesForTest(): void {
  STAGES.length = 0;
  STAGES.push(...BUILTIN_STAGES);
}

/**
 * 按 §8.2 顺序跑 pipeline。第一个 terminal Verdict 短路返回 (deny 先到先终止)。
 * 无 terminal 时按优先级返回 non-terminal gating verdict:
 *   require_plan (#77 · 需 orchestrator elicitation 审批 · 门禁) > inject_timeout (#79 · 执行前 SET) > allow。
 * require_plan 优先于 inject_timeout —— 审批 (第 6 步) 在 timeout 注入 (第 8 步) 之前 · 未批准不应执行。
 */
export function runPipeline(ctx: EnforcementCtx): Verdict {
  let requirePlan: Verdict | null = null; // #77 · 门禁 (orchestrator 弹 elicitation)
  let injectTimeout: Verdict | null = null; // #79 · 执行前注入
  for (const stage of STAGES) {
    const verdict = stage(ctx);
    if (!verdict) continue;
    if (verdict.terminal) return verdict;
    if (verdict.action === 'require_plan') requirePlan = verdict;
    else if (verdict.action === 'inject_timeout') injectTimeout = verdict;
  }
  return (
    requirePlan ??
    injectTimeout ?? {
      action: 'allow',
      reason: 'no stage denied',
      audit_severity: 'info',
      terminal: false,
    }
  );
}
