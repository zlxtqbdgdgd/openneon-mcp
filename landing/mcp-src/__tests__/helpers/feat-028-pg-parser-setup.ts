/**
 * feat-028 vitest setupFile · 跑测试前 init libpg-query WASM runtime 一次。
 *
 * 用 vitest setupFiles (不是 globalSetup) · setupFiles 跟 test 同进程 → module-level
 * pgParserModule 在 destructive-detector-pg-parser.ts 内对 test process 是 ready 状态。
 *
 * 这样所有 fixture 调 classifyOp / classifySql 都能直接走 pg-parser backend · 不需每个
 * test file 各自 beforeAll(initPgParser)。
 */
import { initPgParser } from '../../protection/destructive-detector-pg-parser';

// top-level await · vitest setupFiles 支持
await initPgParser();
