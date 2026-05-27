/**
 * search-samples.ts · feat-024/#3 · get_neondb_query_samples —— T11 脱敏样本检索。
 *
 * 详设 §3 + §4 + §12: agent 拿"执行慢的 query 长啥样" (执行时长 + 脱敏后 query) · 但**永远脱敏** ——
 * store 内 100% 已脱敏 (samples-store 写入端口仅接受 obfuscate() 产出的 QuerySample) · T11 仅查
 * store · agent 没有任何手段拿到 raw param value (OWASP LLM02 server-side boundary)。
 *
 * tool 名 `get_neondb_query_samples` (不带 _obfuscated 后缀 · §11 OQ9: 用户视角不需要知道这是脱敏过的)。
 *
 * 3 filter (signature / time_range / duration_min_ms) · sort captured_at DESC · limit cap 200 ·
 * CSV (feat-006 · 已脱敏) · depth=full progressive disclosure · feat-031 emitAuditEvent
 * (含 sensitive_redact_count_total · §6 审计)。
 *
 * 设计: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-024-L2b-mcp-tool-t11-search-samples-obfuscated.html
 */

import {
  DEFAULT_DEPTH,
  isValidDepth,
  type DepthLevel,
} from '../../config/depth';
import { emitAuditEvent } from '../../observability/audit-emit';
import {
  searchSamples as storeSearchSamples,
  getSamplesStore,
  type QuerySample,
  type SampleFilter,
} from '../../server-enrich/samples-store';

export type TimeRangeInput =
  | 'last 1h'
  | 'last 24h'
  | { from_ms: number; to_ms: number };

export type SearchSamplesInput = {
  projectId: string;
  signature?: string;
  time_range?: TimeRangeInput;
  duration_min_ms?: number;
  /** default 50 · cap 200。 */
  limit?: number;
  depth?: DepthLevel;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const RELATIVE_WINDOW_MS: Record<string, number> = {
  'last 1h': 3_600_000,
  'last 24h': 86_400_000,
};

export function resolveTimeRange(
  tr: TimeRangeInput | undefined,
  now: number = Date.now(),
): { from: number; to: number } | undefined {
  if (tr === undefined) return undefined;
  if (typeof tr === 'string') {
    const span = RELATIVE_WINDOW_MS[tr];
    if (span === undefined) return undefined;
    return { from: now - span, to: now };
  }
  return { from: tr.from_ms, to: tr.to_ms };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

/** CSV shallow 一行 (§4 output · 已脱敏)。 */
type ShallowRow = {
  signature: string;
  captured_at: string;
  duration_ms: number;
  query_obfuscated: string;
  params_obfuscated: string;
};

export type SearchSamplesResult = {
  depth: DepthLevel;
  hits: number;
  backend: 'memory' | 'redis';
  sensitive_redact_count_total: number;
  rows: ShallowRow[];
  /** depth=full: 完整 QuerySample (仍 100% 脱敏)。 */
  full?: QuerySample[];
};

function toShallowRow(s: QuerySample): ShallowRow {
  return {
    signature: s.signature,
    captured_at: new Date(s.captured_at).toISOString(),
    duration_ms: s.duration_ms,
    query_obfuscated: s.query_text_obfuscated,
    // CSV 单元格: ['$1','$2'] → "[$1,$2]" (csv-stringify 不直接渲染数组)。
    params_obfuscated: `[${s.params_obfuscated.join(',')}]`,
  };
}

/**
 * T11 handler: 解析 filter → 查 samples-store → 结构化结果 + feat-031 audit emit
 * (含 sensitive_redact_count_total)。CSV 渲染由 tools.ts 注册层做。
 */
export async function handleSearchSamples(
  args: SearchSamplesInput,
): Promise<SearchSamplesResult> {
  const start = Date.now();
  const depth: DepthLevel = isValidDepth(args.depth) ? args.depth : DEFAULT_DEPTH;
  const limit = clampLimit(args.limit);

  const filter: SampleFilter = {
    projectId: args.projectId,
    signature: args.signature,
    time_range: resolveTimeRange(args.time_range),
    duration_min_ms: args.duration_min_ms,
    limit,
  };

  const samples = await storeSearchSamples(filter);
  const backend = getSamplesStore().kind;
  const redactTotal = samples.reduce(
    (acc, s) => acc + s.sensitive_redact_count,
    0,
  );

  const result: SearchSamplesResult = {
    depth,
    hits: samples.length,
    backend,
    sensitive_redact_count_total: redactTotal,
    rows: samples.map(toShallowRow),
  };
  if (depth === 'full') result.full = samples;

  if (samples.length === 0) {
    console.info(
      '[search-samples] no samples matched · user must enable auto_explain to populate samples (README 启用步骤)',
    );
  }

  // feat-031 audit emit (§3 audit emit · §6 sensitive_redact_count)。
  emitAuditEvent({
    event_type: 'search_samples_invoked',
    outcome: 'allow',
    project_id: args.projectId,
    extra: {
      filter_signature: args.signature ?? '',
      filter_time_range:
        typeof args.time_range === 'string'
          ? args.time_range
          : args.time_range
            ? 'custom'
            : '',
      filter_duration_min_ms: args.duration_min_ms ?? '',
      hits: samples.length,
      sensitive_redact_count_total: redactTotal,
      duration_ms: Date.now() - start,
      backend,
    },
  });

  return result;
}
