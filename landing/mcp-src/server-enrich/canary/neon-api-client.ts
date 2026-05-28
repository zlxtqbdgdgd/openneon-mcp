/**
 * neon-api-client.ts · feat-042/#2 (#160) · thin Neon API client for canary branches
 *
 * 设计依据: [feat-042 详设 §3.2 + Neon API integration](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-042-L3-mcp-server-branch-canary-ddl.html)
 *
 * 职责 (issue #160 验收门 1+2):
 *   - Neon API 子集调用 (createBranch / deleteBranch / listBranchesByLabel)
 *   - 复用现有 NEON_API_KEY env (跟 feat-064 既有 pattern)
 *   - 失败语义化分类 (rate_limit / 5xx / api_key_missing / network) → 上游 (canary-runner)
 *     按类型分流 outcome
 *
 * 复用约束:
 *   - 不引 @neondatabase/api-client 完整 SDK (~800 endpoint · 此处只用 3 个 · thin = 80 LOC)。
 *   - fetch 用 node 原生 (Node 18+ 必带)。
 *   - 注入式 fetcher (单测可 mock · 详 issue 160 验收门 "mock Neon API")。
 */

const NEON_API_BASE = 'https://console.neon.tech/api/v2';

// ──────────────────────────────────────────────────────────────
// 错误类型 (canary-runner 据此分流 outcome)
// ──────────────────────────────────────────────────────────────

export type NeonApiErrorKind =
  | 'api_key_missing' //   NEON_API_KEY env 未设
  | 'rate_limit' //         HTTP 429
  | 'server_error' //       HTTP 5xx
  | 'client_error' //       HTTP 4xx (非 429)
  | 'network' //            fetch 抛异常 (DNS / timeout / TLS)
  | 'parse_error'; //       响应非 JSON / schema 不符

export class NeonApiError extends Error {
  readonly kind: NeonApiErrorKind;
  readonly statusCode?: number;

  constructor(kind: NeonApiErrorKind, message: string, statusCode?: number) {
    super(message);
    this.name = 'NeonApiError';
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

// ──────────────────────────────────────────────────────────────
// 注入式 fetcher (单测可 mock)
// ──────────────────────────────────────────────────────────────

export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

const defaultFetcher: FetchLike = (url, init) =>
  fetch(url, init).then((r) => ({
    ok: r.ok,
    status: r.status,
    statusText: r.statusText,
    json: () => r.json(),
    text: () => r.text(),
  }));

// ──────────────────────────────────────────────────────────────
// 公开类型
// ──────────────────────────────────────────────────────────────

export type CanaryBranchMetadata = {
  branch_id: string;
  branch_name: string;
  /** unix-ts ms · 写 branch metadata 用 (label `purpose=canary` + `expiry_ts=<ms>`) */
  expiry_ts: number;
  /** parent_id (源 branch · canary-runner 默认从 main 拉) */
  parent_id?: string;
};

export type NeonBranchListItem = {
  id: string;
  name: string;
  parent_id?: string;
  /** 我们写的 label (purpose=canary / expiry_ts=...) */
  annotations?: Record<string, string>;
};

export type NeonApiClientOptions = {
  /** 默认从 NEON_API_KEY env 读 · 注入用于测试 */
  apiKey?: string;
  /** 默认 fetch · 注入用于测试 */
  fetcher?: FetchLike;
  /** 单次 API 调用超时 ms · 默认 30000 */
  requestTimeoutMs?: number;
  /** Neon API base URL · 默认官方 console · 测试可指本地 mock */
  baseUrl?: string;
};

export class NeonApiClient {
  private readonly apiKey: string;
  private readonly fetcher: FetchLike;
  private readonly requestTimeoutMs: number;
  private readonly baseUrl: string;

  constructor(opts: NeonApiClientOptions = {}) {
    const key = opts.apiKey ?? process.env.NEON_API_KEY ?? '';
    if (!key) {
      throw new NeonApiError(
        'api_key_missing',
        'NEON_API_KEY env not set · canary branch creation not possible',
      );
    }
    this.apiKey = key;
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.baseUrl = opts.baseUrl ?? NEON_API_BASE;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let resp;
    try {
      resp = await this.fetcher(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new NeonApiError(
        'network',
        `Neon API ${method} ${path} network error: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 429) {
      throw new NeonApiError('rate_limit', 'Neon API rate limit (429)', 429);
    }
    if (resp.status >= 500) {
      throw new NeonApiError(
        'server_error',
        `Neon API server error ${resp.status} ${resp.statusText}`,
        resp.status,
      );
    }
    if (!resp.ok) {
      const txt = await safeText(resp);
      throw new NeonApiError(
        'client_error',
        `Neon API client error ${resp.status} ${resp.statusText}: ${txt}`,
        resp.status,
      );
    }

    if (method === 'DELETE') {
      // DELETE 可能 204 no-content · 不强解 body
      return undefined as T;
    }

    try {
      return (await resp.json()) as T;
    } catch (err) {
      throw new NeonApiError(
        'parse_error',
        `Neon API ${method} ${path} response non-JSON: ${(err as Error).message}`,
      );
    }
  }

  /**
   * 创建 canary branch · annotations 含 purpose=canary + expiry_ts=<ms>。
   * Neon API: POST /projects/{project_id}/branches
   */
  async createCanaryBranch(
    projectId: string,
    opts: {
      name: string;
      parentBranchId?: string;
      expiryTsMs: number;
    },
  ): Promise<CanaryBranchMetadata> {
    type CreateBranchResp = {
      branch: {
        id: string;
        name: string;
        parent_id?: string;
      };
    };

    const body = {
      branch: {
        name: opts.name,
        parent_id: opts.parentBranchId,
        annotations: {
          purpose: 'canary',
          expiry_ts: String(opts.expiryTsMs),
        },
      },
    };

    const resp = await this.request<CreateBranchResp>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/branches`,
      body,
    );

    if (!resp?.branch?.id) {
      throw new NeonApiError('parse_error', 'createBranch resp missing branch.id');
    }

    return {
      branch_id: resp.branch.id,
      branch_name: resp.branch.name,
      parent_id: resp.branch.parent_id,
      expiry_ts: opts.expiryTsMs,
    };
  }

  /** DELETE /projects/{project_id}/branches/{branch_id} · 204 ok。 */
  async deleteBranch(projectId: string, branchId: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(
        branchId,
      )}`,
    );
  }

  /**
   * 列出 project 下 purpose=canary 的 branch · 给 canary-cron 做 retention 清理用。
   * Neon API 没原生 label 过滤 · 此处拉全部 + client-side filter (Neon 单 project branch 数
   * 通常 < 100 · 可接受)。
   */
  async listCanaryBranches(projectId: string): Promise<NeonBranchListItem[]> {
    type ListResp = {
      branches: Array<{
        id: string;
        name: string;
        parent_id?: string;
        annotations?: Record<string, string>;
      }>;
    };
    const resp = await this.request<ListResp>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/branches`,
    );
    const all = resp?.branches ?? [];
    return all.filter((b) => b.annotations?.purpose === 'canary');
  }
}

async function safeText(resp: { text: () => Promise<string> }): Promise<string> {
  try {
    return (await resp.text()).slice(0, 200);
  } catch {
    return '<unreadable>';
  }
}
