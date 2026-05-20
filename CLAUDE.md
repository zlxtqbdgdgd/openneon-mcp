# ⚠️ neon-autopilot 项目改造说明（启动前必读）

> 本仓库是 **neon-autopilot 项目的 `mcp` 模块**（MCP Server 实施层 · fork from `neondatabase/mcp-server-neon`）—— 本仓代码已 / 即将做 **21+ 项改造**（详 [openneon-design §5.5.2](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/overview.html)）

## 启动前必读 · 设计 + AI 协作 source of truth

**开 Claude Code 时第一步**：读以下 3 份文档（防漂移）：

1. [openneon-design/CLAUDE.md](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/CLAUDE.md) —— 12 习惯 + 6 P 规则 + 触发警惕清单（**所有 AI 协作 + 项目设计原则**）
2. [openneon-design/features/overview.html](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/overview.html) —— Phase B 概要设计 source of truth（**重点 §5.5 mcp 全景矩阵 · §5.5.4 run_sql 收编 · §8 安全策略矩阵 · §9 L 配置 · §10 LLM 编码规约**）
3. [openneon-design/features/feature-registry.yaml](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feature-registry.yaml) —— 本仓涉及的 21+ 项改造 feature 清单（grep `module: mcp`）

**重要**：本仓代码改造严格按 [§10 LLM 编码可定位性 5 条规约](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/overview.html)（已有依赖必须复用 / 4 模块边界 / 命名约定 / PR description 改动锚点 / 独立 fixture）。

## 本仓在 neon-autopilot 项目中的角色

`mcp` 模块——按 [§3.5.1 数量分布](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/overview.html) 承载 **27 项改造**：

- **Tool 层** 11 项（T1-T8/T10-T12 day-one + L4 T9 升级）
- **Server / 协议层** 10 项（F8a/F8b/F9 + F10/G1-G4 + G6/G10）
- **Server-side Enrichment** 6 项（按 §3.3.0 数据流原则 · feat-016/017/018/022/038 + feat-037 备路径）

## 本仓特定（neon-autopilot 改造层 · 跨仓不复用）

### Commit 规范

- commit message 用中文 + `feat(mcp-<submodule>):` / `fix(mcp-<submodule>):` 前缀
- submodule 取自 [§2.3 子模块清单](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/overview.html)：`tool` / `server` / `server-enrich` / `protocol`
- 每个 PR 带 `feat-NNN reference` + 改动锚点（详 design [§10.2.4 规约 4](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/overview.html)）

### 跟上游 mcp-server-neon rebase 策略

- 长期分支：`feat/neon-autopilot`（本项目所有 mcp 改造）
- 上游 `main` 定期 fetch 但不强制 rebase（详 [§3.1.3 时间线根因 + §5.5.3 fork 决策](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/overview.html)）

### 本仓特定 caveat（TODO 待填）

- [Vercel deploy 流程 / OAuth 配置 / MCP Server 启动顺序等]

---

# 以下是 fork 自上游 `neondatabase/mcp-server-neon` 的 CLAUDE.md（上游 codebase 操作指南，保留供 build / test 参考）

# CLAUDE.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

This is the **Neon MCP Server** - a Model Context Protocol server that bridges natural language requests to the Neon API, enabling LLMs to manage Neon Postgres databases through conversational commands. The project implements remote (SSE/Streamable HTTP) MCP server transports with OAuth authentication support.

**Architecture Note**: The project is a Next.js application in the `landing/` directory deployed on Vercel serverless infrastructure, accessible at `mcp.neon.tech`.

## Development Commands

