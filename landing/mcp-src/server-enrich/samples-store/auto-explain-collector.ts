/**
 * auto-explain-collector.ts · feat-024/#3 (L2b)。
 *
 * 详设 §3 collector + §11 OQ1/OQ2:
 * 周期 (default 5min) 从 auto_explain 拿 raw log → parse → RawSample (内存暂态) →
 * **obfuscate (必经)** → samples-store.writeSample。
 *
 * **强制脱敏类型保证**: collector 拿到的 RawSample 唯一出口是 obfuscate(raw) → QuerySample ·
 * store.writeSample 类型签名仅 QuerySample · 编译期无法把 raw 直接写进 store (§3 三层防御之运行期通路)。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ #116 auto_explain log 形态 audit 未在 Neon dev cluster 实测 (本 worktree 无 dev server access)。
 * 本 collector 按**标准 PostgreSQL auto_explain `log_format='json'`** 形态实现 parser,并把 log
 * 获取路径抽象成注入式 `LogSource` —— 实测确定 Neon 的取 log 路径 (Path A tail file / Path C
 * Datadog shipper / Path D Console API) 后,只换 LogSource 实现,parser + obfuscate + write 不动。
 * 详见 issue #116 audit comment + README "auto_explain 启用步骤"。
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { makeRawSample, type RawSample } from './raw-sample';
import { obfuscate, getObfuscatorMode } from './obfuscator';
import type { SamplesStoreBackend } from './types';

/**
 * raw log 获取抽象 (Path A/C/D · #116 audit 后选定具体实现注入)。
 * 返回若干条 auto_explain log 文本块 (每块一条慢 query 的 log entry)。
 */
export type LogSource = () => Promise<string[]>;

export interface AutoExplainCollectorOptions {
  projectId: string;
  store: SamplesStoreBackend;
  /** 取 raw log (#116 选定路径 · 注入式)。 */
  logSource: LogSource;
  intervalMs?: number;
  warn?: (msg: string, err?: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 300_000;

export interface AutoExplainCollectorHandle {
  stop(): void;
}

/**
 * 标准 PostgreSQL auto_explain JSON log entry 形态 (log_format='json')。
 * 单条 log line 大致:
 *   { "duration": 234.5, "plan": { "Query Text": "...", "Plan": {...} } }
 * 不同 PG 版本字段名略有差 (Query Text / query) · parser 做容错。
 *
 * @returns RawSample · 无法解析 → null (调用方跳过该条)。
 */
export function parseAutoExplainEntry(
  raw: string,
  now: number = Date.now(),
): RawSample | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // 非 JSON 形态 (log_format != json) · 跳过 (实测确定形态后扩展 text parser)
  }
  const duration =
    typeof obj.duration === 'number'
      ? obj.duration
      : Number(obj.duration ?? NaN);
  const plan =
    (obj.plan as Record<string, unknown>) ??
    (obj.Plan as Record<string, unknown>) ??
    {};
  const queryText =
    (typeof plan['Query Text'] === 'string' && (plan['Query Text'] as string)) ||
    (typeof obj['query'] === 'string' && (obj['query'] as string)) ||
    '';
  if (!Number.isFinite(duration) || queryText.trim() === '') return null;

  // raw_params: auto_explain 默认不单独输出 bind values · 字面量在 Query Text 内 ·
  // 这里 raw_params 留空数组占位 (obfuscator 从 Query Text 抽字面量替换;若未来 log 单列 params 再填)。
  return makeRawSample({
    duration_ms: duration,
    raw_plan: JSON.stringify(plan),
    raw_query: queryText,
    raw_params: [],
    captured_at: now,
  });
}

/**
 * 跑一轮: 取 raw log → parse → **obfuscate (必经)** → writeSample。
 * 失败 fail-safe (warn + skip) · 不抛。
 *
 * @returns 本轮写入 store 的脱敏 sample 数。
 */
export async function runAutoExplainCollectorOnce(
  opts: AutoExplainCollectorOptions,
): Promise<number> {
  const warn = opts.warn ?? ((m: string, e?: unknown) => console.warn(m, e));
  const mode = getObfuscatorMode();

  let entries: string[];
  try {
    entries = await opts.logSource();
  } catch (err) {
    warn(
      '[auto-explain-collector] log source unavailable · skipping round (auto_explain may not be enabled · README 启用步骤)',
      err,
    );
    return 0;
  }

  let written = 0;
  for (const raw of entries) {
    const sample = parseAutoExplainEntry(raw);
    if (!sample) continue;
    try {
      // ⚠ 强制脱敏: raw → obfuscate → QuerySample · 唯一通路 · store 永不见 raw。
      const obfuscated = obfuscate(sample, opts.projectId, mode);
      await opts.store.writeSample(obfuscated);
      written += 1;
    } catch (err) {
      warn('[auto-explain-collector] obfuscate/write failed for one entry · skipping', err);
    }
  }
  return written;
}

/** AUTO_EXPLAIN_COLLECTOR_ENABLED 默认 true · 显式 'false' 才关。 */
export function isAutoExplainCollectorEnabled(): boolean {
  return (process.env.AUTO_EXPLAIN_COLLECTOR_ENABLED ?? 'true') !== 'false';
}

function readIntervalMs(): number {
  const v = Number(process.env.AUTO_EXPLAIN_COLLECTOR_INTERVAL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_INTERVAL_MS;
}

/**
 * 启动 auto_explain collector: 立即一轮 + setInterval 周期。
 * AUTO_EXPLAIN_COLLECTOR_ENABLED=false → no-op (返 null · §8 回滚)。
 */
export function startAutoExplainCollector(
  opts: AutoExplainCollectorOptions,
): AutoExplainCollectorHandle | null {
  if (!isAutoExplainCollectorEnabled()) return null;
  const intervalMs = opts.intervalMs ?? readIntervalMs();

  void runAutoExplainCollectorOnce(opts).catch(() => {});
  const timer = setInterval(() => {
    void runAutoExplainCollectorOnce(opts).catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
