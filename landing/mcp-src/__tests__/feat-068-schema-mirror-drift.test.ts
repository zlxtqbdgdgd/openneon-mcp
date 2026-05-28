/**
 * feat-068 schema mirror drift 检测 · R2 元评 ⚠ 阻塞-B
 *
 * 本仓 `whitelist.schema.json` 是从 openneon anchor PR #39 mirror 来的 ·
 * `$schema_source_commit` 字段记 anchor commit SHA · 任何 anchor 升级必须:
 *   1. 同步 mirror schema 整个文件
 *   2. 刷 `$schema_source_commit` 字段
 *   3. 复跑本测试 + feat-068 fixture
 *
 * 本测试做 3 件事:
 *   A) shape 自检: 验证 mirror schema 顶层字段 (version=integer enum [1] / usdt+uprobe+denylist)
 *   B) source commit 字段非空 + 形似 git SHA (40 hex)
 *   C) 跟 loader (schema.ts) 的 Whitelist TypeScript 类型形状一致 (sanity probe · loader 加载 yaml fixture)
 *
 * 真正的"跟远端 anchor diff=0"由 CI workflow 跑 (curl anchor 仓 + diff) · 本测试是离线版。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import type { Whitelist } from '../tools/handlers/dynamic-probe';

const MIRROR_PATH = join(
  __dirname,
  '..',
  'tools',
  'handlers',
  'dynamic-probe',
  'whitelist.schema.json',
);
const FIXTURE_YAML_PATH = join(
  __dirname,
  '..',
  'tools',
  'handlers',
  'dynamic-probe',
  'whitelist.yaml',
);

describe('feat-068 schema mirror drift (R2 ⚠ 阻塞-B)', () => {
  const schema = JSON.parse(readFileSync(MIRROR_PATH, 'utf8')) as Record<
    string,
    unknown
  >;

  // ───────────────────────────────────────────────
  // A) shape 自检 · mirror schema 顶层字段必须跟 anchor 同
  it('A · 顶层 version 必须是 integer enum [1]', () => {
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['version']);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.version.type).toBe('integer');
    expect(props.version.enum).toEqual([1]);
  });

  it('A · usdt + uprobe 是 array · denylist 是 object · additionalProperties=false', () => {
    expect(schema.additionalProperties).toBe(false);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.usdt.type).toBe('array');
    expect(props.uprobe.type).toBe('array');
    expect(props.denylist.type).toBe('object');
    const denyProps = (props.denylist as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    expect(denyProps.usdt_probe_patterns.type).toBe('array');
    expect(denyProps.uprobe_symbol_patterns.type).toBe('array');
  });

  it('A · definitions.usdtEntry 必填 target/probe_name/subsystem', () => {
    const defs = schema.definitions as Record<string, Record<string, unknown>>;
    expect(defs.usdtEntry.required).toEqual([
      'target',
      'probe_name',
      'subsystem',
    ]);
  });

  it('A · definitions.uprobeEntry 必填 binary/symbol/module/type/is_async · is_async enum=[false]', () => {
    const defs = schema.definitions as Record<string, Record<string, unknown>>;
    expect(defs.uprobeEntry.required).toEqual([
      'binary',
      'symbol',
      'module',
      'type',
      'is_async',
    ]);
    const uprobeProps = defs.uprobeEntry.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(uprobeProps.is_async.type).toBe('boolean');
    expect(uprobeProps.is_async.enum).toEqual([false]);
  });

  // ───────────────────────────────────────────────
  // B) source commit 字段
  it('B · $schema_source_commit 字段存在且形似 git SHA (40 hex)', () => {
    expect(typeof schema.$schema_source_commit).toBe('string');
    expect(schema.$schema_source_commit).toMatch(/^[a-f0-9]{40}$/);
    expect(schema.$schema_source_repo).toBe('zlxtqbdgdgd/openneon');
    expect(schema.$schema_source_path).toBe(
      'pgxn/neon/probes/whitelist.schema.json',
    );
    expect(schema.$schema_source_pr).toBe('39');
  });

  // ───────────────────────────────────────────────
  // C) loader 类型形状自检 · fixture yaml load 上来必须能 pass shape check
  it('C · fixture whitelist.yaml 跟 mirror schema 同形 · loader 能 load + 屏障 2 通过', async () => {
    const parsed = yamlLoad(readFileSync(FIXTURE_YAML_PATH, 'utf8')) as Whitelist;
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.usdt)).toBe(true);
    expect(Array.isArray(parsed.uprobe)).toBe(true);
    expect(typeof parsed.denylist).toBe('object');
    expect(Array.isArray(parsed.denylist)).toBe(false);
    // 屏障 2: 每个 uprobe is_async === false
    for (const entry of parsed.uprobe ?? []) {
      expect(entry.is_async).toBe(false);
    }
  });

  it('C · loader load fixture 走全套 shape + 屏障 2 check 不抛', async () => {
    const {
      loadWhitelist,
      __resetWhitelistCacheForTest,
    } = await import('../tools/handlers/dynamic-probe');
    __resetWhitelistCacheForTest();
    expect(() => loadWhitelist(FIXTURE_YAML_PATH)).not.toThrow();
  });

  it('C · loader 拒 is_async=true 的 uprobe (A5 屏障 2)', async () => {
    const { __setWhitelistForTest } = await import(
      '../tools/handlers/dynamic-probe'
    );
    const bad = {
      version: 1,
      uprobe: [
        {
          binary: 'pageserver',
          symbol: 'neon::async_fn',
          module: 'neon',
          type: 'sync_fn',
          // @ts-expect-error 显式触发屏障 2 · 测试用
          is_async: true,
        },
      ],
    };
    expect(() => __setWhitelistForTest(bad as any)).toThrow(
      /is_async.*不合规|屏障 2/,
    );
  });
});
