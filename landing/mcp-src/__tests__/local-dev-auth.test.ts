import { describe, it, expect, afterEach } from 'vitest';
import {
  isLocalDevAuthEnabled,
  buildLocalDevAuthInfo,
} from '../server/local-dev-auth';
import { DEFAULT_GRANT } from '../utils/grant-context';

const origEnv = process.env.NEON_LOCAL_URL;
afterEach(() => {
  if (origEnv === undefined) delete process.env.NEON_LOCAL_URL;
  else process.env.NEON_LOCAL_URL = origEnv;
});

describe('isLocalDevAuthEnabled (自托管 dev auth 旁路 · NEON_LOCAL_URL gate)', () => {
  it('NEON_LOCAL_URL set → true', () => {
    process.env.NEON_LOCAL_URL = 'postgres://x@127.0.0.1:55432/neondb';
    expect(isLocalDevAuthEnabled()).toBe(true);
  });

  it('NEON_LOCAL_URL unset → false (production 默认 · 正常 Neon Cloud 鉴权)', () => {
    delete process.env.NEON_LOCAL_URL;
    expect(isLocalDevAuthEnabled()).toBe(false);
  });
});

describe('buildLocalDevAuthInfo (synthetic 本地身份)', () => {
  it('/api/mcp → transport stream · all scopes · grant=DEFAULT_GRANT · 无需 bearer', () => {
    const info = buildLocalDevAuthInfo(
      new Request('http://localhost:3344/api/mcp?include=all'),
      undefined,
      'Claude Code/1.0',
    );
    expect(info.scopes).toEqual(['*']);
    expect(info.clientId).toBe('local-dev');
    const extra = info.extra as Record<string, unknown>;
    expect((extra.account as { id: string }).id).toBe('local-dev');
    expect(extra.apiKey).toBe('local-dev'); // 无 bearer → 占位
    expect(extra.readOnly).toBe(false);
    expect(extra.grant).toEqual(DEFAULT_GRANT);
    expect(extra.transport).toBe('stream');
    expect(extra.userAgent).toBe('Claude Code/1.0');
  });

  it('/api/sse → transport sse', () => {
    const info = buildLocalDevAuthInfo(
      new Request('http://localhost:3344/api/sse'),
      undefined,
      undefined,
    );
    expect((info.extra as Record<string, unknown>).transport).toBe('sse');
  });

  it('带 bearer → token/apiKey 透传该 bearer (不强制覆盖)', () => {
    const info = buildLocalDevAuthInfo(
      new Request('http://localhost:3344/api/mcp'),
      'napi_realkey',
      undefined,
    );
    expect(info.token).toBe('napi_realkey');
    expect((info.extra as Record<string, unknown>).apiKey).toBe('napi_realkey');
  });
});
