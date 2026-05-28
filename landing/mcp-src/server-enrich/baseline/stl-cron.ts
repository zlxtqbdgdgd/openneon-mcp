/**
 * feat-038/#2 · STL 后台 cron 1h 预计算 + ttl-cache 集成.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-038-L3-mcp-server-enrich-baseline-stl.html §3.3-§3.4
 *
 * 跑一轮：遍历 endpoints × metrics · 每个 (endpoint, metric) 调 feat-064 seam 拉 30d 历史 →
 * computeStl 算 5 字段 enrich → 写 ttl-cache (key=`stl:{endpoint}:{metric}` · TTL=3600s). 失败
 * (seam 不可达 / 抛错) 跨 endpoint × metric 隔离 + log warn · next round 自动重试. valid sample
 * 不足 → STL 返 'not_computable' → 跳过 (skipped) · 不写 cache · T4 cache miss 时 degrade 5 字段 null.
 *
 * 调度模式参考 feat-023 plan-store background-collector：启动期立即跑一轮 (不 await) + setInterval
 * 周期 · timer.unref() 不阻进程退出 · 失败 fire-and-forget 不传播.
 *
 * 并发：用极简内置 `mapConcurrent` 限 p-limit 5 (避免引入新 npm dep · ~20 LOC 自包含).
 *
 * 接口契约 (下游 feat-043 W2-A5 复用)：
 *   - `runStlPrecomputeOnce(opts)` · 跑一轮 · 纯异步 · 不依赖全局状态.
 *   - `startStlPrecomputeScheduler(opts)` · interval 调度封装 · 返回 handle.stop().
 *   - `stlCacheKey(endpointId, metricName)` · 单一拼接点 · cron 写 + T4 读都用这个.
 *   - `STL_CACHE_TTL_MS = 3_600_000` · 跟详设 §3.3 一致.
 *   - `mapConcurrent(items, limit, fn)` · 通用并发限制工具 · feat-043 slot monitor 可复用.
 */

import {
  computeStl,
  DEFAULT_STL_OPTS,
  type StlEnrich,
  type StlOpts,
} from './stl';
import type { TtlCache } from '../ttl-cache';
import {
  getMetricHistory,
  isMetricHistoryError,
  type MetricHistoryRequest,
  type MetricHistoryResult,
} from '../metrics-history';
import {
  filterAutosuspendWindows,
  type AutosuspendWindow,
} from '../sample-filter';

/** Cron 默认 interval = 1h · 跟 ttl-cache TTL 对齐 · 漂移信号最多滞后 1h (详设 §3.3). */
export const STL_CRON_INTERVAL_MS = 3_600_000;

/** Cache TTL = 1h · 跟详设 §3.3 + §4.3 一致 · 单一来源用于 cron 写入. */
export const STL_CACHE_TTL_MS = 3_600_000;

/** 默认并发上限 · 详设 §3.3. p-limit 5 单 mcp 实例不饱和 CPU. */
export const DEFAULT_STL_CONCURRENCY = 5;

/**
 * Cache key 单一拼接点 · key 含 endpoint + metric · 跨 endpoint 隔离 (§6 跨 tenant 安全 = 必须含
 * 完整维度 · ttl-cache.ts dimensionsKey 同语义)。
 *
 * 详设 §3.3 + §4.3 规定格式 `stl:{endpoint_id}:{metric_name}` · 用 `:` 分段；endpoint / metric 含
 * `:` 时通过 `encodeURIComponent` (`:` → `%3A`) 避免歧义 (例 endpoint='a:b' / metric='c' vs
 * endpoint='a' / metric='b:c' 必须区分开 · 测试用例验证).
 */
export function stlCacheKey(endpointId: string, metricName: string): string {
  return `stl:${encodeURIComponent(endpointId)}:${encodeURIComponent(metricName)}`;
}

