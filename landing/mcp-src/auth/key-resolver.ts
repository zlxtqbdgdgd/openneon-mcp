/**
 * key-resolver.ts · feat-029/#2 · Neon API key 的 scope 解析（key_type + project_ids）
 *
 * 设计依据 ([feat-029 详设](
 * https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-029-L2-mcp-server-token-scope-min.html))
 * + 落地 audit （issue #103 comment）：上游 mcp-server-neon 不读 `process.env.NEON_API_KEY`，所有 key
 * 经 HTTP `Authorization: Bearer` 每请求流入；本模块按 key 解析 scope，结果由 caller 缓存
 * （复用 `getApiKeys()` 5min KV cache · 见 route.ts fetchAccountDetails）。
 *
 * 解析路径（audit #103 选 C+混合）：
 *   1. `getAuthDetails()` → `auth.auth_method`
 *        - `api_key_org` → key_type = `'org'`
 *   2. `listProjects({ limit: 2 })` 推断（auth_method 为 user 时无法区分 personal vs project-scoped）：
 *        - 命中 1 个 project + 无 pagination cursor → `'project-scoped'` · project_ids = [那 1 个]
 *        - 命中 ≥2 / 有 cursor → `'personal'` · project_ids = [全部可见]
 *        - 命中 0 + 401/403 → fail-closed throw（上游 fetchAccountDetails 已经会兜成 null）
 *
 * **fail-closed 矩阵**（feat-029 §6 + issue #105）：
 *   - Neon API 401（key 无效或已 revoke）→ throw `KeyResolverError` · code = 'KEY_INVALID'
 *   - Neon API 5xx / 网络不可达 → throw `KeyResolverError` · code = 'NEON_API_UNAVAILABLE'
 *   - `listProjects` 拿不到任何信号 → throw · code = 'SCOPE_INDETERMINATE'
 *   - 任何 throw 都让 caller（route.ts verifyToken）返 undefined → withMcpAuth 401 拒请求（fail-closed）
 *
 * **不**做 ALLOW_NON_PROJECT_KEY enforcement —— 那是 grant-builder.ts + route.ts 的事。本模块只产
 * 客观信号，让上层按 policy 决定接受 / 拒。
 */
import type { Api } from '@neondatabase/api-client';
import { isAxiosError } from 'axios';
import { logger } from '../utils/logger';

export type KeyType = 'personal' | 'org' | 'project-scoped';

export type KeyScope = {
  /** Neon API key 的类型分类（feat-029 §3 key 类型识别）。 */
  keyType: KeyType;
  /**
   * key 能访问的 project id 集合：
   *   - project-scoped: 长度 1（key 绑定的那 1 个 project）
   *   - personal / org: 长度 N（用户/组织所有 project · listProjects 返回结果 · 含 cursor 时为 truncated）
   */
  projectIds: string[];
  /** key 末 4 位 · 仅用于 audit log / metric（**不**用于鉴权 · 唯一用途是事后追溯哪把 key 越权）。 */
  last4: string;
  /** scope 解析完成时间（ms）· 让 caller 决定 cache TTL 或 stale 检测。 */
  resolvedAt: number;
  /**
   * scope 是否被 truncate（listProjects 仍有未拉的 page）· 主要影响 personal/org 的 projectIds
   * 完整性 · project-scoped 永远 false。Caller 知道 truncate 后可决定走"信号不充分 fail-closed"或
   * "已知 personal/org 接受不完整 list"路径。
   */
  truncated: boolean;
};

export type KeyResolverErrorCode =
  | 'KEY_INVALID' // 401 / 403 Neon API 返回 · key 无效或 revoked
  | 'NEON_API_UNAVAILABLE' // 5xx / network · Neon API 不可达
  | 'SCOPE_INDETERMINATE'; // 调用成功但信号不足以推断 scope（防 fall-through allow）

export class KeyResolverError extends Error {
  readonly code: KeyResolverErrorCode;
  readonly httpStatus?: number;

