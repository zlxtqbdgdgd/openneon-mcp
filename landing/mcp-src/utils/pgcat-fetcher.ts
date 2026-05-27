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
export type FetchStatus = 'ok' | 'timeout' | 'http_5xx' | 'parse_error';

/** 单 pool 的统计 (handler 组 PoolStats 用) */
export interface PoolStats {
  endpoint_id: string;
  pool_name: string;
  pool_mode: 'session' | 'transaction' | 'statement';
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
    if (res.status >= 500) {
      const err = new Error(`metrics endpoint HTTP ${res.status}`);
      (err as Error & { httpStatus?: number }).httpStatus = res.status;
      throw err;
    }
    if (!res.ok) {
      throw new Error(`metrics endpoint HTTP ${res.status}`);
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
    if (typeof status === 'number' && status >= 500) return 'http_5xx';
  }
  return 'timeout'; // 网络层失败 (ECONNREFUSED 等) 归 timeout/unreachable 桶
}

/**
 * fetch + parse pgcat/PgBouncer metrics · 带 cache + retry once + stale fallback。
 *
 * @throws Error (friendly message) 当 fetch 失败且无任何 cache (无 stale 可降级)。
 */
export async function fetchPgcatMetrics(url: string): Promise<FetchPoolStatsResult> {
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
    throw new Error(
      'pgcat metrics endpoint returned unparseable content · check the endpoint is a pgcat/PgBouncer /metrics URL',
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

  // 无 cache · 无 stale → friendly throw
  throw new Error(
    'pgcat metrics endpoint unreachable · please configure PGCAT_METRICS_URL',
  );
}

/** 测试 / 回滚用: 清空 cache + lastGood */
export function __resetPgcatCacheForTest(): void {
  cache.clear();
  lastGood.clear();
}
