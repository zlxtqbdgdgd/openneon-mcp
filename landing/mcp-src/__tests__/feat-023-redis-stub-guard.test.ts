/**
 * feat-023-redis-stub-guard.test.ts · feat-023/#1 · CI guard (acceptance · 跟 feat-026 L4 stub 同模式)。
 *
 * 防 redis-store.ts 的 RedisPlanStore 方法被悄悄改成"半截实现" —— 当前 L2a/L2b 只能是 stub
 * (single-process · in-memory backend) · redis backend 留 L3+ multi-worker (§11 OQ2)。
 *
 * 规则: RedisPlanStore 每个 async 方法 body 必须含 "throw new NotImplementedError" ·
 * 且不含 return 真数据 / new Redis() 类启用逻辑。
 *
 * 铁律: 本仓不跑测试 · 本文件写出即可。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('feat-023/#1 · redis-store stub CI guard', () => {
  const src = readFileSync(
    join(
      new URL(import.meta.url).pathname,
      '..',
      '..',
      'server-enrich',
      'plan-store',
      'redis-store.ts',
    ),
    'utf8',
  );

  it('RedisPlanStore 三个方法体都 throw NotImplementedError', () => {
    for (const fn of ['writePlan', 'searchPlans', 'evictExpired']) {
      const m = src.match(new RegExp(`async ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n  \\}`));
      expect(m, `method ${fn} not found`).not.toBeNull();
      expect(m![1]).toContain('throw new NotImplementedError');
    }
  });

  it('redis-store 不含真启用逻辑 (new Redis / createClient / 实现数据返回)', () => {
    expect(src).not.toMatch(/new Redis\(|createClient\(|ioredis/);
    // 方法 body 内不应出现 return 数据 (除类型注解外)。
    expect(src).not.toMatch(/return\s+\[|return\s+\d|return\s+records/);
  });
});
