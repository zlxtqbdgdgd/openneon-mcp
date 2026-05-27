/**
 * feat-024-store.test.ts · feat-024/#2 · brand type 编译期拒 raw + samples-store 行为。
 *
 * 详设 §3 三层防御 + §7 用例 10: brand type 阻止误传 (`store.writeSample(rawSample as QuerySample)`
 * → ts compile error) · store filter / TTL evict / cap LRU / multi-project 隔离。
 *
 * 铁律: 本仓不跑测试 · 本文件写出即可。
 */
import { describe, it, expect } from 'vitest';
import { MemorySamplesStore } from '../server-enrich/samples-store/memory-store';
import { makeRawSample } from '../server-enrich/samples-store/raw-sample';
import { obfuscate } from '../server-enrich/samples-store/obfuscator';
import type { QuerySample } from '../server-enrich/samples-store/types';

const PROJECT = 'proj-1';

function sample(over: Partial<QuerySample>): QuerySample {
  const base = obfuscate(
    makeRawSample({
      duration_ms: 1000,
      raw_plan: '{}',
      raw_query: "SELECT * FROM t WHERE id='x'",
      raw_params: ['x'],
      captured_at: Date.now(),
    }),
    PROJECT,
    'strict',
  );
  return { ...base, ...over };
}

describe('feat-024/#2 · 用例10 · brand type 编译期拒 raw', () => {
  it('writeSample 仅接受 QuerySample · raw 误传是编译期错误 (@ts-expect-error 锁住)', async () => {
    const store = new MemorySamplesStore();
    const raw = makeRawSample({
      duration_ms: 1,
      raw_plan: '{}',
      raw_query: 'SELECT 1',
      raw_params: [],
      captured_at: Date.now(),
    });
    // @ts-expect-error — RawSample (__brand:'raw') 不可赋给 writeSample(sample: QuerySample)
    // (__brand:'obfuscated')。这行若不再报编译错 · tsc 会让 @ts-expect-error 自己 fail · CI 拦回归。
    const reject = () => store.writeSample(raw);
    void reject; // 运行期不真调 (raw 进不去 store) · 编译期断言即足够
    expect(typeof reject).toBe('function');
  });
});

describe('feat-024/#2 · samples-store 行为', () => {
  it('用例14 · filter signature · 50 samples query signature=A → 仅 A', async () => {
    const store = new MemorySamplesStore();
    await store.writeSample(sample({ signature: 'AAAAAAAAAAAAAAAA' }));
    for (let i = 0; i < 49; i++)
      await store.writeSample(sample({ signature: `oth${i}`.padEnd(16, '0') }));
    const hits = await store.searchSamples({ projectId: PROJECT, signature: 'AAAAAAAAAAAAAAAA' });
    expect(hits).toHaveLength(1);
    expect(hits[0].signature).toBe('AAAAAAAAAAAAAAAA');
  });

  it('用例15 · filter time_range last 24h · 10 samples 5 过期 → 5 hit', async () => {
    const store = new MemorySamplesStore(86_400_000, () => Date.now());
    const now = Date.now();
    for (let i = 0; i < 5; i++)
      await store.writeSample(sample({ signature: `f${i}`.padEnd(16, '0'), captured_at: now - 1000 }));
    for (let i = 0; i < 5; i++)
      await store.writeSample(sample({ signature: `e${i}`.padEnd(16, '0'), captured_at: now - 25 * 3600_000 }));
    const hits = await store.searchSamples({
      projectId: PROJECT,
      time_range: { from: now - 86_400_000, to: now },
    });
    // TTL 24h: 过期的 5 条已被惰性剔除 → 5 hit
    expect(hits).toHaveLength(5);
  });

  it('用例16 · filter duration_min_ms=1000 · 5 samples 2 满足 → 2 hit', async () => {
    const store = new MemorySamplesStore();
    await store.writeSample(sample({ signature: 's1'.padEnd(16, '0'), duration_ms: 2340 }));
    await store.writeSample(sample({ signature: 's2'.padEnd(16, '0'), duration_ms: 1500 }));
    for (let i = 0; i < 3; i++)
      await store.writeSample(sample({ signature: `s${i + 3}`.padEnd(16, '0'), duration_ms: 100 }));
    const hits = await store.searchSamples({ projectId: PROJECT, duration_min_ms: 1000 });
    expect(hits).toHaveLength(2);
  });

  it('TTL evict · 25h 前 sample · evictExpired 清掉', async () => {
    const store = new MemorySamplesStore(86_400_000, () => Date.now());
    await store.writeSample(sample({ signature: 'old'.padEnd(16, '0'), captured_at: Date.now() - 25 * 3600_000 }));
    await store.writeSample(sample({ signature: 'new'.padEnd(16, '0'), captured_at: Date.now() - 1000 }));
    expect(await store.evictExpired()).toBe(1);
    expect(store.size()).toBe(1);
  });

  it('multi-project 隔离 · 别的 project 不串', async () => {
    const store = new MemorySamplesStore();
    await store.writeSample(sample({ projectId: 'other', signature: 'x'.padEnd(16, '0') }));
    const hits = await store.searchSamples({ projectId: PROJECT });
    expect(hits).toHaveLength(0);
  });
});
