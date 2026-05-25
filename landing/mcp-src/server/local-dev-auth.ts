/**
 * local-dev-auth.ts · 自托管 dev MCP auth 旁路 (NEON_LOCAL_URL gate)。
 *
 * 上游 openneon-mcp 是 OAuth-protected SaaS form-factor: MCP transport 的 `withMcpAuth` 强制要
 * Neon Cloud bearer (OAuth token / Neon API key)。自托管开源形态 (neon_local · 无 Neon 云账号) 下
 * 这把鉴权接不上 —— 本模块在 `NEON_LOCAL_URL` set 时 (= 自托管 dev · 非生产) 跳过 Neon Cloud 鉴权,
 * 返回 synthetic 本地身份,让 MCP transport 在无 Neon key 下可连。
 *
 * **安全**:危险操作的把关**不靠 authN**,靠 feat-056 policy engine (按 policy.yaml 的 L 级别 +
 * hard-deny · server enforcement = 硬权威) —— auth 与 enforcement 正交。本旁路严格 `NEON_LOCAL_URL`
 * gate (同 feat-062 local-call 约束:**production 部署绝不 set 该 env**,否则鉴权敞口)。
 *
 * 这是"自托管鉴权 form-shift"(authN 委托客户 IdP / authZ=policy engine / DB 连接=部署侧) 的第一步 ·
 * 完整形态设计待单独 feature + ADR。
 */
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { DEFAULT_GRANT } from '../utils/grant-context';
import type { AppContext } from '../types/context';

/** 自托管 dev auth 旁路是否启用 (NEON_LOCAL_URL gate · production 绝不 set)。 */
export function isLocalDevAuthEnabled(): boolean {
  return !!process.env.NEON_LOCAL_URL;
}

/**
 * synthetic 本地身份 (自托管 dev · 无 Neon Cloud 鉴权)。downstream getAuthContext 读 extra.apiKey/
 * account;run_sql 等真打 Neon Management API 的 tool 仍会因 dummy key 失败,但 plan mode 等
 * enforcement 在 toolHandler **之前**跑 (feat-056 pipeline),不受影响。
 */
export function buildLocalDevAuthInfo(
  req: Request,
  bearerToken: string | undefined,
  userAgent: string | undefined,
): AuthInfo {
  // /api/mcp · /mcp → streamable ('stream') · /api/sse · /sse → 'sse'
  const transport: AppContext['transport'] = new URL(req.url).pathname.endsWith(
    '/mcp',
  )
    ? 'stream'
    : 'sse';
  return {
    token: bearerToken ?? 'local-dev',
    scopes: ['*'],
    clientId: 'local-dev',
    extra: {
      account: {
        id: 'local-dev',
        name: 'Local Dev',
        email: 'dev@localhost',
        isOrg: false,
      },
      apiKey: bearerToken ?? 'local-dev',
      readOnly: false,
      grant: DEFAULT_GRANT,
      transport,
      userAgent,
    },
  };
}
