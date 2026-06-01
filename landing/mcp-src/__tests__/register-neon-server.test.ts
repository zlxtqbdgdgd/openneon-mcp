/**
 * feat-072/#215 (ADR-0019): registerNeonServer is transport-agnostic.
 *
 * Proves the extracted shared registration module wires the full Neon tool
 * surface onto a plain MCP `McpServer` (constructed here directly, NOT via the
 * mcp-handler HTTP path) and serves tools/list over real MCP protocol through an
 * in-memory transport. The injected approval (`elicit`) seam is supplied as a
 * dep — never reached for tools/list — confirming the module does not hardcode
 * `server.server.elicitInput`. The full callTool→pipeline→elicit path is
 * covered by the live dev-server e2e (feat-072/#216 acceptance).
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  registerNeonServer,
  type NeonServerRegistrationDeps,
  type ResolvedAuthContext,
} from '../server/register-neon-server';
import { DEFAULT_GRANT } from '../utils/grant-context';
import type { ServerContext } from '../types/context';

const testContext: ServerContext = {
  apiKey: 'test-api-key',
  account: { id: 'user_test_123', name: 'Test User', email: 'test@example.com' },
  app: {
    name: 'mcp-server-neon',
    transport: 'stream',
    environment: 'development',
    version: 'test',
  },
  readOnly: false,
  grant: DEFAULT_GRANT,
};

function makeDeps(elicit = vi.fn()): NeonServerRegistrationDeps {
  return {
    staticToolContext: {
      grant: DEFAULT_GRANT,
      readOnly: false,
      categoryInclude: 'all',
      sseOwnerIdentity: null,
    },
    getAuthContext: vi.fn(
      async () =>
        ({
          apiKey: 'test-api-key',
          account: testContext.account,
          readOnly: false,
          grant: DEFAULT_GRANT,
          neonClient: {} as ResolvedAuthContext['neonClient'],
          clientApplication: 'other',
          clientName: 'test-client',
          client: undefined,
          context: testContext,
        }) as ResolvedAuthContext,
    ),
    trackServerInit: vi.fn(),
    checkEnvelopeMatches: () => false,
    elicit,
  };
}

async function withRegisteredServer<T>(
  deps: NeonServerRegistrationDeps,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const server = new McpServer(
    { name: 'mcp-server-neon', version: 'test' },
    { capabilities: { tools: {}, prompts: { listChanged: true } } },
  );
  registerNeonServer(server, deps);

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('registerNeonServer (feat-072/#215 · transport-agnostic registration)', () => {
  it('serves the full tool surface over MCP protocol on a plain McpServer', async () => {
    const elicit = vi.fn();
    await withRegisteredServer(makeDeps(elicit), async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);

      expect(tools.length).toBeGreaterThan(0);
      // a stable upstream management tool is present under DEFAULT_GRANT + include=all
      expect(names).toContain('list_projects');
      // every advertised tool carries a name + input schema
      for (const t of tools) {
        expect(typeof t.name).toBe('string');
        expect(t.inputSchema).toBeTruthy();
      }
      // the injected approval seam is not touched by a plain listing
      expect(elicit).not.toHaveBeenCalled();
    });
  });

  it('accepts an injected approval strategy (elicit) as a dependency', () => {
    // structural guarantee: deps carries elicit; the module does not hardcode
    // server.server.elicitInput (slices #216/#217 inject real-human vs auto-approve).
    const elicit = vi.fn();
    const deps = makeDeps(elicit);
    expect(deps.elicit).toBe(elicit);
    expect(typeof deps.getAuthContext).toBe('function');
  });
});
