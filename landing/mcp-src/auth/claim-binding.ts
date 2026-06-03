/**
 * claim-binding.ts · feat-060/#2 (#130) · per-call JWT claim 绑定 tool 参数 · 4-outcome 矩阵
 *
 * 设计依据: [feat-060 详设 §3 调用链 + §4 schema](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-060-L2-mcp-server-claim-binding.html)
 *
 * 责任:
 * - 扫描 tool param schema 找 \`fromClaim\` 声明 (per-tool · 声明式)
 * - 拿对应 JWT (header MCP-Auth-<service> 形式) → 调 verifyJWT (#129)
 * - 从 verified payload 取 claim 值 → 跟 agent 传的 args 比对
 * - 翻成 4-outcome (per §4 矩阵): pass / override / deny_missing / deny_invalid
 * - emit \`claim_override\` audit event (走 feat-031 emitAuditEvent · single source)
 * - 强制覆盖 agent 传入值 (override 路径) · 让 server JWT.sub 是最终事实 · 不让 agent 越权
 *
 * 不做 (out of scope):
 * - JWT verify 自身 (那是 #129 的 verifyJWT)
 * - SQL parse 验 WHERE 谓词 (那是 #131 run_sql + libpg-query slice)
 * - tool param schema 定义本身 (那是 tool registration 的事 · 本中间件只读 schema)
 *
 * 调用方 (route.ts middleware · 串在 feat-029 API Key check 之后 / feat-056 pipeline 之前):
 *   const result = await bindClaims({ toolName, toolSchema, args, headers, projectId });
 *   if (result.outcome === 'deny_missing' || result.outcome === 'deny_invalid') {
 *     // 翻成 HTTP 401/403 + 结构化错误 · audit 已 emit
 *     throw new ClaimBindingDeny(result);
 *   }
 *   // result.outcome === 'pass' | 'override' → 用 result.boundArgs 继续 dispatch
 */
import type { JWTPayload } from 'jose';
import { verifyJWT } from './jwt-verify';
import {
  JwtMissing,
  JwtVerifyError,
  AuthServiceUnknown,
} from './jwt-verify-errors';
import { getProjectAuthServices } from '../policy/loader';
import { emitAuditEvent } from '../observability/audit-emit';
import { isLocalDevAuthEnabled } from '../server/local-dev-auth';

/**
 * tool param schema 里的 \`fromClaim\` 声明 (per 详设 §4.2)。
 *
 * 例: \`user_id: { type: 'integer', fromClaim: { service: 'saas-app-oidc', field: 'sub' } }\`
 */
export type FromClaimSpec = {
  /** policy.yaml authServices 字典里的 key (e.g. "saas-app-oidc") */
  service: string;
  /** JWT payload 里的 claim 名 (e.g. "sub" / "email" / 自定义 claim) */
  field: string;
};

/**
 * tool param schema · 本中间件只读它的 \`fromClaim\` 标注 · 不参与 schema 校验自身。
 *
 * 形态参考详设 §4.2 · 跟 zod / json-schema 兼容 (top-level properties 字典 · 每个 prop 可标 fromClaim)。
 */
export type ToolInputSchema = {
  properties?: Record<
    string,
    {
      fromClaim?: FromClaimSpec;
      [key: string]: unknown;
    }
  >;
};

export type ClaimBindingOutcome =
  | 'pass' // agent 未传 OR 传值跟 claim 一致 · audit low
  | 'override' // agent 传值 != claim · server 用 claim 强制覆盖 · audit high
  | 'deny_missing' // JWT 缺 / claim 缺 / authService 未配 · audit medium
  | 'deny_invalid'; // JWT 签名/过期/aud/iss/jwks · audit high

export type ClaimBindingResult = {
  outcome: ClaimBindingOutcome;
  /** override 后的 args (outcome=pass/override 时有效 · deny 时 undefined) */
  boundArgs?: Record<string, unknown>;
  /** deny 时的 detail (供 caller 翻 HTTP error message · audit 已 emit) */
  denyDetail?: {
    code: string; // jwt-verify-errors.ts 里的 code
    severity: 'medium' | 'high';
    message: string;
  };
};

/**
 * 提取 header 里的 JWT · header 名形态 \`MCP-Auth-<authServiceName>\` (per 详设 §3 · 跟 Google MCP Toolbox 同源)。
 *
 * 不存在 → 返 undefined (调用方按是否声明 fromClaim 翻 deny_missing 还是直接 pass-through)。
 * 大小写不敏感 (HTTP header 规范)。
 */
