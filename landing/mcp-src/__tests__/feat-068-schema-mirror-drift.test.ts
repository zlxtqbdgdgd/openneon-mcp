/**
 * feat-068 denylist mirror drift 检测 · 重设计 (#210 · ADR-0017)
 *
 * 重设计前: 本测试校验 `whitelist.schema.json` mirror (whitelist 强制模型)。
 * 重设计后: whitelist 强制模型废除 · 改 denylist FLOOR · 本测试改校验 `denylist.yaml` mirror。
 *
 * 本仓 `denylist.yaml` 是从 openneon `pgxn/neon/probes/denylist.yaml` (#91 floor 语义) mirror 来的 ·
 * 文件头 `$source_commit` 字段记 openneon commit SHA · 任何 anchor 升级必须:
 *   1. 同步 mirror denylist.yaml 整文件
 *   2. 刷文件头 `$source_commit` 字段
 *   3. 复跑本测试 + feat-068 fixture
 *
 * 本测试做 3 件事:
 *   A) shape 自检: version=1 · denylist {usdt_probe_patterns, uprobe_symbol_patterns} 是 array
 *   B) source provenance: 文件头 $source_commit 形似 git SHA (40 hex) + $source_repo / $source_path
 *   C) loader (denylist.ts) 能 load mirror + 关键安全 pattern 在场 (scram_/password/be_tls)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import type { Denylist } from '../tools/handlers/dynamic-probe';

const MIRROR_PATH = join(
  __dirname,
  '..',
  'tools',
  'handlers',
  'dynamic-probe',
  'denylist.yaml',
);

describe('feat-068 denylist mirror drift (#210)', () => {
  const rawText = readFileSync(MIRROR_PATH, 'utf8');
  const parsed = yamlLoad(rawText) as Denylist;

  // ───────────────────────────────────────────────
  // A) shape 自检
  it('A · version=1 · denylist 是 object · usdt/uprobe pattern 是 array', () => {
    expect(parsed.version).toBe(1);
    expect(typeof parsed.denylist).toBe('object');
    expect(Array.isArray(parsed.denylist)).toBe(false);
    expect(Array.isArray(parsed.denylist.usdt_probe_patterns)).toBe(true);
    expect(Array.isArray(parsed.denylist.uprobe_symbol_patterns)).toBe(true);
    expect((parsed.denylist.usdt_probe_patterns ?? []).length).toBeGreaterThan(0);
  });

  // ───────────────────────────────────────────────
  // B) source provenance (文件头注释)
  it('B · 文件头 $source_commit 形似 git SHA (40 hex) + $source_repo/$source_path', () => {
    const commitM = rawText.match(/\$source_commit:\s*([a-f0-9]{40})/);
    expect(commitM, '$source_commit 必须存在且 40 hex').not.toBeNull();
    expect(rawText).toContain('$source_repo:   zlxtqbdgdgd/openneon');
    expect(rawText).toContain(
      '$source_path:   pgxn/neon/probes/denylist.yaml',
    );
  });

  // ───────────────────────────────────────────────
  // C) loader 能 load + 关键安全 pattern 在场
  it('C · loadDenylist 能 load mirror · 不抛', async () => {
    const { loadDenylist, __resetDenylistCacheForTest } = await import(
      '../tools/handlers/dynamic-probe'
    );
    __resetDenylistCacheForTest();
    expect(() => loadDenylist(MIRROR_PATH)).not.toThrow();
  });

  it('C · 关键安全 pattern (scram_ / password / be_tls_) 在 floor 内 · 实测命中', async () => {
    const { checkDenylist } = await import(
      '../tools/handlers/dynamic-probe/denylist'
    );
    // 用 mirror 实际内容跑 floor · 验证安全敏感函数被拒
    for (const fn of ['scram_ClientKey', 'get_role_password', 'be_tls_open_server', 'pg_md5_hash']) {
      const r = checkDenylist(fn, 'pg', parsed);
      expect(r.ok, `${fn} 必须命中 denylist floor`).toBe(false);
    }
    // 普通函数不被误伤
    expect(checkDenylist('PortalStart', 'pg', parsed).ok).toBe(true);
    expect(checkDenylist('ExecutorRun', 'pg', parsed).ok).toBe(true);
  });
});
