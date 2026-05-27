/**
 * feat-026-l4-stub-guard.test.ts · feat-026/#1 · CI guard (详设 §11 OQ8)
 *
 * 防 `issuePreApprovedToken` body 被悄悄改成颁发真 token —— 这会绕过 plan mode 主闸门成为
 * security incident。L4 ship 时 (feat-049 + feat-051 同 PR) 改 body 配合 ODD/MRC wired assertion。
 *
 * grep 规则: confirm-token-issuer.ts 内 issuePreApprovedToken 函数 body 必须含
 * "throw new NotImplementedError" · 否则 fail。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('feat-026/#1 · L4 stub CI guard (防回归启用)', () => {
  it('issuePreApprovedToken body 必须 throw NotImplementedError', () => {
    const src = readFileSync(
      join(
        new URL(import.meta.url).pathname,
        '..',
        '..',
        'policy',
        'confirm-token-issuer.ts',
      ),
      'utf8',
    );
    // 找函数声明跟下一个 close-brace 之间的 body
    const fnMatch = src.match(
      /export function issuePreApprovedToken[\s\S]*?\{([\s\S]*?)\n\}/,
    );
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![1];
    expect(body).toContain('throw new NotImplementedError');
    // 额外确认 body 不含"颁发"逻辑残留 (putToken / issueConfirmToken / return snapshot 等)
    expect(body).not.toMatch(/putToken|return\s*\{/);
  });
});
