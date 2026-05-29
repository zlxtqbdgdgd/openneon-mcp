/**
 * llm-rewriter.ts · feat-041/#2 (L3) · LLM 改写 SQL 调用 + self-validation + single retry.
 *
 * Detail design:
 *   - Parent: https://github.com/zlxtqbdgdgd/openneon-design/issues/56
 *   - feat-041 详设 §3.2 (三原则) + §3.4 (4 类 risk 强制必填) + §3.5 (self-validation + retry)
 *   - openneon-mcp#185 (本文件)
 *
 * 一句话职责: 收 context (脱敏 SQL + 可选脱敏 EXPLAIN) + model → 走 feat-045 llm-client seam 调
 *   LLM (三原则 system prompt 内置 RewriteOutput JSON schema + 4 类 risk 必填规则) →
 *   解析 JSON → self-validation → 缺字段单次 retry (retry prompt 标 "上轮缺 X") →
 *   返 { best, backups, input_tokens, output_tokens, fallback_reason? }.
 *
 * 复用 feat-045 framework (不重写 · 详设 §3.2):
 *   - LLM client seam: `server-enrich/rca/llm-client.ts` `getLlmClient()` / `setLlmClient()` ·
 *     vendor-neutral · 生产注 Anthropic adapter · 测试注 mock · 跟 generate-rca-report.ts 同源。
 *   - token 估算 + cap: `server-enrich/rca/llm-prompt.ts` `estimateTokens()` · 同 chars/4 启发式。
 *   - 三原则: 数据外置 (LLM 仅填空 · 不自由发挥结构) / [DATA_MISSING:*] 占位 (EXPLAIN 缺时保留) /
 *     双层 token cap (maxTokens=1000 output · system prompt 硬声明 + input < 5000 token)。
 *
 * self-validation + retry (详设 §3.5):
 *   1. JSON 可 parse + 形态匹配 RewriteOutput
 *   2. risks 数组 4 类 category (null_handling / case_sensitivity / index_dependency /
 *      transaction_isolation) 全覆盖
 *   3. confidence ∈ [0, 1]
 *   4. rewritten_sql / rationale / expected_improvement 非空
 *   任一失败 → 单次 retry (system prompt 追加 "上轮缺 X · 必须补上") → 仍失败返
 *   fallback_reason='self_validation_failed' (handler 据此 best=null + 不写 cache)。
 */

import {
  getLlmClient,
  isLlmCallError,
  type RcaModelId,
} from '../rca/llm-client';
import { estimateTokens } from '../rca/llm-prompt';
import type { RewriteContext } from './context-builder';

// -----------------------------------------------------------------------------
// Output / result shapes (跟 handler rewrite-sql.ts 的 RewriteOutput / RewriteLlmCallResult 对齐)
// -----------------------------------------------------------------------------

export type RewriteRiskCategory =
  | 'null_handling'
  | 'case_sensitivity'
  | 'index_dependency'
  | 'transaction_isolation';

export const REQUIRED_RISK_CATEGORIES: RewriteRiskCategory[] = [
  'null_handling',
  'case_sensitivity',
  'index_dependency',
  'transaction_isolation',
];

export type RewriteOutput = {
  rewritten_sql: string;
  rationale: string;
  expected_improvement: string;
  risks: Array<{ category: RewriteRiskCategory; description: string }>;
  confidence: number;
};

export type RewriteFallbackReason =
  | 'self_validation_failed'
  | 'llm_timeout'
  | 'context_fetch_failed';

export type RewriteLlmCallResult = {
  best: RewriteOutput;
  backups: RewriteOutput[];
  input_tokens: number;
  output_tokens: number;
  fallback_reason?: RewriteFallbackReason;
};

export type RewriteModelId = RcaModelId;

// -----------------------------------------------------------------------------
// 三原则 system prompt (详设 §3.2 · 复用 feat-045 三原则模式 · SQL 改写专版)
// -----------------------------------------------------------------------------

/** 协议级稳定字符串 · 改这串 = protocol-breaking · bump version。 */
export const REWRITE_SYSTEM_PROMPT_VERSION = '1.0.0';

/** output token 硬 cap (详设 §3.2 双层 token cap · best + 1-2 backup 短 SQL 改写)。 */
export const REWRITE_MAX_OUTPUT_TOKENS = 1000;

/** input token 硬 cap (详设 §3.2 · SQL + EXPLAIN context < 5000 token)。 */
export const REWRITE_MAX_INPUT_TOKENS = 5000;

