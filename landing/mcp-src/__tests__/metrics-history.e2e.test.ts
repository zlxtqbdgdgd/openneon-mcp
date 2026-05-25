/**
 * feat-064 · metrics-history seam 端到端验证 (real Datadog query API · us5)。
 *
 * Gated on DD_API_KEY + DD_APP_KEY · 无凭证时 skip。在 dev server 上跑 (凭证从 .env.local / 环境读):
 *   DD_API_KEY=... DD_APP_KEY=... npm run test:e2e:mcp
 *
 * 验证 seam 对真 Datadog 取数: 结果要么是 success{points,coverage} · 要么是分类清晰的 error · 绝不抛。
 * ⚠️ "某真实信号取出的值对不对" 依赖 feat-016 第一个真实信号 → 随 feat-016 详设补 (§7 note)。
 */
import { describe, it, expect } from 'vitest';
import {
  getMetricHistory,
  isMetricHistoryError,
} from '../server-enrich/metrics-history';

const HAS_DD = !!process.env.DD_API_KEY && !!process.env.DD_APP_KEY;

describe.skipIf(!HAS_DD)('feat-064 metrics-history · real Datadog e2e (us5)', () => {
  it('connections history over last 1h returns a well-formed success OR a classified error (never throws)', async () => {
    const result = await getMetricHistory({
      signal: 'connections',
      dimensions: {},
      window: { last: '1h' },
      bucket: '5m',
    });

    if (isMetricHistoryError(result)) {
      expect(['unreachable', 'auth', 'rate_limited', 'backend_error']).toContain(
        result.error.reason,
      );
    } else {
      // success: coverage is computed; expected_points = 1h / 5m = 12.
      expect(result.coverage.expected_points).toBe(12);
      expect(Array.isArray(result.points)).toBe(true);
    }
  });

  it('credentials authenticate (no auth error with valid keys)', async () => {
    const result = await getMetricHistory({
      signal: 'connections',
      dimensions: {},
      window: { last: '1h' },
      bucket: '5m',
    });
    if (isMetricHistoryError(result)) {
      // With valid keys present, an auth failure means the keys are wrong — surface it.
      expect(result.error.reason).not.toBe('auth');
    }
  });
});
