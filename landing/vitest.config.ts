import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['mcp-src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    // feat-028: PG parser WASM init 一次性 · 全部 fixture 跑前 await loadModule
    // 用 setupFiles (不是 globalSetup) · setupFiles 跟 test 同进程 · module state 共享
    setupFiles: ['./mcp-src/__tests__/helpers/feat-028-pg-parser-setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