All commands should be run from the `landing/` directory. The project uses [pnpm](https://pnpm.io) as the package manager, pinned via Corepack. Run `corepack enable` to activate it.

> **Troubleshooting:** If `pnpm install` fails with registry or network errors, check whether your npm registry is configured to use the Databricks proxy. Set the registry in `~/.npmrc` or `landing/.npmrc`.

### Building and Running

```bash
cd landing
pnpm install

# Start the Next.js dev server (for the remote MCP server)
pnpm run dev
```

### Formatting, Linting, and Type Checking

```bash
cd landing

# Check formatting (runs in CI)
pnpm run fmt:check

# Auto-fix formatting
pnpm run fmt

# Lint
pnpm run lint

# Auto-fix lint + formatting together
pnpm run lint:fix

# Type check
pnpm run typecheck

# Check for unused code and dependencies
pnpm run knip

# Auto-fix unused exports/dependencies
pnpm run knip:fix
```

### Testing

```bash
cd landing

# Run full test suite (unit + integration + e2e; used in CI)
pnpm run test

# Run unit tests
pnpm run test:unit

# Run integration tests
pnpm run test:integration

# Run MCP protocol e2e tests (real tool calls over MCP protocol)
pnpm run test:e2e:mcp

# Run website e2e tests (Playwright; provisions/validates ephemeral DB first)
pnpm run test:e2e:web

# Run all e2e tests
pnpm run test:e2e
```

### Testing Pyramid Rules

The repository follows this hierarchy:

1. **E2E first** (highest confidence):
   - `test:e2e:mcp`: MCP client + server protocol tests that perform real tool calls.
   - `test:e2e:web`: Playwright tests for website and HTTP endpoints.
2. **Integration second**:
   - Deterministic handler contract tests, typically with mocked external dependencies.
3. **Unit third**:
   - Fast tests for pure logic and validation edge cases.

Use file naming to classify tiers:

- `*.e2e.test.ts` for MCP protocol end-to-end tests
- `*.integration.test.ts` for integration tests
- `*.test.ts` for unit tests

Merge-gating tests must be deterministic. Do not make third-party uptime (for example, external docs websites) a required CI dependency.

**Unit and integration tests** use [Vitest](https://vitest.dev/) and live in `mcp-src/__tests__/`. Configuration is in `landing/vitest.config.ts`.

**E2E tests** use [Playwright](https://playwright.dev/) and live in `landing/e2e/`. Configuration is in `landing/playwright.config.ts`.

- **Global setup** (`e2e/global-setup.ts`): Provisions an ephemeral Postgres database via [Instagres](https://instagres.com) and generates a random `COOKIE_SECRET`. Both are written to `.env.e2e` (gitignored) and passed to the Next.js dev server.
- **No secrets needed**: The e2e infrastructure is fully self-contained. Instagres databases expire after 72 hours; no explicit teardown is required.
- **Reuse across runs**: If `.env.e2e` already exists, global-setup reuses it instead of re-provisioning. Delete the file to force a fresh database.
- **CI**: The PR workflow runs format, lint, knip, `pnpm run test`, and build before merge.

## Architecture

### Core Components

1. **MCP Server (`landing/mcp-src/server/index.ts`)**

   - Creates and configures the MCP server instance
   - Registers all tools and resources from centralized definitions
   - Implements error handling and observability (Sentry, analytics)
   - Each tool call is tracked and wrapped in error handling

   **Account Resolution (`landing/mcp-src/server/account.ts`)**:
   - Resolves user/org account info from Neon API auth details
   - Handles org accounts, personal accounts, and project-scoped API keys
   - Falls back gracefully when project-scoped keys cannot access account-level endpoints

2. **Tools System (`landing/mcp-src/tools/`)**

   - `definitions.ts`: Exports `NEON_TOOLS` array defining all available tools with their schemas
   - `tools.ts`: Exports `NEON_HANDLERS` object mapping tool names to handler functions
   - `toolsSchema.ts`: Zod schemas for tool input validation
   - `handlers/`: Individual tool handler implementations organized by feature

3. **Remote Transport (`landing/app/api/[transport]/route.ts`)**

   - Next.js API route handling SSE and Streamable HTTP transports
   - Uses `mcp-handler` library for serverless MCP protocol handling
   - SSE sessions are bound to caller identity via `mcp-src/server/session-binding.ts` (Redis-backed; verifies the POST /message caller matches the GET /sse owner using a hashed binding key)

4. **OAuth System (`landing/lib/oauth/` and `landing/mcp-src/oauth/`)**

   - OAuth 2.0 server implementation for remote MCP authentication
   - Integrates with Neon's OAuth provider (UPSTREAM_OAUTH_HOST)
   - Token persistence using Keyv with Postgres backend
   - Cookie-based client approval tracking

5. **Resources (`landing/mcp-src/resources.ts`)**
   - MCP resources that provide read-only context (like "getting started" guides)
   - Registered alongside tools but don't execute operations

6. **Grant Context & Tool Filtering (`landing/mcp-src/utils/grant-context.ts`, `landing/mcp-src/tools/grant-filter.ts`)**
   - Fine-grained access control beyond plain read/write: per-category scopes (`projects`, `branches`, `schema`, `querying`, `neon_auth`, `data_api`, `docs`) and optional project-scoping to a single `projectId`
   - Grant resolved from OAuth resource URI query params (authorize-time), OAuth token grant field (runtime), or direct MCP URL query params for API-key auth
   - `grant-filter.ts` filters `NEON_TOOLS` by scope category, hides project-agnostic tools in project-scoped mode, and strips `project_id` from input schemas when scoped
   - Exposed publicly via `GET /api/list-tools` (stateless preview of tool visibility for a given grant)

### Key Architectural Patterns

- **Tool Registration Pattern**: All tools are defined in `NEON_TOOLS` array and handlers in `NEON_HANDLERS` object. The server iterates through tools and registers them with their corresponding handlers.

- **Error Handling**: Tools throw errors which are caught by the server wrapper, logged to Sentry, and returned as structured error messages to the LLM.

- **Stateless Design**: The server is designed for serverless deployment. Tools like migrations and query tuning create temporary branches but do NOT store state in memory. Instead, all context (branch IDs, migration SQL, etc.) is returned to the LLM, which passes it back to subsequent tool calls. This enables horizontal scaling on Vercel.

- **Read-Only Mode** (`landing/mcp-src/utils/read-only.ts`): Tools define a `readOnlySafe` property. When the server runs in read-only mode, only tools marked as `readOnlySafe: true` are available. Read-only mode is determined by priority: `X-Neon-Read-Only` header > `x-read-only` header (legacy) > OAuth scope (only `read` scope = read-only) > default (false). The module also exports `SCOPE_DEFINITIONS` for human-readable scope labels and `hasWriteScope()` to check for write permissions.

- **MCP Tool Annotations**: All tools include MCP-standard annotations for client hints:
  - `title`: Human-readable tool name
  - `readOnlyHint`: Whether the tool only reads data
  - `destructiveHint`: Whether the tool can cause irreversible changes
  - `idempotentHint`: Whether repeated calls produce the same result
  - `openWorldHint`: Whether the tool interacts with external systems

- **Analytics & Observability**: Every tool call, resource access, and error is tracked through Segment analytics and Sentry error reporting.

## Adding New Tools

1. Define the tool schema in `landing/mcp-src/tools/toolsSchema.ts`:

```typescript
export const myNewToolInputSchema = z.object({
  project_id: z.string().describe('The Neon project ID'),
  // ... other fields
});
```

2. Add the tool definition to `NEON_TOOLS` array in `landing/mcp-src/tools/definitions.ts`:

```typescript
{
  name: 'my_new_tool' as const,
  description: 'Description of what this tool does',
  inputSchema: myNewToolInputSchema,
  readOnlySafe: true, // Set to true if tool only reads data (for read-only mode filtering)
  annotations: {
    title: 'My New Tool',
    readOnlyHint: true,      // Does it only read data?
    destructiveHint: false,  // Can it cause irreversible changes?
    idempotentHint: true,    // Do repeated calls produce same result?
    openWorldHint: false,    // Does it interact with external systems?
  } satisfies ToolAnnotations,
}
```

3. Create a handler in `landing/mcp-src/tools/handlers/my-new-tool.ts`:

```typescript
import { ToolHandler } from '../types';
import { myNewToolInputSchema } from '../toolsSchema';

export const myNewToolHandler: ToolHandler<'my_new_tool'> = async (
  args,
  neonClient,
  extra,
) => {
  // Implementation
  return {
    content: [
      {
        type: 'text',
        text: 'Result message',
      },
    ],
  };
};
```

4. Register the handler in `landing/mcp-src/tools/tools.ts`:

```typescript
import { myNewToolHandler } from './handlers/my-new-tool';

export const NEON_HANDLERS = {
  // ... existing handlers
  my_new_tool: myNewToolHandler,
};
```

## Environment Configuration

See `landing/.env.local.example` for all configuration options. Key variables:

- `NEON_API_KEY`: Required for running tests (unit, integration, e2e)
- `OAUTH_DATABASE_URL`: Required for remote MCP server with OAuth
- `COOKIE_SECRET`: Required for remote MCP server OAuth flow
- `CLIENT_ID` / `CLIENT_SECRET`: OAuth client credentials

**E2E test environment**: The e2e tests do not require any manual environment configuration. `e2e/global-setup.ts` provisions an ephemeral database and generates secrets automatically, writing them to `.env.e2e` (gitignored).

## Project Structure

```
landing/                  # Next.js app (main project)
├── app/                 # Next.js App Router
│   ├── api/            # API routes for remote MCP server
│   │   ├── [transport]/route.ts  # Main MCP handler (SSE/Streamable HTTP)
│   │   ├── authorize/  # OAuth authorization endpoint (renders consent UI)
│   │   ├── token/      # OAuth token exchange
│   │   ├── register/   # Dynamic client registration
│   │   ├── revoke/     # OAuth token revocation
│   │   ├── list-tools/ # Stateless tool-visibility preview (no auth)
│   │   └── health/     # Health check endpoint
│   ├── callback/       # OAuth callback handler
│   └── .well-known/    # OAuth discovery endpoints
│   # Note: Root `/` redirects to https://neon.tech/docs/ai/neon-mcp-server
│   # (configured in next.config.ts). There is no landing page.
├── e2e/                # Playwright E2E tests
│   ├── global-setup.ts             # Instagres DB provisioning + secret generation
│   ├── smoke.spec.ts               # Smoke tests (health, OAuth discovery, redirect)
│   ├── list-tools.spec.ts          # /api/list-tools visibility/grant tests
│   ├── mcp-response-integrity.spec.ts # MCP transport response shape checks
│   └── oauth-register-authorize.spec.ts # OAuth register + authorize flow
├── lib/                # Next.js-compatible utilities
│   ├── assert.ts       # Type-narrowing assertion helper
│   ├── config.ts       # Centralized configuration
│   ├── errors.ts       # OAuth-aware HTTP error mapping for route handlers
│   └── oauth/          # OAuth utilities for Next.js
├── mcp-src/            # MCP server source code
│   ├── __tests__/      # Vitest unit/integration/MCP e2e tests
│   │   ├── *.test.ts              # Unit tests
│   │   ├── *.integration.test.ts  # Integration tests
│   │   └── *.e2e.test.ts          # MCP protocol e2e tests
│   ├── server/         # MCP server factory
│   │   ├── index.ts          # Server creation and tool registration
│   │   ├── api.ts            # Neon API client factory
│   │   ├── account.ts        # Account resolution (user/org/project-scoped)
│   │   ├── errors.ts         # Error handling utilities
│   │   └── session-binding.ts # Redis-backed SSE session-to-caller binding
│   ├── tools/          # Tool definitions and handlers
│   │   ├── index.ts        # Re-exports definitions and handlers
│   │   ├── definitions.ts  # Tool definitions (NEON_TOOLS) with annotations
│   │   ├── tools.ts        # Tool handlers mapping (NEON_HANDLERS)
│   │   ├── toolsSchema.ts  # Zod schemas for tool inputs
│   │   ├── grant-filter.ts # Filter NEON_TOOLS by grant context (scope categories, project scoping)
│   │   ├── handlers/       # Individual tool implementations
│   │   ├── types.ts        # TypeScript types
│   │   └── utils.ts        # Tool utilities
│   ├── oauth/          # OAuth model and KV store
│   ├── analytics/      # Segment analytics
│   ├── sentry/         # Sentry error tracking
│   ├── types/          # Shared TypeScript types
│   ├── utils/          # Shared utilities
│   │   ├── read-only.ts          # Read-only mode detection, SUPPORTED_SCOPES
│   │   ├── grant-context.ts      # Grant resolution + scope categories + project scoping
│   │   ├── singleflight.ts       # Promise deduplication by key (concurrent-call coalescing)
│   │   ├── trace.ts              # TraceId generation for request correlation
│   │   ├── client-application.ts # Client application utilities
│   │   └── logger.ts             # Logging utilities
│   ├── describeUtils.ts # Postgres \d-style describe helpers (derived from @neondatabase/psql-describe)
│   ├── resources.ts    # MCP resources
│   ├── prompts.ts      # LLM prompts
│   └── constants.ts    # Shared constants
├── public/             # Static assets (favicons, OG image, llms.txt)
├── .prettierrc         # Prettier config (singleQuote: true)
├── .prettierignore     # Prettier ignore patterns
├── vitest.config.ts    # Vitest configuration
├── playwright.config.ts # Playwright E2E configuration
├── package.json        # Package configuration
├── tsconfig.json       # TypeScript config (bundler resolution)
├── vercel.json         # Vercel deployment config
└── vercel-migration.md # Migration documentation

dev-notes/              # Developer notes and solution documentation
└── *.md               # Problem solutions, fixes, and technical decisions
```

## Important Notes

- **TypeScript Configuration**: Uses `bundler` module resolution for Next.js compatibility. Imports use extensionless paths (no `.js` suffix).
- **Registry metadata version sync**: Keep root `server.json` `version` in sync with `landing/package.json` `version`. CI enforces this via the PR workflow.

- **Migration Pattern**: Tools like `prepare_database_migration` and `prepare_query_tuning` create temporary branches and return all context (branch IDs, SQL, database name, etc.) in the response. The LLM must pass this context back to subsequent `complete_*` tools. No state is stored server-side, enabling serverless deployment.

- **Neon API Client**: Created using `@neondatabase/api-client` package. All tool handlers receive a pre-configured `neonClient` instance.

## Remote MCP Server (Vercel)

The remote MCP server (`mcp.neon.tech`) is deployed on Vercel's serverless infrastructure.

### Key Technologies

- **Next.js App Router**: API routes handle MCP protocol and OAuth flow
- **mcp-handler library**: Abstracts MCP protocol complexity for serverless environments
- **Vercel Fluid Compute**: Supports up to 800s function duration for SSE connections
- **Upstash Redis**: Session storage via Vercel KV (`KV_URL` environment variable)
- **Postgres via Keyv**: Token persistence using `OAUTH_DATABASE_URL`

### API Endpoints

| Route | Purpose |
|-------|---------|
| `/api/mcp` | Streamable HTTP transport (recommended) |
| `/api/sse` | Server-Sent Events transport (deprecated) |
| `/api/authorize` | OAuth authorization initiation |
| `/callback` | OAuth callback handler |
| `/api/token` | OAuth token exchange |
| `/api/revoke` | OAuth token revocation |
| `/api/register` | Dynamic client registration |
| `/api/list-tools` | Stateless preview of available tools for a given grant (no auth) |
| `/.well-known/oauth-authorization-server` | OAuth server metadata (includes `scopes_supported` and `x-neon-scope-categories`) |
| `/.well-known/oauth-protected-resource` | OAuth protected resource metadata |

### OAuth Scopes

The server supports three top-level scopes: `read`, `write`, and `*`. These are exposed via the `/.well-known/oauth-authorization-server` endpoint's `scopes_supported` field.

- **`read`**: Read-only access to Neon resources
- **`write`**: Full access including create/delete operations
- **`*`**: Wildcard, equivalent to full access

During authorization, users can uncheck "Full access" to request only `read` scope, which enables read-only mode.

In addition to the top-level scopes, the server exposes **scope categories** via the non-standard `x-neon-scope-categories` field on the same metadata document: `projects`, `branches`, `schema`, `querying`, `neon_auth`, `data_api`, `docs`. These drive fine-grained tool filtering (see Grant Context above) and can also constrain a token to a single project. See `landing/mcp-src/utils/grant-context.ts` for grant resolution.

### Environment Variables (Vercel)

| Variable | Description |
|----------|-------------|
| `SERVER_HOST` | Server URL (falls back to `VERCEL_URL`) |
| `UPSTREAM_OAUTH_HOST` | Neon OAuth provider URL |
| `CLIENT_ID` / `CLIENT_SECRET` | OAuth client credentials |
| `COOKIE_SECRET` | Secret for signed cookies |
| `KV_URL` | Vercel KV (Upstash Redis) URL |
| `OAUTH_DATABASE_URL` | Postgres URL for token storage |
| `SENTRY_DSN` | Sentry error tracking DSN |
| `ANALYTICS_WRITE_KEY` | Segment analytics write key |

### Development Notes

- Import paths in `landing/mcp-src/` are extensionless (no `.js` suffix)
- See `landing/vercel-migration.md` for detailed migration documentation

## GitHub Workflows

### Deploy Preview Workflow

The `deploy-preview.yml` workflow enables deploying PRs to the preview environment (`preview-mcp.neon.tech`) for testing OAuth flows and remote MCP functionality.

**Usage:**
1. Add the `deploy-preview` label to a PR
2. The workflow pushes to the `preview` branch, which triggers Vercel deployment
3. Only one PR can own the preview environment at a time (label is auto-removed from other PRs)
4. Label is automatically removed when PR is merged or closed

**Note:** The preview environment has OAuth configured, making it the only way to test full OAuth flows in PRs.

### Claude Code Action Workflow

The `claude.yml` workflow enables interactive Claude assistance in issues and pull requests.

**Usage:**
- Mention `@claude` in any issue, PR comment, or PR review comment
- Claude will analyze and respond to your request
- Only works for OWNER/MEMBER/COLLABORATOR to prevent abuse

**Available Commands:**
- GitHub CLI commands (`gh issue:*`, `gh pr:*`, `gh search:*`)
- Can help with code review, issue triage, and PR descriptions

### Claude Code Review Workflow

This repository uses an enhanced Claude Code Review workflow that provides inline feedback on pull requests.

### What Gets Reviewed

- Architecture and design patterns (tool registration, handler typing)
- Security vulnerabilities (SQL injection, secrets, input validation)
- Logic bugs (error handling, state management, edge cases)
- Performance issues (N+1 queries, inefficient API usage)
- Testing gaps (missing evaluations, uncovered scenarios)
- MCP-specific patterns (analytics tracking, error handling, Sentry capture)

### What's Automated (Not Reviewed by Claude)

- Formatting: `pnpm run fmt:check` (checked by pr.yml)
- Linting: `pnpm run lint` (checked by pr.yml)
- Tests: `pnpm run test` (unit + integration + MCP e2e + website e2e, checked by `pr.yml`)
- Building: `pnpm run build` (checked by pr.yml)

### Review Process

1. Workflow triggers automatically on PR open
2. Claude analyzes changes with full project context
3. Inline comments posted on significant issues
4. Summary comment provides overview and statistics

### Inline Comment Format

- **Severity**: Critical | Important | Consider
- **Category**: [Security/Logic/Performance/Architecture/Testing/MCP]
- **Description**: Clear explanation with context
- **Fix**: Actionable code example or reference

### Triggering Reviews

- **Automatic**: Opens when PR is created
- **Manual**: Run workflow via GitHub Actions with PR number
- **Security**: Only OWNER/MEMBER/COLLABORATOR PRs (blocks external)

## Agent skills

> 由 `/setup-matt-pocock-skills` 生成（2026-05-19）。供 mattpocock/skills 套件下的工程类 skill（`to-issues` / `triage` / `to-prd` / `qa` / `improve-codebase-architecture` / `diagnose` / `tdd` 等）查询 per-repo 配置。

### Issue tracker

GitHub Issues · 仓 `zlxtqbdgdgd/openneon-mcp` · 用 `gh` CLI。详 [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)。

### Triage labels

5 个 canonical role 全用默认 label 名（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。详 [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)。

### Domain docs

**single-context** · 本仓属 openneon 项目（5 仓 multirepo · 本仓非主词典宿主）· 跨仓共享词汇查 [openneon-design](https://github.com/zlxtqbdgdgd/openneon-design)。详 [`docs/agents/domain.md`](docs/agents/domain.md)。
