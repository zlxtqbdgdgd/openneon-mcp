/**
 * schema.ts · feat-068/#1 (#144) · zod schema + whitelist loader
 *
 * agent 调 `attach_neondb_dynamic_probe` 的 input 必走本 schema parse。
 *
 * 校验顺序 (fail-closed):
 *   1. zod schema (类型 / 范围 / enum / regex)
 *   2. function ∈ whitelist (feat-067/#2 + feat-069/#2 维护)
 *   3. function ∉ denylist (优先于 whitelist · scram_* / *_secret / *_password 等)
 *   4. duration ≤ 300 (zod max)
 *   5. max_overhead_pct ∈ [1.0, 5.0] (zod min/max)
 *   6. function 名 regex anchor (^[A-Za-z_][A-Za-z0-9_:]*$ · 防 bpftrace 注入)
 *
 * 同步策略: whitelist.schema.json mirror from openneon A0b PR #39 (build-time copy · 跨仓自治).
 * upgrade path: openneon 仓 schema 变更 → 本仓 PR 同步 mirror + 复跑 fixture。
 */
import { z } from 'zod/v3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { TEMPLATE_NAMES, SAFE_SYMBOL_RE, type TemplateName } from './templates';

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
// whitelist loader
// ──────────────────────────────────────────────────────────────

export type WhitelistProbe = {
  function: string;
  kind: 'usdt' | 'uprobe' | 'kprobe';
  binary: string;
  description?: string;
};

export type Whitelist = {
  version: string;
  probes: WhitelistProbe[];
  denylist: string[];
};

let cached: Whitelist | null = null;

/**
 * 加载 whitelist.yaml · 默认路径 = 同目录 fixture (feat-068 自带) ·
 * 生产部署可通过 OPENNEON_PROBE_WHITELIST_PATH env 覆盖到 openneon 仓的 whitelist.yaml。
 *
 * fail-safe: 文件不存在或解析失败 → 抛 (启动期 fail-closed · 没白名单不放任何 attach)。
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
  if (
    !parsed ||
    !Array.isArray(parsed.probes) ||
    !Array.isArray(parsed.denylist)
  ) {
    throw new Error(
      `[dynamic-probe/schema] whitelist at ${resolved} 缺 probes/denylist 字段 · fail-closed`,
    );
  }
  if (!path) cached = parsed;
  return parsed;
}

/** 测试用 · 重置缓存 */
export function __resetWhitelistCacheForTest(): void {
  cached = null;
}

/** 测试用 · 注入 in-memory whitelist · 不读文件 */
export function __setWhitelistForTest(w: Whitelist | null): void {
  cached = w;
}

/** glob 比配 · `*` 等价 `.*` · case-insensitive · 用于 denylist */
function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(
    '^' +
      pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
      '$',
    'i',
  );
  return re.test(name);
}

export type WhitelistCheckResult =
  | { ok: true; probe: WhitelistProbe }
  | { ok: false; reason: string };

/**
 * 校验 function 是否允许 attach。
 *   1. 命中 denylist → fail (优先 · 即便也在 whitelist 也拒)
 *   2. 命中 whitelist (function 精确匹配) → ok
 *   3. 都不在 → fail (默认 deny · 白名单制)
 */
export function checkWhitelist(
  functionName: string,
  whitelist?: Whitelist,
): WhitelistCheckResult {
  const wl = whitelist ?? loadWhitelist();
  for (const pat of wl.denylist) {
    if (globMatch(pat, functionName)) {
      return {
        ok: false,
        reason: `命中 denylist 模式 "${pat}" · hard-deny (G4 安全敏感函数)`,
      };
    }
  }
  const hit = wl.probes.find((p) => p.function === functionName);
  if (!hit) {
    return {
      ok: false,
      reason: `function "${functionName}" 不在 whitelist (feat-067 PG / feat-069 Rust 维护) · 白名单制默认拒`,
    };
  }
  return { ok: true, probe: hit };
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
  return { ok: true, input: parsed.data, probe: wlCheck.probe };
}

/** template name 类型 re-export 方便 handler 调用方使用 */
export type { TemplateName };
