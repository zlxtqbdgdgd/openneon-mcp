/**
 * metrics-history seam · feat-064 (L2a) · the single collection point for "fetch a signal's history".
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-064-L2-mcp-server-enrich-metrics-history.html
 *
 * Consumers (feat-016 baseline, feat-018 SLI history, …) call `getMetricHistory(req)` with a logical
 * signal + dimensions + window + bucket and get back `{ points, coverage }` or `{ error }`. The
 * backend (currently Datadog) is hidden behind the adapter — swap backends without touching this
 * interface or any consumer. INTERNAL only · not agent-facing (§6).
 */

import { datadogAdapter } from './datadog-adapter';
import type {
  MetricHistoryAdapter,
  MetricHistoryRequest,
  MetricHistoryResult,
} from './types';

export type {
  MetricHistoryAdapter,
  MetricHistoryRequest,
  MetricHistoryResult,
  MetricHistorySuccess,
  MetricHistoryError,
  MetricWindow,
  Coverage,
} from './types';
export { isMetricHistoryError } from './types';

// feat-040 (L3) · AutosuspendEventFetchAdapter sub-interface · 跟 feat-066 TraceFetchAdapter 同 pattern.
// 不进 MetricHistoryAdapter union · 独立 sub-interface · 调用方按 Partial<...> 组合。
export type {
  AutosuspendWindow,
  AutosuspendEventFetchAdapter,
  AutosuspendEventsRequest,
  AutosuspendEventsResult,
  AutosuspendEventsSuccess,
  AutosuspendEventsError,
  NeonControlPlaneMode,
  NeonControlPlaneConfig,
  GetAutosuspendWindowsDeps,
} from './autosuspend-events';
export {
  getAutosuspendWindows,
  createAutosuspendCache,
  clearAutosuspendCache,
  createNeonControlPlaneAdapter,
  readNeonControlPlaneConfig,
  isAutosuspendEventsError,
} from './autosuspend-events';

/**
 * Fetch a signal's historical time series.
 *
 * @param req - logical signal + dimensions + window + bucket
 * @param adapter - backend adapter · defaults to Datadog · overridable (tests / future backends)
 */
export function getMetricHistory(
  req: MetricHistoryRequest,
  adapter: MetricHistoryAdapter = datadogAdapter,
): Promise<MetricHistoryResult> {
  return adapter.fetch(req);
}
