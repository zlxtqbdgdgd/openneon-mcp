/**
 * pgcat-fetcher.ts · feat-025/#1 (L2b) · 拉 pgcat / PgBouncer 的 /metrics endpoint
 *
 * HTTP GET /metrics + 5s timeout (POOL_STATS_TIMEOUT_MS) + retry once · 10s TTL cache
 * (POOL_STATS_CACHE_TTL_MS · 复用 server-enrich/ttl-cache.ts)。
 *
 * 降级路径 (§5):
 *   - fetch 成功 → parse → cache (stale=false) → 返
 *   - fetch 失败 (网络/5xx/timeout) 且有 cache → 返 stale=true 旧 cache + log warn
 *   - fetch 失败且无 cache → throw friendly error ("pgcat metrics endpoint unreachable · ...")
 *
 * snapshot 模式 (无 history store · 每次拉最新)· per-endpoint URL dispatch 在 handler 层。
 */
import { logger } from './logger';
import { TtlCache } from '../server-enrich/ttl-cache';
import {
  parsePgcatPrometheus,
  PrometheusParseError,
  type ParsedPoolMetrics,
} from './prometheus-parser';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 10_000;

/** fetch 结果分类 (audit fetch_status 用) */
export type FetchStatus =
  | 'ok'
  | 'timeout'
  | 'http_5xx'
  | 'http_4xx'
  | 'parse_error';

/**
 * 抛给 handler 的 fetch 失败错误 · 带分类 status (handler 据此正确上报 fetchStatus · 不再硬编码)。
 */
export class PgcatFetchError extends Error {
  readonly fetchStatus: FetchStatus;
  constructor(message: string, fetchStatus: FetchStatus) {
    super(message);
    this.name = 'PgcatFetchError';
    this.fetchStatus = fetchStatus;
  }
}

/** 单 pool 的统计 (handler 组 PoolStats 用) */
export interface PoolStats {
  endpoint_id: string;
  pool_name: string;
  // 'unknown' = metrics 未带 pool_mode label (pgcat 实情 · 见 prometheus-parser FIELD_MAP 注释)
  pool_mode: 'session' | 'transaction' | 'statement' | 'unknown';
  role: 'primary' | 'replica' | 'unknown';
  cl_active: number;
  cl_waiting: number;
  sv_active: number;
  sv_idle: number;
  sv_used: number;
  max_wait_ms: number;
  total_xact_count: number;
  captured_at: number; // epoch ms
  stale: boolean; // true = fetch 失败用旧 cache · 警示 agent
}

export interface FetchPoolStatsResult {
  pools: ParsedPoolMetrics[];
  capturedAt: number;
  stale: boolean;
  cacheHit: boolean;
  fetchStatus: FetchStatus;
}

interface CacheEntry {
  pools: ParsedPoolMetrics[];
  capturedAt: number;
}

// URL → 最近一次成功 parse 的结果 · 10s TTL (短期复用 · 抑制 agent hammer pgcat)
const cache = new TtlCache<CacheEntry>();
// stale fallback 用: TTL 过期后仍保留最后一次成功结果 (TtlCache 过期即删 · 故另存一份)
const lastGood = new Map<string, CacheEntry>();