export const REWRITE_SYSTEM_PROMPT = `You are the openneon SQL rewrite advisor. Three rules, no exceptions:

RULE 1 — DATA-EXTERNAL, FILL THE SCHEMA ONLY
You receive an obfuscated SQL statement and (optionally) an obfuscated EXPLAIN plan. All
sensitive literals are already replaced with $N placeholders; do NOT try to recover or invent
them. Your job is to propose a semantically-equivalent faster rewrite. Return ONLY a single JSON
object matching this exact schema — no preamble, no markdown fence, no commentary:

{
  "best": {
    "rewritten_sql": "<the rewritten SQL · semantically equivalent · keep $N placeholders>",
    "rationale": "<1-3 sentences · why this is faster · reference EXPLAIN signals when present>",
    "expected_improvement": "<e.g. '50% IO reduction' or 'index scan replaces seq scan'>",
    "risks": [
      { "category": "null_handling", "description": "<...>" },
      { "category": "case_sensitivity", "description": "<...>" },
      { "category": "index_dependency", "description": "<...>" },
      { "category": "transaction_isolation", "description": "<...>" }
    ],
    "confidence": <number in [0,1]>
  },
  "backups": [ /* 0 to 2 alternative rewrites · same object shape as best */ ]
}

RULE 2 — ALL FOUR RISK CATEGORIES ARE MANDATORY
The "risks" array MUST contain exactly the four categories above, every time:
null_handling, case_sensitivity, index_dependency, transaction_isolation. If a category does not
apply to this rewrite, set its description to "N/A · this rewrite does not affect <category>".
NEVER omit a category. NEVER add categories outside the four. The DBA relies on seeing all four to
sign off the rewrite.

RULE 3 — PRESERVE [DATA_MISSING:explain] · BOUNDED OUTPUT
When the EXPLAIN plan is absent the input will contain a [DATA_MISSING:explain] marker. Do not
pretend you saw a plan; ground "rationale" only in the SQL text in that case. Stop once the JSON
object is complete. The hard output cap is 1000 tokens; do not approach it. confidence MUST be a
number between 0 and 1 inclusive. rewritten_sql / rationale / expected_improvement MUST be
non-empty.`;

/** 用户 payload: 脱敏 SQL + (脱敏 EXPLAIN 或 [DATA_MISSING:explain] 占位)。 */
export function buildRewriteUserPayload(context: RewriteContext): string {
  const explainBlock =
    context.explain && context.explain.trim().length > 0
      ? context.explain
      : '[DATA_MISSING:explain]';
  return `# SQL (obfuscated · keep $N placeholders)\n${context.sql}\n\n# EXPLAIN plan (obfuscated · read-only)\n${explainBlock}`;
}

// -----------------------------------------------------------------------------
// self-validation (详设 §3.5)
// -----------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true; value: { best: RewriteOutput; backups: RewriteOutput[] } }
  | { ok: false; missing: string[] };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** 校验单个 RewriteOutput 候选 · 返回缺失字段名数组 (空 = 合法)。 */
function validateOutput(candidate: unknown, label: string): string[] {
  const missing: string[] = [];
  if (candidate === null || typeof candidate !== 'object') {
    return [`${label}:object`];
  }
  const o = candidate as Record<string, unknown>;

  if (!isNonEmptyString(o.rewritten_sql)) missing.push(`${label}.rewritten_sql`);
  if (!isNonEmptyString(o.rationale)) missing.push(`${label}.rationale`);
  if (!isNonEmptyString(o.expected_improvement))
    missing.push(`${label}.expected_improvement`);

  if (
    typeof o.confidence !== 'number' ||
    Number.isNaN(o.confidence) ||
    o.confidence < 0 ||
    o.confidence > 1
  ) {
    missing.push(`${label}.confidence(must be in [0,1])`);
  }

  const risks = o.risks;
  if (!Array.isArray(risks)) {
    missing.push(`${label}.risks(array)`);
  } else {
    const present = new Set<string>();
    for (const r of risks) {
      if (r && typeof r === 'object') {
        const cat = (r as Record<string, unknown>).category;
        const desc = (r as Record<string, unknown>).description;
        if (typeof cat === 'string' && isNonEmptyString(desc)) present.add(cat);
      }
    }
    for (const required of REQUIRED_RISK_CATEGORIES) {
      if (!present.has(required)) {
        missing.push(`${label}.risks[category=${required}]`);
      }
    }
  }
  return missing;
}

/**
 * 解析 LLM 文本 → JSON → self-validation (详设 §3.5):
 *   best 必合法 · backups 每条若存在也校验 (非法 backup 丢弃 · 不导致整体失败 · best 才是硬门)。
 */
