/**
 * feat-024-ci-guard.test.ts · feat-024/#2 · 3 CI grep guard (OWASP LLM02 防回归)。
 *
 * 详设 §3 CI grep guard + §7 用例 11-13:
 *  1. raw_params / rawParams / raw_param 0 production hit (仅 raw-sample.ts internal + 本 fixture 见)
 *  2. obfuscate=false / skipObfuscate / OBFUSCATOR_MODE 强写 moderate 0 hit (防 opt-out 绕过)
 *  3. 启动期 NODE_ENV=production + OBFUSCATOR_MODE !== 'strict' → log error + warn
 *
 * 铁律: 本仓不跑测试 · 本文件写出即可。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { assertProductionObfuscatorMode } from '../server-enrich/samples-store/obfuscator';

const MCP_SRC = join(new URL(import.meta.url).pathname, '..', '..');

/** grep -rn · 返回命中行 (排除允许文件)。grep 无命中退出码 1 → 当空处理。 */
function grep(pattern: string, paths: string[], excludes: string[] = []): string[] {
  try {
    const out = execSync(
      `grep -rnE ${JSON.stringify(pattern)} ${paths.map((p) => JSON.stringify(p)).join(' ')}`,
      { cwd: MCP_SRC, encoding: 'utf8' },
    );
    return out
      .split('\n')
      .filter((l) => l.trim() !== '')
      .filter((l) => !excludes.some((ex) => l.includes(ex)));
  } catch {
    return []; // grep 无命中 → 退出码 1
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  // 现代 @types/node 把 NODE_ENV 标 readonly · 用 bracket 索引 (process.env 索引签名是
  // string | undefined · 可赋可 delete) 绕过 typedef · 不改运行期语义。
  delete (process.env as Record<string, string | undefined>)['NODE_ENV'];
  delete (process.env as Record<string, string | undefined>)['OBFUSCATOR_MODE'];
});

describe('feat-024/#2 · CI grep guard 1 · raw_param 不泄露到 production code', () => {
  it('samples-store/ + search-samples.ts 0 raw_param hit (raw-sample.ts internal + fixture 允许)', () => {
    const hits = grep(
      'raw_params|rawParams|raw_param',
      ['server-enrich/samples-store', 'tools/handlers/search-samples.ts'],
      [
        'server-enrich/samples-store/raw-sample.ts', // internal · 唯一允许定义 raw_params 的地方
        'server-enrich/samples-store/auto-explain-collector.ts', // 只读 raw-sample 的 collector (注释/字段引用)
        'server-enrich/samples-store/obfuscator.ts', // 唯一 raw → obfuscated 转换通路 (§3 三层防御) · 读 raw.raw_params.length 推 params_obfuscated 长度
      ],
    );
    expect(hits).toEqual([]);
  });
});

describe('feat-024/#2 · CI grep guard 2 · 无 obfuscate opt-out 绕过', () => {
  it('全 mcp-src 0 hit: obfuscate=false / skipObfuscate / OBFUSCATOR_MODE 硬编码 moderate', () => {
    // 3 个独立 pattern · 分别跑避免 ERE alternation 误配:
    //  a) obfuscate 后跟 `=` (赋值) + false (skip)
    //  b) skipObfuscate 标识符
    //  c) OBFUSCATOR_MODE 单 `=` 赋值 'moderate' (排除 `===` 比较)
    // c 用 `[^=]=[^=]` 锁定单 `=` (前后非 `=`) · 防误配 `OBFUSCATOR_MODE === 'moderate'` 这类比较表达式。
    const patterns = [
      'obfuscate[^a-zA-Z]*=[[:space:]]*false',
      'skipObfuscate',
      "OBFUSCATOR_MODE[[:space:]]*=[[:space:]]*['\"]moderate['\"]",
    ];
    const allHits: string[] = [];
    for (const p of patterns) {
      allHits.push(
        ...grep(p, ['server-enrich/samples-store', 'tools/handlers/search-samples.ts']),
      );
    }
    expect(allHits).toEqual([]);
  });
});

describe('feat-024/#2 · CI grep guard 3 · production OBFUSCATOR_MODE check', () => {
  it('NODE_ENV=production + OBFUSCATOR_MODE=moderate → log error + warn (不 throw)', () => {
    (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'production';
    process.env.OBFUSCATOR_MODE = 'moderate';
    const error = vi.fn();
    const warn = vi.fn();
    const detected = assertProductionObfuscatorMode({ error, warn });
    expect(detected).toBe(true);
    expect(error).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('NODE_ENV=production + OBFUSCATOR_MODE=strict → 不报警', () => {
    (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'production';
    process.env.OBFUSCATOR_MODE = 'strict';
    const error = vi.fn();
    const warn = vi.fn();
    expect(assertProductionObfuscatorMode({ error, warn })).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });
});
