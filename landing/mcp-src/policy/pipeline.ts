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
  projectId?: string;
  autonomyLevel: AutonomyLevel;
  grant?: { projectId?: string | null }; // key 的 project scope (G1 · #76 用 · null = 非 project-scoped)
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

// §8.2 顺序 stage 链 · #73 只 hard-deny G4 · 后续护栏 registerStage 注册自己的 stage
const STAGES: Stage[] = [hardDenyG4Stage];

/** 注册一个 stage 到链尾 (供 feat-026/027/028/030 等护栏注册自己的 stage) */
export function registerStage(stage: Stage): void {
  STAGES.push(stage);
}

/** 测试用: 重置到只含内置 hard-deny stage (清掉 registerStage 注册的 · 防测试间污染) */
export function __resetStagesForTest(): void {
  STAGES.length = 0;
  STAGES.push(hardDenyG4Stage);
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
