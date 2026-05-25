/**
 * Datadog metrics-history adapter · feat-064 (L2a).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-064-L2-mcp-server-enrich-metrics-history.html §3
 *
 * Translates a logical signal request into a Datadog `/api/v1/query` call:
 *   avg:<dd_metric>{<tags>}.rollup(<bucket_seconds>)
 * then parses the returned series into points + coverage. Explicit `.rollup()` keeps the bucket
 * granularity (and thus expected_points) deterministic — Datadog otherwise auto-rolls-up long
 * windows to an unpredictable point count.
 *
 * Failure (network / auth / rate-limited / backend error) returns an `error` result · NEVER an
 * empty-points success. "取数失败 ≠ 取到但稀疏" (§3 · §6 fail-closed).
 */

import { readDatadogConfig } from './datadog-config';
import { getDatadogMapping, type DatadogSignalMapping } from './signal-map';
import { resolveWindow, parseDurationSeconds } from './duration';
import { computeCoverage } from './coverage';
import type {
  MetricHistoryAdapter,
  MetricHistoryRequest,
  MetricHistoryResult,
} from './types';

/** Build the Datadog tag filter `{...}` from logical dimensions (remapped per the signal mapping). */
function buildTagFilter(
  dimensions: Record<string, string>,
  mapping: DatadogSignalMapping,
): string {
  const keys = Object.keys(dimensions);
  if (keys.length === 0) return '{*}';
  const parts = keys.map((k) => {
    const ddKey = mapping.tagKeyMap?.[k] ?? k;
    return `${ddKey}:${dimensions[k]}`;
  });
  return `{${parts.join(',')}}`;
}

/**
 * Build the Datadog query string for a signal · `<agg>:<metric>{<tags>}.rollup(<bucketSeconds>)`.
 * Pure (no I/O) · the unit of vendor-specific query-language knowledge.
 */
export function buildDatadogQuery(
  mapping: DatadogSignalMapping,
  dimensions: Record<string, string>,
  bucketSeconds: number,
): string {
  const agg = mapping.aggregation ?? 'avg';
  const tags = buildTagFilter(dimensions, mapping);
  return `${agg}:${mapping.ddMetric}${tags}.rollup(${bucketSeconds})`;
}

type DatadogQueryBody = {
  status?: string;
  error?: string;
  series?: Array<{ pointlist?: Array<[number, number | null]> }>;
};

/**
 * Parse a Datadog `/api/v1/query` body into [unix_seconds, value] points.
 * Datadog pointlist timestamps are milliseconds → converted to seconds. Empty / missing series →
 * empty points (a valid sparse result, NOT an error). Pure.
 */
export function parseSeries(
  body: DatadogQueryBody,
): Array<[number, number | null]> {
  const series = body.series ?? [];
  if (series.length === 0) return [];
  const pointlist = series[0]?.pointlist ?? [];
  return pointlist.map(([tsMs, value]) => [
    Math.floor(tsMs / 1000),
    value === null || value === undefined ? null : Number(value),
  ]);
}

/** Map an HTTP status to an error reason (auth / rate_limited / backend_error). */
export function classifyHttpStatus(
  status: number,
): 'auth' | 'rate_limited' | 'backend_error' {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  return 'backend_error';
}

/** Injectable fetch (defaults to global fetch · overridable in tests). */
type FetchLike = typeof fetch;

export function createDatadogAdapter(
  fetchImpl: FetchLike = fetch,
): MetricHistoryAdapter {
  return {
    async fetch(req: MetricHistoryRequest): Promise<MetricHistoryResult> {
      const config = readDatadogConfig();
      if (!config) {
        return {
          error: {
            reason: 'auth',
            detail: 'Datadog credentials missing (DD_API_KEY / DD_APP_KEY).',
          },
        };
      }

      const mapping = getDatadogMapping(req.signal);
      if (!mapping) {
        return {
          error: {
            reason: 'backend_error',
            detail: `No Datadog mapping for signal '${req.signal}'.`,
          },
        };
      }

      let from: number;
      let to: number;
      let bucketSeconds: number;
      try {
        ({ from, to } = resolveWindow(req.window));
        bucketSeconds = parseDurationSeconds(req.bucket);
      } catch (e) {
        return {
          error: {
            reason: 'backend_error',
            detail: e instanceof Error ? e.message : String(e),
          },
        };
      }

      const query = buildDatadogQuery(mapping, req.dimensions, bucketSeconds);
      const params = new URLSearchParams({
        from: String(from),
        to: String(to),
        query,
      });
      const url = `${config.baseUrl}/api/v1/query?${params.toString()}`;

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          headers: {
            'DD-API-KEY': config.apiKey,
            'DD-APPLICATION-KEY': config.appKey,
          },
        });
      } catch (e) {
        return {
          error: {
            reason: 'unreachable',
            detail: e instanceof Error ? e.message : String(e),
          },
        };
      }

      if (!res.ok) {
        return {
          error: {
            reason: classifyHttpStatus(res.status),
            detail: `Datadog query API returned HTTP ${res.status}.`,
          },
        };
      }

      let body: DatadogQueryBody;
      try {
        body = (await res.json()) as DatadogQueryBody;
      } catch (e) {
        return {
          error: {
            reason: 'backend_error',
            detail: `Failed to parse Datadog response: ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }

      if (body.status === 'error') {
        return {
          error: {
            reason: 'backend_error',
            detail: body.error ?? 'Datadog query returned status=error.',
          },
        };
      }

      const points = parseSeries(body);
      const coverage = computeCoverage(points, from, to, bucketSeconds);
      return { points, coverage };
    },
  };
}

/** Default Datadog adapter (global fetch). */
export const datadogAdapter: MetricHistoryAdapter = createDatadogAdapter();
