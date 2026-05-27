/**
 * recommendation/thresholds.ts · feat-022 (L2b) · 规则可调阈值加载。
 *
 * 详设 §11 OQ2 决策: 阈值在 `~/.openneon/policy.yaml` 顶层 `recommendation_thresholds` key 配 ·
 * 默认值 hardcoded · **不暴露给 agent** (agent 看到统一 T7 接口)。
 *
 * 这里独立读 policy.yaml 的 `recommendation_thresholds` 块 (policy/loader.ts 管的是 per-project
 * autonomy_level · 跟阈值是正交关注点 · 不混进那个 schema 免得 ripple)。fail-safe: 文件缺失/坏值
 * → 全用 hardcoded 默认 (绝不因配置坏掉拒绝出推荐)。
 *
 * 单测可用 `__setThresholdsForTest` 注入 · 跑 fixture 用例 12 (threshold tunable) 走这条。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { logger } from '../../utils/logger';
import type { RecommendationThresholds } from './types';

const POLICY_PATH = join(homedir(), '.openneon', 'policy.yaml');

/** hardcoded 默认 (§3 各规则 day-one 阈值 · §11 OQ2 default)。 */
export const DEFAULT_THRESHOLDS: RecommendationThresholds = {
  autovacuum_lag_hours: 24,
  autovacuum_dead_tuple_min: 10000,
  unused_index_min_bytes: 1024 * 1024, // 1 MB
  missing_index_cost_ratio: 10,
  inefficient_join_outer_rows: 10000,
};

let override: Partial<RecommendationThresholds> | null = null;

function coerceNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return undefined;
}

/** 从 raw yaml block 提取并校验数值字段 (非法值忽略 · 回退默认)。 */
function parseThresholds(raw: unknown): Partial<RecommendationThresholds> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<RecommendationThresholds> = {};
  const keys: (keyof RecommendationThresholds)[] = [
    'autovacuum_lag_hours',
    'autovacuum_dead_tuple_min',
    'unused_index_min_bytes',
    'missing_index_cost_ratio',
    'inefficient_join_outer_rows',
  ];
  for (const k of keys) {
    const n = coerceNumber(r[k]);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

/**
 * 解析当前生效阈值 = hardcoded 默认 ← policy.yaml.recommendation_thresholds ← 测试注入。
 * fail-safe: 任何读取/解析错误 → 仅用默认 (不抛)。
 */
export function resolveThresholds(): RecommendationThresholds {
  if (override) {
    return { ...DEFAULT_THRESHOLDS, ...override };
  }
  let fromFile: Partial<RecommendationThresholds> = {};
  try {
    const text = readFileSync(POLICY_PATH, 'utf8');
    const doc = load(text) as Record<string, unknown> | undefined;
    fromFile = parseThresholds(doc?.['recommendation_thresholds']);
  } catch {
    // 文件不存在/坏 → 静默回退默认 (recommendation 阈值不该让 tool 失败)。
    logger.debug?.(
      '[recommendation] policy.yaml recommendation_thresholds 缺失/不可读 · 用 hardcoded 默认',
    );
  }
  return { ...DEFAULT_THRESHOLDS, ...fromFile };
}

/** 单测注入 (fixture 用例 12 threshold tunable)。传 null 复位。 */
export function __setThresholdsForTest(
  t: Partial<RecommendationThresholds> | null,
): void {
  override = t;
}
