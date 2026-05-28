/**
 * AutosuspendEventFetchAdapter · feat-040 (L3) sub-interface · 拉 Neon control plane 上的
 * compute autosuspend / wake 事件 · 转成 [start, end) windows · 供 sample-filter.ts 排除 sample。
 *
 * 详设: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-040-L3-mcp-server-enrich-baseline-autosuspend-exclusion.html §3.2 + §3.5
 * 父 issue: zlxtqbdgdgd/openneon-design#49 · 子 issue: zlxtqbdgdgd/openneon-mcp#152
 *
 * 责任 (#152 验收门):
 *   - sub-interface 定义 (跟 feat-066 TraceFetchAdapter 同 pattern · NOT 强加到 ObservabilityAdapter)
 *   - 双模式 NEON_CONTROL_PLANE_MODE = 'cloud' | 'oss' · 切 base URL (商用 api.neon.tech vs 开源 control_plane)
 *   - 独立凭证 NEON_API_TOKEN (不复用 Datadog · 走 Neon API token)
 *   - getAutosuspendWindows(endpoint_id, project_id, time_range) → AutosuspendWindow[]
 *   - ttl-cache · TTL 1h · key = autosuspend:{project_id}:{endpoint_id}:{since}_{until}
 *   - feat-064 / feat-066 消费方零影响 · 本 sub-interface 独立 · 不掺 MetricHistoryAdapter
 *
 * 接口契约 (跟 sample-filter.ts 4 baseline 算法约定):
 *   AutosuspendWindow.start / end · unix 秒 · 半开 [start, end)
 *   adapter 返 windows · 由 sample-filter.filterAutosuspendWindows 双指针排除
 *
 * 跨 tenant 安全 (#151):
 *   request 必带 project_id · cache key 含 project_id · feat-060 claim binding 自动从 JWT 拿
 *   current_project_id (调用方 route.ts middleware 已 enforce · 本 module 只透传)。
 *
 * Aurora / 无 autosuspend 概念的 DB:
 *   adapter 直接返 `{ windows: [] }` (no-op) · sample-filter 自动旁路 · 跨 DB code-reusable。
 */

import { TtlCache, type Clock } from '../ttl-cache';
import { logger } from '../../utils/logger';

/** 半开区间 [start, end) · unix 秒 · 跟 MetricHistory.points 同时间单位。 */
export type AutosuspendWindow = {
  /** unix-second · autosuspend 段起点 (compute 停 metric emit 时刻) */
  start: number;
  /** unix-second · autosuspend 段终点 (compute wake metric resume 时刻) · 半开 */
  end: number;
};

export type AutosuspendEventsRequest = {
  /** Neon endpoint id (compute primary endpoint · 跟 Neon API 同口径) */
  endpoint_id: string;
  /** Neon project id · 跨 tenant 隔离边界 (feat-060 claim binding 强制) */
  project_id: string;
  /** unix-second · 拉事件的时间范围起点 */
  since: number;
  /** unix-second · 拉事件的时间范围终点 */
  until: number;
};

export type AutosuspendEventsSuccess = {
  windows: AutosuspendWindow[];
};

export type AutosuspendEventsError = {
  error: {
    reason: 'unreachable' | 'auth' | 'rate_limited' | 'backend_error';
    detail?: string;
  };
};

export type AutosuspendEventsResult =
  | AutosuspendEventsSuccess
  | AutosuspendEventsError;

/** Narrowing helper · true when fetch failed (跟 MetricHistory isMetricHistoryError 同 pattern)。 */
export function isAutosuspendEventsError(
  r: AutosuspendEventsResult,
): r is AutosuspendEventsError {
  return (r as AutosuspendEventsError).error !== undefined;
}

/**
 * sub-interface · 跟 feat-066 TraceFetchAdapter 同 pattern · NOT 强 ObservabilityAdapter union 一员。
 *
 * 调用方按 `Partial<AutosuspendEventFetchAdapter>` 组合 (有则用 · 无则 fallback no-op windows)。
 */
export type AutosuspendEventFetchAdapter = {
  getAutosuspendWindows: (
    req: AutosuspendEventsRequest,
  ) => Promise<AutosuspendEventsResult>;
};

// =====================================================================================
// Neon control plane API 双模式 · cloud (商用) / oss (开源 control_plane)
// =====================================================================================

