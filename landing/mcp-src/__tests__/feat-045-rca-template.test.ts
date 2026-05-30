/**
 * feat-045/#1 unit tests · 7-section template renderer + token-estimation helpers.
 *
 * Detail design: openneon-mcp#145 §验收门 · form-shift (规则 P4 · LLM-out-of-mcp).
 *
 * Covers:
 *   - 7 节结构完整 (固定 H2 顺序)
 *   - [DATA_MISSING:probe] 占位 (degrade gracefully)
 *   - §7 归因 footer 留 [ATTRIBUTION_PENDING] 占位 (cc skill 填叙事 · mcp 不调 LLM)
 *   - estimateTokens 单调 + RCA_MAX_INPUT_TOKENS 参考上限
 *   - 模板渲染对 input 纯函数 (no model · form-shift 后无 model 字段)
 */

import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  RCA_SECTION_HEADERS,
} from '../server-enrich/rca/template';
import {
  RCA_MAX_INPUT_TOKENS,
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

function makeInput(overrides: Partial<RcaSection7Input> = {}): RcaSection7Input {
  return {
    traceId: SAMPLE_TRACE_ID,
    generatedAt: '2026-05-28T12:00:00Z',
    cacheHit: false,
    estimatedInputTokens: 1500,
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

  it('header section pre-fills trace_id + server-estimated tokens (no model · form-shift)', () => {
    const md = renderTemplate(makeInput());
    expect(md).toContain(`trace_id=${SAMPLE_TRACE_ID}`);
    expect(md).toContain('input_tokens (server-estimated): 1500');
    // form-shift: mcp tool never picks a model · header carries no model line
    expect(md).not.toContain('model:');
  });

  it('§7 归因 footer leaves an [ATTRIBUTION_PENDING] placeholder for the cc skill', () => {
    const md = renderTemplate(makeInput());
    expect(md).toContain('## 归因');
    expect(md).toContain('[ATTRIBUTION_PENDING]');
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

describe('feat-045/#1 · token-estimation helpers (deterministic · no LLM)', () => {
  it('estimateTokens grows with string length', () => {
    expect(estimateTokens('aaaa')).toBeLessThanOrEqual(estimateTokens('aaaaaaaaaaaa'));
  });

  it('RCA_MAX_INPUT_TOKENS is a positive reference cap', () => {
    expect(RCA_MAX_INPUT_TOKENS).toBeGreaterThan(0);
  });
});

describe('feat-045/#1 · template render is a pure function of input', () => {
  it('same input → byte-identical markdown (no clock / randomness / model)', () => {
    const input = makeInput();
    expect(renderTemplate(input)).toBe(renderTemplate(input));
  });

  it('H2 structure is stable regardless of which legs are present', () => {
    const full = renderTemplate(makeInput());
    const degraded = renderTemplate(makeInput({ probe: undefined }));
    const fullHeaders = full.match(/^##? .+$/gm)?.join('\n') ?? '';
    const degradedHeaders = degraded.match(/^##? .+$/gm)?.join('\n') ?? '';
    expect(fullHeaders).toBe(degradedHeaders);
  });
});
