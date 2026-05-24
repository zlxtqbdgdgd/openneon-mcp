/**
 * pipeline.ts · feat-056 policy engine 的 enforcement pipeline (ADR-0007)
 *
 * pipeline orchestrator 拥有 §8.2 优先级链:按顺序跑 stage · 第一个 terminal Verdict 短路。
 * 5 个护栏 (feat-026/027/028/030) 作为 stage 注册进来 (registerStage) · 不各自独立拦截
 * (单一 ordering 权威 · 根治 R001 Blocker 6 "三方打架")。
 *
 * #73 (骨架 tracer bullet): 只 hard-deny G4 stage + 默认 allow。
 * 后续: #75 matrix lookup stage · #76 G1/G9 · #77 plan mode · #80 timeout。
 */
import type { OpClass } from '../protection/destructive-detector';
import { isHardDenied } from './hard-deny';
import { lookupMatrix } from './matrix';
import {
  isRateLimitedOp,
  recordAndCheckRateLimit,
  RATE_LIMIT_CONFIG,
} from './rate-limiter';

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
};

export type EnforcementCtx = {
  opClass: OpClass;
  toolName: string;
  projectId?: string; // effective (injectProjectId 后 · 审计/限流 key)
  requestedProjectId?: string; // 原始 args.projectId (injectProjectId 前 · G1 检测跨 project 意图)
  autonomyLevel: AutonomyLevel;
  grant?: { projectId?: string | null }; // key 的 project scope (G1 · null = 非 project-scoped)
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

// G9 速率限制 stage (feat-056/#76) · §8.2 第 3 步 (G4 之后) · destructive op 5min 滑窗超限 → deny
// (hard-deny · 防 agent 批量删 · R10 Cursor 9 秒删库)。注: 有 in-memory counter 副作用 (rate-limit 本质)。
const g9RateLimitStage: Stage = (ctx) => {
  if (!isRateLimitedOp(ctx.opClass)) return null; // 只读/建索引/分支 不计
  const key = ctx.grant?.projectId ?? ctx.projectId ?? 'global';
  if (recordAndCheckRateLimit(key)) {
    return {
      action: 'deny',
      reason: `destructive ops 速率超限 (G9 · >${RATE_LIMIT_CONFIG.MAX_DESTRUCTIVE}/${RATE_LIMIT_CONFIG.WINDOW_MS / 60000}min) · hard-deny`,
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
  // cell === 'require_plan': feat-027 plan mode (#77) 实现**前** fail-closed deny —— 没有审批
  // 机制就不放行写 (保守);#77 后由 plan stage 接管 elicitation 审批放行。
  return {
    action: 'deny',
    reason: `${ctx.opClass} @ ${ctx.autonomyLevel} 需 plan mode 审批 · feat-027 (#77) 实现前 fail-closed`,
    audit_severity: 'medium',
    terminal: true,
  };
};

// §8.2 顺序 stage 链 · 内置: G1 跨project (#76) → G4 hard-deny (#73) → G9 速率 (#76) → matrix (#75)
// · 后续护栏 (feat-026/027/030) registerStage 注册
const BUILTIN_STAGES: readonly Stage[] = [
  g1CrossProjectStage,
  hardDenyG4Stage,
  g9RateLimitStage,
  matrixStage,
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
 * 按 §8.2 顺序跑 pipeline。第一个 terminal Verdict 短路返回。
 * #73: hard-deny 命中 → deny terminal · 否则 allow (per-project matrix lookup 在 #75)。
 */
export function runPipeline(ctx: EnforcementCtx): Verdict {
  for (const stage of STAGES) {
    const verdict = stage(ctx);
    if (verdict && verdict.terminal) return verdict;
    // 非 terminal verdict (require_plan / inject_timeout) 的累积处理在后续护栏 stage (#77/#80)
  }
  return {
    action: 'allow',
    reason: 'no stage denied',
    audit_severity: 'info',
    terminal: false,
  };
}
