/**
 * feat-038 · STL ttl-cache module-level singleton · cron 写 + T4 读共享同一实例.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-038-L3-mcp-server-enrich-baseline-stl.html §3.5 + §4.3
 *
 * 形态：module-level instance (跟 feat-016 baseline.ts `defaultCache` 同 pattern) · 1h TTL ·
 * 不缓存 current_value (跟 cross-tenant 安全策略一致 · STL 5 字段是 objective 慢漂移摘要 · 安全可
 * 跨 request cache).
 *
 * 注入：测试用 `resetStlCache()` 拿一个干净 instance · 不污染 module state.
 */

import { TtlCache } from '../ttl-cache';
import type { StlEnrich } from './stl';

let stlCache = new TtlCache<StlEnrich>();

/** T4 handler + stl-cron 共享读写入口 · 不导出实例本身防外部 mutate (TtlCache 内部 mut safe). */
export function getStlCache(): TtlCache<StlEnrich> {
  return stlCache;
}

/** 测试 / rollback · 拿一个全新 instance · vi.mock 时可整体替换. */
export function resetStlCache(): void {
  stlCache = new TtlCache<StlEnrich>();
}
