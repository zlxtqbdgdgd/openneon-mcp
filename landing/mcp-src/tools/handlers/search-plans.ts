/**
 * search-plans.ts · feat-023/#2 · get_neondb_search_plans —— T10 主动巡检 plan history。
 *
 * 详设 §3 调用链 + §4 数据契约 + §12 场景:
 * agent 跨时间窗 + pattern filter 查 plan-store ("找所有有 Seq Scan 的 plan" / "找 cost > 10000 的 plan"
 * / "找特定 signature 的 plan 演变") · 返脱敏 (无绑定参数 · EXPLAIN 默认) plan 摘要 CSV。
 *
 * 数据底座是 feat-023/#1 plan-store (on-demand T3 hook + background pg_stat_statements collector 填充)。
 * T10 仅查 store · 不重跑 EXPLAIN (解耦 · 详设 §2 Path C)。
 *
 * 5 filter (pattern / time_range / cost_min / has_seq_scan / signature_list) AND 组合 ·
 * sort captured_at DESC · limit cap 200 · CSV (feat-006) · depth=full progressive disclosure (feat-007)
 * 返完整 plan_json · feat-031 emitAuditEvent(search_plans_invoked)。
 *
 * 设计: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-023-L2b-mcp-tool-t10-search-plans.html
 */

import {
  DEFAULT_DEPTH,
  isValidDepth,
  type DepthLevel,
} from '../../config/depth';
import { emitAuditEvent } from '../../observability/audit-emit';
import {
  searchPlans as storeSearchPlans,
  getPlanStore,
  planSummaryLine,
  type PlanFilter,
  type PlanRecord,
} from '../../server-enrich/plan-store';

/** time_range 相对窗 enum (字符串) | 绝对窗 (custom)。 */
export type TimeRangeInput =
  | 'last 1h'
  | 'last 24h'
  | 'last 7d'
  | { from_ms: number; to_ms: number };

export type SearchPlansInput = {
  projectId: string;
  pattern?: string;
  time_range?: TimeRangeInput;
  cost_min?: number;
  has_seq_scan?: boolean;
  signature_list?: string[];
  /** default 50 · cap 200。 */
  limit?: number;
  /** feat-007 progressive: shallow (默认 · 摘要) / full (拉 plan_json)。 */
  depth?: DepthLevel;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const RELATIVE_WINDOW_MS: Record<string, number> = {
  'last 1h': 3_600_000,
  'last 24h': 86_400_000,
  'last 7d': 604_800_000,
};

/**
 * time_range → 绝对 { from, to } (epoch ms)。
 * 相对窗 = now - span ~ now · custom = { from_ms, to_ms } 直接用 · 缺省 → undefined (不限时间)。
 */
export function resolveTimeRange(
  tr: TimeRangeInput | undefined,
  now: number = Date.now(),
): { from: number; to: number } | undefined {
  if (tr === undefined) return undefined;
  if (typeof tr === 'string') {
    const span = RELATIVE_WINDOW_MS[tr];
    if (span === undefined) return undefined; // 未知字符串 → 不限时间 (宽松)
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

/** CSV shallow 一行 (§4 output)。 */
type ShallowRow = {
  signature: string;
  captured_at: string;
  source: string;
  cost_total: number;
  has_seq_scan: boolean;
  plan_summary: string;
};

export type SearchPlansResult = {
  depth: DepthLevel;
  hits: number;
  backend: 'memory' | 'redis';
  /** depth=shallow: CSV-ready 摘要行。 */
  rows: ShallowRow[];
  /** depth=full: 完整 records (含摘要化 plan_json · progressive disclosure)。 */
  full?: PlanRecord[];
};

function toShallowRow(r: PlanRecord): ShallowRow {
  return {
    signature: r.signature,
    captured_at: new Date(r.captured_at).toISOString(),
    source: r.source,
    cost_total: r.cost_total,
    has_seq_scan: r.has_seq_scan,
    plan_summary: planSummaryLine(r),
  };
}

/**
 * T10 handler: 解析 filter → 查 plan-store → sort/limit (store 已做) → 结构化结果 +
 * feat-031 audit emit。CSV 渲染由 tools.ts 注册层用 formatToolResponse(result.rows) 做
 * (跟其他 tool 一致 · format query param 复用)。
 */
export async function handleSearchPlans(
  args: SearchPlansInput,
): Promise<SearchPlansResult> {
  const start = Date.now();
  const depth: DepthLevel = isValidDepth(args.depth) ? args.depth : DEFAULT_DEPTH;
  const limit = clampLimit(args.limit);

  const filter: PlanFilter = {
    projectId: args.projectId,
    pattern: args.pattern,
    time_range: resolveTimeRange(args.time_range),
    cost_min: args.cost_min,
    has_seq_scan: args.has_seq_scan,
    signature_list: args.signature_list,
    limit,
  };

  const records = await storeSearchPlans(filter);
  const backend = getPlanStore().kind;

  const result: SearchPlansResult = {
    depth,
    hits: records.length,
    backend,
    rows: records.map(toShallowRow),
  };
  if (depth === 'full') {
    result.full = records;
  }

  if (records.length === 0) {
    console.info(
      '[search-plans] no plans matched · plan-store may be empty (run T3 first or wait for background collector)',
    );
  }

  // feat-031 audit emit (§4)。filter_time_range 转字符串描述 · 不放原始绑定值 (无 PII)。
  emitAuditEvent({
    event_type: 'search_plans_invoked',
    outcome: 'allow',
    project_id: args.projectId,
    extra: {
      filter_pattern: args.pattern ?? '',
      filter_time_range:
        typeof args.time_range === 'string'
          ? args.time_range
          : args.time_range
            ? 'custom'
            : '',
      filter_cost_min: args.cost_min ?? '',
      filter_has_seq_scan: args.has_seq_scan ?? '',
      hits: records.length,
      duration_ms: Date.now() - start,
      backend,
    },
  });

  return result;
}
