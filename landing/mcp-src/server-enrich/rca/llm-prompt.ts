/**
 * RCA LLM prompt engine · feat-045/#1 (L3) · 三原则 system prompt.
 *
 * Detail design: zlxtqbdgdgd/openneon-design#18 §为什么必须做 + openneon-mcp#145 §验收门.
 *
 * 三原则 (LLM 自由发挥 = 幻觉源 · agent-native RCA 的差异化在 server 推证据 + LLM 仅填空):
 *
 *   1. **证据优先 / 数据外置**: prompt 把 7 节 markdown 模板 + 全量 server 事实 (trace span /
 *      audit timeline / probe 热点 / explain diff) 一次性传 LLM · LLM 只填模板空位 + 写自然
 *      语言归因句 · 不自由发挥 · 不重写表格 · 不臆造数据。
 *
 *   2. **`[DATA_MISSING:*]` 占位防编造 (OWASP LLM09 over-reliance)**: 任一数据源 fetch 失败 →
 *      对应节区段 server 端预填 `[DATA_MISSING:probe]` / `[DATA_MISSING:audit]` 等占位 · LLM
 *      被 system prompt 明确禁止改写 / 删除 / "推断" 这些占位 · 保留可见 → 让 DBA 知道哪段
 *      不可信。
 *
 *   3. **双层 token cap (OWASP LLM10 unbounded consumption)**: `maxTokens=4500` 走 SDK 硬限 +
 *      system prompt 末尾再次声明 "不超 5K token" (LLM 自审) · 任一触发都截断。input 端通过
 *      data-fetcher 的 token-economy 预算控制 (#147 跑批 input p99 < 3000)。
 *
 * 因果链可验证: LLM 写归因句必须引用 trace span / probe 数据 / explain diff 三类证据中至少一类 ·
 * 不引证据的归因句被 system prompt 标 "[UNVERIFIED]" 前缀 · DBA 复盘看 prefix 立判。
 */

import type { RcaModelId } from './llm-client';

/**
 * The canonical system prompt · stable across all 3 supported models (#147 跨 model robustness
 * ≥95%). Edits to this string are protocol-breaking · bump SYSTEM_PROMPT_VERSION on any change.
 */
export const SYSTEM_PROMPT_VERSION = '1.0.0';

export const RCA_SYSTEM_PROMPT = `You are the openneon RCA report writer. Three rules, no exceptions:

RULE 1 — EVIDENCE FIRST, NO FREE FORM
You will receive a 7-section markdown template with server-computed facts pre-filled in tables.
Your job is to (a) write 1–3 natural-language attribution sentences per section AND (b) leave
every server-pre-filled table / number / column verbatim. Do not rewrite tables. Do not recompute
percentages. Do not invent span ids, function names, line numbers, or timestamps.

RULE 2 — PRESERVE [DATA_MISSING:*] PLACEHOLDERS
When a section already contains a [DATA_MISSING:<source>] marker (e.g. [DATA_MISSING:probe]),
copy it exactly into your output. Do not delete, do not paraphrase, do not "infer what it would
have said". The marker tells the DBA that one upstream data source failed; pretending it didn't
is the worst outcome for incident review.

RULE 3 — BOUNDED OUTPUT
Stop generating once you have filled the 7 sections. The hard token cap is 4500; do not approach
it. If you find yourself padding, stop. Every attribution sentence MUST reference at least one
piece of evidence from the input (trace span / probe hotspot / audit event / explain diff). An
unsupported attribution sentence MUST be prefixed "[UNVERIFIED] " so the DBA sees it.

OUTPUT FORMAT
Return ONLY the completed markdown report. No preamble. No \`\`\`markdown\`\`\` fence. No commentary.`;

/** Build the user payload · the 7-section template (pre-filled) + raw evidence appendix. */
export function buildUserPayload(args: {
  templateMarkdown: string;
  evidenceAppendix: string;
}): string {
  return `${args.templateMarkdown}\n\n---\n# Evidence Appendix (read-only · do not echo back)\n\n${args.evidenceAppendix}`;
}

/**
 * Hard cap for output tokens · double-guard with prompt-level statement (rule 3).
 *
 * 4500 leaves room under the §验收门 "single RCA < 5K token" budget for downstream wrapping.
 */
export const RCA_MAX_OUTPUT_TOKENS = 4500;

/**
 * Hard cap for input tokens · enforce at handler boundary before calling LLM.
 *
 * Above this we truncate the evidence appendix (NOT the template) and append a
 * `[DATA_MISSING:evidence_truncated]` notice to the appendix tail. Template is sacred.
 */
export const RCA_MAX_INPUT_TOKENS = 6000;

/**
 * Estimate tokens from a string · cheap heuristic (chars/4 · matches Anthropic tokenizer ±15%).
 * Used by token-economy bookkeeping (#147) and the input-cap guard. NOT for billing.
 */
export function estimateTokens(s: string): number {
  // chars / 4 is the well-known ballpark for English+code; we use ceil so we never under-estimate.
  return Math.ceil(s.length / 4);
}

/** Defaults per model · all three configured identically to stabilize cross-model robustness. */
export function defaultsFor(model: RcaModelId): {
  maxTokens: number;
  modelId: RcaModelId;
} {
  return {
    maxTokens: RCA_MAX_OUTPUT_TOKENS,
    modelId: model,
  };
}
