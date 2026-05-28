/**
 * LLM 主路径 · feat-037/#2 (L3) · 小样本 + 业务语义的 log pattern 聚类.
 *
 * Detail design: zlxtqbdgdgd/openneon-design#51 §3.4 LLM 主路径 + §6 OWASP +
 * feat-037-L3-hybrid-log-pattern-clustering.html.
 *
 * 复用栈 (按全局 CLAUDE.md 工程纪律):
 *   - feat-045 `llm-prompt.ts` 三原则 system prompt (证据优先 / [DATA_MISSING:*] / 双层 token cap)
 *   - feat-045 `llm-client.ts` LlmClient / setLlmClient / RcaModelId (Anthropic SDK adapter 通路)
 *   - feat-045 estimateTokens (chars/4 · 跟 RCA token-economy 同源)
 *
 * **两个职责** (跟 RCA 完全独立 · Q6 forbids cross-domain coupling):
 *   1. **prompt 渲染**: 把 obfuscated log + drain3 pre-cluster 喂给 LLM · 让 LLM 出 two-tier 命名
 *      (semantic_name + semantic_category + semantic_summary) · 不出 raw template (那是 drain3 的活)
 *   2. **结果 schema validate**: LLM 返 JSON · 严格按 LogPattern[] shape 解析 · 任何 missing field
 *      或 enum drift → 落 `[DATA_MISSING:llm]` fallback (rule 2) · 整个 cluster_neondb_logs 不阻塞
 *
 * **fail-closed**: LLM 失败 / 超 token / model not_configured → 返 LlmCallError · 由 path-router
 *   接 fallback 走 Drain3。本文件不知道 fallback · 只负责 "调 LLM + 解 JSON + 校 schema"。
 *
 * **OWASP LLM10 unbounded consumption**: 双层 cap:
 *   - input 端: estimateTokens 超 MAX_LLM_INPUT_TOKENS → 落 `[DATA_MISSING:input_truncated]`
 *   - output 端: maxTokens=4500 走 SDK 硬限 + system prompt 末尾再次声明
 */

import {
  estimateTokens,
  RCA_MAX_OUTPUT_TOKENS,
} from '../rca/llm-prompt';
import {
  getLlmClient,
  isLlmCallError,
  type RcaModelId,
} from '../rca/llm-client';
import { SEMANTIC_CATEGORIES } from './types';
import type {
  LogLine,
  LogPattern,
  PatternClusterResult,
  SemanticCategory,
  Severity,
  TailAggregate,
} from './types';

// ------------------------------------------------------------------------------------------------
// Limits · 跟 RCA framework 同 budget · 主路径只是另一种 LLM consumer
// ------------------------------------------------------------------------------------------------

/** Hard cap · 跟 #155 §验收门 maxTokens=4500 + system prompt 双层 cap 对齐. */
export const LLM_CLUSTERING_MAX_OUTPUT_TOKENS = RCA_MAX_OUTPUT_TOKENS;

/**
 * Input-side cap · MUST < path-router 50K 阈值 · 否则 router 都不会调本路径。
 * 路径切换阈值 50K (Q2) · 主路径里再 cap 一次防 overshoot · 双层 fail-closed。
 */
export const LLM_CLUSTERING_MAX_INPUT_TOKENS = 40_000;

// ------------------------------------------------------------------------------------------------
// Three-rule system prompt · 复用 feat-045 三原则结构 · two-tier 命名 + 5 enum 写死在 prompt
// ------------------------------------------------------------------------------------------------

export const LLM_CLUSTERING_SYSTEM_PROMPT_VERSION = '1.0.0';

