/**
 * timeout-injection.ts · feat-030/#79 · G3 statement/lock_timeout 注入 stage
 *
 * feat-056 pipeline 的 §8.2 第 8 步 (执行前最后一道): 对写 op 返回 inject_timeout verdict ·
 * orchestrator 在 SQL 进 DB 前 SET lock_timeout (+ statement_timeout) · 超时 DB 自动 abort
 * 回滚 · 防长锁雪崩 (R10 §3.1 Doctolib/TSB: 一条 ALTER 等锁堵死整表)。
 *
 * 注入策略 op-class-aware (非一刀切固定值): lock_timeout 所有写 op 普适注入 (核心防护) ·
 * statement_timeout 普通写注入兜底 · 长跑 DDL (CREATE INDEX CONCURRENTLY) 豁免 (否则误杀
 * 几十分钟的大表合法建索引)。
 *
 * 注入值只来自 DEFAULT_TIMEOUTS (编译期常量) 或校验过的 policy.yaml timeout_overrides ·
 * **绝不来自 agent** (防 agent 把 timeout 设成 '999h' 绕过防护 · 详设 §6)。
 *
 * 设计: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-030-L2-mcp-server-pg-timeout-injection.html (§3 §4)
 */
import type { OpClass } from '../../protection/destructive-detector';
import type { Stage } from '../pipeline';

/** 注入的一对 PostgreSQL timeout GUC · lock_timeout 必给 · statement_timeout 长跑 op 可省。 */
export type TimeoutSpec = {
  /** lock_timeout · 等锁超时即 abort (长锁雪崩核心防护) · 所有写 op 普适。 */
  lock_timeout: string;
  /** statement_timeout · 语句总时长兜底 · 长跑 DDL (CONCURRENTLY 等) 省略以免误杀。 */
  statement_timeout?: string;
};

/**
 * op-class → 默认 timeout 映射 (详设 §4.1)。可被 policy.yaml timeout_overrides per-project 覆盖。
 *
 * - ALTER/DDL/DELETE/DROP → lock_timeout + statement_timeout (普通写注入兜底)
 * - CREATE_INDEX_CONCURRENTLY → 仅 lock_timeout (豁免 statement_timeout · 大表建索引可跑几十分钟)
 * - READ_ONLY / CREATE_OR_RESTORE_BRANCH / hard-deny op-class / DROP_REPLICATION_SLOT
 *   → 不在表内 → timeoutFor 返回 null (不注入)
 */
export const DEFAULT_TIMEOUTS: Partial<Record<OpClass, TimeoutSpec>> = {
  ALTER_TABLE_BIG_LOCK: { lock_timeout: '30s', statement_timeout: '5min' },
  DDL_ADD_COLUMN: { lock_timeout: '30s', statement_timeout: '5min' },
  DELETE_UPDATE_BULK: { lock_timeout: '30s', statement_timeout: '5min' },
  DROP_TABLE_OR_INDEX: { lock_timeout: '30s', statement_timeout: '5min' },
  CREATE_INDEX_CONCURRENTLY: { lock_timeout: '30s' }, // ← statement_timeout 豁免 (长跑)
};

/**
 * 合法 PostgreSQL 时间型 GUC 字面量白名单 (lock_timeout / statement_timeout 的 SET 值)。
 *
 * 接受: 纯整数 (= 毫秒) 或 整数 + 可选单位 (us/ms/s/min/h/d) · 如 '30s' '5min' '500ms' '0' '30000'。
 * 用途 = **防 SQL 注入**: 注入走 `SET lock_timeout = '<value>'` 字符串拼接 · 严格白名单确保 value
 * 不含引号/分号/语句 (详设 §6)。loader 加载 policy override 时 + sql-driver 注入时各 guard 一次。
 */
const PG_TIMEOUT_VALUE = /^\d{1,9}\s?(us|ms|s|min|h|d)?$/;

export function isValidPgTimeoutValue(value: unknown): value is string {
  return typeof value === 'string' && PG_TIMEOUT_VALUE.test(value.trim());
}

/**
 * 解析 op-class → 要注入的 timeout · 不适用 (只读/分支/hard-deny/slot) 返回 null。
 * override (校验过的 policy.yaml timeout_overrides) 优先于 DEFAULT_TIMEOUTS。
 */
export function timeoutFor(
  opClass: OpClass,
  overrides?: Partial<Record<OpClass, TimeoutSpec>>,
): TimeoutSpec | null {
  const spec = overrides?.[opClass] ?? DEFAULT_TIMEOUTS[opClass];
  return spec ?? null;
}

/**
 * feat-056 pipeline stage (§8.2 第 8 步)。near-pure: 据 op-class (+ per-project override) 决定
 * 是否注入 timeout · 返回 non-terminal inject_timeout verdict (pipeline 继续到执行 · orchestrator
 * 在 createSqlClient 执行 SQL 前 SET)。只读/不适用 op → null (不注入 · pipeline 继续)。
 */
export const timeoutInjectionStage: Stage = (ctx) => {
  const timeouts = timeoutFor(ctx.opClass, ctx.timeoutOverrides);
  if (!timeouts) return null;
  const stmt = timeouts.statement_timeout
    ? ` + statement_timeout=${timeouts.statement_timeout}`
    : ' (CONCURRENTLY 豁免 statement_timeout)';
  return {
    action: 'inject_timeout',
    timeouts,
    reason: `注入 lock_timeout=${timeouts.lock_timeout}${stmt} 防长锁雪崩 (${ctx.opClass})`,
    audit_severity: 'info',
    terminal: false,
  };
};
