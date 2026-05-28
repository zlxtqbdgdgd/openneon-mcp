/**
 * LogFetchAdapter sub-interface · feat-037/#3 · 跟 feat-064 metrics-history seam 同 pattern.
 *
 * Detail design: zlxtqbdgdgd/openneon-design#51 §3.2 + feat-064 ObservabilityAdapter union.
 *
 * 一句话: log 拉取也是 vendor-neutral seam · default Datadog logs API · swap backends 不动 consumer.
 *
 * 跟 metrics-history seam 同 pattern:
 *   - request 描述 "想要什么" (endpoint + 时间窗 + severity + trace_id) · 不带 backend 语法
 *   - adapter 翻译成具体 backend 调用 (Datadog logs / Loki / 自托管 ES) · 隐藏 SDK
 *   - 返回 logs[] (already PII-obfuscated by adapter implementation) + coverage 元数据
 *   - 失败 → error result · NEVER 空数组 masquerading as success (fail-closed · §6)
 *
 * **OWASP LLM02**: adapter 实现 MUST 在出 seam 边界前过 obfuscateLogLine · raw log 永不出 seam.
 *   本 type 定义只描述 contract · 各 adapter 实现各自负责脱敏 (mcp tool handler 再补一道防御).
 *
 * **feat-064 seam union**: 未来 ObservabilityAdapter = MetricHistoryAdapter & Partial<LogFetchAdapter>
 *   让一个 backend (Datadog) 同时 implement metric + log 取数 · 各 adapter 单独 implement 各自接口.
 */

import type { LogLine } from '../pattern/types';

// ------------------------------------------------------------------------------------------------
// Request / Result
// ------------------------------------------------------------------------------------------------

export type LogFetchRequest = {
  /** Logical endpoint id (e.g. compute endpoint) → adapter 翻译成 backend 的 host/tag 维度 */
  endpointId: string;
  /** ISO8601 起止 · half-open [start, end) */
  timeRange: { start: string; end: string };
  /** Optional severity 过滤 (FATAL/ERROR/WARN/INFO/DEBUG · 大写) */
  severity?: string[];
  /** Optional trace_id 过滤 (32-hex W3C · v2 阶段才生效 · v1 raw stderr 没字段) */
  traceId?: string;
  /** Adapter 出多少行上限 · 防一次取 1M 把内存撑爆 · default 100K */
  limit?: number;
};

export type LogFetchCoverage = {
  fetched_lines: number;
  /** adapter 报告的总匹配行 · 可能 > fetched_lines (limit 截断) */
  total_matching_lines: number;
  /** 是否 limit 截断 · UI 提示 DBA 'tail 不全' */
  truncated: boolean;
  /** ISO8601 · 实际拉到的最新行时间 */
  latest_line_ts: string | null;
};

export type LogFetchSuccess = {
  /** Obfuscated log lines (adapter MUST pre-obfuscate · §6 OWASP LLM02) */
  lines: LogLine[];
  coverage: LogFetchCoverage;
};

export type LogFetchError = {
  error: {
    reason: 'unreachable' | 'auth' | 'rate_limited' | 'backend_error' | 'feat_036_not_ready';
    detail?: string;
  };
};

export type LogFetchResult = LogFetchSuccess | LogFetchError;

export function isLogFetchError(r: LogFetchResult): r is LogFetchError {
  return (r as LogFetchError).error !== undefined;
}

// ------------------------------------------------------------------------------------------------
// Adapter contract (vendor-neutral · ADR-0009 seam style)
// ------------------------------------------------------------------------------------------------

export type LogFetchAdapter = {
  fetch: (req: LogFetchRequest) => Promise<LogFetchResult>;
};

// ------------------------------------------------------------------------------------------------
// Default adapter · v1 阶段返 feat_036_not_ready (Q6B staged delivery)
// ------------------------------------------------------------------------------------------------

/**
 * v1 stub adapter · feat-036 v1 raw stderr 没结构化字段 · trace_id filter 没法 honor.
 *
 * v2 jsonlog adapter (feat-036 ship 后) 通过 setLogFetchAdapter 注入真实 Datadog logs adapter.
 *
 * **错误 reason='feat_036_not_ready'** 是契约 · path-router / mcp tool handler 在 staged delivery
 * 阶段按 reason 判断要不要 degrade · 不当 backend_error 处理 (是 phased rollout 不是真正错).
 */
export const STUB_LOG_FETCH_ADAPTER: LogFetchAdapter = {
  fetch: async (req: LogFetchRequest) => {
    // 没 trace_id 走 v1 path · 当前 mock 实现也仅返空 + 提示 caller 注入真实 adapter
    if (req.traceId) {
      return {
        error: {
          reason: 'feat_036_not_ready',
          detail:
            'trace_id filter requires feat-036 v2 jsonlog · v1 raw stderr 没结构化字段 · 等 feat-036 v2 ship 后注入真实 adapter (setLogFetchAdapter).',
        },
      };
    }
    return {
      error: {
        reason: 'backend_error',
        detail:
          'no log fetch adapter wired · register a backend via setLogFetchAdapter (Datadog logs adapter pending feat-036 v2).',
      },
    };
  },
};

let activeAdapter: LogFetchAdapter = STUB_LOG_FETCH_ADAPTER;

export function setLogFetchAdapter(adapter: LogFetchAdapter): void {
  activeAdapter = adapter;
}

export function getLogFetchAdapter(): LogFetchAdapter {
  return activeAdapter;
}

export function resetLogFetchAdapter(): void {
  activeAdapter = STUB_LOG_FETCH_ADAPTER;
}

/** Convenience · 跟 metrics-history.getMetricHistory 同 style. */
export function getLogHistory(
  req: LogFetchRequest,
  adapter: LogFetchAdapter = getLogFetchAdapter(),
): Promise<LogFetchResult> {
  return adapter.fetch(req);
}
