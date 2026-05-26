/**
 * issue #100 mitigation · capability cache (redis-backed) 单测。
 *
 * 覆盖: key derivation (sha256 hash UA) · save (TTL 24h) · load (hit/miss/redis-fail)
 * · fail-soft (redis 故障不阻塞 · load 返 null · save 不抛)。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

const { mockRedisGet, mockRedisSet, mockCreateClient } = vi.hoisted(() => {
  const mockRedisGet = vi.fn();
  const mockRedisSet = vi.fn();
  const mockCreateClient = vi.fn(() => {
    return {
      on: vi.fn(),
      connect: vi.fn(async () => undefined),
      get: mockRedisGet,
      set: mockRedisSet,
    };
  });
  return { mockRedisGet, mockRedisSet, mockCreateClient };
});

vi.mock('redis', () => ({ createClient: mockCreateClient }));

import {
  capsKey,
  saveCapabilities,
  loadCapabilities,
  _resetCapabilityCacheClient,
} from '../server/capability-cache';

const REDIS_URL = 'redis://127.0.0.1:6379';
const ACCOUNT = 'acc-123';
const UA = 'claude-code/2.1.150 (cli)';
const CAPS = { elicitation: { form: {} }, roots: {} };

function expectedKey(account: string, ua: string) {
  const hash = createHash('sha256').update(ua).digest('hex').slice(0, 16);
  return `mcp:caps:${account}:${hash}`;
}

describe('capability-cache · capsKey', () => {
  it('hash 截断到 16 hex 字符 (= 64 bit 抗碰撞) · 不含特殊字符', () => {
    const key = capsKey(ACCOUNT, UA);
    expect(key).toMatch(/^mcp:caps:acc-123:[0-9a-f]{16}$/);
  });

  it('相同 (account, UA) 输入 → 相同 key (确定性)', () => {
    expect(capsKey(ACCOUNT, UA)).toBe(capsKey(ACCOUNT, UA));
  });

  it('UA 不同 → key 不同 (避免不同 client 共享 cache)', () => {
    expect(capsKey(ACCOUNT, 'cursor/1.0')).not.toBe(capsKey(ACCOUNT, UA));
  });

  it('account 不同 → key 不同 (多租户隔离)', () => {
    expect(capsKey('other', UA)).not.toBe(capsKey(ACCOUNT, UA));
  });
});

describe('capability-cache · saveCapabilities', () => {
  beforeEach(() => {
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    mockCreateClient.mockClear();
    _resetCapabilityCacheClient();
    process.env.REDIS_URL = REDIS_URL;
  });

  it('写 SET key value EX 24h (24*3600 sec)', async () => {
    mockRedisSet.mockResolvedValue('OK');
    await saveCapabilities(ACCOUNT, UA, CAPS);

    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    const [key, value, opts] = mockRedisSet.mock.calls[0];
    expect(key).toBe(expectedKey(ACCOUNT, UA));
    expect(JSON.parse(value)).toEqual(CAPS);
    expect(opts).toEqual({ EX: 24 * 3600 });
  });

  it('空 accountId · 不调 redis (无效 identity)', async () => {
    await saveCapabilities('', UA, CAPS);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('空 userAgent · 不调 redis', async () => {
    await saveCapabilities(ACCOUNT, '', CAPS);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('redis 抛错 · fail-soft (不向上抛 · 不阻塞主流程)', async () => {
    mockRedisSet.mockRejectedValue(new Error('ECONNRESET'));
    await expect(saveCapabilities(ACCOUNT, UA, CAPS)).resolves.toBeUndefined();
  });
});

describe('capability-cache · loadCapabilities', () => {
  beforeEach(() => {
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    mockCreateClient.mockClear();
    _resetCapabilityCacheClient();
    process.env.REDIS_URL = REDIS_URL;
  });

  it('命中 · 返回 parsed caps', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify(CAPS));
    const result = await loadCapabilities(ACCOUNT, UA);

    expect(mockRedisGet).toHaveBeenCalledWith(expectedKey(ACCOUNT, UA));
    expect(result).toEqual(CAPS);
  });

  it('未命中 (redis 返 null) · 返回 null', async () => {
    mockRedisGet.mockResolvedValue(null);
    expect(await loadCapabilities(ACCOUNT, UA)).toBeNull();
  });

  it('redis 抛错 · 返回 null (fail-soft · 调用方走 fail-closed deny)', async () => {
    mockRedisGet.mockRejectedValue(new Error('socket closed'));
    expect(await loadCapabilities(ACCOUNT, UA)).toBeNull();
  });

  it('JSON parse 失败 (corrupt value) · 返回 null', async () => {
    mockRedisGet.mockResolvedValue('{invalid json');
    expect(await loadCapabilities(ACCOUNT, UA)).toBeNull();
  });

  it('空 accountId · 不调 redis · 返回 null', async () => {
    expect(await loadCapabilities('', UA)).toBeNull();
    expect(mockRedisGet).not.toHaveBeenCalled();
  });

  it('REDIS_URL 未设 · 返回 null (本地无 redis 时 fail-soft)', async () => {
    delete process.env.REDIS_URL;
    delete process.env.KV_URL;
    expect(await loadCapabilities(ACCOUNT, UA)).toBeNull();
  });
});
