import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { resolveGrantFromSearchParams } from '../../../mcp-src/utils/grant-context';
import { isReadOnly } from '../../../mcp-src/utils/read-only';
import {
  getAvailableTools,
  getAccessControlWarnings,
} from '../../../mcp-src/tools/grant-filter';
import { filterToolsByRole } from '../../../mcp-src/tools/role-toolsets';
import { resolvePolicy } from '../../../mcp-src/policy/loader';
import { parseCategoryInclude } from '../../../mcp-src/config/categories';
import {
  isToolSupportingDepth,
  DEFAULT_DEPTH,
} from '../../../mcp-src/config/depth';
import { SUPPORTED_OUTPUT_FORMATS } from '../../../mcp-src/server/response-formatter';

/**
 * Detect whether a tool accepts the `format` output param (feat-006 #3 advertise).
 *
 * Introspects the tool's zod inputSchema for a `format` field · zero-maintenance (auto-syncs
 * with whatever tools add `outputFormatField` to their schema · currently T1/T2/T6/T8 day-one
 * openneon tools that route through formatToolResponse).
 */
function toolSupportsFormat(inputSchema: unknown): boolean {
  return (
    inputSchema instanceof z.ZodObject &&
    'format' in (inputSchema.shape as Record<string, unknown>)
  );
}
import { logger } from '../../../mcp-src/utils/logger';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'x-read-only',
};

/**
 * CORS preflight handler.
 */
export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * GET /api/list-tools
 *
 * Returns the list of available MCP tools based on URL query params.
 * No authentication required — this is a stateless preview of tool visibility.
 *
 * Accepts URL query params:
 *   - category: scope categories (repeated or comma-separated)
 *   - projectId: scope to a single project
 *   - readonly: true | false
 *   - include: 'core' | 'all' (feat-005 #3 listing filter · default 'core')
 *   - Also supports legacy x-read-only header
 */
export function GET(req: Request) {
  let phase = 'resolve_grant';
  const startedAt = Date.now();
  const url = new URL(req.url);
  const searchParams = url.searchParams;

  try {
    const grant = resolveGrantFromSearchParams(searchParams);

    phase = 'resolve_read_only';
    const readOnly = isReadOnly({
      queryParamValue: searchParams.get('readonly'),
      headerValue: req.headers.get('x-read-only'),
    });

    phase = 'resolve_category_include';
    const categoryInclude = parseCategoryInclude(searchParams.get('include'));

    phase = 'get_available_tools';
    const tools = getAvailableTools(grant, readOnly, categoryInclude);

    // feat-059/#1: role 软过滤 (tools/list ∩ ROLE_TOOLSETS[agent_role]) · 在 category filter 之上 ·
    // role 来自 per-project policy.agent_role (未配 → 不过滤 · 退 category-only listing)。软 · 不拦调用。
    phase = 'apply_role_toolset';
    const agentRole = resolvePolicy(grant.projectId ?? undefined).agent_role;
    const roleFilteredTools = filterToolsByRole(tools, agentRole);

    phase = 'get_access_control_warnings';
    const warnings = getAccessControlWarnings(grant, readOnly);

    phase = 'build_response_body';
    const body = {
      grant,
      readOnly,
      categoryInclude,
      agentRole: agentRole ?? null,
      ...(warnings.length > 0 ? { warnings } : {}),
      tools: roleFilteredTools.map((tool) => {
        // feat-007 #4 · advertise progressive disclosure capability so clients know which
        // tools accept ?depth=full opt-in (T6/T8 day-one · per DEPTH_SUPPORTING_TOOLS).
        const supportsDepth = isToolSupportingDepth(tool.name);
        // feat-006 #3 · advertise supported output formats so clients know which tools
        // accept ?format= (T1/T2/T6/T8 day-one · detected via inputSchema introspection).
        const supportsFormat = toolSupportsFormat(tool.inputSchema);
        return {
          name: tool.name,
          title: tool.annotations?.title ?? tool.name,
          scope: tool.scope,
          readOnlySafe: tool.readOnlySafe,
          supportsDepth,
          defaultDepth: supportsDepth ? DEFAULT_DEPTH : null,
          outputFormat: supportsFormat ? [...SUPPORTED_OUTPUT_FORMATS] : null,
          description: tool.description,
        };
      }),
    };

    return NextResponse.json(body, { headers: CORS_HEADERS });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('list_tools_request_failed', {
      phase,
      durationMs,
      errorName: err.name,
      errorMessage: err.message,
      errorStack: err.stack,
    });

    return NextResponse.json(
      {
        error: 'list_tools_failed',
        phase,
        message: err.message,
      },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