export function envTimeoutMs(): number {
  const v = Number(process.env.POOL_STATS_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

export function envCacheTtlMs(): number {
  const v = Number(process.env.POOL_STATS_CACHE_TTL_MS);
  // 允许 0 (禁 cache · 回滚开关 · §8)· 负/NaN 落默认
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_CACHE_TTL_MS;
}

/**
 * 基本 SSRF 防护: 拒绝指向云元数据 / 明显内网保留地址的 metrics URL。
 *
 * PGCAT_METRICS_URL 来自运维 env (非终端用户直传)·风险等级中等,但仍做最小拦截:
 * 拒绝 link-local 元数据端点 (169.254.169.254 / fd00:ec2::254) 与常见 SSRF 探测目标。
 *
 * TODO(security): pgcat/PgBouncer 常部署在内网 (10.x / 172.16-31 / 192.168 / localhost),
 * 这些是合法目标 · 故此处**不**一刀切封内网,只封云元数据地址。若未来允许用户直传 URL,
 * 需升级为 DNS 解析后逐 IP 校验 (防 DNS rebinding) + allowlist。
 */
function assertNotSsrfTarget(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PgcatFetchError(
      `invalid PGCAT_METRICS_URL · not a valid URL: ${url}`,
      'parse_error',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PgcatFetchError(
      `PGCAT_METRICS_URL must be http(s) · got ${parsed.protocol}`,
      'parse_error',
    );
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // 云元数据端点 (AWS/GCP/Azure IMDS · OpenStack)· 这是 SSRF 经典目标 · 一律拒绝
  const metadataHosts = new Set([
    '169.254.169.254',
    'fd00:ec2::254',
    'metadata.google.internal',
  ]);
  if (metadataHosts.has(host) || host.startsWith('169.254.')) {
    throw new PgcatFetchError(
      `PGCAT_METRICS_URL points to a link-local / cloud-metadata address (${host}) · refused`,
      'parse_error',
    );
  }
}

/** 一次 HTTP GET /metrics · timeout 用 AbortController · 返文本或抛 (含 status) */
async function httpGet(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'text/plain' },
    });
    // 任何非 2xx 都把 httpStatus 附到 error 上 · classifyError 据此分流 5xx / 4xx
    // (旧实现只给 5xx 附 status · 4xx 落到 error 无 status → 被误归 timeout)
    if (!res.ok) {
      const err = new Error(`metrics endpoint HTTP ${res.status}`);
      (err as Error & { httpStatus?: number }).httpStatus = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function classifyError(err: unknown): FetchStatus {
  if (err instanceof PrometheusParseError) return 'parse_error';
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'timeout';
    const status = (err as Error & { httpStatus?: number }).httpStatus;
    if (typeof status === 'number') {
      if (status >= 500) return 'http_5xx';
      if (status >= 400) return 'http_4xx'; // 4xx 单独成桶 · 不再误归 timeout
    }
  }
  return 'timeout'; // 网络层失败 (ECONNREFUSED 等) 归 timeout/unreachable 桶
}

/**
 * fetch + parse pgcat/PgBouncer metrics · 带 cache + retry once + stale fallback。
 *
 * @throws Error (friendly message) 当 fetch 失败且无任何 cache (无 stale 可降级)。
 */
export async function fetchPgcatMetrics(url: string): Promise<FetchPoolStatsResult> {
  assertNotSsrfTarget(url); // 元数据/link-local 地址在 fetch 前就拦掉
  const ttlMs = envCacheTtlMs();
  const timeoutMs = envTimeoutMs();

  // cache hit (TTL 内)· 不 fetch
  if (ttlMs > 0) {
    const cached = cache.get(url);
    if (cached) {
      return {
        pools: cached.pools,
        capturedAt: cached.capturedAt,
        stale: false,
        cacheHit: true,
        fetchStatus: 'ok',
      };
    }
  }

  // cache miss · fetch (retry once)
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await httpGet(url, timeoutMs);
      const pools = parsePgcatPrometheus(text); // parse_error 在此抛
      const entry: CacheEntry = { pools, capturedAt: Date.now() };
      if (ttlMs > 0) cache.set(url, entry, ttlMs);
      lastGood.set(url, entry);
      return {
        pools,
        capturedAt: entry.capturedAt,
        stale: false,
        cacheHit: false,
        fetchStatus: 'ok',
      };
    } catch (err) {
      lastErr = err;
      // parse_error 不 retry (重试还是同样脏数据)· 网络/5xx/timeout retry 一次
      if (err instanceof PrometheusParseError) break;
    }
  }

  const status = classifyError(lastErr);

  // parse_error: 直接抛 friendly (无 stale 降级 · endpoint 在线但内容坏)
  if (status === 'parse_error') {
    throw new PgcatFetchError(
      'pgcat metrics endpoint returned unparseable content · check the endpoint is a pgcat/PgBouncer /metrics URL',
      'parse_error',
    );
  }

  // stale fallback: 有最后成功结果 → 返 stale=true + log warn
  const stale = lastGood.get(url);
  if (stale) {
    logger.warn('pgcat metrics fetch 失败 · 返回 stale cache', {
      url,
      fetchStatus: status,
      capturedAt: stale.capturedAt,
    });
    return {
      pools: stale.pools,
      capturedAt: stale.capturedAt,
      stale: true,
      cacheHit: true,
      fetchStatus: status,
    };
  }

  // 无 cache · 无 stale → friendly throw · 带上分类 status 供 handler 正确上报 fetchStatus
  throw new PgcatFetchError(
    'pgcat metrics endpoint unreachable · please configure PGCAT_METRICS_URL',
    status,
  );
}

/** 测试 / 回滚用: 清空 cache + lastGood */
export function __resetPgcatCacheForTest(): void {
  cache.clear();
  lastGood.clear();
}
