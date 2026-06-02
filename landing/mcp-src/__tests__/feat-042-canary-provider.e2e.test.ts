/**
 * feat-042 · NeonLocalBranchProvider e2e (ADR-0021 验收 gate · dev server 直连真 neon_local)
 *
 * 设计依据: [ADR-0021](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/docs/adr/0021-branch-lifecycle-self-hosted-control-plane-never-official-cloud.md)
 *   要求 "转 done 必须 dev-server 直连 e2e 真建一次分支" · 本测验真 provider 代码 (非 mock)。
 *
 * 只在 dev server (NEON_LOCAL_REPO_DIR 指向真 neon_local 仓) 跑 · 本地 / CI 自动 skip。
 * 跑法 (dev server):
 *   NEON_LOCAL_REPO_DIR=/home/z1/liqiang/zlxtqbdgdgd/openneon \
 *     npx vitest run mcp-src/__tests__/feat-042-canary-provider.e2e.test.ts
 *
 * 验证完整 canary 生命周期 (全程自托管开源栈 · 永不连官方云):
 *   建分支 → 起 compute endpoint → 真 DDL → 列分支(带回填 expiry) → 删分支 → 确认清理。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import {
  NeonLocalBranchProvider,
  createNeonLocalConnStringResolver,
} from '../server-enrich/canary/neon-local-branch-provider';

const REPO = process.env.NEON_LOCAL_REPO_DIR;

// 占位守卫: 确保本文件在缺 NEON_LOCAL_REPO_DIR 时仍有 1 个收集到的用例 (否则 vitest 报 "no tests"
// 失败)。真 e2e 在下方 describe.skipIf · 只在 dev server 跑。
it('e2e 文件守卫 (provider 可导入)', () => {
  expect(typeof NeonLocalBranchProvider).toBe('function');
});

/** pageserver DELETE timeline 是 202 异步 · 轮询直到 list 不再含该 branch。 */
async function waitGone(
  provider: NeonLocalBranchProvider,
  id: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const list = await provider.listCanaryBranches();
    if (!list.some((b) => b.id === id)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

describe.skipIf(!REPO)(
  'feat-042 · NeonLocalBranchProvider e2e (真 neon_local · 无云)',
  () => {
    // 注意: describe.skipIf 仍会在 collection 期执行 describe 体 · 故 provider 实例化必须放进
    // it 体内 (否则缺 NEON_LOCAL_REPO_DIR 时 readConfig 抛 · 整个文件 collection 失败)。
    let leaked: string | undefined;
    let provider: NeonLocalBranchProvider;

    afterAll(async () => {
      if (leaked && provider)
        await provider.deleteBranch('p', leaked).catch(() => {});
    });

    it('建分支 → compute → 真 DDL → 列 → 删 · 全生命周期', async () => {
      provider = new NeonLocalBranchProvider();
      const resolver = createNeonLocalConnStringResolver();
      const expiry = Date.now() + 7 * 86_400_000;

      // 1. 建分支 (timeline branch off main · 真数据快照)
      const meta = await provider.createCanaryBranch('p', {
        name: `canary-e2e-${expiry}`,
        expiryTsMs: expiry,
      });
      leaked = meta.branch_id;
      expect(meta.branch_id).toMatch(/^[0-9a-f]{32}$/);
      expect(meta.branch_name).toContain(`--exp${expiry}`);

      // 2. 起 compute endpoint → connstr → 真 DDL on canary
      const connStr = await resolver('p', meta.branch_id, meta.branch_name);
      expect(connStr).toMatch(/^postgresql:\/\//);
      const client = new Client({ connectionString: connStr });
      await client.connect();
      try {
        await client.query('CREATE TABLE _canary_e2e_probe(x int)');
        await client.query('INSERT INTO _canary_e2e_probe VALUES (42)');
        const r = await client.query(
          'SELECT count(*)::int AS n FROM _canary_e2e_probe',
        );
        expect(r.rows[0].n).toBe(1);
      } finally {
        await client.end();
      }

      // 3. 列分支: expiry 从 branch 名解析回填到 annotations
      const listed = await provider.listCanaryBranches();
      const found = listed.find((b) => b.id === meta.branch_id);
      expect(found).toBeDefined();
      expect(found?.annotations?.expiry_ts).toBe(String(expiry));

      // 4. 删分支 (拆 endpoint + pageserver HTTP delete timeline) → 确认清理
      await provider.deleteBranch('p', meta.branch_id);
      leaked = undefined;
      expect(await waitGone(provider, meta.branch_id)).toBe(true);
    }, 180_000);
  },
);