export function parseAndValidate(text: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch {
    return { ok: false, missing: ['json(parse failed)'] };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, missing: ['json(not an object)'] };
  }
  const root = parsed as Record<string, unknown>;
  const bestMissing = validateOutput(root.best, 'best');
  if (bestMissing.length > 0) {
    return { ok: false, missing: bestMissing };
  }

  // best 合法 · 收编 backups (最多 2 条 · 仅保留校验通过的)。
  const backups: RewriteOutput[] = [];
  const rawBackups = Array.isArray(root.backups) ? root.backups : [];
  for (const b of rawBackups.slice(0, 2)) {
    if (validateOutput(b, 'backup').length === 0) {
      backups.push(b as RewriteOutput);
    }
  }

  return {
    ok: true,
    value: { best: root.best as RewriteOutput, backups },
  };
}

/** 去掉 LLM 可能误加的 ```json ... ``` 围栏 (RULE 1 要求不加 · 但宽容解析)。 */
function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

/** retry 时追加到 system prompt 末尾的纠正提示 (详设 §3.5 · "上轮缺 X · 必须补上")。 */
export function buildRetrySystemPrompt(missing: string[]): string {
  return `${REWRITE_SYSTEM_PROMPT}\n\nRETRY NOTICE — your previous response was rejected by self-validation. Missing or invalid fields: ${missing.join(
    ', ',
  )}. Re-emit the full JSON object with every field present and valid. All four risk categories are mandatory.`;
}

// -----------------------------------------------------------------------------
// 主入口: LLM 调用 + self-validation + single retry
// -----------------------------------------------------------------------------

export type RewriteLlmArgs = {
  context: RewriteContext;
  model: RewriteModelId;
};

/**
 * 调 LLM 改写 SQL (详设 §3.6 step 7-8):
 *   - input cap guard (estimateTokens · 超 5000 → 当 context 过大 · self_validation_failed 走 fallback
 *     而非裸调 · 防 OWASP LLM10 · 真实长 SQL 已被 handler zod schema 20000 char 上限挡掉大头)
 *   - LLM client seam 调 (feat-045 getLlmClient · 生产 Anthropic adapter · 测试 mock)
 *   - LLM error (unreachable/auth/rate_limited/...) → fallback_reason='llm_timeout'
 *   - self-validation 失败 → 单次 retry (纠正 prompt) → 仍失败 fallback_reason='self_validation_failed'
 */
export async function rewriteWithLlm(
  args: RewriteLlmArgs,
): Promise<RewriteLlmCallResult> {
  const userPayload = buildRewriteUserPayload(args.context);
  const estInput =
    estimateTokens(REWRITE_SYSTEM_PROMPT) + estimateTokens(userPayload);

  const emptyBest: RewriteOutput = {
    rewritten_sql: '',
    rationale: '',
    expected_improvement: '',
    risks: [],
    confidence: 0,
  };

  if (estInput > REWRITE_MAX_INPUT_TOKENS) {
    // context 过大 · 不裸调 (双层 token cap · 详设 §3.2)。
    return {
      best: emptyBest,
      backups: [],
      input_tokens: estInput,
      output_tokens: 0,
      fallback_reason: 'self_validation_failed',
    };
  }

  const client = getLlmClient();
  let inputTokens = 0;
  let outputTokens = 0;
  let lastMissing: string[] = [];

  // attempt 0 = 初次 · attempt 1 = 单次 retry (纠正 prompt)。
  for (let attempt = 0; attempt <= 1; attempt++) {
    const systemPrompt =
      attempt === 0
        ? REWRITE_SYSTEM_PROMPT
        : buildRetrySystemPrompt(lastMissing);

    const result = await client.call({
      model: args.model,
      systemPrompt,
      userPayload,
      maxTokens: REWRITE_MAX_OUTPUT_TOKENS,
    });

    if (isLlmCallError(result)) {
      // 网络 / auth / rate-limited / token cap → fallback (不 retry network error · 单次 retry 仅给 validation)。
      return {
        best: emptyBest,
        backups: [],
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        fallback_reason: 'llm_timeout',
      };
    }

    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;

    const validation = parseAndValidate(result.text);
    if (validation.ok) {
      return {
        best: validation.value.best,
        backups: validation.value.backups,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      };
    }
    lastMissing = validation.missing;
    // attempt 0 失败 → 进 attempt 1 (retry)。attempt 1 失败 → 落到循环外 fallback。
  }

  return {
    best: emptyBest,
    backups: [],
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    fallback_reason: 'self_validation_failed',
  };
}
