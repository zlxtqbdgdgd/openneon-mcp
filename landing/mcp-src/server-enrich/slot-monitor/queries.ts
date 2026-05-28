/**
 * queries.ts · feat-043/#1 · PG `pg_replication_slots` 查询 + inactive_seconds 计算
 *
 * 设计依据: design#53 §3.2 cron workflow + §4.1 PG view 输入字段 + §11 PG 版本兼容。
 *
 * 仅查 inactive slot (`active = false`) · `inactive_seconds`:
 *   - PG 16+: 直接用 `inactive_since` 字段 (PG 文档 view-pg-replication-slots)
 *   - PG < 16: fallback `now() - confirmed_flush_lsn` 估算 (小幅低估 · 不影响 36h critical 判定)
 *
 * `restart_lsn` 暂未用 (L4 升级 wal_lag_bytes 时算 `pg_wal_lsn_diff(pg_current_wal_lsn(),
 * restart_lsn)` · §11 attribute 命名空间预留)。
 *
 * **跨 DB 通用**: `pg_replication_slots` 是 PostgreSQL 9.4+ 标准 view · Neon / Aurora /
 * RDS / 自建 PG 全暴露 · 任何 read role 都可读 · 无 superuser 要求 (§6 权限与安全)。
 */

/** PG client 协议 · 仅 query 单 method · 测试 mock 极简 */
export interface PgClientLike {
  query<R = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** `pg_replication_slots` 单 row · queries 输出 */
export type InactiveSlotRow = {
  /** PG 字段 `slot_name` · 用户自定义 · 非 PII (§6) */
  slot_name: string;
  /** PG 字段 `active` · 本 query 仅返 false (WHERE active = false) */
  active: false;
  /** `inactive_since` (PG 16+) 或 fallback `confirmed_flush_lsn` 的 ISO 时间 · null 若 row 自有字段缺失 */
  detection_basis_at: string | null;
  /** 计算后 inactive 秒数 · ≥ 0 · null 若 PG 既无 `inactive_since` 又无 `confirmed_flush_lsn` (罕见 · 新建空 slot) */
  inactive_seconds: number | null;
  /** `restart_lsn` 字符串 · L4 升级 wal_lag_bytes 用 · 当前透传 · 不参与判定 */
  restart_lsn: string | null;
};

/**
 * 查询 SQL · 用 COALESCE(inactive_since, confirmed_flush_lsn) 自动兼容 PG 版本:
 *   - PG 16+ 有 inactive_since → 优先用
 *   - PG < 16 无 inactive_since → SQL parse 阶段失败 (字段不存在) · queries.ts caller 退路:
 *     fall back 到 LEGACY_QUERY (仅 confirmed_flush_lsn 估算)
 *
 * 注: PG 16+ 直接 SELECT 不存在字段会 syntax error · 不会返 null。所以单 query 不够 ·
 * 用 to_jsonb(s.*) 法把 column 反射成 JSONB · 避开 column missing error · 单 query 全兼容。
 *
 * 详 design#53 §11 PG 版本兼容 risk 缓解。
 */
export const SLOT_QUERY_SQL = `
SELECT
  slot_name,
  active,
  restart_lsn::text AS restart_lsn,
  -- PG 16+: inactive_since (timestamptz · NULL if currently active)
  -- PG < 16: 反射为 NULL (col 不存在 · jsonb 取 NULL)
  to_jsonb(s.*) ->> 'inactive_since' AS inactive_since_text,
  confirmed_flush_lsn::text AS confirmed_flush_lsn_text,
  -- 计算 inactive_seconds: 优先 PG16 inactive_since · fallback now() - 假定 confirmed_flush_lsn
  -- 等同时间戳 (LSN 不直接是 ts · 这里只算 lower bound · 详 §11)
  EXTRACT(
    EPOCH FROM (
      now() - COALESCE(
        (to_jsonb(s.*) ->> 'inactive_since')::timestamptz,
        now()
      )
    )
  )::float8 AS inactive_seconds_pg16,
  -- 退路: PG < 16 无 inactive_since · 用 statistics_reset 或者直接报 null (caller 退到估算)
  to_jsonb(s.*) ->> 'inactive_since' IS NOT NULL AS has_inactive_since
FROM pg_replication_slots s
WHERE active = false
`.trim();

type RawSlotRow = {
  slot_name: string;
  active: boolean | string;
  restart_lsn: string | null;
  inactive_since_text: string | null;
  confirmed_flush_lsn_text: string | null;
  inactive_seconds_pg16: number | string | null;
  has_inactive_since: boolean | string | null;
};

/**
 * 拉一个 endpoint 的 inactive slot 列表。
 *
 * @param pg 注入的 PG client (跨 DB 测试用 mock · 生产 wire pg.Pool)
 * @returns inactive slot 行 (含算好的 inactive_seconds) · 空数组 = 全 active (健康)
 * @throws caller 处理 (cron 用 try/catch 记 failed_endpoints[] · 不阻塞其他 endpoint)
 */
export async function fetchInactiveSlots(
  pg: PgClientLike,
): Promise<InactiveSlotRow[]> {
  const result = await pg.query<RawSlotRow>(SLOT_QUERY_SQL);
  return result.rows.map((row) => {
    const hasInactiveSince =
      row.has_inactive_since === true || row.has_inactive_since === 't';
    const rawSeconds =
      typeof row.inactive_seconds_pg16 === 'string'
        ? Number(row.inactive_seconds_pg16)
        : row.inactive_seconds_pg16;
    return {
      slot_name: row.slot_name,
      active: false as const,
      detection_basis_at: hasInactiveSince ? row.inactive_since_text : null,
      // PG 16+: 用 inactive_seconds_pg16 · PG < 16: null (caller 知道 · slot-checker 会 skip)
      inactive_seconds:
        hasInactiveSince && rawSeconds !== null && Number.isFinite(rawSeconds)
          ? Math.max(0, Math.round(rawSeconds))
          : null,
      restart_lsn: row.restart_lsn,
    };
  });
}
