/**
 * metrics-history seam unit tests · feat-064 (L2a).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-064-L2-mcp-server-enrich-metrics-history.html §7
 *
 * Covers: query translation (logical signal + dimensions + bucket → DD query string), series →
 * points + coverage, sparse vs failure distinction, and HTTP error classification
 * (auth / rate_limited / unreachable / backend_error). HTTP is mocked (no real Datadog).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseDurationSeconds, resolveWindow } from '../server-enrich/metrics-history/duration';
import { computeCoverage } from '../server-enrich/metrics-history/coverage';
import {
  buildDatadogQuery,
  parseSeries,
  classifyHttpStatus,
  createDatadogAdapter,
} from '../server-enrich/metrics-history/datadog-adapter';
import { getMetricHistory, isMetricHistoryError } from '../server-enrich/metrics-history';
import type { MetricHistoryRequest } from '../server-enrich/metrics-history';

describe('duration parsing + window resolution', () => {
  it('parses d/h/m/s units to seconds', () => {
    expect(parseDurationSeconds('7d')).toBe(604800);
    expect(parseDurationSeconds('24h')).toBe(86400);
    expect(parseDurationSeconds('1h')).toBe(3600);
    expect(parseDurationSeconds('5m')).toBe(300);
    expect(parseDurationSeconds('15s')).toBe(15);
  });

  it('throws on an unparseable duration (never silently coerced)', () => {
    expect(() => parseDurationSeconds('lots')).toThrow();
    expect(() => parseDurationSeconds('0h')).toThrow();
  });

  it('relative window resolves against a fixed now', () => {
    const { from, to } = resolveWindow({ last: '1h' }, 1_000_000);
    expect(to).toBe(1_000_000);
    expect(from).toBe(1_000_000 - 3600);
  });

  it('absolute window passes through', () => {
    expect(resolveWindow({ from: 10, to: 20 })).toEqual({ from: 10, to: 20 });
  });
});

describe('computeCoverage', () => {
  it('expected_points = span ÷ bucket · actual counts non-null · latest = max non-null ts', () => {
    const cov = computeCoverage(
      [
        [100, 1],
        [200, null],
        [300, 5],
      ],
      0,
      600,
      100,
    );
    expect(cov.expected_points).toBe(6); // 600 / 100
    expect(cov.actual_points).toBe(2); // two non-null
    expect(cov.span_seconds).toBe(600);
    expect(cov.latest_point_ts).toBe(300);
  });

  it('all-null points → actual 0 · latest null (no data · staleness)', () => {
    const cov = computeCoverage([[100, null]], 0, 100, 100);
    expect(cov.actual_points).toBe(0);
    expect(cov.latest_point_ts).toBeNull();
  });
});

describe('buildDatadogQuery', () => {
  it('builds <agg>:<metric>{tags}.rollup(sec)', () => {
    const q = buildDatadogQuery(
      { ddMetric: 'postgresql.connections', aggregation: 'avg' },
      { endpoint: 'main' },
      3600,
    );
    expect(q).toBe('avg:postgresql.connections{endpoint:main}.rollup(3600)');
  });

  it('no dimensions → {*}', () => {
    const q = buildDatadogQuery({ ddMetric: 'postgresql.connections' }, {}, 300);
    expect(q).toBe('avg:postgresql.connections{*}.rollup(300)');
  });

  it('remaps logical dimension keys to DD tag keys', () => {
    const q = buildDatadogQuery(
      {
        ddMetric: 'postgresql.connections',
        tagKeyMap: { endpoint: 'endpoint_id' },
      },
      { endpoint: 'main' },
      60,
    );
    expect(q).toBe('avg:postgresql.connections{endpoint_id:main}.rollup(60)');
  });
});

describe('parseSeries', () => {
  it('converts pointlist ms → seconds, preserves null', () => {
    const points = parseSeries({
      series: [{ pointlist: [[1_000_000_000_000, 5], [1_000_000_060_000, null]] }],
    });
    expect(points).toEqual([
      [1_000_000_000, 5],
      [1_000_000_060, null],
    ]);
  });

  it('empty series → empty points (sparse · not an error)', () => {
    expect(parseSeries({ series: [] })).toEqual([]);
  });
});

describe('classifyHttpStatus', () => {
  it('401/403 → auth · 429 → rate_limited · else backend_error', () => {
    expect(classifyHttpStatus(401)).toBe('auth');
    expect(classifyHttpStatus(403)).toBe('auth');
    expect(classifyHttpStatus(429)).toBe('rate_limited');
    expect(classifyHttpStatus(500)).toBe('backend_error');
  });
});

describe('adapter fetch · success + failure (failure ≠ sparse)', () => {
  const req: MetricHistoryRequest = {
    signal: 'connections',
    dimensions: { endpoint: 'main' },
    window: { from: 0, to: 600 },
    bucket: '100s',
  };

  beforeEach(() => {
    process.env.DD_API_KEY = 'test-api';
    process.env.DD_APP_KEY = 'test-app';
    process.env.DD_SITE = 'us5.datadoghq.com';
  });

  afterEach(() => {
    delete process.env.DD_API_KEY;
    delete process.env.DD_APP_KEY;
    delete process.env.DD_SITE;
    vi.restoreAllMocks();
  });

  it('200 with series → points + coverage (success)', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ok',
        series: [{ pointlist: [[0, 1], [100_000, 2], [200_000, null]] }],
      }),
    });
    const adapter = createDatadogAdapter(fakeFetch as unknown as typeof fetch);
    const result = await getMetricHistory(req, adapter);

    expect(isMetricHistoryError(result)).toBe(false);
    if (!isMetricHistoryError(result)) {
      expect(result.points.length).toBe(3);
      expect(result.coverage.expected_points).toBe(6); // 600/100
      expect(result.coverage.actual_points).toBe(2);
    }
    // .rollup(100) reached the URL (explicit bucket).
    const calledUrl = fakeFetch.mock.calls[0][0] as string;
    expect(decodeURIComponent(calledUrl)).toContain('rollup(100)');
  });

  it('200 with EMPTY series → success with 0 coverage (sparse · NOT error)', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', series: [] }),
    });
    const adapter = createDatadogAdapter(fakeFetch as unknown as typeof fetch);
    const result = await getMetricHistory(req, adapter);
    expect(isMetricHistoryError(result)).toBe(false);
    if (!isMetricHistoryError(result)) {
      expect(result.points).toEqual([]);
      expect(result.coverage.actual_points).toBe(0);
    }
  });

  it('HTTP 403 → error{auth} (not empty points)', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const adapter = createDatadogAdapter(fakeFetch as unknown as typeof fetch);
    const result = await getMetricHistory(req, adapter);
    expect(isMetricHistoryError(result)).toBe(true);
    if (isMetricHistoryError(result)) expect(result.error.reason).toBe('auth');
  });

  it('HTTP 429 → error{rate_limited}', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    const adapter = createDatadogAdapter(fakeFetch as unknown as typeof fetch);
    const result = await getMetricHistory(req, adapter);
    expect(isMetricHistoryError(result)).toBe(true);
    if (isMetricHistoryError(result)) expect(result.error.reason).toBe('rate_limited');
  });

  it('network throw → error{unreachable}', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const adapter = createDatadogAdapter(fakeFetch as unknown as typeof fetch);
    const result = await getMetricHistory(req, adapter);
    expect(isMetricHistoryError(result)).toBe(true);
    if (isMetricHistoryError(result)) expect(result.error.reason).toBe('unreachable');
  });

  it('missing credentials → error{auth} (no crash)', async () => {
    delete process.env.DD_API_KEY;
    const fakeFetch = vi.fn();
    const adapter = createDatadogAdapter(fakeFetch as unknown as typeof fetch);
    const result = await getMetricHistory(req, adapter);
    expect(isMetricHistoryError(result)).toBe(true);
    if (isMetricHistoryError(result)) expect(result.error.reason).toBe('auth');
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('unmapped signal → error{backend_error}', async () => {
    const fakeFetch = vi.fn();
    const adapter = createDatadogAdapter(fakeFetch as unknown as typeof fetch);
    const result = await getMetricHistory(
      { ...req, signal: 'no_such_signal' },
      adapter,
    );
    expect(isMetricHistoryError(result)).toBe(true);
    if (isMetricHistoryError(result)) expect(result.error.reason).toBe('backend_error');
  });
});