/**
 * runStlPrecomputeOnce 入参 · 全注入式 (cache / fetchHistory / warn / 列表) · 无 process.env / 模块状态。
 *
 * @field endpoints - cron 全量预计算的 endpoint id 列表 · 由 caller 注入 (通常从 signal-registry 或 control plane 拉).
 * @field metrics - 跨 endpoint 通用 metric 名列表 (来自 signal-registry).
 * @field cache - ttl-cache 实例 · 写入 5 字段 enrich.
 * @field fetchHistory - feat-064 seam 注入 · 默认走 getMetricHistory (Datadog adapter).
 * @field concurrency - p-limit 上限 · 默认 5.
 * @field stlOpts - STL 算法参数 · 默认 DEFAULT_STL_OPTS.
 * @field windowDays - 拉历史窗口天数 · 默认 30 · 详设 §3.4 30d.
 * @field bucket - history bucket · 默认 '1h' (跟 samplesPerDay=24 对齐).
 * @field warn - 日志注入 · 默认 console.warn.
 * @field cacheTtlMs - TTL 覆盖 (测试用) · 默认 STL_CACHE_TTL_MS.
 * @field fetchAutosuspendWindows - feat-040 follow-up (#174) · 注入函数拿 per-endpoint autosuspend
 *   windows · STL trend 计算前先过 filterAutosuspendWindows 排除 idle 段 (防月级慢漂移被 idle
 *   window 污染 · 详 design#47 §3.4 / ADR-0014)。未注入 = 不做 filter (向后兼容 · 跟 feat-040
 *   sub-interface 注入式同 pattern)。
 */
export type StlPrecomputeOptions = {
  endpoints: readonly string[];
  metrics: readonly string[];
  cache: TtlCache<StlEnrich>;
  fetchHistory?: (req: MetricHistoryRequest) => Promise<MetricHistoryResult>;
  concurrency?: number;
  stlOpts?: StlOpts;
  windowDays?: number;
  bucket?: string;
  warn?: (msg: string, err?: unknown) => void;
  cacheTtlMs?: number;
  // feat-040 follow-up (#174): autosuspend windows 注入 · 缺省 = 不 filter
  fetchAutosuspendWindows?: (
    endpointId: string,
    windowDays: number,
  ) => Promise<ReadonlyArray<AutosuspendWindow>>;
};

export type StlPrecomputeResult = {
  /** 算出 5 字段并写入 cache 的任务数. */
  written: number;
  /** seam 失败 / 算法抛错 的任务数. */
  failed: number;
  /** valid sample 不足 → 'not_computable' · 不写 cache 但非异常 · 跟 failed 区分. */
  skipped: number;
};

/** Scheduler 句柄 · stop() 清 setInterval (跟 plan-store background-collector 同 pattern). */
export interface StlSchedulerHandle {
  stop(): void;
}

/**
 * 跑一轮 STL 预计算 (启动期 + 每个 interval 各调一次)。
 *
 * 错误隔离：单 (endpoint, metric) 失败 → log warn + 计 failed · 不影响其他任务 · 不抛到 caller.
 *
 * @returns {written, failed, skipped} · 三者总和 = endpoints × metrics.
 */
