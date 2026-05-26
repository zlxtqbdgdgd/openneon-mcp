/**
 * Redis-backed cache for MCP client capabilities · keyed by stable identity
 * `(accountId, userAgent)`. Workaround for issue #100:
 *
 * `mcp-handler` 1.0.6 SSE 给每个连接 fresh `McpServer` (with empty
 * `_clientCapabilities`)。Claude Code 2.1.150 在 SSE 断后自动重连但**不重发
 * `initialize`** — server side 因此永远拿不到 `elicitation:{form:{}}` capability,
 * 所有高危 op 走 ADR-0008 fail-closed deny。
 *
 * 修复思路 (issue #100 方案 C): 用 `(accountId, userAgent)` 作 stable identity ·
 * 第一次真 `initialize` 来时把 capability 写 redis · 后续 reconnect 的 fresh
 * `McpServer` 没收 initialize 时,从 redis 拿出 cached capability **直接写**
 * `server.server._clientCapabilities`。
 *
 * ADR-0008 fail-closed 语义保留: 缓存 *未命中* 且 initialize 没来 = 真 fail-closed deny。
 * 缓存命中 = "同 identity 在过去 24h 真发过 initialize 声明过这能力" = 合理的
 * attestation continuity,不是软降级。真 initialize 来时覆写 cache。
 */
import { createHash } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger';

const CAPS_KEY_PREFIX = 'mcp:caps:';
/** 24h. Long enough to span typical workday + overnight reconnect loops · short
 * enough that client upgrades (e.g. claude-code 升级声明新 capability) 自动过期
 * (oninitialized 覆写也会刷新,所以 TTL 是 fallback 而非主要 invalidation 路径). */
const CAPS_TTL_SEC = 24 * 60 * 60;
const REDIS_OP_TIMEOUT_MS = 500;

let clientPromise: Promise<RedisClientType> | null = null;

function withTimeout<T>(promise: Promise<T>, op: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`capability-cache ${op} timed out`));
    }, REDIS_OP_TIMEOUT_MS);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function getRedis(): Promise<RedisClientType> {
  if (clientPromise) return clientPromise;

  const url = process.env.KV_URL || process.env.REDIS_URL;
  if (!url) {
    return Promise.reject(
      new Error('KV_URL/REDIS_URL not set; capability cache unavailable'),
    );
  }

  const client = createClient({ url }) as RedisClientType;
  client.on('error', (err) => {
    logger.error('capability-cache redis error', { err });
    clientPromise = null;
  });

  const pending = client.connect().then(() => client);
  pending.catch(() => {
    clientPromise = null;
  });
  clientPromise = pending;
  return clientPromise;
}

/** Build the redis key for an identity. UA hashed (sha256 · first 16 hex chars =
 * 64 bits) to keep key bounded + avoid special chars. accountId is trusted
 * server-side (来自 verified authInfo · 不是 user-controlled string). */
export function capsKey(accountId: string, userAgent: string): string {
  const uaHash = createHash('sha256')
    .update(userAgent)
    .digest('hex')
    .slice(0, 16);
  return `${CAPS_KEY_PREFIX}${accountId}:${uaHash}`;
}

/**
 * Persist real `clientCapabilities` (来自 `server.server.getClientVersion`-time
 * oninitialized hook) under stable identity. Fail-soft: redis 故障不阻塞主流程,
 * 下次 reconnect 走 fail-closed deny 而非误放行。
 */
export async function saveCapabilities(
  accountId: string,
  userAgent: string,
  capabilities: ClientCapabilities,
): Promise<void> {
  if (!accountId || !userAgent) return;
  const key = capsKey(accountId, userAgent);
  try {
    const redis = await getRedis();
    await withTimeout(
      redis.set(key, JSON.stringify(capabilities), { EX: CAPS_TTL_SEC }),
      'save',
    );
    logger.info('capability-cache · saved', {
      accountId,
      userAgentHash: key.slice(CAPS_KEY_PREFIX.length + accountId.length + 1),
      caps: capabilities,
    });
  } catch (err) {
    logger.warn('capability-cache · save failed (fail-soft)', { err, key });
  }
}

/**
 * Look up cached capabilities. Returns `null` on miss OR redis故障 · 调用方在
 * `null` 时维持现有 fail-closed 路径 (ADR-0008 硬限不变)。
 */
export async function loadCapabilities(
  accountId: string,
  userAgent: string,
): Promise<ClientCapabilities | null> {
  if (!accountId || !userAgent) return null;
  const key = capsKey(accountId, userAgent);
  try {
    const redis = await getRedis();
    const raw = await withTimeout(redis.get(key), 'load');
    if (!raw) return null;
    return JSON.parse(raw) as ClientCapabilities;
  } catch (err) {
    logger.warn('capability-cache · load failed (treating as miss)', {
      err,
      key,
    });
    return null;
  }
}

/** Test-only: drop the cached redis client (between vitest runs). */
export function _resetCapabilityCacheClient(): void {
  clientPromise = null;
}
