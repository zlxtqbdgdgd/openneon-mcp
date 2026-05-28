/**
 * feat-037/#3 · LogFetchAdapter sub-interface tests · openneon-mcp#158.
 *
 * 验收门:
 *   1. LogFetchAdapter contract (跟 feat-064 MetricHistoryAdapter 同 pattern)
 *   2. stub adapter 返 feat_036_not_ready when trace_id passed (staged delivery)
 *   3. setLogFetchAdapter 注入真实 adapter
 *   4. isLogFetchError type narrowing
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getLogFetchAdapter,
  setLogFetchAdapter,
  resetLogFetchAdapter,
  isLogFetchError,
  getLogHistory,
  STUB_LOG_FETCH_ADAPTER,
  type LogFetchAdapter,
  type LogFetchSuccess,
} from '../server-enrich/metrics-history/log-fetch';

describe('feat-037/#3 · LogFetchAdapter stub default', () => {
  beforeEach(() => resetLogFetchAdapter());

  it('returns feat_036_not_ready when trace_id is supplied (v1 staged delivery)', async () => {
    const r = await getLogFetchAdapter().fetch({
      endpointId: 'ep-1',
      timeRange: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
      traceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    });
    expect(isLogFetchError(r)).toBe(true);
    if (!isLogFetchError(r)) return;
    expect(r.error.reason).toBe('feat_036_not_ready');
  });

  it('returns backend_error otherwise (no adapter wired)', async () => {
    const r = await getLogFetchAdapter().fetch({
      endpointId: 'ep-1',
      timeRange: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
    });
    expect(isLogFetchError(r)).toBe(true);
    if (!isLogFetchError(r)) return;
    expect(r.error.reason).toBe('backend_error');
  });
});

describe('feat-037/#3 · custom adapter injection', () => {
  it('setLogFetchAdapter swaps the active backend (vendor-neutral seam)', async () => {
    const mockAdapter: LogFetchAdapter = {
      fetch: async () => ({
        lines: [
          { message: 'foo', severity: 'INFO', timestamp: '2026-05-28T10:00:00Z' },
        ],
        coverage: {
          fetched_lines: 1,
          total_matching_lines: 1,
          truncated: false,
          latest_line_ts: '2026-05-28T10:00:00Z',
        },
      }),
    };
    setLogFetchAdapter(mockAdapter);
    const r = await getLogHistory({
      endpointId: 'ep-1',
      timeRange: { start: '2026-05-28T10:00:00Z', end: '2026-05-28T10:10:00Z' },
    });
    expect(isLogFetchError(r)).toBe(false);
    const s = r as LogFetchSuccess;
    expect(s.lines).toHaveLength(1);
    expect(s.coverage.fetched_lines).toBe(1);
    resetLogFetchAdapter();
  });
});

describe('feat-037/#3 · seam invariants', () => {
  it('STUB_LOG_FETCH_ADAPTER is identity-stable (same module-level singleton)', () => {
    expect(STUB_LOG_FETCH_ADAPTER).toBe(STUB_LOG_FETCH_ADAPTER);
    resetLogFetchAdapter();
    expect(getLogFetchAdapter()).toBe(STUB_LOG_FETCH_ADAPTER);
  });
});
