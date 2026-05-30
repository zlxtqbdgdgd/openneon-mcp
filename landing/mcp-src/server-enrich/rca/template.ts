/**
 * RCA 7-section markdown template · feat-045/#1 (L3) · pure renderer.
 *
 * Detail design: zlxtqbdgdgd/openneon-design#18 §Scope (RCA 报告模板) +
 * openneon-mcp#145 §验收门 (7 节固定 markdown 模板 ~100 LOC).
 *
 * 7 sections (固定顺序 · 与 design #18 issue body 给出的模板对齐):
 *   1. Header                      — trace_id · timestamp · cache hit · estimated input tokens
 *   2. Trace 链路图                — ASCII span tree across proxy/compute/safekeeper/pageserver
 *   3. 跨组件耗时分布              — table: component / ms / pct
 *   4. 函数级归因 (动态探针)       — table: function / p95 / hotspot pct  (degrade → [DATA_MISSING:probe])
 *   5. 修复时间线                  — audit-event-sourced timeline (感知/定位/假设/修复/验证)
 *   6. 验证结果                    — before vs after metrics + explain diff
 *   7. 归因 (footer)               — placeholder + 三原则 reminder; the cc skill fills NL prose here
 *
 * **Pure**: no I/O, no clock, no randomness. Inputs come from data-fetcher (#146). The renderer
 * pre-fills every server-computed value and inserts `[DATA_MISSING:<source>]` whenever a fetcher
 * leg failed. form-shift (规则 P4): the mcp tool never calls an LLM — the cc skill consumes this
 * skeleton + evidence bundle and writes attribution sentences AROUND those tables (never INSIDE them).
 *
 * Order is load-bearing: tests assert against H2 headers in this exact sequence to detect
 * 跨 model robustness 漂移 (§ openneon-mcp#147 §跨 model 一致性 ≥ 95%).
 */

import type { RcaSection7Input } from './types';

export const RCA_SECTION_HEADERS = [
  '## Trace 链路图',
  '## 跨组件耗时分布',
  '## 函数级归因 (动态探针)',
  '## 修复时间线',
  '## 验证结果',
  '## 归因',
] as const;

export type RcaSectionHeader = (typeof RCA_SECTION_HEADERS)[number];

/** Render the full 7-section markdown · server pre-fills · LLM augments later. */
export function renderTemplate(input: RcaSection7Input): string {
  return [
    renderHeader(input),
    renderTraceLinkGraph(input),
    renderComponentLatency(input),
    renderFunctionAttribution(input),
    renderTimeline(input),
    renderValidation(input),
    renderAttributionFooter(),
  ].join('\n\n');
}

/** §1 Header — trace_id + timestamp + cache + server-estimated input tokens. */
function renderHeader(input: RcaSection7Input): string {
  const cacheTag = input.cacheHit ? 'cached' : 'fresh';
  return [
    `# RCA · trace_id=${input.traceId} · ${input.generatedAt}`,
    '',
    `- cache: ${cacheTag}`,
    `- input_tokens (server-estimated): ${input.estimatedInputTokens}`,
  ].join('\n');
}

/** §2 Trace 链路图 — ASCII span tree. */
function renderTraceLinkGraph(input: RcaSection7Input): string {
  if (!input.trace) return `## Trace 链路图\n\n[DATA_MISSING:trace]`;
  const lines = input.trace.spanTree.map(
    (n) => `${'  '.repeat(n.depth)}↳ ${n.serviceName}::${n.operationName} (${n.durationMs}ms)`,
  );
  return ['## Trace 链路图', '', '```', ...lines, '```'].join('\n');
}

/** §3 跨组件耗时分布 — markdown table. */
function renderComponentLatency(input: RcaSection7Input): string {
  if (!input.trace)
    return `## 跨组件耗时分布\n\n[DATA_MISSING:trace]`;
  const rows = input.trace.componentLatency.map(
    (r) => `| ${r.component} | ${r.durationMs} | ${r.pct.toFixed(1)}% |`,
  );
  return [
    '## 跨组件耗时分布',
    '',
    '| 组件 | 耗时 (ms) | 占比 |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
}

/** §4 函数级归因 — degrade gracefully when probe data is missing. */
function renderFunctionAttribution(input: RcaSection7Input): string {
  if (!input.probe)
    return `## 函数级归因 (动态探针)\n\n[DATA_MISSING:probe]`;
  const rows = input.probe.hotspots.map(
    (h) => `| ${h.functionName} | ${h.p95Ms} | ${h.hotspotPct.toFixed(1)}% |`,
  );
  return [
    '## 函数级归因 (动态探针)',
    '',
    '| 函数 | p95 (ms) | 热点占比 |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
}

/** §5 修复时间线 — sourced from audit events emitted by feat-044 state machine. */
function renderTimeline(input: RcaSection7Input): string {
  if (!input.audit)
    return `## 修复时间线\n\n[DATA_MISSING:audit]`;
  const lines = input.audit.events.map(
    (e) => `- T+${e.deltaSeconds}s ${e.stage}: ${e.summary}`,
  );
  return ['## 修复时间线', '', ...lines].join('\n');
}

/** §6 验证结果 — before/after compare + explain diff hash. */
function renderValidation(input: RcaSection7Input): string {
  if (!input.validation)
    return `## 验证结果\n\n[DATA_MISSING:explain_diff]`;
  const v = input.validation;
  const improvement =
    v.beforeMs > 0
      ? (((v.beforeMs - v.afterMs) / v.beforeMs) * 100).toFixed(1)
      : '0.0';
  return [
    '## 验证结果',
    '',
    `- 修复前: ${v.beforeMs}ms`,
    `- 修复后: ${v.afterMs}ms`,
    `- 改善: ${improvement}%`,
    `- explain_diff_sha256: ${v.explainDiffSha256}`,
  ].join('\n');
}

/**
 * §7 归因 footer — placeholder for the cc skill (form-shift · 规则 P4 · mcp never calls an LLM).
 * The skill consumes this skeleton + evidence bundle and writes the NL attribution prose here.
 */
function renderAttributionFooter(): string {
  return [
    '## 归因',
    '',
    '[ATTRIBUTION_PENDING] (cc skill fills natural-language attribution prose here)',
    '- 三原则: 证据优先 · `[DATA_MISSING:*]` 占位 · 双层 token cap',
    '- 未引用证据的归因句应以 `[UNVERIFIED]` 前缀标注',
  ].join('\n');
}
