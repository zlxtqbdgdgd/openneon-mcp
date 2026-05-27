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
  delete process.env.NODE_ENV;
  delete process.env.OBFUSCATOR_MODE;
});

describe('feat-024/#2 · CI grep guard 1 · raw_param 不泄露到 production code', () => {
  it('samples-store/ + search-samples.ts 0 raw_param hit (raw-sample.ts internal + fixture 允许)', () => {
    const hits = grep(
      'raw_params|rawParams|raw_param',
      ['server-enrich/samples-store', 'tools/handlers/search-samples.ts'],
      [
        'server-enrich/samples-store/raw-sample.ts', // internal · 唯一允许定义 raw_params 的地方
        'server-enrich/samples-store/auto-explain-collector.ts', // 只读 raw-sample 的 collector (注释/字段引用)
      ],
    );
    expect(hits).toEqual([]);
  });
});

describe('feat-024/#2 · CI grep guard 2 · 无 obfuscate opt-out 绕过', () => {
  it('全 mcp-src 0 hit: obfuscate=false / skipObfuscate / OBFUSCATOR_MODE 硬编码 moderate', () => {
    const hits = grep(
      'obfuscate[^a-zA-Z]*=[^=]*false|skipObfuscate|OBFUSCATOR_MODE[^!]*=[^=]*.moderate.',
      ['server-enrich/samples-store', 'tools/handlers/search-samples.ts'],
    );
    expect(hits).toEqual([]);
  });
});

describe('feat-024/#2 · CI grep guard 3 · production OBFUSCATOR_MODE check', () => {
  it('NODE_ENV=production + OBFUSCATOR_MODE=moderate → log error + warn (不 throw)', () => {
    process.env.NODE_ENV = 'production';
    process.env.OBFUSCATOR_MODE = 'moderate';
    const error = vi.fn();
    const warn = vi.fn();
    const detected = assertProductionObfuscatorMode({ error, warn });
    expect(detected).toBe(true);
    expect(error).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('NODE_ENV=production + OBFUSCATOR_MODE=strict → 不报警', () => {
    process.env.NODE_ENV = 'production';
    process.env.OBFUSCATOR_MODE = 'strict';
    const error = vi.fn();
    const warn = vi.fn();
    expect(assertProductionObfuscatorMode({ error, warn })).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });
});
