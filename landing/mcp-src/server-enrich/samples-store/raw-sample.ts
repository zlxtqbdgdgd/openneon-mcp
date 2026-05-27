/**
 * raw-sample.ts · feat-024/#2 · **internal-only** RawSample brand type。
 *
 * 详设 §3 TypeScript 类型隔离: RawSample 仅存在于 collector 闭包内 (auto_explain log parse 暂态) ·
 * **绝不 export 到公共 API · 绝不进 store**。`__brand: 'raw'` 让编译期无法把它误传给只接受
 * QuerySample 的 store 写入端口 (brand type 三层防御之一)。
 *
 * 唯一合法出口: obfuscator.ts 的 `obfuscate(raw: RawSample): QuerySample` —— raw → obfuscated
 * 的唯一通路。本文件是 CI guard 唯一允许出现 `raw_params` 字段的地方 (feat-024 §7 用例 11)。
 */

/**
 * auto_explain log 解析出的原始样本 (含真实绑定参数值 · 含 PII)。
 *
 * **internal · 不 export 出 samples-store 子层 · 不进 store · obfuscate() 后立即丢弃** (§6 OQ6:
 * 运行期 process memory 暂态可见 raw 是接受的风险 · 同所有 server-side processing 一致)。
 */
export type RawSample = {
  __brand: 'raw';
  duration_ms: number;
  /** auto_explain plan 原文 (JSON / text · 可能含字面量)。 */
  raw_plan: string;
  /** query 原文 SQL (含字面量)。 */
  raw_query: string;
  /** 绑定参数原值 (PII · 如 [12345, 'alice@example.com'])。 */
  raw_params: unknown[];
  captured_at: number;
};

/** 构造 RawSample (仅 collector 内部用 · brand 由本函数盖章)。 */
export function makeRawSample(fields: Omit<RawSample, '__brand'>): RawSample {
  return { __brand: 'raw', ...fields };
}
