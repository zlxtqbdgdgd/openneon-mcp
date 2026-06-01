import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // feat-028 PG parser wasm: externalize libpg-query so turbopack does not bundle it.
  // (turbopack 生产构建会把 wasm 路径改写成不存在的 /ROOT/... · externalize 后运行时 require 真实 node_modules · loader 自找 wasm)
  serverExternalPackages: ['libpg-query'],

  // feat-072/#219 (ADR-0019): deployed as a **long-running Node server**
  // (`next start`), NOT Vercel serverless — stateful in-memory MCP sessions
  // (#216) need a persistent process (Vercel config removed: vercel.json gone).
  // Not 'export' mode: API routes are dynamic server-rendered and hold state.

  // Redirect landing page to Neon docs (single source of truth)
  async redirects() {
    return [
      {
        source: '/',
        destination: 'https://neon.tech/docs/ai/neon-mcp-server',
        permanent: true,
      },
    ];
  },

  // Backwards compatibility: old routes → new API routes
  // This allows existing MCP client configurations to continue working
  async rewrites() {
    return [
      {
        source: '/mcp',
        destination: '/api/mcp',
      },
      {
        source: '/sse',
        destination: '/api/sse',
      },
      {
        source: '/health',
        destination: '/api/health',
      },
    ];
  },
};

export default nextConfig;