function extractJwt(
  headers: Headers | Record<string, string | string[] | undefined>,
  authServiceName: string,
): string | undefined {
  const headerName = `mcp-auth-${authServiceName}`.toLowerCase();
  if (headers instanceof Headers) {
    const v = headers.get(headerName);
    return v === null ? undefined : v;
  }
  // plain object headers (Node.js req.headers)
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === headerName) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

/**
 * 收集 tool schema 里所有 fromClaim 声明 · 返 (param 名 → spec) 映射。
 *
 * 未声明 fromClaim 的 prop 不进结果 (那些 param 不走本中间件 · agent 控制)。
 */
export function collectFromClaims(
  schema: ToolInputSchema | undefined,
): Map<string, FromClaimSpec> {
  const result = new Map<string, FromClaimSpec>();
  if (!schema?.properties) return result;
  for (const [paramName, prop] of Object.entries(schema.properties)) {
    if (prop && typeof prop === 'object' && prop.fromClaim) {
      const fc = prop.fromClaim;
      if (
        fc &&
        typeof fc === 'object' &&
        typeof fc.service === 'string' &&
        typeof fc.field === 'string'
      ) {
        result.set(paramName, { service: fc.service, field: fc.field });
      }
    }
  }
  return result;
}

/**
 * 比对两个 claim 值是否一致 · 严格相等 (string === string · number === number)。
 *
 * JWT payload field 可能是 string 或 number (sub 通常是 string · email 是 string · iat 是 number)。
 * agent 传入值也是这两类。允许 number/string 跨类型比对吗?
 *   ✗ 不允许 · "42" !== 42 · 这避免微妙的类型混淆 (e.g. 防 agent 用 "42abc" 当数字传)。
 *   → 这是 fail-closed 风格 · 不一致就 override。
 */
function claimValuesMatch(
  agentValue: unknown,
  claimValue: unknown,
): boolean {
  // undefined / null: agent 未传 → 不算 mismatch (调用方按 outcome=pass 处理 · 但 boundArgs 仍注入)
  if (agentValue === undefined || agentValue === null) return true;
  return agentValue === claimValue;
}

/**
 * feat-060/#3 (#131): 沿 dot-path 取嵌套字段 (e.g. \`expected_user_filter.value\` from \`{ expected_user_filter: { value: 42 } }\`)。
 *
 * 中途任一层不是 object / 该 key 不存在 → 返 undefined。不抛错 (调用方按 undefined 处理 · agent 未传 = pass)。
 */
function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * feat-060/#3 (#131): 沿 dot-path 设置嵌套字段 · 中途缺层 → 自动建空 object。
 *
 * **重要**: 不 mutate 原 obj · 返新 shallow-cloned obj (浅克隆 path 路径上每层 · 兄弟节点共享)。
 * 防 claim-binding override 时 mutate 上游传入的 args。
 *
 * e.g. setNestedValue({a: {b: 1}}, 'a.c', 2) → {a: {b: 1, c: 2}} (原 a 对象被 clone)
 */
function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const parts = path.split('.');
  if (parts.length === 1) {
    return { ...obj, [parts[0]]: value };
  }
  const [head, ...rest] = parts;
  const child = obj[head];
  const childObj: Record<string, unknown> =
    child !== null && typeof child === 'object'
      ? (child as Record<string, unknown>)
      : {};
  return { ...obj, [head]: setNestedValue(childObj, rest.join('.'), value) };
}

/**
 * 主入口 · per tool-call 调一次。
 *
 * @param ctx.toolName tool 名 (audit 用 + log)
 * @param ctx.toolSchema tool 的 inputSchema (扫 fromClaim)
 * @param ctx.args agent 传入的 args (可能含 / 不含 fromClaim 声明的 param)
 * @param ctx.headers HTTP request headers (拉 MCP-Auth-<service> JWT)
 * @param ctx.projectId 经 feat-029 解析 / feat-056 effectiveProjectId 后的 project id (从 policy 拉 authServices)
 * @param ctx.principal audit 用 (e.g. \`agent:<key-last-4>\`)
 *
 * @returns 4-outcome + boundArgs (pass/override) 或 denyDetail (deny_*)
 */