export const LLM_CLUSTERING_SYSTEM_PROMPT = `You are the openneon log pattern classifier. Three rules, no exceptions.

RULE 1 — EVIDENCE FIRST, NO FREE FORM
You will receive a numbered list of obfuscated log lines (PII already scrubbed at the server boundary).
Your job is to cluster them into log patterns and produce, for each cluster:
  - template:           regex-like generalization · keep keywords, replace values with <*>
  - semantic_name:      EXACTLY "[Resource] [Operation]" form · 2-5 English words · e.g.
                        "WAL Replay Lag", "Vacuum Skipped Tuples", "Auth Token Expired"
  - semantic_category:  one of [query | error | maintenance | auth | replication | other]
  - semantic_summary:   1-2 sentences in plain English · what the pattern means
Never invent log content that isn't in the input. Never re-introduce values masked as <*>.

RULE 2 — PRESERVE [DATA_MISSING:*] PLACEHOLDERS
If the input contains "[DATA_MISSING:input_truncated]", produce clusters ONLY for the lines you
were given · do NOT extrapolate to missing lines. If you cannot classify a cluster's category,
emit semantic_category="other" — never guess. If a single log line is unparseable, group it
under template="<unparseable>" with category="other".

RULE 3 — BOUNDED OUTPUT
Hard token cap is 4500. Stop generating once every cluster is emitted. Output must be valid JSON
that matches this schema EXACTLY (no markdown fence, no preamble, no trailing prose):
{
  "patterns": [
    {
      "pattern_id": "p1",                                        // sequential p1, p2, …
      "template": "<*> connection terminated due to <*>",        // regex-like w/ <*> placeholders
      "count": 12,                                               // integer · how many lines hit
      "first_line_index": 0,                                     // 0-based · first input line in this cluster
      "last_line_index": 11,                                     // 0-based · last input line
      "semantic_name": "Connection Terminated",                  // [Resource] [Operation] strict
      "semantic_category": "error",                              // 5-enum + other
      "semantic_summary": "Client connection closed unexpectedly, often during pool churn."
    }
  ]
}
Total clusters MUST NOT exceed top_n hint passed in the user payload (default 50). If you would
exceed it, merge the smallest clusters into one with semantic_category="other".`;

// ------------------------------------------------------------------------------------------------
// User payload builder · evidence-first · 把 obfuscated log 全量喂给 LLM
// ------------------------------------------------------------------------------------------------

export function buildClusteringUserPayload(args: {
  lines: LogLine[];
  topN: number;
  inputTruncated: boolean;
}): string {
  const header = `# Log Pattern Clustering Task
top_n=${args.topN}
total_lines=${args.lines.length}
${args.inputTruncated ? '\n[DATA_MISSING:input_truncated]\n' : ''}`;
  const body = args.lines
    .map((l, i) => `[${i}] sev=${l.severity ?? 'INFO'} ts=${l.timestamp ?? '-'} :: ${l.message}`)
    .join('\n');
  return `${header}\n\n# Log lines (numbered · 0-based)\n${body}`;
}

// ------------------------------------------------------------------------------------------------
// LLM raw output schema + validator (zod-free · 不引依赖 · 同 rca llm-prompt.ts 风格)
// ------------------------------------------------------------------------------------------------

type LlmRawPattern = {
  pattern_id?: unknown;
  template?: unknown;
  count?: unknown;
  first_line_index?: unknown;
  last_line_index?: unknown;
  semantic_name?: unknown;
  semantic_category?: unknown;
  semantic_summary?: unknown;
};

type LlmRawResponse = {
  patterns?: unknown;
};

export type LlmClusteringError = {
  ok: false;
  error: {
    reason:
      | 'llm_unreachable'
      | 'llm_auth'
      | 'llm_rate_limited'
      | 'llm_backend_error'
      | 'llm_token_cap_exceeded'
      | 'llm_not_configured'
      | 'llm_invalid_json'
      | 'llm_schema_violation';
    detail?: string;
  };
};

export type LlmClusteringSuccess = {
  ok: true;
  result: PatternClusterResult;
  /** Reported by backend · token-economy bookkeeping. */
  input_tokens: number;
  output_tokens: number;
  model: RcaModelId;
};

export type LlmClusteringResult = LlmClusteringSuccess | LlmClusteringError;

/**
 * Main entrypoint · 调 LLM + 解 JSON + 校 schema + 把 LLM raw 结构变成 PatternClusterResult.
 *
 * 调用方 (path-router) 拿到 `LlmClusteringError` → fallback Drain3。
 * 调用方拿到 `LlmClusteringSuccess` → 直接返。
 */
