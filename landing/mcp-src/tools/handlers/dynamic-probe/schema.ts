/**
 * schema.ts · feat-068 重设计 (#210 · ADR-0017) · zod schema + denylist FLOOR 校验
 *
 * agent 调 `attach_neondb_dynamic_probe` 的 input 必走本 schema parse。
 *
 * 重设计 (ADR-0017): 主引擎从 bpftrace+sidecar 改为 pg_uprobe (SQL 驱动) · 治理从
 * "whitelist 强制" 改为 "denylist floor":
 *   - input: template(enum) → probe_type(enum TIME/HIST/MEM) + function + target(pg/rust)
 *   - function regex 收紧 ^[A-Za-z_][A-Za-z0-9_]*$ (ELF 导出符号字符集 · 防 SQL 注入 · 去掉 ':')
 *   - 不再要求 function ∈ whitelist · 只过 denylist FLOOR (命中即拒 · 不可绕过)
 *
 * 校验顺序 (fail-closed):
 *   1. zod schema (类型 / 范围 / enum / regex)
 *   2. function ∉ denylist FLOOR (按 target 选 usdt/uprobe pattern 集 · re.fullmatch · denylist.ts)
 *   3. duration ≤ 300 (zod max)
 *   4. max_overhead_pct ∈ [1.0, 5.0] (zod min/max)
 */
import { z } from 'zod/v3';
import { checkDenylist, type Denylist } from './denylist';
import { type ProbeType } from './sql-driver';

/** probe_type enum · 跟 pg_uprobe set_uprobe 第二参 + sql-driver ProbeType 一致 */
export const PROBE_TYPES = ['TIME', 'HIST', 'MEM'] as const;

/** target enum · pg = PG C 导出符号 (走 usdt_probe_patterns floor) · rust = Rust uprobe 符号 */
export const PROBE_TARGETS = ['pg', 'rust'] as const;
export type ProbeTarget = (typeof PROBE_TARGETS)[number];

/**
 * 函数名 escape regex · ELF 导出符号字符集 (^[A-Za-z_][A-Za-z0-9_]*$) ·
 * 防 SQL 注入 (虽 sql-driver 已参数化 $1 · 这里是 defense in depth · 拒任何含 ;'`"() 空格等的串)。
 * 注: 相比旧 bpftrace 版去掉了 ':' (旧 USDT probe_name 形如 postgresql:executor__run 需要冒号 ·
 * pg_uprobe 探的是裸 C 符号名 · 无冒号)。
 */
export const SAFE_SYMBOL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** zod schema · MCP tool input 严格校验 (feat-068 重设计 §4.1) */
export const attachDynamicProbeInputSchema = z.object({
  probe_type: z
    .enum(PROBE_TYPES)
    .describe(
      `pg_uprobe 探针类型: TIME (执行耗时 calls+avg ns) / HIST (耗时直方图) / MEM (MemoryContext 变化)`,
    ),
  function: z
    .string()
    .regex(
      SAFE_SYMBOL_RE,
      '函数名只允许 ELF 导出符号字符集 [A-Za-z_][A-Za-z0-9_]* · 防 SQL 注入',
    )
    .describe(
      '要 attach 的 C 导出函数符号 (任意导出函数 · 不再要求 ∈ whitelist · 只过 denylist FLOOR)',
    ),
  target: z
    .enum(PROBE_TARGETS)
    .default('pg')
    .describe(
      'pg = PostgreSQL C 导出符号 (denylist usdt_probe_patterns floor) · rust = Rust uprobe (uprobe_symbol_patterns floor)',
    ),
  duration_seconds: z
    .number()
    .int()
    .min(1)
    .max(300, 'duration cap = 300s (5 min) · 重设计 §4.1')
    .describe('probe attach 持续秒 · cap 5 min · sql-driver set→等→stat 等待窗口'),
  max_overhead_pct: z
    .number()
    .min(1.0)
    .max(5.0)
    .describe(
      'post-condition 提前判退阈值 (% CPU on target) · 重设计 §6 (1.0 ~ 5.0)',
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

/** lookup 后给上层 handler 用的统一 probe 视图 · 给 audit/sql-driver 用 */
export type ProbeView = {
  /** 探测的 C 导出函数符号 */
  function: string;
  /** pg_uprobe 探针类型 */
  probe_type: ProbeType;
  /** 探测目标 (pg / rust) */
  target: ProbeTarget;
};

/** zod schema + denylist FLOOR 联合校验 · 返结构化结果给 handler 用 */
export type ValidationResult =
  | { ok: true; input: AttachDynamicProbeInput; probe: ProbeView }
  | { ok: false; reason: string };

/**
 * zod schema + denylist FLOOR 联合校验。
 *   1. zod parse 失败 → reason 含 "schema"
 *   2. function 命中 denylist (按 target 选 pattern 集) → reason 含 "denylist" (hard-deny floor)
 *   3. 通过 → 返 input + probe view (任意导出函数放行 · form-shift 价值点)
 */
export function validateAttachInput(
  raw: unknown,
  denylist?: Denylist,
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
  const { function: fn, target, probe_type } = parsed.data;
  const dl = checkDenylist(fn, target === 'rust' ? 'rust' : 'pg', denylist);
  if (!dl.ok) {
    return {
      ok: false,
      reason: `function "${fn}" 命中 denylist ${dl.set}_probe_patterns "${dl.pattern}" · hard-deny FLOOR (安全敏感函数 · 不可绕过)`,
    };
  }
  return {
    ok: true,
    input: parsed.data,
    probe: { function: fn, probe_type, target },
  };
}
