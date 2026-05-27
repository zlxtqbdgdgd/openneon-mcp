/**
 * grant-builder.ts · feat-029/#2-#3 · 把 KeyScope 翻译成 GrantContext + 应用 policy gate
 *
 * 设计：[feat-029 §4 数据契约](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-029-L2-mcp-server-token-scope-min.html)
 *
 * - GrantContext 是给 feat-056 EnforcementCtx.grant 的契约
 *   （pipeline.ts:51 · `{ projectId: string | null }`）
 * - 本 feature 在 GrantContext 上**扩展** keyType / last4 字段（给 audit log · feat-031 OTel 消费），
 *   仍兼容 GrantContext 形状（projectId / scopes 字段保持原义 · feat-056 G1 stage 已就绪）。
 * - **policy gate（feat-029/#3）**：`ALLOW_NON_PROJECT_KEY=false`（默认）+ personal/org key → reject。
 *   通过 `assertKeyAllowed()` 让 caller fail-closed（throw）· enforcement 在最近的 auth 入口处发生
 *   而不是 build grant 之后再回头检查（更窄的 trust window）。
 * - **escape hatch（feat-029 §8 + #3）**：`PROJECT_SCOPE_ENFORCE_ENABLED=false` → 完全跳过 reject ·
 *   key_type 仅作 audit 标记 · grant 仍按 scope 构造（不退到全开放）。
 */
import {
  DEFAULT_GRANT,
  type GrantContext,
} from '../utils/grant-context';
import type { KeyScope, KeyType } from './key-resolver';
import { logger } from '../utils/logger';

/**
 * 扩展的 grant · 比 feat-056 EnforcementCtx 契约多带 key_type + last4 用于 audit。
 * feat-056 G1 stage 只读 `.projectId`；route.ts 写 audit log 时读 keyType / last4。
 */
export type ResolvedGrant = GrantContext & {
  /** 来自 key-resolver · personal / org / project-scoped */
  keyType: KeyType;
  /** key 末 4 位 · audit 用 · 全文不可落 log */
  last4: string;
  /** scope 解析完成时间 ms */
  resolvedAt: number;
};

export type GrantBuilderOptions = {
  /**
   * 是否启用 feat-029 项目级最小权限 enforcement。
   * - true（默认）: personal/org key + ALLOW_NON_PROJECT_KEY=false → reject
   * - false: 跳过 reject · scope 仅作 audit · 给紧急回滚 escape hatch（feat-029 §8）
   *
   * 默认从 `process.env.PROJECT_SCOPE_ENFORCE_ENABLED` 读 · `'false'` 字面值才关。
   */
  enforceProjectScope?: boolean;
  /**
   * 是否显式 opt-in 接受 personal/org key（feat-029 §3 + §4）。
   * - false（默认）: 拒 personal/org · 仅接受 project-scoped
   * - true: warn log + 接受
   *
   * 默认从 `process.env.ALLOW_NON_PROJECT_KEY` 读 · `'true'` 字面值才开。
   */
  allowNonProjectKey?: boolean;
};

/**
 * policy gate 决策：key 是否被 mcp Server 接受？
 *
 * 返回 'accept' / 'accept_with_warning' / 'reject'。caller 按结果决定走流程：
 *   - accept: 静默接受 · 构造 grant
 *   - accept_with_warning: warn log 提示 blast radius · 构造 grant
 *   - reject: throw 拒请求 / 拒启动 · 在 audit log 落 outcome=reject_non_project_key
 */
export type AcceptanceDecision =
  | { kind: 'accept' }
  | { kind: 'accept_with_warning'; reason: string }
  | { kind: 'reject'; reason: string };

export function isProjectScopeEnforceEnabled(
  override?: boolean,
): boolean {
  if (typeof override === 'boolean') return override;
  // 默认 true（feat-029 §8 紧急逃生通道才显式 'false'）
  return process.env.PROJECT_SCOPE_ENFORCE_ENABLED !== 'false';
}

export function isNonProjectKeyAllowed(override?: boolean): boolean {
  if (typeof override === 'boolean') return override;
  // 默认 false（OWASP LLM06 安全默认）· 显式 'true' 才接受
  return process.env.ALLOW_NON_PROJECT_KEY === 'true';
}

/**
 * 决定一把 key 是否允许使用 mcp Server。
 *
 * - project-scoped key: 永远 accept
 * - personal / org + ALLOW_NON_PROJECT_KEY=true: accept_with_warning
 * - personal / org + ALLOW_NON_PROJECT_KEY=false: reject（feat-029 OWASP LLM06 默认）
 * - PROJECT_SCOPE_ENFORCE_ENABLED=false: 全 accept（escape hatch · audit-only 模式）
 */
