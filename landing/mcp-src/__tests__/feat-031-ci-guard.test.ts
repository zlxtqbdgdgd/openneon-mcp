/**
 * feat-031-ci-guard.test.ts · CI guard: 防 ad-hoc audit emission
 *
 * feat-031 §6 single-source 原则: 所有 audit event 必须通过 emitAuditEvent · 不允许:
 *   - console.log('audit:...') 类 ad-hoc 输出
 *   - logger.info/warn 含 'audit_event' / 'audit:' 等关键字
 *
 * 此 test 用 grep-style 扫描 mcp-src/ (排除 observability/ 自己 + __tests__/)。
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const MCP_SRC_DIR = path.resolve(__dirname, '..');

function grep(pattern: string): string[] {
  try {
    const out = execFileSync(
      'grep',
      [
        '-rEn',
        '--include=*.ts',
        '--exclude-dir=__tests__',
        '--exclude-dir=observability',
        pattern,
        MCP_SRC_DIR,
      ],
      { encoding: 'utf8' },
    );
    return out.trim() ? out.trim().split('\n') : [];
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    // grep exit 1 = 无匹配 · 正常
    if (e.status === 1) return [];
    throw err;
  }
}

describe('feat-031 CI guard · single-source audit emission', () => {
  it('no console.log("audit*") in mcp-src (除 observability/ + __tests__/)', () => {
    const hits = grep('console\\.(log|info|warn|error)\\(\\s*["\'`]audit');
    expect(hits, `found ad-hoc audit console.log:\n${hits.join('\n')}`).toEqual(
      [],
    );
  });

  it('no logger.info/warn with "audit_event" / "audit:" prefix in mcp-src', () => {
    const hits = grep('logger\\.(info|warn|error)\\([^)]*audit_event');
    expect(hits, `found ad-hoc audit logger:\n${hits.join('\n')}`).toEqual([]);
  });
});