export async function runStlPrecomputeOnce(
  opts: StlPrecomputeOptions,
): Promise<StlPrecomputeResult> {
  const warn = opts.warn ?? ((m: string, e?: unknown) => console.warn(m, e));
  const fetchHistory = opts.fetchHistory ?? getMetricHistory;
  const concurrency = opts.concurrency ?? DEFAULT_STL_CONCURRENCY;
  const stlOpts = opts.stlOpts ?? DEFAULT_STL_OPTS;
  const windowDays = opts.windowDays ?? 30;
  const bucket = opts.bucket ?? '1h';
  const ttlMs = opts.cacheTtlMs ?? STL_CACHE_TTL_MS;

  // 展平任务 · cross product.
  type Task = { endpointId: string; metricName: string };
  const tasks: Task[] = [];
  for (const ep of opts.endpoints) {
    for (const m of opts.metrics) {
      tasks.push({ endpointId: ep, metricName: m });
    }
  }

  let written = 0;
  let failed = 0;
  let skipped = 0;

  await mapConcurrent(tasks, concurrency, async (task) => {
    try {
      const history = await fetchHistory({
        signal: task.metricName,
        dimensions: { endpoint: task.endpointId },
        window: { last: `${windowDays}d` },
        bucket,
      });

      // seam 显式 error · 跟 feat-016 baseline 一样降级 (计 failed · 让 cache miss 处理).
      if (isMetricHistoryError(history)) {
        warn(
          `[stl-cron] seam 拉历史失败 endpoint=${task.endpointId} metric=${task.metricName} reason=${history.error.reason}`,
          history.error.detail,
        );
        failed += 1;
        return;
      }

      // feat-040 follow-up (#174): autosuspend 段 filter · trend 计算前排除 idle window
      // 防月级慢漂移被 idle 段污染 (详 design#47 §3.4 + ADR-0014).
      let points: ReadonlyArray<[number, number | null]> = history.points;
      if (opts.fetchAutosuspendWindows) {
        try {
          const windows = await opts.fetchAutosuspendWindows(
            task.endpointId,
            windowDays,
          );
          points = filterAutosuspendWindows(points, windows);
        } catch (err) {
          // autosuspend fetch 失败 · 不阻塞 STL 计算 · log warn + 用未 filter samples 兜底
          // (跟 feat-040 baseline.ts 同 fail-safe pattern · idle window 风险换可用性).
          warn(
            `[stl-cron] autosuspend fetch 失败 endpoint=${task.endpointId} metric=${task.metricName} · 用未 filter samples 兜底 (trend 可能被 idle 段污染)`,
            err,
          );
        }
      }

      // 提取数值序列 (null = sparse bucket · STL 自身过滤 NaN/Infinity · 但 null 直接转 NaN 跳过).
      const samples = points.map(([, v]) =>
        v === null || v === undefined ? Number.NaN : v,
      );
      const result = computeStl(samples, stlOpts);
      if (result === 'not_computable') {
        // valid sample 不足 · 不写 cache · T4 cache miss 路径 5 字段全 null (degrade).
        skipped += 1;
        return;
      }
      opts.cache.set(stlCacheKey(task.endpointId, task.metricName), result, ttlMs);
      written += 1;
    } catch (err) {
      warn(
        `[stl-cron] 单任务异常 endpoint=${task.endpointId} metric=${task.metricName}`,
        err,
      );
      failed += 1;
    }
  });

  return { written, failed, skipped };
}

/**
 * 启动后台 STL 预计算 scheduler · 立即跑一轮 + setInterval 周期.
 *
 * 跟 plan-store background-collector 同 pattern：
 *   - 启动期一次性 (不 await · fire-and-forget · 内部已 warn 失败).
 *   - timer.unref() 不阻进程退出.
 *   - stop() 清 setInterval.
 */
export function startStlPrecomputeScheduler(
  opts: StlPrecomputeOptions & { intervalMs?: number },
): StlSchedulerHandle {
  const intervalMs = opts.intervalMs ?? STL_CRON_INTERVAL_MS;

  // 启动期立即跑 · 不 await.
  void runStlPrecomputeOnce(opts).catch(() => {
    /* 已在内部 warn · 防 unhandled rejection. */
  });

  const timer = setInterval(() => {
    void runStlPrecomputeOnce(opts).catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * 极简并发限制 (~15 LOC · 替代 npm `p-limit`) · 通用工具 · feat-043 slot monitor 后台轮询可复用.
 *
 * 维护 ≤ `limit` 个 inflight promise · 每完成一个就启动下一个 · 全部完成才 resolve.
 * fn 必须自己处理异常 (本模块内部已 try/catch · 不让 reject 传出 → 防止 Promise.all 短路).
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error('mapConcurrent: limit must be ≥ 1');
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const N = items.length;
  const workerCount = Math.min(limit, N);

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= N) return;
      results[idx] = await fn(items[idx], idx);
    }
  }

  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
