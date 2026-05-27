/**
 * T12 get_neondb_pool_stats handler · feat-025/#1 (L2b).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-025-L2b-mcp-tool-t12-pool-stats.html
 *
 * Neon 独有 +1 · Datadog DBM 无对位。让 agent 看连接池的 client active/waiting + server idle/used
 * 视角——跟 T4 health_signals 的 conn_saturation 互补 (T4 看 pg_stat_activity · T12 看 proxy 池队列)。
 *
 * **External-component** runtime form: pgcat / PgBouncer 由用户自部署 · mcp 通过其 /metrics endpoint
 * (Prometheus 格式) 拉数据 · 不依赖 Neon Cloud 未开源的 proxy/pgcat 层。snapshot 模式 (无 history store)。
 */
import {
  fetchPgcatMetrics,
  type PoolStats,
  type FetchStatus,
} from '../../utils/pgcat-fetcher';
import { emitAuditEvent } from '../../observability/audit-emit';
import { logger } from '../../utils/logger';

export type GetPoolStatsInput = {
  /** Neon project ID · required (feat-029 grant projectId scope 校验). */
  projectId: string;
  /** Optional endpoint ID · 决定用哪个 PGCAT_METRICS_URL_<project>_<endpoint> · 缺省用 per-project / 全局。 */
  endpoint_id?: string;
};

/** CSV/JSON 行 (captured_at 渲染成 ISO · feat-006 默认 CSV) */
export type PoolStatsRow = Omit<PoolStats, 'captured_at'> & {
  captured_at: string; // ISO8601 (epoch ms 不友好)
};

export type GetPoolStatsResult = {
  pools: PoolStatsRow[];
  /** fetch 分类 · agent / audit 用 */
  fetchStatus: FetchStatus | 'ok';
  cacheHit: boolean;
  stale: boolean;
};

/**
 * 解析 metrics URL · dispatch 优先级 (§3 调用链):
 *   PGCAT_METRICS_URL_<project>_<endpoint> > PGCAT_METRICS_URL_<project> > PGCAT_METRICS_URL
 *
 * env key 里 project / endpoint 的 '-' 不是合法 env 名字符 · 用户 export 时一般转 '_'。
 * 这里把 projectId / endpoint_id 的非 [A-Za-z0-9_] 字符转 '_' 后拼 key (跟用户 export 约定一致)。
 */
export function resolveMetricsUrl(
  projectId: string,
  endpointId?: string,
): string | undefined {
  const norm = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
  const pid = norm(projectId);
  if (endpointId) {
    const eid = norm(endpointId);
    const perEndpoint = process.env[`PGCAT_METRICS_URL_${pid}_${eid}`];
    if (perEndpoint) return perEndpoint;
  }
  const perProject = process.env[`PGCAT_METRICS_URL_${pid}`];
  if (perProject) return perProject;
  return process.env.PGCAT_METRICS_URL;
}

/**
 * T12 handler core。fetch pgcat/PgBouncer metrics · 组 PoolStats[] · emit audit。
 *
 * @throws Error (friendly) 当 URL 未配 或 endpoint 不可达且无 cache。
 */
export async function handleGetPoolStats(
  input: GetPoolStatsInput,
): Promise<GetPoolStatsResult> {
  const start = Date.now();
  const url = resolveMetricsUrl(input.projectId, input.endpoint_id);

  if (!url) {
    // 未配 URL → friendly error (同 unreachable 文案族 · agent 知道要配 env)
    emitPoolStatsAudit(input, {
      poolCount: 0,
      clWaitingTotal: 0,
      fetchStatus: 'timeout',
      cacheHit: false,
      durationMs: Date.now() - start,
    });
    throw new Error(
      'pgcat metrics endpoint unreachable · please configure PGCAT_METRICS_URL',
    );
  }

  let result;
  try {
    result = await fetchPgcatMetrics(url);
  } catch (err) {
    // fetch 彻底失败 (无 stale 可降级) → audit + rethrow friendly
    emitPoolStatsAudit(input, {
      poolCount: 0,
      clWaitingTotal: 0,
      fetchStatus: 'timeout',
      cacheHit: false,
      durationMs: Date.now() - start,
    });
    throw err;
  }

  const capturedIso = new Date(result.capturedAt).toISOString();
  // 列顺序 = 详设 §4 CSV header (formatToolResponse 取首行 keys 当列序)
  const pools: PoolStatsRow[] = result.pools.map((p) => ({
    endpoint_id: input.endpoint_id ?? '',
    pool_name: p.pool_name,
    pool_mode: p.pool_mode,
    role: p.role,
    cl_active: p.cl_active,
    cl_waiting: p.cl_waiting,
    sv_active: p.sv_active,
    sv_idle: p.sv_idle,
    sv_used: p.sv_used,
    max_wait_ms: p.max_wait_ms,
    total_xact_count: p.total_xact_count,
    captured_at: capturedIso,
    stale: result.stale,
  }));

  if (pools.length === 0) {
    logger.info('pgcat metrics parse 出 0 个 pool (空 metrics)', {
      projectId: input.projectId,
      endpoint_id: input.endpoint_id,
    });
  }

  const clWaitingTotal = pools.reduce((s, p) => s + p.cl_waiting, 0);
  emitPoolStatsAudit(input, {
    poolCount: pools.length,
    clWaitingTotal,
    fetchStatus: result.fetchStatus,
    cacheHit: result.cacheHit,
    durationMs: Date.now() - start,
  });

  return {
    pools,
    fetchStatus: result.fetchStatus,
    cacheHit: result.cacheHit,
    stale: result.stale,
  };
}

function emitPoolStatsAudit(
  input: GetPoolStatsInput,
  fields: {
    poolCount: number;
    clWaitingTotal: number;
    fetchStatus: FetchStatus;
    cacheHit: boolean;
    durationMs: number;
  },
): void {
  emitAuditEvent({
    event_type: 'pool_stats_invoked',
    outcome: 'allow',
    severity: 'low',
    project_id: input.projectId,
    endpoint_id: input.endpoint_id,
    extra: {
      'openneon.audit.pool_count': fields.poolCount,
      'openneon.audit.cl_waiting_total': fields.clWaitingTotal,
      'openneon.audit.fetch_status': fields.fetchStatus,
      'openneon.audit.cache_hit': fields.cacheHit,
      'openneon.audit.duration_ms': fields.durationMs,
    },
  });
}