export type NeonControlPlaneMode = 'cloud' | 'oss';

export type NeonControlPlaneConfig = {
  /** 模式 · 'cloud' = api.neon.tech · 'oss' = 自部 control_plane */
  mode: NeonControlPlaneMode;
  /** API base URL (oss 必传 · cloud 用 api.neon.tech 默认) */
  baseUrl: string;
  /** Neon API token · 走 Authorization: Bearer · 不复用 Datadog 凭证 (#152) */
  apiToken: string;
};

/**
 * Env vars:
 *   NEON_CONTROL_PLANE_MODE = 'cloud' | 'oss' · 默 'cloud'
 *   NEON_API_BASE_URL       = 自定义 base (oss 模式必填 · cloud 默 'https://console.neon.tech/api/v2')
 *   NEON_API_TOKEN          = Neon API token (per-project / Personal token)
 *
 * 凭证 null 时 adapter 返 auth error · 不 throw · fail-closed (跟 datadog-adapter 同 pattern)。
 */
export function readNeonControlPlaneConfig(): NeonControlPlaneConfig | null {
  const mode = (process.env.NEON_CONTROL_PLANE_MODE ?? 'cloud') as
    | NeonControlPlaneMode
    | string;
  const apiToken = process.env.NEON_API_TOKEN;
  if (!apiToken) return null;
  if (mode !== 'cloud' && mode !== 'oss') {
    logger.warn(
      `[autosuspend-events] NEON_CONTROL_PLANE_MODE=${mode} 非法 · fallback 'cloud'`,
    );
  }
  const resolvedMode: NeonControlPlaneMode = mode === 'oss' ? 'oss' : 'cloud';
  const defaultBase =
    resolvedMode === 'cloud'
      ? 'https://console.neon.tech/api/v2'
      : 'http://localhost:7000/api/v1'; // oss control_plane 默
  const baseUrl = process.env.NEON_API_BASE_URL || defaultBase;
  return { mode: resolvedMode, baseUrl, apiToken };
}

type ConsoleOperationsResp = {
  operations?: Array<{
    action?: string;
    endpoint_id?: string;
    created_at?: string;
    finished_at?: string;
    status?: string;
  }>;
};

/**
 * cloud 模式 Neon Console API · 拉 endpoint operations · action 'suspend_compute' 段开始 ·
 * 接下来 'start_compute' / 'apply_config' 段结束。
 *
 * cloud API 文档: https://api-docs.neon.tech/reference/listprojectoperations
 * (NOTE · 真实 API 字段以 prod 为准 · 本 mapping 跟 console.neon.tech v2 一致)。
 *
 * oss 模式 control_plane 自部 schema 可能略不同 · 本函数按 cloud schema 解析 · oss 部署需保持
 * 字段名一致 (control_plane 已有 operations 概念) · 不一致时上游 adapter 二次 mapping。
 */
function parseConsoleOperations(
  body: ConsoleOperationsResp,
  endpoint_id: string,
  since: number,
  until: number,
): AutosuspendWindow[] {
  const ops = (body.operations ?? []).filter(
    (o) => o.endpoint_id === endpoint_id,
  );
  // 按时间升序
  const sorted = [...ops].sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) / 1000 : 0;
    const tb = b.created_at ? Date.parse(b.created_at) / 1000 : 0;
    return ta - tb;
  });
  const windows: AutosuspendWindow[] = [];
  let pendingSuspendStart: number | null = null;
  for (const op of sorted) {
    if (!op.created_at) continue;
    const ts = Date.parse(op.created_at) / 1000;
    if (ts < since - 86400 || ts > until + 86400) continue; // ±1 天 margin
    if (op.action === 'suspend_compute' && op.status === 'finished') {
      // finished_at 是 suspend 完成时刻 · 也就是 metric 停 emit 的起点
      const startTs = op.finished_at ? Date.parse(op.finished_at) / 1000 : ts;
      pendingSuspendStart = startTs;
    } else if (
      pendingSuspendStart !== null &&
      (op.action === 'start_compute' || op.action === 'apply_config')
    ) {
      windows.push({ start: pendingSuspendStart, end: ts });
      pendingSuspendStart = null;
    }
  }
  // 未闭合的 suspend · 假设到 until 时刻仍在 autosuspend
  if (pendingSuspendStart !== null) {
    windows.push({ start: pendingSuspendStart, end: until });
  }
  return windows;
}

