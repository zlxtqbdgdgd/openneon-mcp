#!/usr/bin/env node
// feat-072/#217 (ADR-0019): local stdio MCP entrypoint.
//
// Builds the server via createMcpServer (now backed by registerNeonServer — the
// SAME feat-056 pipeline as the HTTP path: classify → runPipeline → injected
// approval → handler) and connects it over StdioServerTransport. stdio is
// bidirectional, so the pipeline's `elicitInput` human-approval round-trip works
// natively — no redis, no public network port. Local trust model: auth is the
// caller's NEON_API_KEY, resolved to the account via the Neon API (same resolver
// the OAuth path uses).
//
// Run: `NEON_API_KEY=... pnpm run mcp:stdio`  (set NEON_READ_ONLY=true for RO).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './index';
import { createNeonClient } from './api';
import { resolveAccountFromAuth } from './account';
import { DEFAULT_GRANT } from '../utils/grant-context';
import { logger } from '../utils/logger';
import type { ServerContext } from '../types/context';
import pkg from '../../package.json';

async function main(): Promise<void> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      'NEON_API_KEY env var is required to run the Neon MCP server over stdio\n',
    );
    process.exit(1);
  }

  const readOnly = process.env.NEON_READ_ONLY === 'true';
  const neonClient = createNeonClient(apiKey);
  const { data: auth } = await neonClient.getAuthDetails();
  const account = await resolveAccountFromAuth(auth, neonClient);

  const context: ServerContext = {
    apiKey,
    account,
    app: {
      name: 'mcp-server-neon',
      transport: 'stdio',
      environment: (process.env.NODE_ENV ??
        'production') as ServerContext['app']['environment'],
      version: pkg.version,
    },
    readOnly,
    grant: DEFAULT_GRANT,
  };

  const server = await createMcpServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Neon MCP server running on stdio', {
    account: account.id,
    readOnly,
  });
}

main().catch((err) => {
  process.stderr.write(
    `Failed to start Neon MCP stdio server: ${
      err instanceof Error ? err.message : String(err)
    }\n`,
  );
  process.exit(1);
});
