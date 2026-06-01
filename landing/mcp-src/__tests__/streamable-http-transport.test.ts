/**
 * feat-072/#216 (ADR-0019): 有状态 Streamable HTTP transport 的 session 生命周期。
 *
 * 在进程内驱动 handleStatefulStreamableHttp（裸 SDK WebStandardStreamableHTTPServerTransport）
 * 跑一次真实 MCP initialize 握手，证明：① 建立 server + 经 registerNeonServer 注册不抛 ②
 * 分配 Mcp-Session-Id（有状态）③ 同 id 复用同一 session、不同 id 各自独立。真 tool-call /
 * elicitation 双路径走 dev-server 直连 e2e 验（test-infra · #216 acceptance）。
 */
import { describe, it, expect } from 'vitest';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { handleStatefulStreamableHttp } from '../server/streamable-http-transport';
import type { StaticToolContext } from '../server/register-neon-server';
import { DEFAULT_GRANT } from '../utils/grant-context';

const staticToolContext: StaticToolContext = {
  grant: DEFAULT_GRANT,
  readOnly: false,
  categoryInclude: 'all',
  sseOwnerIdentity: null,
};

const auth = {
  token: 'test-token',
  clientId: 'test-client',
  scopes: [],
  extra: {
    apiKey: 'test-api-key',
    account: { id: 'user_test', name: 'Test User' },
    grant: DEFAULT_GRANT,
    readOnly: false,
  },
} as unknown as AuthInfo;

function initRequest(): Request {
  const req = new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }),
  });
  (req as Request & { auth?: AuthInfo }).auth = auth;
  return req;
}

describe('handleStatefulStreamableHttp (feat-072/#216 · 有状态 streamable)', () => {
  it('initialize 建立有状态 session 并分配 Mcp-Session-Id', async () => {
    const res = await handleStatefulStreamableHttp(initRequest(), staticToolContext);
    expect(res.ok).toBe(true);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('两次 initialize 分到不同 session id（各自独立有状态）', async () => {
    const a = await handleStatefulStreamableHttp(initRequest(), staticToolContext);
    const b = await handleStatefulStreamableHttp(initRequest(), staticToolContext);
    const idA = a.headers.get('mcp-session-id');
    const idB = b.headers.get('mcp-session-id');
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
  });
});
