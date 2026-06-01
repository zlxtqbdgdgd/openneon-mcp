#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../utils/logger';
import { createNeonClient } from './api';
import { track } from '../analytics/analytics';
import { captureException } from '@sentry/node';
import { ServerContext } from '../types/context';
import { detectClientApplication } from '../utils/client-application';
import { DEFAULT_GRANT } from '../utils/grant-context';
import pkg from '../../package.json';
import { registerNeonServer } from './register-neon-server';
import { type ElicitResultLike } from '../policy/stages/plan-mode';

export const createMcpServer = async (context: ServerContext) => {
  const server = new McpServer(
    {
      name: 'mcp-server-neon',
      version: pkg.version,
    },
    {
      capabilities: {
        tools: {},
        prompts: {
          listChanged: true,
        },
      },
    },
  );

  const neonClient = createNeonClient(context.apiKey);

  // Compute client info once at server instantiation
  let clientName = context.userAgent ?? 'unknown';
  let clientApplication = detectClientApplication(clientName);

  const grant = { ...(context.grant ?? DEFAULT_GRANT) };

  // Track server initialization (idempotent · registerNeonServer calls it per
  // tool call, oninitialized also calls it → guard so server_init fires once)
  let hasTrackedServerInit = false;
  const trackServerInit = () => {
    if (hasTrackedServerInit) return;
    hasTrackedServerInit = true;
    track({
      userId: context.account.id,
      event: 'server_init',
      properties: {
        clientName,
        clientApplication,
        readOnly: String(context.readOnly ?? false),
        projectScoped: String(!!grant.projectId),
        customScopes: grant.scopes?.join(',') ?? 'all',
      },
      context: {
        client: context.client,
        app: context.app,
      },
    });
    logger.info('Server initialized:', {
      clientName,
      clientApplication,
      readOnly: context.readOnly,
      grant,
    });
  };

  // Always use MCP handshake clientInfo (more reliable than HTTP User-Agent)
  // This ensures we get the real client name even when using mcp-remote,
  // which forwards the original client name (e.g., "Cursor (via mcp-remote 0.1.31)")
  server.server.oninitialized = () => {
    const clientInfo = server.server.getClientVersion();
    // Prefer MCP clientInfo over HTTP User-Agent
    if (clientInfo?.name) {
      clientName = clientInfo.name;
      clientApplication = detectClientApplication(clientName);
    }
    trackServerInit();
  };

  // feat-072/#217 (ADR-0019): register the full Neon tool surface through the
  // shared, transport-agnostic pipeline (classify -> runPipeline -> injected
  // approval -> handler) — the SAME chokepoint as the HTTP path, instead of the
  // old pipeline-free inline registration. stdio injects the real client
  // elicitInput; auth is the static local context (no per-request OAuth).
  const readOnly = context.readOnly ?? false;

  registerNeonServer(server, {
    staticToolContext: {
      grant,
      readOnly,
      categoryInclude: 'all',
      sseOwnerIdentity: null,
    },
    getAuthContext: async () => ({
      apiKey: context.apiKey,
      account: context.account,
      readOnly,
      grant,
      neonClient,
      clientApplication,
      clientName,
      client: context.client,
      context,
    }),
    trackServerInit,
    checkEnvelopeMatches: () => false,
    elicit: async (message, requestedSchema, timeoutMs) => {
      const res = await server.server.elicitInput(
        { message, requestedSchema } as never,
        { timeout: timeoutMs },
      );
      return { action: res.action, content: res.content } as ElicitResultLike;
    },
  });

  server.server.onerror = (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Server error:', {
      message,
      error,
    });
    const contexts = { app: context.app, client: context.client };
    const eventId = captureException(error, {
      user: { id: context.account.id },
      contexts: contexts,
    });
    track({
      userId: context.account.id,
      event: 'server_error',
      properties: { message, error, eventId },
      context: contexts,
    });
  };

  return server;
};
