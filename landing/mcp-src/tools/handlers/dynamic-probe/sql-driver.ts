/**
 * sql-driver.ts · feat-068 重设计 (#210 · ADR-0017) · pg_uprobe SQL 驱动
 *
 * 动态探针主引擎从 "bpftrace + ephemeral sidecar" 改为 PostgreSQL 扩展 `pg_uprobe` (compute 内置 ·
 * pg17 已装验证)。pg_uprobe 能力全通过 SQL 函数暴露 (pg_uprobe--0.3.sql):
 *   - set_uprobe(func text, uprobe_type text, is_shared boolean) → text · uprobe_type ∈ {TIME, HIST, MEM}
 *   - stat_time_uprobe(func text)                → text "calls: N  avg time: M ns" (TIME / MEM)
 *   - stat_hist_uprobe(func text)                → SETOF (time_range, hist_entry, percent) (HIST)
 *   - delete_uprobe(func text, should_write_stat boolean) → void
 *
 * ⚠️ 时序坑: is_shared=false 的探针是 **session 级** · set/查 stat/delete 必须同一 DB 连接。
 *   所以本驱动用单个注入的 client 跑完整套 set→(等 duration)→stat→delete · 不每条 SQL 开新连接。
 *   注入方 (route.ts 生产 · 测试 mock) 负责保证传进来的 client 是同一物理连接 (pg.PoolClient ·
 *   不是 pool 本身)。
 *
 * ⚠️ 防注入 (#210 comment 明确要求): 所有探测函数名/类型经 $1/$2 参数化绑定传入 SQL ·
 *   禁止字符串拼接 SQL。函数名字符集已在 schema.ts SAFE_SYMBOL_RE (^[A-Za-z_][A-Za-z0-9_]*$) 双保险。
 */

/** PG client 协议 · 仅 query 单 method · 跟 server-enrich/slot-monitor/queries.ts PgClientLike 同形 ·
 *  生产 wire pg.PoolClient (单连接 · 保证 session 级探针同连接) · 测试 mock。 */
export interface PgClientLike {
  query<R = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** pg_uprobe 探针类型 · 跟 set_uprobe 第二参 enum 一致 */
export type ProbeType = 'TIME' | 'HIST' | 'MEM';

export type RunProbeInput = {
  /** 探测的 C 导出函数符号 (已过 schema regex + denylist floor) */
  function: string;
  /** 探针类型 · 决定调哪个 stat 函数 */
  probe_type: ProbeType;
  /** 探针挂载持续秒 · 驱动 set 后 sleep 这么久再查 stat (测试可注入短 duration) */
  duration_seconds: number;
  /**
   * 测试用 · 注入 sleep 实现 (默认真 setTimeout)。
   * 单测传 `async () => {}` 跳过真实等待 · 不卡测试时长。
   */
  sleep?: (ms: number) => Promise<void>;
};

/** TIME / MEM 探针解析后的 enriched 结果 */
export type TimeProbeResult = {
  probe_type: 'TIME' | 'MEM';
  function: string;
  /** 函数被调用次数 (从 "calls: N" 解析) · null = 未采到 */
  calls: number | null;
  /** 平均执行时间 ns (从 "avg time: M ns" 解析 · TIME) · MEM 时是平均内存变化原值 · null = 未采到 */
  avg_time_ns: number | null;
  /** stat_time_uprobe 原始返回串 (debug / audit · 不含函数参数 · 只有 timing/count) */
  raw: string;
  elapsed_ms: number;
};

/** HIST 探针解析后的 enriched 结果 (直方图行集) */
export type HistProbeResult = {
  probe_type: 'HIST';
  function: string;
  /** stat_hist_uprobe SETOF 行 · (time_range, hist_entry, percent) */
  histogram: Array<{
    time_range: string;
    hist_entry: string;
    percent: number;
  }>;
  elapsed_ms: number;
};

export type RunProbeResult = TimeProbeResult | HistProbeResult;

/** set_uprobe 第二参 (uprobe_type) → stat 走 hist 还是 time */
function statKind(probeType: ProbeType): 'hist' | 'time' {
  return probeType === 'HIST' ? 'hist' : 'time';
}

/**
 * 解析 stat_time_uprobe 返回串 "calls: N  avg time: M ns" → { calls, avg_time_ns }。
 * 容错: 字段缺失返 null (不抛 · 让上层 post-condition 判 probe 是否真挂上)。
 */
export function parseTimeStat(raw: string): {
  calls: number | null;
  avg_time_ns: number | null;
} {
  const callsM = raw.match(/calls:\s*(\d+)/i);
  const avgM = raw.match(/avg\s*time:\s*([\d.]+)/i);
  return {
    calls: callsM ? Number(callsM[1]) : null,
    avg_time_ns: avgM ? Number(avgM[1]) : null,
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 完整跑一次探针 · **必须同一 client 连接** (session 级探针时序约束):
 *   1. set_uprobe($1, $2, false)            — 挂探针 (session 级 · is_shared=false)
 *   2. sleep(duration_seconds)              — 等采样窗口 (测试可注入短/零)
 *   3. stat_time_uprobe($1) | stat_hist_uprobe($1) — 按 probe_type 拉 enriched stat
 *   4. delete_uprobe($1, false)             — 摘探针 (should_write_stat=false · 不落盘)
 *
 * fail-safe: 任何 step 抛 → 在 finally 里尽力 delete_uprobe (best-effort · 不让探针悬挂) 后 re-throw。
 * 所有 SQL 用 $1/$2 参数化绑定 · 不拼接 (防注入 · #210 comment)。
 */
export async function runProbe(
  client: PgClientLike,
  input: RunProbeInput,
): Promise<RunProbeResult> {
  const sleep = input.sleep ?? defaultSleep;
  const start = Date.now();
  let probeSet = false;
  try {
    // 1. set (session 级 · is_shared=false → 必须同连接查 stat)
    await client.query('SELECT set_uprobe($1, $2, false)', [
      input.function,
      input.probe_type,
    ]);
    probeSet = true;

    // 2. 等采样窗口
    await sleep(Math.max(0, input.duration_seconds) * 1000);

    // 3. 拉 stat (按 probe_type 分支)
    if (statKind(input.probe_type) === 'hist') {
      const res = await client.query<{
        time_range: string;
        hist_entry: string;
        percent: string | number;
      }>('SELECT time_range, hist_entry, percent FROM stat_hist_uprobe($1)', [
        input.function,
      ]);
      return {
        probe_type: 'HIST',
        function: input.function,
        histogram: res.rows.map((r) => ({
          time_range: r.time_range,
          hist_entry: r.hist_entry,
          percent: Number(r.percent),
        })),
        elapsed_ms: Date.now() - start,
      };
    } else {
      const res = await client.query<{ stat_time_uprobe: string }>(
        'SELECT stat_time_uprobe($1) AS stat_time_uprobe',
        [input.function],
      );
      const raw = res.rows[0]?.stat_time_uprobe ?? '';
      const { calls, avg_time_ns } = parseTimeStat(raw);
      return {
        probe_type: input.probe_type === 'MEM' ? 'MEM' : 'TIME',
        function: input.function,
        calls,
        avg_time_ns,
        raw,
        elapsed_ms: Date.now() - start,
      };
    }
  } finally {
    // 4. 摘探针 (best-effort · 即便 stat 失败也别让探针悬挂在 session 上)
    if (probeSet) {
      try {
        await client.query('SELECT delete_uprobe($1, false)', [input.function]);
      } catch {
        // delete 失败不掩盖原始错误 (若有) · session 关闭时探针自然随 session 销毁
      }
    }
  }
}