export function decideKeyAcceptance(
  scope: KeyScope,
  options: GrantBuilderOptions = {},
): AcceptanceDecision {
  const enforce = isProjectScopeEnforceEnabled(options.enforceProjectScope);
  const allowNonProject = isNonProjectKeyAllowed(options.allowNonProjectKey);

  if (scope.keyType === 'project-scoped') {
    return { kind: 'accept' };
  }
  if (!enforce) {
    // escape hatch · scope 仍记下来 · audit-only
    return {
      kind: 'accept_with_warning',
      reason: `PROJECT_SCOPE_ENFORCE_ENABLED=false · ${scope.keyType} key accepted in audit-only mode`,
    };
  }
  if (allowNonProject) {
    return {
      kind: 'accept_with_warning',
      reason: `${scope.keyType} key accepted via ALLOW_NON_PROJECT_KEY=true · cross-project blast radius warning`,
    };
  }
  return {
    kind: 'reject',
    reason:
      `${scope.keyType} Key rejected · mcp Server requires Project-scoped Key by default. ` +
      'Options: (a) Create a Project-scoped Key at ' +
      'https://console.neon.tech/<project>/settings/api-keys · ' +
      '(b) opt-in via ALLOW_NON_PROJECT_KEY=true (warns about cross-project blast radius)',
  };
}

/**
 * 拒-key 错误 · 给 caller throw 用 · 含 fail-closed 必要 audit 字段（key_type + last4）。
 */
export class KeyNotAcceptedError extends Error {
  readonly keyType: KeyType;
  readonly last4: string;
  readonly outcome:
    | 'reject_personal_key'
    | 'reject_org_key';

  constructor(scope: KeyScope, message: string) {
    super(message);
    this.name = 'KeyNotAcceptedError';
    this.keyType = scope.keyType;
    this.last4 = scope.last4;
    this.outcome =
      scope.keyType === 'org' ? 'reject_org_key' : 'reject_personal_key';
  }
}

/**
 * 把解析好的 KeyScope 翻译成 ResolvedGrant + 应用 policy gate。
 *
 * @throws {KeyNotAcceptedError} ALLOW_NON_PROJECT_KEY=false + 非 project-scoped key（默认）
 */
export function buildGrantFromScope(
  scope: KeyScope,
  options: GrantBuilderOptions = {},
): ResolvedGrant {
  const decision = decideKeyAcceptance(scope, options);
  switch (decision.kind) {
    case 'reject': {
      logger.error('key-resolver · key rejected (feat-029 fail-closed)', {
        keyType: scope.keyType,
        last4: scope.last4,
        outcome:
          scope.keyType === 'org' ? 'reject_org_key' : 'reject_personal_key',
        reason: decision.reason,
      });
      throw new KeyNotAcceptedError(scope, decision.reason);
    }
    case 'accept_with_warning': {
      logger.warn('key-resolver · non-project key accepted (feat-029)', {
        keyType: scope.keyType,
        last4: scope.last4,
        projectCount: scope.projectIds.length,
        reason: decision.reason,
      });
      break;
    }
    case 'accept': {
      // silent
      break;
    }
  }

  // project-scoped: projectId 锁定到那 1 个 · feat-056 G1 stage 用它跟 requested 比对
  // personal/org: projectId=null（=不锁单 project · feat-056 G1 不阻拦 · 配套 ALLOW=true 才走到这里）
  const projectId =
    scope.keyType === 'project-scoped' && scope.projectIds.length === 1
      ? scope.projectIds[0]
      : null;

  return {
    ...DEFAULT_GRANT,
    projectId,
    keyType: scope.keyType,
    last4: scope.last4,
    resolvedAt: scope.resolvedAt,
  };
}

/**
 * 把 URL search params / OAuth token 中的 GrantContext 合并到 ResolvedGrant 上。
 *
 * 优先级（保守原则 · 取交集）：
 *   - projectId: key scope > URL param · 若两者都有且不一致 → 用 key scope（feat-056 G1 会再拦）
 *   - scopes: URL param > key scope（key scope 不含 scopes 字段）· 用户用 ?category= 主动收窄是合法
 */
export function mergeResolvedGrant(
  resolved: ResolvedGrant,
  fromRequest: GrantContext,
): ResolvedGrant {
  return {
    ...resolved,
    // project-scoped key 的 projectId 优先 · 防 URL param 提升 scope
    projectId: resolved.projectId ?? fromRequest.projectId ?? null,
    scopes: fromRequest.scopes ?? resolved.scopes ?? null,
  };
}
