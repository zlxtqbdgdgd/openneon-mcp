/**
 * E2E tests for the /api/list-tools endpoint.
 *
 * Implements **feat-061 fixture step 1 listing check** (per feat-005 §7 +
 * feat-005 #4 sub-issue · GitHub issue #8) using existing Playwright e2e
 * infrastructure instead of the originally specified shell script —
 * `scripts/l1-sales-fixture/check-tool-listing.sh`. Same coverage, reuses
 * the project's existing test infra (no separate shell dependency tooling).
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-005-L1-mcp-server-tool-listing-core-optional.html
 *
 * Coverage:
 * - default listing (no params · = core after feat-005 #3 ship) · 4 day-one core tools
 * - ?include=all opt-in · full 35-tool listing (31 upstream + 4 day-one openneon)
 * - ?include=core explicit · same as default
 * - ?include=<invalid> · strict whitelist fallback to core
 * - grant filtering (category=querying / projectId=X / readonly=true) — orthogonal to category filter
 * - CORS preflight + warnings flow (untouched from upstream)
 *
 * These tests make real HTTP requests to the running Next.js server.
 * The /api/list-tools endpoint is stateless (no auth, no database) — only
 * needs the Next.js dev server (handled by Playwright's webServer config).
 *
 * Uses Playwright's APIRequestContext (via the `request` fixture) for
 * API-only tests — no browser needed.
 */

import { test, expect } from '@playwright/test';

test.describe('/api/list-tools endpoint · default core listing (feat-005 #3 ship)', () => {
  test('default (no params) returns 4 core tools by name (T1/T2/T6/T8 day-one core)', async ({
    request,
  }) => {
    const response = await request.get('/api/list-tools');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.categoryInclude).toBe('core');
    expect(body.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'find_neondb_instances',
      'get_neondb_calling_services',
      'get_neondb_query_statement',
      'get_neondb_schemas',
    ]);
    expect(body.readOnly).toBe(false);
    expect(body.grant.scopes).toBeNull();
    expect(body.grant.projectId).toBeNull();
    expect(body.warnings).toBeUndefined();
  });

  test('?include=core explicit returns same as default (idempotent)', async ({
    request,
  }) => {
    const response = await request.get('/api/list-tools?include=core');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.categoryInclude).toBe('core');
    expect(body.tools).toHaveLength(4);
  });

  test('?include=<invalid> falls back to core default (strict whitelist · defense against typos)', async ({
    request,
  }) => {
    const response = await request.get('/api/list-tools?include=optional');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.categoryInclude).toBe('core');
    expect(body.tools).toHaveLength(4);
  });
});

test.describe('/api/list-tools endpoint · all-listing opt-in', () => {
  test('?include=all returns 35 tools (31 upstream + 4 day-one openneon)', async ({
    request,
  }) => {
    const response = await request.get('/api/list-tools?include=all');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.categoryInclude).toBe('all');
    expect(body.tools).toHaveLength(35);
    expect(body.readOnly).toBe(false);
    expect(body.warnings).toBeUndefined();
  });

  test('advertises supportsDepth + defaultDepth (feat-007 #4 · T6/T8 depth-capable)', async ({
    request,
  }) => {
    const response = await request.get('/api/list-tools?include=all');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    const byName = Object.fromEntries(
      body.tools.map((t: { name: string }) => [t.name, t]),
    );
    expect(byName['get_neondb_query_statement'].supportsDepth).toBe(true);
    expect(byName['get_neondb_query_statement'].defaultDepth).toBe('shallow');
    expect(byName['get_neondb_schemas'].supportsDepth).toBe(true);
    expect(byName['find_neondb_instances'].supportsDepth).toBe(false);
    expect(byName['find_neondb_instances'].defaultDepth).toBeNull();
  });

  test('advertises outputFormat (feat-006 #3 · day-one tools accept ?format=)', async ({
    request,
  }) => {
    const response = await request.get('/api/list-tools?include=all');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    const byName = Object.fromEntries(
      body.tools.map((t: { name: string }) => [t.name, t]),
    );
    expect(byName['get_neondb_query_statement'].outputFormat).toEqual([
      'csv',
      'json',
      'tsv',
    ]);
    expect(byName['find_neondb_instances'].outputFormat).toEqual([
      'csv',
      'json',
      'tsv',
    ]);
    expect(byName['run_sql'].outputFormat).toBeNull();
  });

  test('?include=all returns 12 tools for category=querying (10 upstream + 2 day-one T6/T2)', async ({
    request,
  }) => {
    const response = await request.get(
      '/api/list-tools?include=all&category=querying',
    );
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.tools).toHaveLength(12);
    expect(body.grant.scopes).toEqual(['querying']);
  });

  test('?include=all returns 27 tools for project-scoped mode (project-agnostic tools hidden including T1)', async ({
    request,
  }) => {
    const response = await request.get(
      '/api/list-tools?include=all&projectId=proj-123',
    );
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.tools).toHaveLength(27);
    expect(body.grant.projectId).toBe('proj-123');

    const names = body.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain('list_projects');
    expect(names).not.toContain('list_organizations');
    expect(names).not.toContain('create_project');
    expect(names).not.toContain('delete_project');
    // T1 also in PROJECT_AGNOSTIC_TOOLS (enriched project listing · cross-project · hidden)
    expect(names).not.toContain('find_neondb_instances');
    expect(names).not.toContain('search');
    expect(names).not.toContain('fetch');
    // T6/T8/T2 require projectId · survive
    expect(names).toContain('get_neondb_query_statement');
    expect(names).toContain('get_neondb_schemas');
    expect(names).toContain('get_neondb_calling_services');
  });

  test('?include=all returns 23 tools for readonly=true (19 upstream + 4 day-one · all readOnlySafe)', async ({
    request,
  }) => {
    const response = await request.get(
      '/api/list-tools?include=all&readonly=true',
    );
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.tools).toHaveLength(23);
    expect(body.readOnly).toBe(true);

    for (const tool of body.tools) {
      expect(tool.readOnlySafe).toBe(true);
    }
  });

  test('includes warnings for invalid scope categories (with include=all to isolate scope filter)', async ({
    request,
  }) => {
    const response = await request.get(
      '/api/list-tools?include=all&category=not-a-real-scope',
    );
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    // Empty scopes → only always-available tools (search/fetch)
    expect(body.tools).toHaveLength(2);
    expect(body.readOnly).toBe(false);
    expect(body.warnings).toBeDefined();
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain('⚠️ Warning:');
  });
});

test.describe('/api/list-tools endpoint · CORS + protocol', () => {
  test('CORS headers are present on response', async ({ request }) => {
    const response = await request.get('/api/list-tools');
    expect(response.ok()).toBeTruthy();

    expect(response.headers()['access-control-allow-origin']).toBe('*');
    expect(response.headers()['access-control-allow-methods']).toContain('GET');
  });

  test('OPTIONS preflight returns 204 with CORS headers', async ({
    request,
  }) => {
    const response = await request.fetch('/api/list-tools', {
      method: 'OPTIONS',
    });

    expect(response.status()).toBe(204);
    expect(response.headers()['access-control-allow-origin']).toBe('*');
    expect(response.headers()['access-control-allow-headers']).toContain(
      'x-read-only',
    );
  });
});
