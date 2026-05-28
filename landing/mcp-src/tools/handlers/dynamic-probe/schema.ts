/**
 * schema.ts · feat-068/#1 (#144) · zod schema + whitelist loader
 *
 * agent 调 `attach_neondb_dynamic_probe` 的 input 必走本 schema parse。
 *
 * 校验顺序 (fail-closed):
 *   1. zod schema (类型 / 范围 / enum / regex)
 *   2. function ∈ whitelist (feat-067/#2 USDT + feat-069/#2 uprobe 维护)
 *   3. function ∉ denylist (优先于 whitelist · scram_* / *_secret / *_password 等)
 *   4. duration ≤ 300 (zod max)
 *   5. max_overhead_pct ∈ [1.0, 5.0] (zod min/max)
 *   6. function 名 regex anchor (^[A-Za-z_][A-Za-z0-9_:]*$ · 防 bpftrace 注入)
 *   7. (A5 屏障 2) uprobe 命中条目 is_async === false · async fn 永不放进 L3 attach
 *
 * 同步策略: whitelist.schema.json mirror from openneon A0b PR #39 ·
 *   commit be7564eb19024ff5805607c5c4e9e3b762256d33 · 路径 pgxn/neon/probes/whitelist.schema.json ·
 *   build-time copy · 跨仓自治。upgrade path: openneon 仓 schema 变更 → 本仓 PR 同步 mirror +
 *   $schema_source_commit 字段刷新 + 复跑 fixture (drift CI 检测)。
 */
import { z } from 'zod/v3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import {
  TEMPLATE_NAMES,
  SAFE_SYMBOL_RE,
  USDT_INCOMPATIBLE_TEMPLATES,
  type TemplateName,
} from './templates';

/** zod schema · MCP tool input 严格校验 (feat-068 详设 §4.1) */
export const attachDynamicProbeInputSchema = z.object({
  template: z
    .enum(TEMPLATE_NAMES)
    .describe(
      `bpftrace 模板 enum (沙箱化 · 不接受自由脚本) · 当前 5 个 PoC: ${TEMPLATE_NAMES.join(', ')}`,
    ),
  function: z
    .string()
    .regex(
      SAFE_SYMBOL_RE,
      '函数名只允许 [A-Za-z_][A-Za-z0-9_:]* · 防 bpftrace 单线注入',
    )
    .describe(
      '要 attach 的函数符号 (必须在 whitelist · feat-067 PG USDT + feat-069 Rust uprobe 维护)',
    ),
  duration_seconds: z
    .number()
    .int()
    .min(1)
    .max(300, 'duration cap = 300s (5 min) · 详设 §4.1')
    .describe('probe attach 持续秒 · cap 5 min'),
  max_overhead_pct: z
    .number()
    .min(1.0)
    .max(5.0)
    .describe(
      'watchdog 提前 detach 阈值 (% CPU on target) · 详设 §6 (1.0 ~ 5.0)',
    ),
  endpoint_id: z
    .string()
    .optional()
    .describe('Neon endpoint ID · L3+ ODD 内强制 (此字段必填)'),
  project_id: z
    .string()
    .optional()
    .describe('Neon project ID · 走 G1 跨 project hard-deny 校验'),
});

export type AttachDynamicProbeInput = z.infer<
  typeof attachDynamicProbeInputSchema
>;

// ──────────────────────────────────────────────────────────────
// whitelist loader · 与 anchor #39 schema 同形
// ──────────────────────────────────────────────────────────────

/** USDT 条目 · target/probe_name/subsystem 必填 · 跟 anchor `definitions/usdtEntry` 一致 */
export type UsdtEntry = {
  target:
    | 'postgresql'
    | 'pageserver'
    | 'safekeeper'
    | 'proxy'
    | 'local_proxy'
    | 'pg_sni_router';
  probe_name: string;
  subsystem: string;
  pg_version_min?: number | null;
  pg_version_max?: number | null;
  sample_overhead_ns_estimate?: number | null;
  args?: string[];
  notes?: string;
};

/** uprobe 条目 · binary/symbol/module/type/is_async 必填 · 跟 anchor `definitions/uprobeEntry` 一致 */
export type UprobeEntry = {
  binary:
    | 'pageserver'
    | 'safekeeper'
    | 'proxy'
    | 'local_proxy'
    | 'pg_sni_router';
  symbol: string;
  module: string;
  type: 'sync_fn' | 'method' | 'trait_impl' | 'closure';
  /** L3 白名单只允许同步函数 · async fn 永远 false · loader 加 assert 屏障 2 (A5 决策) */
  is_async: false;
  estimated_overhead_ns?: number | null;
  address_offset?: number | null;
  notes?: string;
};

/** anchor 黑名单结构 · usdt + uprobe pattern 分集合 */
export type WhitelistDenylist = {
  usdt_probe_patterns?: string[];
  uprobe_symbol_patterns?: string[];
};