  constructor(code: KeyResolverErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'KeyResolverError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 取末 4 位作为 audit 标识 · key 全文**永不**落 log（feat-029 §6 敏感字段） */
export function keyLast4(apiKey: string): string {
  if (!apiKey || apiKey.length < 4) return '****';
  return apiKey.slice(-4);
}

/**
 * 解析 Neon API key 的 scope 信息。
 *
 * @param neonClient 已绑 apiKey 的 client（createNeonClient(apiKey)）
 * @param apiKey 原 key 字符串（**只**用于 last4 · 不发到日志）
 * @throws {KeyResolverError} 任意 fail-closed 路径
 */
export async function resolveKeyScope(
  neonClient: Pick<Api<unknown>, 'getAuthDetails' | 'listProjects'>,
  apiKey: string,
): Promise<KeyScope> {
  const last4 = keyLast4(apiKey);

  // 步骤 1: getAuthDetails → auth_method
  let authMethod: string;
  try {
    const { data: auth } = await neonClient.getAuthDetails();
    authMethod = auth.auth_method;
  } catch (error) {
    throw toResolverError(error, 'getAuthDetails', last4);
  }

  // 步骤 2: listProjects(limit: 2) → 推断 personal / project-scoped
  let projectIds: string[];
  let truncated: boolean;
  try {
    // limit=2 + pagination cursor 信号足以区分 single-project 和 multi-project
    const res = await neonClient.listProjects({ limit: 2 });
    const projects = res.data?.projects ?? [];
    projectIds = projects.map((p) => p.id).filter((id): id is string => !!id);
    // 任何 pagination cursor 都意味着还有更多 · 视为 truncated
    truncated = Boolean(
      (res.data as { pagination?: { cursor?: string } } | undefined)?.pagination
        ?.cursor,
    );
  } catch (error) {
    throw toResolverError(error, 'listProjects', last4);
  }

  // 步骤 3: 推断 keyType
  let keyType: KeyType;
  if (authMethod === 'api_key_org') {
    keyType = 'org';
  } else if (projectIds.length === 1 && !truncated) {
    // 单 project + 没有更多 · 强烈信号是 project-scoped
    // （personal key 但用户只有 1 个 project 的歧义 audit #103 提过 · 这里仍按 project-scoped
    // 处理 —— 更严格的安全选择 · 用户实际是 personal 时也只能见自己的那 1 个 project 不会越权）
    keyType = 'project-scoped';
  } else if (projectIds.length === 0) {
    // 0 project 又非 org · 信号不足（可能是 0-project 用户 / API 返回异常）
    throw new KeyResolverError(
      'SCOPE_INDETERMINATE',
      `Cannot resolve key scope: listProjects returned 0 projects and auth_method=${authMethod} (last4=${last4})`,
    );
  } else {
    keyType = 'personal';
  }

  const scope: KeyScope = {
    keyType,
    projectIds,
    last4,
    resolvedAt: Date.now(),
    truncated,
  };
  logger.info('key-resolver · scope resolved (feat-029)', {
    keyType,
    projectCount: projectIds.length,
    truncated,
    last4,
  });
  return scope;
}

// =====================================================================================
// ADR-0021 路线 R · 自托管 · 从本地 config 解析 KeyScope (永不连官方云)
// =====================================================================================

/**
 * 是否走本地 config 解析 KeyScope (而非 cloud key 内省)。
 *
 * [ADR-0021](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/docs/adr/0021-branch-lifecycle-self-hosted-control-plane-never-official-cloud.md)
 * 永不连官方云 → 自托管部署配 `NEON_GRANT_PROJECT_IDS` 即用本地 config Grant 源 · 未配则退回
 * cloud `resolveKeyScope` (legacy · 待 ADR-0021 待解 §6 自建 CP 凭证模型落地后收成单一自托管路径)。
 * **默认行为不变** —— 不配 `NEON_GRANT_PROJECT_IDS` 的现有部署仍走原 cloud 路径。
 */
export function shouldResolveScopeFromConfig(): boolean {
  return Boolean(process.env.NEON_GRANT_PROJECT_IDS);
}

/**
 * 从本地 config 解析 KeyScope (ADR-0021 路线 R · 自托管 · 不调任何 cloud API · 零网络)。
 *
 *   NEON_GRANT_PROJECT_IDS = 逗号分隔 project id (该自托管部署服务的 project)。
 *     - 1 个 → 'project-scoped' (G1 floor 把 blast radius 锁到那 1 个)
 *     - 多个 → 'personal' (多 project · 需配套 ALLOW_NON_PROJECT_KEY)
 *
 * G1 跨 project hard-deny floor (grant-builder.decideKeyAcceptance) 逻辑**一行不动** —— 它只消费
 * KeyScope · 不在乎 scope 是云内省来的还是 config 来的。这正是 ADR-0021 路线 R 的核心: 换来源不动 floor。
 *
 * @param apiKey 原 key 字符串 (只用于 last4 · 不落 log · 不发任何网络)
 * @throws {KeyResolverError} NEON_GRANT_PROJECT_IDS 空 → SCOPE_INDETERMINATE (fail-closed)
 */
export function resolveKeyScopeFromConfig(apiKey: string): KeyScope {
  const last4 = keyLast4(apiKey);
  const projectIds = (process.env.NEON_GRANT_PROJECT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (projectIds.length === 0) {
    throw new KeyResolverError(
      'SCOPE_INDETERMINATE',
      `NEON_GRANT_PROJECT_IDS empty · 自托管 KeyScope 无法解析 (last4=${last4})`,
    );
  }
  const keyType: KeyType =
    projectIds.length === 1 ? 'project-scoped' : 'personal';
  logger.info(
    'key-resolver · scope resolved from config (ADR-0021 路线 R · 自托管)',
    { keyType, projectCount: projectIds.length, last4 },
  );
  return {
    keyType,
    projectIds,
    last4,
    resolvedAt: Date.now(),
    truncated: false,
  };
}

function toResolverError(
  error: unknown,
  endpoint: string,
  last4: string,
): KeyResolverError {
  if (isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return new KeyResolverError(
        'KEY_INVALID',
        `Neon API rejected key on ${endpoint} (status=${status} · last4=${last4})`,
        status,
      );
    }
    if (status && status >= 500) {
      return new KeyResolverError(
        'NEON_API_UNAVAILABLE',
        `Neon API ${endpoint} returned ${status} (last4=${last4})`,
        status,
      );
    }
    // 网络层（无 response）· 或其他 4xx
    return new KeyResolverError(
      'NEON_API_UNAVAILABLE',
      `Neon API ${endpoint} call failed: ${error.message} (last4=${last4})`,
      status,
    );
  }
  return new KeyResolverError(
    'NEON_API_UNAVAILABLE',
    `Neon API ${endpoint} threw non-axios error: ${(error as Error)?.message ?? error} (last4=${last4})`,
  );
}