export async function bindClaims(ctx: {
  toolName: string;
  toolSchema: ToolInputSchema | undefined;
  args: Record<string, unknown>;
  headers: Headers | Record<string, string | string[] | undefined>;
  projectId: string | undefined;
  principal: string;
}): Promise<ClaimBindingResult> {
  // ADR-0022 桶①: 自托管 dev-bypass（NEON_LOCAL_URL set · local-dev-auth.ts 已旁路 OAuth · 无真 JWT）
  // 下 claim-binding 无 claim 可绑、只会 deny_missing(PROJECT_HAS_NO_AUTH_SERVICE)，把 run_sql（唯一
  // fromClaim 工具）读写全堵死（含临时分支写 → 挡死 autopilot 在隔离分支上验证修复）。单租户自托管无
  // 跨租户风险 → 与 OAuth 旁路同一把 NEON_LOCAL_URL gate 整体旁路。hard-deny + plan-mode 仍由 feat-056
  // pipeline 在 toolHandler 之前把关（auth 与 enforcement 正交），安全不降。production 绝不 set 该 env。
  if (isLocalDevAuthEnabled()) {
    return { outcome: 'pass', boundArgs: ctx.args };
  }

  const fromClaims = collectFromClaims(ctx.toolSchema);

  // 1. 该 tool 没声明 fromClaim → 完全旁路 · 不走本 middleware · 兼容 feat-029-only 部署
  if (fromClaims.size === 0) {
    return { outcome: 'pass', boundArgs: ctx.args };
  }

  // 2. project 未配 authServices → 该 project 不应接受 fromClaim 声明的 tool 调用
  //    (deny_missing · 防 prompt injection 强制走 fromClaim 路径但 project 没 verify 能力)
  const projectAuthServices = ctx.projectId
    ? getProjectAuthServices(ctx.projectId)
    : [];
  if (projectAuthServices.length === 0) {
    const detail = {
      code: 'PROJECT_HAS_NO_AUTH_SERVICE',
      severity: 'medium' as const,
      message: `tool ${ctx.toolName} 声明了 fromClaim · 但 project ${ctx.projectId ?? '(none)'} 未配置 authServices`,
    };
    emitClaimAudit({
      ...ctx,
      outcome: 'deny_missing',
      severity: 'medium',
      extra: { reason: detail.code },
    });
    return { outcome: 'deny_missing', denyDetail: detail };
  }

  // 3. 逐个 fromClaim param 处理 · 任一 deny 立即终止 (fail-closed) · 全部 pass 或部分 override → 返合并 args
  // feat-060/#3 (#131): paramName 支持 dot-path (e.g. \`expected_user_filter.value\`) · nested set/get
  let boundArgs: Record<string, unknown> = { ...ctx.args };
  let sawOverride = false;
  const verifiedClaims: Map<string, JWTPayload> = new Map();

  for (const [paramName, spec] of fromClaims) {
    // service 必须在 project 的 authServices 列表里 (project policy 没授权该 service · deny)
    if (!projectAuthServices.includes(spec.service)) {
      const detail = {
        code: 'PROJECT_DENIES_AUTH_SERVICE',
        severity: 'medium' as const,
        message: `project ${ctx.projectId} 未授权 authService "${spec.service}" (tool ${ctx.toolName} param ${paramName})`,
      };
      emitClaimAudit({
        ...ctx,
        outcome: 'deny_missing',
        severity: 'medium',
        param: paramName,
        extra: { reason: detail.code, authService: spec.service },
      });
      return { outcome: 'deny_missing', denyDetail: detail };
    }

    // verify JWT (per-service · cache 同一 service 的 verify · 避免多个 fromClaim 反复 verify 同 JWT)
    let payload = verifiedClaims.get(spec.service);
    if (!payload) {
      const token = extractJwt(ctx.headers, spec.service);
      if (!token) {
        const err = new JwtMissing(
          `tool ${ctx.toolName} param ${paramName} 声明 fromClaim service=${spec.service} · 但请求 header MCP-Auth-${spec.service} 不存在`,
        );
        const detail = {
          code: err.code,
          severity: err.severity,
          message: err.message,
        };
        emitClaimAudit({
          ...ctx,
          outcome: 'deny_missing',
          severity: 'medium',
          param: paramName,
          extra: { reason: err.code, authService: spec.service },
        });
        return { outcome: 'deny_missing', denyDetail: detail };
      }
      try {
        payload = await verifyJWT(token, spec.service);
      } catch (err) {
        if (err instanceof JwtVerifyError) {
          const detail = {
            code: err.code,
            severity: err.severity,
            message: err.message,
          };
          emitClaimAudit({
            ...ctx,
            outcome: err.outcome,
            severity: err.severity,
            param: paramName,
            extra: { reason: err.code, authService: spec.service },
          });
          return { outcome: err.outcome, denyDetail: detail };
        }
        // 非 JwtVerifyError · 兜底当 deny_invalid · 不 fail-open
        const detail = {
          code: 'UNKNOWN_VERIFY_ERROR',
          severity: 'high' as const,
          message: `verify JWT 抛意外错: ${(err as Error).message ?? String(err)}`,
        };
        emitClaimAudit({
          ...ctx,
          outcome: 'deny_invalid',
          severity: 'high',
          param: paramName,
          extra: {
            reason: detail.code,
            authService: spec.service,
            error: (err as Error).message ?? String(err),
          },
        });
        return { outcome: 'deny_invalid', denyDetail: detail };
      }
      verifiedClaims.set(spec.service, payload);
    }

    // 取 claim 值 · 字段缺 → deny_missing
    const claimValue = (payload as Record<string, unknown>)[spec.field];
    if (claimValue === undefined || claimValue === null) {
      const detail = {
        code: 'CLAIM_FIELD_MISSING',
        severity: 'medium' as const,
        message: `JWT (service=${spec.service}) 缺 claim "${spec.field}" (tool ${ctx.toolName} param ${paramName})`,
      };
      emitClaimAudit({
        ...ctx,
        outcome: 'deny_missing',
        severity: 'medium',
        param: paramName,
        extra: { reason: detail.code, authService: spec.service, field: spec.field },
      });
      return { outcome: 'deny_missing', denyDetail: detail };
    }

    // 比对 + override · 支持 dot-path (e.g. \`expected_user_filter.value\`)
    const agentValue = getNestedValue(ctx.args, paramName);
    if (claimValuesMatch(agentValue, claimValue)) {
      // pass · 注入 boundArgs (agent 未传时把 claim 值塞进去 · 已传一致时维持)
      boundArgs = setNestedValue(boundArgs, paramName, claimValue);
    } else {
      // override · agent 传了不一致值 · 用 claim 强制覆盖 · audit high
      sawOverride = true;
      boundArgs = setNestedValue(boundArgs, paramName, claimValue);
      emitClaimAudit({
        ...ctx,
        outcome: 'override',
        severity: 'high',
        param: paramName,
        agentAttemptedValue: agentValue,
        boundValue: claimValue,
        extra: { authService: spec.service, field: spec.field },
      });
    }
  }

  // 全部 pass · 已发 audit · 出全 args
  if (!sawOverride) {
    // emit 一条 pass 级 audit (low severity · 给跟踪用 · 不刷量太大 · 一次 tool-call 1 条)
    emitClaimAudit({
      ...ctx,
      outcome: 'pass',
      severity: 'low',
      extra: { params: Array.from(fromClaims.keys()) },
    });
  }

  return {
    outcome: sawOverride ? 'override' : 'pass',
    boundArgs,
  };
}