/** 顶层 whitelist · 同 anchor #39 schema */
export type Whitelist = {
  version: 1;
  usdt?: UsdtEntry[];
  uprobe?: UprobeEntry[];
  denylist?: WhitelistDenylist;
};

/** lookup 命中后给上层用的统一 probe 视图 · 抹平 usdt/uprobe 字段差 · 给模板渲染/dispatch 用 */
export type WhitelistProbe = {
  /** 上层 handler 用的统一函数名 · usdt = probe_name · uprobe = symbol */
  function: string;
  kind: 'usdt' | 'uprobe';
  /** USDT = target enum (e.g. postgresql) · uprobe = binary enum (e.g. pageserver) */
  binary: string;
  /** uprobe 专属字段透传给上层 · async fn 屏障 2 已经在 loader 拦 · 这里仅供调试可视 */
  is_async?: boolean;
  /** 给 audit/log 用 · 不参与 attach */
  notes?: string;
};

let cached: Whitelist | null = null;

/**
 * 加载 whitelist.yaml · 默认路径 = 同目录 fixture (feat-068 自带) ·
 * 生产部署通过 OPENNEON_PROBE_WHITELIST_PATH env 覆盖到 openneon 仓的 whitelist.yaml。
 *
 * fail-safe: 文件不存在或解析失败 → 抛 (启动期 fail-closed · 没白名单不放任何 attach)。
 *
 * A5 屏障 2: loader 对每个 uprobe 条目断言 `is_async === false` · 任何 async fn 进入白名单
 * 立即 throw · feat-069 uprobe 编译期 SyncFnGuard 是屏障 1 · 这里是屏障 2 (运行期 mcp 加载)
 * · feat-068 attach 路径再过一遍 is_async assert 是屏障 3 (defense in depth)。
 */
export function loadWhitelist(path?: string): Whitelist {
  if (cached && !path) return cached;
  const resolved =
    path ??
    process.env.OPENNEON_PROBE_WHITELIST_PATH ??
    join(__dirname, 'whitelist.yaml');
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (e) {
    throw new Error(
      `[dynamic-probe/schema] whitelist not found at ${resolved} · fail-closed (无白名单不放 attach)`,
      { cause: e },
    );
  }
  const parsed = yamlLoad(raw) as Whitelist | undefined;
  validateWhitelistShape(parsed, resolved);
  if (!path) cached = parsed!;
  return parsed!;
}

/**
 * shape 校验 · 跟 anchor schema 对齐 (version=1 / usdt[]+uprobe[] / denylist object) ·
 * 同时落 A5 屏障 2 (uprobe 必须 is_async === false)。
 */
function validateWhitelistShape(
  parsed: unknown,
  resolvedPath: string,
): asserts parsed is Whitelist {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      `[dynamic-probe/schema] whitelist at ${resolvedPath} 不是 object · fail-closed`,
    );
  }
  const w = parsed as Partial<Whitelist>;
  if (w.version !== 1) {
    throw new Error(
      `[dynamic-probe/schema] whitelist at ${resolvedPath} version 必须 = 1 · 收到 ${JSON.stringify(w.version)} · fail-closed (anchor #39 schema 仅接受 v1)`,
    );
  }
  if (w.usdt !== undefined && !Array.isArray(w.usdt)) {
    throw new Error(
      `[dynamic-probe/schema] whitelist at ${resolvedPath} usdt 必须是 array · fail-closed`,
    );
  }
  if (w.uprobe !== undefined && !Array.isArray(w.uprobe)) {
    throw new Error(
      `[dynamic-probe/schema] whitelist at ${resolvedPath} uprobe 必须是 array · fail-closed`,
    );
  }
  if (
    w.denylist !== undefined &&
    (typeof w.denylist !== 'object' || Array.isArray(w.denylist))
  ) {
    throw new Error(
      `[dynamic-probe/schema] whitelist at ${resolvedPath} denylist 必须是 object (有 usdt_probe_patterns/uprobe_symbol_patterns 子字段) · fail-closed`,
    );
  }
  // A5 屏障 2 · uprobe 必须 is_async === false · async fn 永不放进 L3 attach
  for (const entry of w.uprobe ?? []) {
    if (entry.is_async !== false) {
      throw new Error(
        `[dynamic-probe/schema] uprobe 条目 "${entry.symbol}" is_async=${JSON.stringify(entry.is_async)} 不合规 · L3 白名单只允许 is_async===false · A5 屏障 2 (feat-068 mcp 加载期) fail-closed`,
      );
    }
  }
}

/** 测试用 · 重置缓存 */
export function __resetWhitelistCacheForTest(): void {
  cached = null;
}

