/**
 * feat-029/#3 (#105) · 用例 7 · 运行期 revocation 检测 fixture
 *
 * tool 调用对 Neon API 拿到 401/403 → key 被 revoke 或失效 → 清 5min KV cache · 让下一次
 * verifyToken 重新跑 resolveKeyScope · 在那一步 fail-closed deny。
 *
 * 详 [feat-029 §6 revocation 通路](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-029-L2-mcp-server-token-scope-min.html#6-权限与安全)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// silence logger
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// 模块顶层 mock · 让 errors.ts import 时拿到 spy 版本
const deleteSpy = vi.fn().mockResolvedValue(true);
vi.mock('../oauth/kv-store', () => ({
  getApiKeys: () => ({ delete: deleteSpy }),
}));
vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

beforeEach(() => {
  deleteSpy.mockClear();
});

describe('用例 7: 运行期 revocation (handleToolError invalidate cache)', () => {
  it('invalidateRevokedApiKeyCache 直接调用 · delete 命中', async () => {
    const { invalidateRevokedApiKeyCache } = await import('../server/errors');
    invalidateRevokedApiKeyCache('neon_project_test_xxxxFOOO');
    // fire-and-forget · 给 micro-task 时间跑
    await new Promise((r) => setTimeout(r, 5));
    expect(deleteSpy).toHaveBeenCalledWith('neon_project_test_xxxxFOOO');
  });

  it('handleToolError 在 axios 401 时主动 invalidate cache', async () => {
    const { handleToolError } = await import('../server/errors');
    handleToolError(
      {
        isAxiosError: true,
        response: {
          status: 401,
          statusText: 'Unauthorized',
          data: { message: 'revoked' },
        },
        message: 'unauthorized',
      } as never,
      {},
      'trace-1',
      'neon_project_test_RVKD',
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(deleteSpy).toHaveBeenCalledWith('neon_project_test_RVKD');
  });

  it('handleToolError 在 axios 403 时主动 invalidate cache', async () => {
    const { handleToolError } = await import('../server/errors');
    handleToolError(
      {
        isAxiosError: true,
        response: {
          status: 403,
          statusText: 'Forbidden',
          data: { message: 'forbidden' },
        },
        message: 'forbidden',
      } as never,
      {},
      'trace-2',
      'neon_project_test_403X',
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(deleteSpy).toHaveBeenCalledWith('neon_project_test_403X');
  });

  it('handleToolError 在 axios 500 时不触发 invalidate (非 revocation 信号)', async () => {
    const { handleToolError } = await import('../server/errors');
    handleToolError(
      {
        isAxiosError: true,
        response: {
          status: 500,
          statusText: 'Server Error',
          data: { message: 'oops' },
        },
        message: 'server error',
      } as never,
      {},
      'trace-3',
      'neon_project_test_500X',
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('handleToolError 缺 apiKey 参数时不触发 invalidate (兼容老路径)', async () => {
    const { handleToolError } = await import('../server/errors');
    handleToolError(
      {
        isAxiosError: true,
        response: {
          status: 401,
          statusText: 'Unauthorized',
          data: { message: 'no key' },
        },
        message: 'unauthorized',
      } as never,
      {},
      'trace-4',
      // intentionally no apiKey
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});