/**
 * Neon control plane adapter 默认实现 · cloud / oss 双模式 ·
 * 双模式只切 base URL · 字段 schema 相同 (oss control_plane 跟 cloud 同源)。
 */
export function createNeonControlPlaneAdapter(
  config?: NeonControlPlaneConfig | null,
  fetchImpl: typeof fetch = fetch,
): AutosuspendEventFetchAdapter {
  return {
    async getAutosuspendWindows(
      req: AutosuspendEventsRequest,
    ): Promise<AutosuspendEventsResult> {
      const cfg = config ?? readNeonControlPlaneConfig();
      if (!cfg) {
        return {
          error: {
            reason: 'auth',
            detail:
              'NEON_API_TOKEN 未配 · adapter 返 auth error · fallback no-op',
          },
        };
      }
      const url = `${cfg.baseUrl}/projects/${encodeURIComponent(req.project_id)}/operations`;
      try {
        const resp = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${cfg.apiToken}`,
            'Content-Type': 'application/json',
          },
        });
        if (resp.status === 401 || resp.status === 403) {
          return { error: { reason: 'auth', detail: `HTTP ${resp.status}` } };
        }
        if (resp.status === 429) {
          return {
            error: { reason: 'rate_limited', detail: `HTTP ${resp.status}` },
          };
        }
        if (!resp.ok) {
          return {
            error: {
              reason: 'backend_error',
              detail: `HTTP ${resp.status}`,
            },
          };
        }
        const body = (await resp.json()) as ConsoleOperationsResp;
        const windows = parseConsoleOperations(
          body,
          req.endpoint_id,
          req.since,
          req.until,
        );
        return { windows };
      } catch (err) {
        return {
          error: {
            reason: 'unreachable',
            detail: (err as Error).message ?? String(err),
          },
        };
      }
    },
  };
}

// =====================================================================================
// TTL cache · per-(project, endpoint, time_range) · TTL 1h
// =====================================================================================

const TTL_MS_1H = 60 * 60 * 1000;

const defaultCache = new TtlCache<AutosuspendEventsSuccess>();
const defaultAdapter = createNeonControlPlaneAdapter();

export function createAutosuspendCache(
  now?: Clock,
): TtlCache<AutosuspendEventsSuccess> {
  return new TtlCache<AutosuspendEventsSuccess>(now);
}

export function clearAutosuspendCache(): void {
  defaultCache.clear();
}

/** key 含 project_id · 跨 tenant 隔离边界 (#151 case 4)。 */
function autosuspendCacheKey(req: AutosuspendEventsRequest): string {
  return `autosuspend:${req.project_id}:${req.endpoint_id}:${req.since}_${req.until}`;
}

export type GetAutosuspendWindowsDeps = {
  adapter?: AutosuspendEventFetchAdapter;
  cache?: TtlCache<AutosuspendEventsSuccess>;
};

/**
 * 拉 endpoint 在 [since, until] 内的 autosuspend windows · 自带 TTL 1h cache。
 *
 * 失败 (adapter error) 不进 cache · 调用方拿 error result · sample-filter 上游按 no-op 兜底
 * (filter 空 windows · 用全部 sample · log warn · 跟 L2a degrade behavior 一致 · #151 case 3)。
 */
export async function getAutosuspendWindows(
  req: AutosuspendEventsRequest,
  deps: GetAutosuspendWindowsDeps = {},
): Promise<AutosuspendEventsResult> {
  const adapter = deps.adapter ?? defaultAdapter;
  const cache = deps.cache ?? defaultCache;
  const key = autosuspendCacheKey(req);
  const cached = cache.get(key);
  if (cached) return cached;
  const result = await adapter.getAutosuspendWindows(req);
  if (!isAutosuspendEventsError(result)) {
    cache.set(key, result, TTL_MS_1H);
  } else {
    logger.warn(
      `[autosuspend-events] fetch 失败 · reason=${result.error.reason} · detail=${result.error.detail ?? ''} · fallback no-op windows · 跟 L2a degrade 一致`,
    );
  }
  return result;
}