/** 测试用 · 注入 in-memory whitelist · 不读文件 · 仍走 shape + 屏障 2 校验 */
export function __setWhitelistForTest(w: Whitelist | null): void {
  if (w !== null) {
    validateWhitelistShape(w, '<inline-test>');
  }
  cached = w;
}

/** glob 比配 · `*` 等价 `.*` · case-insensitive · 用于 denylist · pattern 是 glob 不是 regex */
function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(
    '^' +
      pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
      '$',
    'i',
  );
  return re.test(name);
}

/** regex 比配 · denylist usdt_probe_patterns / uprobe_symbol_patterns 是 regex · case-insensitive */
function regexMatch(pattern: string, name: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    // 无效 regex · fail-closed 视为命中 (拒绝)
    return true;
  }
  return re.test(name);
}

export type WhitelistCheckResult =
  | { ok: true; probe: WhitelistProbe }
  | { ok: false; reason: string };

/**
 * 校验 function 是否允许 attach。
 *   1. 命中 denylist (usdt_probe_patterns + uprobe_symbol_patterns 任一) → fail (优先)
 *   2. 命中 whitelist (usdt.probe_name 或 uprobe.symbol 精确匹配) → ok
 *   3. uprobe 命中后再过一道 is_async === false assert (A5 屏障 3)
 *   4. 都不在 → fail (默认 deny · 白名单制)
 */
export function checkWhitelist(
  functionName: string,
  whitelist?: Whitelist,
): WhitelistCheckResult {
  const wl = whitelist ?? loadWhitelist();

  // denylist 优先 · 两个 pattern 集合都查
  const dlUsdt = wl.denylist?.usdt_probe_patterns ?? [];
  const dlUprobe = wl.denylist?.uprobe_symbol_patterns ?? [];
  for (const pat of dlUsdt) {
    if (regexMatch(pat, functionName)) {
      return {
        ok: false,
        reason: `命中 denylist usdt_probe_patterns "${pat}" · hard-deny (G4 安全敏感函数)`,
      };
    }
  }
  for (const pat of dlUprobe) {
    if (regexMatch(pat, functionName)) {
      return {
        ok: false,
        reason: `命中 denylist uprobe_symbol_patterns "${pat}" · hard-deny (G4 安全敏感函数)`,
      };
    }
  }

  // whitelist usdt
  for (const entry of wl.usdt ?? []) {
    if (entry.probe_name === functionName) {
      return {
        ok: true,
        probe: {
          function: entry.probe_name,
          kind: 'usdt',
          binary: entry.target,
          notes: entry.notes,
        },
      };
    }
  }

  // whitelist uprobe
  for (const entry of wl.uprobe ?? []) {
    if (entry.symbol === functionName) {
      // A5 屏障 3 (defense in depth · loader 已查过 · 这里 attach 路径再查)
      if (entry.is_async !== false) {
        return {
          ok: false,
          reason: `uprobe "${entry.symbol}" is_async=${JSON.stringify(entry.is_async)} · L3 不允许 attach async fn (屏障 3)`,
        };
      }
      return {
        ok: true,
        probe: {
          function: entry.symbol,
          kind: 'uprobe',
          binary: entry.binary,
          is_async: false,
          notes: entry.notes,
        },
      };
    }
  }

  return {
    ok: false,
    reason: `function "${functionName}" 不在 whitelist (feat-067 PG / feat-069 Rust 维护) · 白名单制默认拒`,
  };
}

/** zod schema + whitelist 联合校验 · 返结构化结果给 handler 用 */
export type ValidationResult =
  | { ok: true; input: AttachDynamicProbeInput; probe: WhitelistProbe }
  | { ok: false; reason: string };

export function validateAttachInput(
  raw: unknown,
  whitelist?: Whitelist,
): ValidationResult {
  const parsed = attachDynamicProbeInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `schema 校验失败: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}=${i.message}`)
        .join('; ')}`,
    };
  }
  const wlCheck = checkWhitelist(parsed.data.function, whitelist);
  if (!wlCheck.ok) {
    return { ok: false, reason: wlCheck.reason };
  }
  // template × kind 兼容性 (BUG A 修复 · USDT 没有 retprobe · entry/exit 配对模板拒)
  if (
    wlCheck.probe.kind === 'usdt' &&
    USDT_INCOMPATIBLE_TEMPLATES.has(parsed.data.template)
  ) {
    return {
      ok: false,
      reason: `template "${parsed.data.template}" 需 entry/exit 配对 (uretprobe 语义) · USDT (probe_name=${wlCheck.probe.function}) 不支持 retprobe · 请改 kind=uprobe 的符号或换 call_count/stacktrace_top/lwlock_contention_top 等单点模板`,
    };
  }
  return { ok: true, input: parsed.data, probe: wlCheck.probe };
}

/** template name 类型 re-export 方便 handler 调用方使用 */
export type { TemplateName };