/**
 * 走 feat-031 \`emitAuditEvent\` 落 \`claim_override\` event · 不另起 audit sink (§10.2.1 防重复)。
 *
 * 4 outcome 都走同一 event_type \`claim_override\` (feat-031 schema § audit-emit.ts 已定 · 这 4 outcome
 * 的 severity / 字段不同但 event_type 统一 · 调用方按 outcome 分流)。
 */
function emitClaimAudit(args: {
  toolName: string;
  projectId: string | undefined;
  principal: string;
  outcome: ClaimBindingOutcome;
  severity: 'low' | 'medium' | 'high';
  param?: string;
  agentAttemptedValue?: unknown;
  boundValue?: unknown;
  extra?: Record<string, unknown>;
}): void {
  emitAuditEvent({
    event_type: 'claim_override',
    outcome:
      args.outcome === 'override'
        ? 'override'
        : args.outcome === 'pass'
          ? 'allow'
          : 'deny',
    severity: args.severity,
    principal: args.principal,
    project_id: args.projectId,
    agent_attempted_value: args.agentAttemptedValue,
    bound_value: args.boundValue,
    extra: {
      tool: args.toolName,
      ...(args.param ? { param: args.param } : {}),
      ...(args.extra ?? {}),
    },
  });
}

/**
 * 测试 / 调用方便利 · 给 mock fixture 用 (本 module 自身不缓存 verify 结果 · 缓存在 jwks-cache · 这里只是别名)。
 */
export { type JWTPayload };
