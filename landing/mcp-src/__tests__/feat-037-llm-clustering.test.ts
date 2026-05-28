/**
 * feat-037/#2 · LLM 主路径 unit tests · openneon-mcp#155.
 *
 * 验收门:
 *   1. 复用 feat-045 llm-prompt.ts 三原则
 *   2. 复用 feat-045 llm-client.ts (LlmClient 注入 mock)
 *   3. Two-tier 命名: semantic_name + semantic_summary · 5 enum + other
 *   4. system prompt 强制 JSON
 *   5. schema validate · LLM 漂 → llm_schema_violation
 *   6. token 超限 input 截断 → [DATA_MISSING:input_truncated]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  LLM_CLUSTERING_SYSTEM_PROMPT,
  LLM_CLUSTERING_SYSTEM_PROMPT_VERSION,
  buildClusteringUserPayload,
  llmClusterLogs,
  LLM_CLUSTERING_MAX_INPUT_TOKENS,
} from '../server-enrich/pattern/llm-clustering';
import {
  setLlmClient,
  resetLlmClient,
  type LlmClient,
} from '../server-enrich/rca/llm-client';
import { SEMANTIC_CATEGORIES } from '../server-enrich/pattern/types';
import {
  genStandardLogs,
  MOCK_LLM_OUTPUT_OPUS,
} from './fixtures/feat-037-cluster-cases';

describe('feat-037/#2 · system prompt 三原则', () => {
  it('exports stable prompt version', () => {
    expect(LLM_CLUSTERING_SYSTEM_PROMPT_VERSION).toBe('1.0.0');
  });

  it('system prompt encodes 5 fixed enums + other', () => {
    for (const cat of SEMANTIC_CATEGORIES) {
      expect(LLM_CLUSTERING_SYSTEM_PROMPT.toLowerCase()).toContain(cat);
    }
  });

  it('system prompt encodes two-tier strict semantic_name format', () => {
    expect(LLM_CLUSTERING_SYSTEM_PROMPT).toContain('[Resource] [Operation]');
  });

  it('system prompt encodes [DATA_MISSING:*] placeholder rule (rule 2)', () => {
    expect(LLM_CLUSTERING_SYSTEM_PROMPT).toContain('[DATA_MISSING:input_truncated]');
  });

  it('system prompt encodes hard token cap (rule 3)', () => {
    expect(LLM_CLUSTERING_SYSTEM_PROMPT).toContain('4500');
  });
});

describe('feat-037/#2 · user payload builder', () => {
  it('numbers each line · 0-based', () => {
    const p = buildClusteringUserPayload({
      lines: [
        { message: 'foo', severity: 'INFO', timestamp: '2026-05-28T10:00:00Z' },
        { message: 'bar' },
      ],
      topN: 50,
      inputTruncated: false,
    });
    expect(p).toContain('[0]');
    expect(p).toContain('[1]');
    expect(p).toContain('total_lines=2');
  });

  it('inserts [DATA_MISSING:input_truncated] when input was truncated', () => {
    const p = buildClusteringUserPayload({
      lines: [{ message: 'foo' }],
      topN: 50,
      inputTruncated: true,
    });
    expect(p).toContain('[DATA_MISSING:input_truncated]');
  });
});

describe('feat-037/#2 · llmClusterLogs roundtrip', () => {
  beforeEach(() => resetLlmClient());
  afterEach(() => resetLlmClient());

  it('returns LlmClusteringSuccess with parsed PatternClusterResult when LLM honors schema', async () => {
    const mock: LlmClient = {
      call: async () => ({
        text: MOCK_LLM_OUTPUT_OPUS,
        inputTokens: 1200,
        outputTokens: 800,
        model: 'claude-opus-4-7',
      }),
    };
    setLlmClient(mock);
    const r = await llmClusterLogs({
      lines: genStandardLogs(100),
      topN: 50,
      model: 'claude-opus-4-7',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.patterns.length).toBe(8);
    expect(r.result.patterns[0].semantic_name).toBe('User Select Query');
    expect(r.result.patterns[0].semantic_category).toBe('query');
    // Two-tier 命名: name + summary 都填
    expect(r.result.patterns[0].semantic_summary).toBeTruthy();
  });

  it('returns LlmClusteringError when LLM client not configured', async () => {
    const r = await llmClusterLogs({
      lines: [{ message: 'foo' }],
      topN: 50,
      model: 'claude-opus-4-7',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe('llm_not_configured');
  });

  it('returns llm_invalid_json when LLM returns garbage', async () => {
    setLlmClient({
      call: async () => ({
        text: 'this is not JSON',
        inputTokens: 50,
        outputTokens: 5,
        model: 'claude-opus-4-7',
      }),
    });
    const r = await llmClusterLogs({
      lines: [{ message: 'foo' }],
      topN: 50,
      model: 'claude-opus-4-7',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe('llm_invalid_json');
  });

  it('returns llm_schema_violation when LLM drifts (bad category)', async () => {
    setLlmClient({
      call: async () => ({
        text: JSON.stringify({
          patterns: [
            {
              pattern_id: 'p1',
              template: 'foo',
              count: 1,
              semantic_name: 'Foo Bar',
              semantic_category: 'INVENTED_CATEGORY', // drift
            },
          ],
        }),
        inputTokens: 50,
        outputTokens: 50,
        model: 'claude-opus-4-7',
      }),
    });
    const r = await llmClusterLogs({
      lines: [{ message: 'foo' }],
      topN: 50,
      model: 'claude-opus-4-7',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe('llm_schema_violation');
    expect(r.error.detail).toContain('semantic_category');
  });

  it('strips markdown fence before JSON.parse', async () => {
    setLlmClient({
      call: async () => ({
        text: '```json\n' + MOCK_LLM_OUTPUT_OPUS + '\n```',
        inputTokens: 50,
        outputTokens: 200,
        model: 'claude-opus-4-7',
      }),
    });
    const r = await llmClusterLogs({
      lines: genStandardLogs(100),
      topN: 50,
      model: 'claude-opus-4-7',
    });
    expect(r.ok).toBe(true);
  });

  it('truncates oversized input and marks [DATA_MISSING:input_truncated]', async () => {
    // Build > LLM_CLUSTERING_MAX_INPUT_TOKENS worth of input
    // Each line ~ 60 chars + 16 prefix = 76 chars ~ 19 tokens; need > 40K tokens → > 2100 lines
    const big = genStandardLogs(3000);
    let capturedPayload = '';
    setLlmClient({
      call: async (req) => {
        capturedPayload = req.userPayload;
        return {
          text: MOCK_LLM_OUTPUT_OPUS,
          inputTokens: 30000,
          outputTokens: 800,
          model: 'claude-opus-4-7',
        };
      },
    });
    const r = await llmClusterLogs({
      lines: big,
      topN: 50,
      model: 'claude-opus-4-7',
    });
    expect(capturedPayload).toContain('[DATA_MISSING:input_truncated]');
    expect(r.ok).toBe(true);
  });
});
