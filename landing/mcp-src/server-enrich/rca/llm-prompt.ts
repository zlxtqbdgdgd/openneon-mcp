/**
 * RCA token-estimation helpers · feat-045/#1 (L3) · deterministic, no LLM.
 *
 * Detail design: zlxtqbdgdgd/openneon-design#18 §为什么必须做 + openneon-mcp#145 §验收门.
 *
 * form-shift (规则 P4 · LLM-out-of-mcp): the RCA *narrative* prompt (三原则 system prompt +
 * buildUserPayload + output-token cap) moved to the cc skill — the mcp tool only does deterministic
 * evidence gathering + template pre-fill and never calls an LLM. What remains here is the pure,
 * deterministic token-size estimator + the input-size guard the取证器 uses to budget its output
 * (also reused by feat-037 pattern path-router · same chars/4 启发式).
 */

/**
 * Input-size reference cap · the取证器 caps the `estimatedInputTokens` it stamps in the template
 * header at this value. Above this, the cc skill (which owns the LLM call) should truncate its own
 * evidence appendix; the mcp side just surfaces the estimate. NOT a hard reject.
 */
export const RCA_MAX_INPUT_TOKENS = 6000;

/**
 * Estimate tokens from a string · cheap heuristic (chars/4 · matches Anthropic tokenizer ±15%).
 * Used by token-economy bookkeeping (#147) and the input-size guard. NOT for billing.
 */
export function estimateTokens(s: string): number {
  // chars / 4 is the well-known ballpark for English+code; we use ceil so we never under-estimate.
  return Math.ceil(s.length / 4);
}
