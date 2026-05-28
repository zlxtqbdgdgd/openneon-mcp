/**
 * RCA LLM client adapter · feat-045/#1 (L3).
 *
 * Detail design: zlxtqbdgdgd/openneon-design#18 §Scope + openneon-mcp#145.
 *
 * Vendor-neutral interface for "call an LLM with a system prompt + user payload, return text".
 * Mirrors the metrics-history seam pattern (ADR-0009 single collection point): consumers (RCA
 * handler) pass a model id + prompt + maxTokens; an adapter translates to the backend's SDK
 * (Anthropic Claude / OpenAI / etc). Swap backends = swap adapter · the interface and consumers
 * don't move.
 *
 * **fail-closed**: backend failure (network / auth / rate-limited / token cap exceeded) returns a
 * structured error · NEVER a partial / empty success masquerading as a full report. The handler
 * MUST surface the error in the [DATA_MISSING:llm] placeholder (§ LLM prompt rule 2).
 *
 * SDK NOT wired here: the production Anthropic adapter is registered at module-init time by
 * `landing/mcp-src/server/llm-init.ts` (when that lands · feat-041); tests inject a mock via
 * `setLlmClient`. This file intentionally has zero `@anthropic-ai/sdk` import so vitest stays
 * hermetic and so the module compiles before the SDK ships (contract-first per task brief).
 */

/** Supported model ids (cross-model robustness · #147 §跨 model 一致性). */
export type RcaModelId =
  | 'claude-opus-4-7'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5';

export type LlmCallRequest = {
  model: RcaModelId;
  systemPrompt: string;
  userPayload: string;
  /** Hard cap on output tokens · double-guard against OWASP LLM10 (§ LLM prompt rule 3). */
  maxTokens: number;
};

export type LlmCallSuccess = {
  text: string;
  /** Reported by backend · used by token-economy bookkeeping (#147). */
  inputTokens: number;
  outputTokens: number;
  model: RcaModelId;
};

export type LlmCallError = {
  error: {
    reason:
      | 'unreachable'
      | 'auth'
      | 'rate_limited'
      | 'backend_error'
      | 'token_cap_exceeded'
      | 'not_configured';
    detail?: string;
  };
};

export type LlmCallResult = LlmCallSuccess | LlmCallError;

export function isLlmCallError(r: LlmCallResult): r is LlmCallError {
  return (r as LlmCallError).error !== undefined;
}

export type LlmClient = {
  call: (req: LlmCallRequest) => Promise<LlmCallResult>;
};

/**
 * Default not-configured client · returns `not_configured` error for every call.
 * Production wiring (feat-041 anthropic adapter) replaces this via `setLlmClient`.
 */
const NOT_CONFIGURED_CLIENT: LlmClient = {
  call: async () => ({
    error: {
      reason: 'not_configured',
      detail:
        'LLM client not wired · register a backend via setLlmClient (anthropic adapter pending feat-041).',
    },
  }),
};

let activeClient: LlmClient = NOT_CONFIGURED_CLIENT;

/** Production wiring (feat-041) + tests inject mocks here. */
export function setLlmClient(client: LlmClient): void {
  activeClient = client;
}

export function getLlmClient(): LlmClient {
  return activeClient;
}

/** Test helper · restore to not-configured default. */
export function resetLlmClient(): void {
  activeClient = NOT_CONFIGURED_CLIENT;
}
