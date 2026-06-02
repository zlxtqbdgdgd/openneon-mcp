/**
 * AutosuspendEventFetchAdapter · feat-040 (L3) sub-interface · 拉 Neon control plane 上的
 * compute autosuspend / wake 事件 · 转成 [start, end) windows · 供 sample-filter.ts 排除 sample。
 *
 * 详设: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-040-L3-mcp-server-enrich-baseline-autosuspend-exclusion.html §3.2 + §3.5
 * 父 issue: zlxtqbdgdgd/openneon-design#49 · 子 issue: zlxtqbdgdgd/openneon-mcp#152
 *
 * 责任 (#152 验收门):
 *   - sub-interface 定义 (跟 feat-066 TraceFetchAdapter 同 pattern · NOT 强加到 ObservabilityAdapter)
 *   - 自托管开源 control_plane operations API (ADR-0021: 删 cloud 模式 · 永不连官方 api.neon.tech)
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
// 自托管开源 control_plane operations API (ADR-0021: 删 cloud 模式 · 永不连官方 api.neon.tech)
// =====================================================================================

export type NeonControlPlaneConfig = {
  /** 自托管 control_plane operations API base URL (ADR-0021: 绝不指向官方 api.neon.tech) */
  baseUrl: string;
  /** control_plane API token · 走 Authorization: Bearer · 不复用 Datadog 凭证 (#152) */
  apiToken: string;
};

/**
 * Env vars (ADR-0021: 永不连官方云 · 仅自托管开源 control_plane):
 *   NEON_API_BASE_URL = 自托管 control_plane operations API base (必配 · 不配 → null · **绝不默认云**)
 *   NEON_API_TOKEN    = control_plane API token
 *
 * URL / 凭证缺 → 返 null → adapter 返 auth error → sample-filter no-op degrade (不阻塞 baseline ·
 * 跟 L2a behavior 一致 · 跟 datadog-adapter fail-closed 同 pattern)。**已删 cloud 默认 base** —— 原
 * 双模式 (NEON_CONTROL_PLANE_MODE=cloud|oss) 被 ADR-0021 收成单一自托管路径。
 */
export function readNeonControlPlaneConfig(): NeonControlPlaneConfig | null {
  const apiToken = process.env.NEON_API_TOKEN;
  const baseUrl = process.env.NEON_API_BASE_URL;
  if (!apiToken || !baseUrl) return null;
  return { baseUrl, apiToken };
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
 * 解析自托管 control_plane 的 operations 列表 · action 'suspend_compute' 段开始 · 接下来
 * 'start_compute' / 'apply_config' 段结束。
 *
 * 字段 schema 沿用 Neon operations 概念 (control_plane 已有 operations) · 自托管部署需保持字段名
 * 一致 · 不一致时上游 adapter 二次 mapping。**ADR-0021: 数据源是自托管 control_plane · 非官方云**。
 */
function parseControlPlaneOperations(
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
        const windows = parseControlPlaneOperations(
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
