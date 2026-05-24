/**
 * rate-limiter.ts · G9 destructive ops 速率限制 (feat-056/#3 · ADR-0007 hard-deny 第 3 层)
 *
 * in-memory 滑窗:per key (project/key id) 的 destructive op 计数 · 5 分钟窗 · 超 N 次 deny。
 * 防 agent 批量删 (R10 §2.1 Cursor 9 秒删 PocketOS 库)。任何 autonomy_level 不可禁 (hard-deny)。
 *
 * 注:单进程 in-memory(够 day-one)· 多实例需共享存储(Redis 等 · 后续)。
 */
import type { OpClass } from '../protection/destructive-detector';

const WINDOW_MS = 5 * 60 * 1000; // 5 分钟滑窗
const MAX_DESTRUCTIVE = 5; // 窗内最多 5 个 destructive op

// 计入速率的 destructive op-class (删/改类 · CREATE INDEX / ADD COLUMN / 只读 / 分支 不计)
const RATE_LIMITED_OPS: ReadonlySet<OpClass> = new Set<OpClass>([
  'DROP_TABLE_OR_INDEX',
  'DROP_REPLICATION_SLOT',
  'DELETE_UPDATE_BULK',
  'ALTER_TABLE_BIG_LOCK',
  // 以下虽被 G4 hard-deny 先拦(走不到 G9)· 列出保持语义完整
  'DROP_DATABASE_OR_TRUNCATE',
  'DROP_USER_OR_REVOKE',
]);

// key → 时间戳数组 (滑窗)
const hits = new Map<string, number[]>();

export function isRateLimitedOp(opClass: OpClass): boolean {
  return RATE_LIMITED_OPS.has(opClass);
}

/**
 * 记一次 destructive op 并查是否超限。返回 true = 超限 (应 deny)。
 * key = 限流主体 (grant.projectId / project_id · 调用方传)。
 */
export function recordAndCheckRateLimit(
  key: string,
  now: number = Date.now(),
): boolean {
  const arr = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > MAX_DESTRUCTIVE;
}

/** 测试用: 清空计数 */
export function __resetRateLimitForTest(): void {
  hits.clear();
}

export const RATE_LIMIT_CONFIG = { WINDOW_MS, MAX_DESTRUCTIVE };
