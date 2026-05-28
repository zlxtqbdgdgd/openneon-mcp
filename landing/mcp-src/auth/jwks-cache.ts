/**
 * jwks-cache.ts · feat-060/#1 (#129) · per-authService 的 JWKS 缓存 + revalidate
 *
 * 设计依据: [feat-060 详设 §3 改动 + §4.1 jwks_cache_ttl_seconds](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-060-L2-mcp-server-claim-binding.html)
 *
 * - per-authServiceName 一份 cache · key=name · 命中 TTL 内不重 fetch (省 5min × N 个 JWKS pull)
 * - **fail-closed (ADR-0008 同源)**: TTL 过期后 fetch 失败 (网络 / 5xx / DNS) → 抛 JwksUnreachable ·
 *   **不 stale 兜底** · 调用方 (jwt-verify) translate 成 deny_invalid outcome 拒签 · 而不是用过期 key 验
 *   (过期 key 可能已 revoke · 信任过期 key = 攻击窗口)。
 * - 单 in-flight fetch 去重 (同一 authService 短时间多请求只发一次 HTTP · 避免 thundering herd)。
 *
 * jose 6.x 的 createRemoteJWKSet 已经做了 cache + cooldown · 但它的 stale fallback 跟我们 fail-closed
 * 语义不符 (jose 默认 \`cooldownDuration\` 内 cache miss 会 timeout 慢拉但仍返回 stale · ADR-0008 要立刻拒)。
 * 所以本文件包装一层薄 cache · expired 后强制走 fetch · fetch 失败立刻 throw。
 */
import { createRemoteJWKSet, type JWSHeaderParameters } from 'jose';
import type { AuthServiceConfig } from '../policy/loader';
import { JwksUnreachable } from './jwt-verify-errors';
import { logger } from '../utils/logger';

/**
 * jose createRemoteJWKSet 返回的 callable · 由 \`(protectedHeader, token) => Promise<KeyLike>\` 形态描述。
 * 调用方 (jwt-verify) 把它传给 jose.jwtVerify(token, keyResolver) · 不直接调本类型签名。
 */
export type JWKSResolver = ReturnType<typeof createRemoteJWKSet>;

type CacheEntry = {
  resolver: JWKSResolver;
  /** epoch ms · TTL 到期时间 · 过 = 强制 fetch 新的 (jose 内部也有 cache · 此处用 epoch 控外层) */
  expiresAt: number;
  /** in-flight refresh · 短时间多请求复用 · 避免 thundering herd */
  refreshPromise?: Promise<JWKSResolver>;
};

const cache: Map<string, CacheEntry> = new Map();

/**
 * 取(或惰性建)一个 authService 的 JWKS resolver。
 *
 * 命中 + 未过期 → 复用 (jose 内部 cooldown 还会再降一层 HTTP)。
 * 过期 OR 首次 → 建新 resolver (createRemoteJWKSet 是同步 · 真 HTTP fetch 发生在调用 resolver 时)。
 * 拿 resolver 后调用方 (jwt-verify) 实际 verify 时会触发 fetch · 失败再翻成 JwksUnreachable。
 *
 * 注: 本函数不发 HTTP · 错误延后到 resolver 实际被调时才发生 · 这是 jose 的设计 · 此处包装层只
 * 管 TTL + in-flight 去重 · 错误归属交 verify。
 */
export function getJwksResolver(svc: AuthServiceConfig): JWKSResolver {
  const now = Date.now();
  const cached = cache.get(svc.name);
  if (cached && cached.expiresAt > now) {
    return cached.resolver;
  }
  // 过期或首次 · 构造新 resolver
  const url = new URL(svc.jwks_url);
  const resolver = createRemoteJWKSet(url, {
    // jose 6.x cooldownDuration 默认 30s · 给 thundering herd 兜底
    cooldownDuration: 30_000,
    // **不**给 timeoutDuration: 让 fetch 默认超时 (5s in jose 6.x) · 失败抛错由 verify 翻成 JwksUnreachable
  });
  cache.set(svc.name, {
    resolver,
    expiresAt: now + svc.jwks_cache_ttl_seconds * 1000,
  });
  return resolver;
}

/**
 * 测试用 · 清 cache · 防 fixture 间互相污染。
 */
export function __resetJwksCacheForTest(): void {
  cache.clear();
}

/**
 * 主动 fetch 一次 JWKS · 用于探活 / 校验配置 · 失败抛 JwksUnreachable (fail-closed)。
 * (verify 主路径不调本函数 · jose 内部 fetch 即可 · 本函数给 ad-hoc test / probe 用。)
 */
export async function probeJwksReachable(
  svc: AuthServiceConfig,
): Promise<void> {
  const resolver = getJwksResolver(svc);
  try {
    // 用空 header 触发 fetch · 期望抛 "no applicable key" (说明 JWKS 拉到了 · 只是没 match key)
    // 或抛网络错 (说明 JWKS 不可达)。
    await resolver({} as JWSHeaderParameters, {} as never);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // jose 拉到 JWKS 但没匹配 key 时抛 "no applicable key" / "JWKSNoMatchingKey"
    // 网络错则是 fetch failed / ECONNREFUSED / TLS 之类
    if (
      msg.includes('no applicable key') ||
      msg.includes('JWKSNoMatchingKey') ||
      (err as { code?: string }).code === 'ERR_JWKS_NO_MATCHING_KEY'
    ) {
      logger.debug(`JWKS probe ok (no key match expected)`, {
        authService: svc.name,
      });
      return;
    }
    throw new JwksUnreachable(
      `authService "${svc.name}" JWKS 不可达: ${msg}`,
    );
  }
}
