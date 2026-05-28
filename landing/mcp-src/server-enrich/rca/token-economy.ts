/**
 * RCA token-economy bookkeeping · feat-045/#3 (L3).
 *
 * Detail design: openneon-mcp#147 §Token economy 跑批 100 incident.
 *
 * 统计聚合器 (in-process · 不持久化 · 跑批 fixture 用):
 *   - 记录每次 RCA 生成的 inputTokens / outputTokens / cached
 *   - 跑完一批可吐 p50 / p95 / p99 + cache hit rate
 *   - §验收门: input p99 < 3000 · output p99 < 5000 · cache hit rate 文档化
 *
 * **不**做 OTel metric emission · 留给 caller (handler.ts) 通过 audit emit 写
 * `rca_generated` 事件 (含 tokens / cached / duration_ms).
 */

export type TokenSample = {
  traceId: string;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
  durationMs: number;
};

export class TokenEconomyAggregator {
  private samples: TokenSample[] = [];

  record(sample: TokenSample): void {
    this.samples.push(sample);
  }

  size(): number {
    return this.samples.length;
  }

  /** Cache hit ratio · 0 if no samples. */
  cacheHitRate(): number {
    if (this.samples.length === 0) return 0;
    const hits = this.samples.filter((s) => s.cached).length;
    return hits / this.samples.length;
  }

  /** Return percentile of inputTokens · linear interpolation · empty → 0. */
  inputTokensPercentile(p: number): number {
    return percentile(
      this.samples.map((s) => s.inputTokens),
      p,
    );
  }

  outputTokensPercentile(p: number): number {
    return percentile(
      this.samples.map((s) => s.outputTokens),
      p,
    );
  }

  durationMsPercentile(p: number): number {
    return percentile(
      this.samples.map((s) => s.durationMs),
      p,
    );
  }

  /** Final report shape (for the #147 跑批 doc). */
  summary(): {
    n: number;
    cacheHitRate: number;
    inputP50: number;
    inputP95: number;
    inputP99: number;
    outputP50: number;
    outputP95: number;
    outputP99: number;
    durationP50: number;
    durationP99: number;
  } {
    return {
      n: this.samples.length,
      cacheHitRate: this.cacheHitRate(),
      inputP50: this.inputTokensPercentile(50),
      inputP95: this.inputTokensPercentile(95),
      inputP99: this.inputTokensPercentile(99),
      outputP50: this.outputTokensPercentile(50),
      outputP95: this.outputTokensPercentile(95),
      outputP99: this.outputTokensPercentile(99),
      durationP50: this.durationMsPercentile(50),
      durationP99: this.durationMsPercentile(99),
    };
  }

  reset(): void {
    this.samples = [];
  }
}

/** Linear-interpolated percentile (0-100) · pure helper. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const rank = ((p / 100) * (sorted.length - 1));
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
