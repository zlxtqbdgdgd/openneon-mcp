/**
 * samples-store seam · feat-024/#2 (L2b) · server-enrich 第 5 个子层入口。
 *
 * 详设 §3: 全局单例 getSamplesStore() + searchSamples(filter) + writeSample(sample) +
 * collector lifecycle。backend 由 SAMPLES_STORE_BACKEND 选 (memory default · redis L3+ stub)。
 *
 * **公共 API 只 export QuerySample 侧** —— RawSample / makeRawSample 不从本 index re-export
 * (raw 仅 collector 内部 import raw-sample.ts · 三层防御 §3)。
 *
 * env (§4):
 *   SAMPLES_STORE_BACKEND=memory
 *   SAMPLES_STORE_TTL_MS=86400000
 *   OBFUSCATOR_MODE=strict
 *   AUTO_EXPLAIN_COLLECTOR_ENABLED=true
 *   AUTO_EXPLAIN_COLLECTOR_INTERVAL_MS=300000
 */

import { MemorySamplesStore } from './memory-store';
import { RedisSamplesStore } from './redis-store';
import type {
  QuerySample,
  SampleFilter,
  SamplesStoreBackend,
} from './types';

export type { QuerySample, SampleFilter, SamplesStoreBackend } from './types';
export {
  obfuscate,
  obfuscateText,
  getObfuscatorMode,
  assertProductionObfuscatorMode,
  type ObfuscatorMode,
} from './obfuscator';

const DEFAULT_TTL_MS = 86_400_000;

function readTtlMs(): number {
  const v = Number(process.env.SAMPLES_STORE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

let singleton: SamplesStoreBackend | null = null;

/** 全局单例 samples-store · backend 由 SAMPLES_STORE_BACKEND 选。 */
export function getSamplesStore(): SamplesStoreBackend {
  if (singleton) return singleton;
  const backend = (process.env.SAMPLES_STORE_BACKEND ?? 'memory').toLowerCase();
  singleton =
    backend === 'redis'
      ? new RedisSamplesStore()
      : new MemorySamplesStore(readTtlMs());
  return singleton;
}

/** test helper · 重置单例。 */
export function _resetSamplesStoreForTests(store?: SamplesStoreBackend): void {
  singleton = store ?? null;
}

/** thin convenience: 查 store (T11 handler 用)。 */
export function searchSamples(filter: SampleFilter): Promise<QuerySample[]> {
  return getSamplesStore().searchSamples(filter);
}

/**
 * thin convenience: 写 store。**类型签名仅 QuerySample** —— OWASP LLM02 主防御边界:
 * RawSample 编译期就传不进来 · 唯一生产 QuerySample 的是 obfuscate() (§3 三层防御)。
 */
export function writeSample(sample: QuerySample): Promise<void> {
  return getSamplesStore().writeSample(sample);
}
