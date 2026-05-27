/**
 * samples-store seam types · feat-024/#2 (L2b) · 跟 plan-store 平行的第 5 个 enrich 子层。
 *
 * 详设 §3 三层防御 + §4 数据契约:
 * - QuerySample (`__brand:'obfuscated'`) = public 类型 · store 内容 · agent 可见 · 100% 脱敏
 * - SamplesStoreBackend.writeSample 类型签名**仅接受 QuerySample** —— 编译期拒 raw (brand type)
 * - SampleFilter = T11 查询条件
 *
 * RawSample (internal · `__brand:'raw'`) 在 raw-sample.ts · 唯一通路是 obfuscator.obfuscate()。
 */

/**
 * 脱敏后的 query 样本 (store 内容 · agent 可见)。`__brand:'obfuscated'` 是编译期标记 ——
 * 只有 obfuscate() 能生产带此 brand 的对象 (§3 三层防御之运行期唯一通路)。
 */
export type QuerySample = {
  __brand: 'obfuscated';
  /** sha256(normalized_query) 前 16 hex · 跟 plan-store / T3 / T7 统一。 */
  signature: string;
  /** 脱敏后的 query 文本 · 字面量已替换为 $N (如 "WHERE id=$1")。 */
  query_text_obfuscated: string;
  /** 脱敏占位符序列 (['$1', '$2', ...] · 替代真实绑定值)。 */
  params_obfuscated: string[];
  duration_ms: number;
  captured_at: number;
  /** 本 sample 脱敏掉的字面量数 · for audit (§6 sensitive_redact_count)。 */
  sensitive_redact_count: number;
  /** project scope · multi-project 隔离边界 (§6 OQ8 · 跟 plan-store 同源)。 */
  projectId: string;
  /** USR (feat-008-011 L2b ship 后追加)。 */
  usr?: {
    tenant_id: string;
    timeline_id: string;
    endpoint_id: string;
    shard_id?: string;
  };
};

/** T11 / searchSamples filter (详设 §4)。projectId 必填 —— 隔离边界。 */
export type SampleFilter = {
  projectId: string;
  /** 特定 query 查 sample。 */
  signature?: string;
  /** 绝对时间窗 (epoch ms) · T11 handler 把 'last 1h' 类相对窗解析成它。 */
  time_range?: { from: number; to: number };
  /** 仅返超过 N ms 的 sample。 */
  duration_min_ms?: number;
  /** default 50 · T11 handler cap 200。 */
  limit?: number;
};

/**
 * samples-store backend 契约。
 * **writeSample 仅接受 QuerySample** —— 这是 OWASP LLM02 主防御边界 (§6): raw 在编译期就传不进来。
 */
export interface SamplesStoreBackend {
  writeSample(sample: QuerySample): Promise<void>;
  searchSamples(filter: SampleFilter): Promise<QuerySample[]>;
  /** TTL evict · 返回清掉的条数。 */
  evictExpired(): Promise<number>;
  readonly kind: 'memory' | 'redis';
}