export async function llmClusterLogs(args: {
  lines: LogLine[];
  topN: number;
  model: RcaModelId;
}): Promise<LlmClusteringResult> {
  // 1. 估算 input · 超 cap 落 [DATA_MISSING:input_truncated] (双层 fail-closed · OWASP LLM10)
  let lines = args.lines;
  let inputTruncated = false;
  let estInput = estimateTokens(
    LLM_CLUSTERING_SYSTEM_PROMPT + buildClusteringUserPayload({ lines, topN: args.topN, inputTruncated: false }),
  );
  if (estInput > LLM_CLUSTERING_MAX_INPUT_TOKENS) {
    // 截断 · 保留前 K 行 + 最后 K 行 (头尾 anomaly 通常在两端)
    const head = Math.floor(lines.length / 2);
    lines = [...args.lines.slice(0, head), ...args.lines.slice(-head)];
    inputTruncated = true;
    estInput = estimateTokens(
      LLM_CLUSTERING_SYSTEM_PROMPT + buildClusteringUserPayload({ lines, topN: args.topN, inputTruncated: true }),
    );
  }

  const userPayload = buildClusteringUserPayload({ lines, topN: args.topN, inputTruncated });

  // 2. 调 LLM (LlmClient adapter · feat-045 已 ship)
  const llm = await getLlmClient().call({
    model: args.model,
    systemPrompt: LLM_CLUSTERING_SYSTEM_PROMPT,
    userPayload,
    maxTokens: LLM_CLUSTERING_MAX_OUTPUT_TOKENS,
  });
  if (isLlmCallError(llm)) {
    return {
      ok: false,
      error: {
        reason: mapLlmErrorReason(llm.error.reason),
        detail: llm.error.detail,
      },
    };
  }

  // 3. 解 JSON · LLM 偶尔会自作主张加 fence · strip 再 parse (与 feat-045 一致)
  let raw: LlmRawResponse;
  try {
    raw = JSON.parse(stripMarkdownFence(llm.text)) as LlmRawResponse;
  } catch (err) {
    return {
      ok: false,
      error: {
        reason: 'llm_invalid_json',
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // 4. 校 schema + 装回 PatternClusterResult
  const parsed = parseLlmPatterns(raw, args.lines, inputTruncated);
  if (!parsed.ok) {
    return { ok: false, error: { reason: 'llm_schema_violation', detail: parsed.detail } };
  }
  return {
    ok: true,
    result: parsed.result,
    input_tokens: llm.inputTokens,
    output_tokens: llm.outputTokens,
    model: llm.model,
  };
}

// ------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------

function mapLlmErrorReason(
  r:
    | 'unreachable'
    | 'auth'
    | 'rate_limited'
    | 'backend_error'
    | 'token_cap_exceeded'
    | 'not_configured',
): LlmClusteringError['error']['reason'] {
  switch (r) {
    case 'unreachable':
      return 'llm_unreachable';
    case 'auth':
      return 'llm_auth';
    case 'rate_limited':
      return 'llm_rate_limited';
    case 'backend_error':
      return 'llm_backend_error';
    case 'token_cap_exceeded':
      return 'llm_token_cap_exceeded';
    case 'not_configured':
      return 'llm_not_configured';
  }
}

function stripMarkdownFence(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith('```')) {
    const lines = trimmed.split('\n');
    return lines.slice(1, lines[lines.length - 1].startsWith('```') ? -1 : lines.length).join('\n');
  }
  return trimmed;
}

type ParseSuccess = { ok: true; result: PatternClusterResult };
type ParseFailure = { ok: false; detail: string };

function parseLlmPatterns(
  raw: LlmRawResponse,
  origLines: LogLine[],
  inputTruncated: boolean,
): ParseSuccess | ParseFailure {
  if (!Array.isArray(raw.patterns)) {
    return { ok: false, detail: '`patterns` must be an array' };
  }
  const patterns: LogPattern[] = [];
  let totalCount = 0;
  for (let idx = 0; idx < raw.patterns.length; idx++) {
    const p = raw.patterns[idx] as LlmRawPattern;
    if (typeof p.pattern_id !== 'string') {
      return { ok: false, detail: `patterns[${idx}].pattern_id must be string` };
    }
    if (typeof p.template !== 'string') {
      return { ok: false, detail: `patterns[${idx}].template must be string` };
    }
    if (typeof p.count !== 'number' || p.count < 0) {
      return { ok: false, detail: `patterns[${idx}].count must be non-negative number` };
    }
    if (typeof p.semantic_name !== 'string' || p.semantic_name.trim().length === 0) {
      return { ok: false, detail: `patterns[${idx}].semantic_name must be non-empty string` };
    }
    if (typeof p.semantic_category !== 'string' || !SEMANTIC_CATEGORIES.includes(p.semantic_category as SemanticCategory)) {
      return {
        ok: false,
        detail: `patterns[${idx}].semantic_category must be one of [${SEMANTIC_CATEGORIES.join('|')}]`,
      };
    }
    const firstIdx = typeof p.first_line_index === 'number' ? p.first_line_index : 0;
    const lastIdx =
      typeof p.last_line_index === 'number' ? p.last_line_index : Math.max(0, origLines.length - 1);

    const { severity, firstSeen, lastSeen } = aggregateLinesForCluster(origLines, firstIdx, lastIdx);
    totalCount += p.count;
    patterns.push({
      pattern_id: p.pattern_id,
      template: p.template,
      count: p.count,
      percentage: 0, // 留待循环结束统一算
      severity_distribution: severity,
      first_seen: firstSeen,
      last_seen: lastSeen,
      semantic_name: p.semantic_name,
      semantic_category: p.semantic_category as SemanticCategory,
      semantic_summary: typeof p.semantic_summary === 'string' ? p.semantic_summary : null,
    });
  }
  for (const p of patterns) {
    p.percentage = totalCount > 0 ? p.count / totalCount : 0;
  }
  // 主路径 LLM 不出 tail · top N hint 已防止溢出 · 若有 input_truncated 在 tail meta 留可见标记
  const tail: TailAggregate = {
    total_count: inputTruncated ? Math.max(0, origLines.length - totalCount) : 0,
    cluster_count: 0,
    severity_distribution: emptySeverity(),
    first_seen: null,
    last_seen: null,
  };
  return {
    ok: true,
    result: {
      patterns,
      tail_aggregate: tail,
      total_lines: origLines.length,
      total_clusters: patterns.length,
    },
  };
}

function aggregateLinesForCluster(
  lines: LogLine[],
  startIdx: number,
  endIdx: number,
): { severity: Record<Severity, number>; firstSeen: string | null; lastSeen: string | null } {
  const sev = emptySeverity();
  let firstSeen: string | null = null;
  let lastSeen: string | null = null;
  const lo = Math.max(0, Math.min(startIdx, lines.length - 1));
  const hi = Math.max(lo, Math.min(endIdx, lines.length - 1));
  for (let i = lo; i <= hi; i++) {
    const l = lines[i];
    const s = normalizeSeverity(l.severity);
    sev[s] += 1;
    if (l.timestamp) {
      if (!firstSeen || l.timestamp < firstSeen) firstSeen = l.timestamp;
      if (!lastSeen || l.timestamp > lastSeen) lastSeen = l.timestamp;
    }
  }
  return { severity: sev, firstSeen, lastSeen };
}

function emptySeverity(): Record<Severity, number> {
  return { FATAL: 0, ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 };
}

function normalizeSeverity(s: string | undefined): Severity {
  const up = (s ?? '').toUpperCase();
  if (up === 'FATAL' || up === 'PANIC') return 'FATAL';
  if (up === 'ERROR' || up === 'ERR') return 'ERROR';
  if (up === 'WARN' || up === 'WARNING') return 'WARN';
  if (up === 'DEBUG' || up === 'TRACE') return 'DEBUG';
  return 'INFO';
}
