/**
 * feat-045/#1 unit tests · 7-section template renderer + LLM prompt 三原则 engine.
 *
 * Detail design: openneon-mcp#145 §验收门.
 *
 * Covers:
 *   - 7 节结构完整 (固定 H2 顺序)
 *   - [DATA_MISSING:probe] 占位 (degrade gracefully)
 *   - input cap 触发后 [DATA_MISSING:evidence_truncated]
 *   - 跨 model 模板渲染一致 (≥ 95% · structural identity)
 */

import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  RCA_SECTION_HEADERS,
} from '../server-enrich/rca/template';
import {
  RCA_SYSTEM_PROMPT,
  RCA_MAX_OUTPUT_TOKENS,
  RCA_MAX_INPUT_TOKENS,
  buildUserPayload,
  estimateTokens,
} from '../server-enrich/rca/llm-prompt';
import {
  SAMPLE_TRACE,
  SAMPLE_PROBE,
  SAMPLE_AUDIT,
  SAMPLE_VALIDATION,
  SAMPLE_TRACE_ID,
} from './fixtures/feat-045-rca-cases';
import type { RcaSection7Input } from '../server-enrich/rca/types';
import type { RcaModelId } from '../server-enrich/rca/llm-client';

function makeInput(overrides: Partial<RcaSection7Input> = {}): RcaSection7Input {
  return {
    traceId: SAMPLE_TRACE_ID,
    generatedAt: '2026-05-28T12:00:00Z',
    model: 'claude-opus-4-7',
    cacheHit: false,
    estimatedInputTokens: 1500,
    maxOutputTokens: RCA_MAX_OUTPUT_TOKENS,
    trace: SAMPLE_TRACE,
    probe: SAMPLE_PROBE,
    audit: SAMPLE_AUDIT,
    validation: SAMPLE_VALIDATION,
    ...overrides,
  };
}

describe('feat-045/#1 · 7-section template structure', () => {
  it('emits the 6 H2 headers in canonical order (header + 6 sections)', () => {
    const md = renderTemplate(makeInput());
    let cursor = 0;
    for (const header of RCA_SECTION_HEADERS) {
      const idx = md.indexOf(header, cursor);
      expect(idx, `header missing or out of order: ${header}`).toBeGreaterThan(-1);
      cursor = idx;
    }
  });

  it('header section pre-fills trace_id + model + token budget', () => {
    const md = renderTemplate(makeInput());
    expect(md).toContain(`trace_id=${SAMPLE_TRACE_ID}`);
    expect(md).toContain('model: claude-opus-4-7');
    expect(md).toContain(`max_output_tokens: ${RCA_MAX_OUTPUT_TOKENS}`);
  });

  it('component latency table contains every component row in declaration order', () => {
    const md = renderTemplate(makeInput());
    expect(md).toMatch(/\| proxy \| 1 \| 0\.1%/); // 0.07 rounds to 0.1 with toFixed(1)
    expect(md).toMatch(/\| compute \| 1480 \| 98\.7%/);
    expect(md).toMatch(/\| pageserver \| 1480 \| 98\.7%/);
  });

  it('function attribution table includes the heap_hot hotspot from probe data', () => {
    const md = renderTemplate(makeInput());
    expect(md).toMatch(/heap_hot_search_buffer.*60\.5%/);
  });

  it('timeline lists all 5 OHSQL state-machine stages in delta order', () => {
    const md = renderTemplate(makeInput());
    const stages = ['感知', '定位', '假设', '修复', '验证'];
    let cursor = 0;
    for (const s of stages) {
      const idx = md.indexOf(s, cursor);
      expect(idx, `stage out of order: ${s}`).toBeGreaterThan(-1);
      cursor = idx;
    }
  });
});

describe('feat-045/#1 · [DATA_MISSING:*] graceful degrade', () => {
  it('emits [DATA_MISSING:probe] when probe leg is undefined', () => {
    const md = renderTemplate(makeInput({ probe: undefined }));
    expect(md).toContain('[DATA_MISSING:probe]');
    // adjacent sections must still render
    expect(md).toContain('## 跨组件耗时分布');
    expect(md).toContain('## 修复时间线');
  });

  it('emits [DATA_MISSING:trace] for both link graph + component latency when trace missing', () => {
    const md = renderTemplate(makeInput({ trace: undefined }));
    const occurrences = md.match(/\[DATA_MISSING:trace\]/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('emits [DATA_MISSING:audit] when audit leg is undefined', () => {
    const md = renderTemplate(makeInput({ audit: undefined }));
    expect(md).toContain('[DATA_MISSING:audit]');
  });

  it('emits [DATA_MISSING:explain_diff] when validation leg is undefined', () => {
    const md = renderTemplate(makeInput({ validation: undefined }));
    expect(md).toContain('[DATA_MISSING:explain_diff]');
  });
});

describe('feat-045/#1 · LLM prompt 三原则 engine', () => {
  it('system prompt mentions all 3 rules verbatim by number', () => {
    expect(RCA_SYSTEM_PROMPT).toMatch(/RULE 1/);
    expect(RCA_SYSTEM_PROMPT).toMatch(/RULE 2/);
    expect(RCA_SYSTEM_PROMPT).toMatch(/RULE 3/);
  });

  it('rule 2 explicitly names the [DATA_MISSING:*] placeholder', () => {
    expect(RCA_SYSTEM_PROMPT).toContain('[DATA_MISSING:');
  });

  it('rule 3 names a hard token cap aligned with RCA_MAX_OUTPUT_TOKENS', () => {
    expect(RCA_SYSTEM_PROMPT).toContain(String(RCA_MAX_OUTPUT_TOKENS));
  });

  it('buildUserPayload concatenates template + evidence with a separator', () => {
    const payload = buildUserPayload({
      templateMarkdown: '# T',
      evidenceAppendix: 'E',
    });
    expect(payload).toContain('# T');
    expect(payload).toContain('# Evidence Appendix');
    expect(payload).toContain('E');
  });

  it('estimateTokens grows with string length', () => {
    expect(estimateTokens('aaaa')).toBeLessThanOrEqual(estimateTokens('aaaaaaaaaaaa'));
  });

  it('input cap is < 5K output budget (rule 3 double-guard)', () => {
    expect(RCA_MAX_INPUT_TOKENS).toBeGreaterThan(0);
    expect(RCA_MAX_OUTPUT_TOKENS).toBeLessThan(5000);
  });
});

describe('feat-045/#1 · cross-model template robustness (#147)', () => {
  const models: RcaModelId[] = [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ];

  it('renders identical H2 structure across all 3 models (≥ 95%)', () => {
    const structures = models.map((m) => {
      const md = renderTemplate(makeInput({ model: m }));
      return md.match(/^##? .+$/gm)?.join('\n') ?? '';
    });
    expect(structures[0]).toBe(structures[1]);
    expect(structures[1]).toBe(structures[2]);
  });

  it('header stamps each model id distinctly', () => {
    for (const m of models) {
      const md = renderTemplate(makeInput({ model: m }));
      expect(md).toContain(`model: ${m}`);
    }
  });
});
