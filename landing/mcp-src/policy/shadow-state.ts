/**
 * shadow-state.ts · feat-056/#4 (#78) · L 级别升级前的 shadow (试用) 机制。
 *
 * **decide-high / execute-low**: shadow 期 agent 按目标高 L 决策,但执行按低 L (plan-gated 给 DBA 看)。
 * N 天通过率 (DBA 批准的 shadow-decided 写 / 总 shadow 决策) 达阈值才 auto-promote 转正。
 *
 * engine 状态 `~/.openneon/.shadow-state.json` (engine-managed · **非用户编辑** · 详设 §4.4):
 *   { "<project_id>": { "days_remaining": 5, "decided": 40, "approved": 39 } }
 *
 * - `days_remaining` 按 **wall-clock** 在 load 时递减 (跨重启保持 · 不靠进程存活)。
 * - pass-rate = `approved / decided`;过期 (days_remaining≤0) + pass-rate≥threshold → auto-promote + alert。
 * - **升级强制 shadow** (§9.4)·**降级立即生效** (shadow_during 不比目标更严 → 不 shadow · 直接目标 L)。
 *
 * 注: 本文件是 shadow **引擎 + lifecycle 逻辑** (纯函数 + 文件 I/O · 全单测)。把 resolveShadow 的
 * effectiveLevel 接进 enforcement pipeline + 在 plan-mode 批准时 recordApproval 的**请求期 wiring**
 * 随写执行路径 (run_sql 收编 + plan-mode 消费) 成熟同步接入 (同 feat-030/#79 timeout 消费 defer)。
 *
 * 设计: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-056-Lx-cross-mcp-policy-engine.html (§4.4 §9.4)
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { logger } from '../utils/logger';
import type { AutonomyLevel } from './pipeline';

const SHADOW_PATH = join(homedir(), '.openneon', '.shadow-state.json');

// 严 → 松 (index 越小越严) · 与 loader LEVEL_ORDER 一致
const LEVEL_ORDER: readonly AutonomyLevel[] = ['L1', 'L2a', 'L2b', 'L3', 'L4'];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ShadowEntry = {
  days_remaining: number;
  decided: number;
  approved: number;
  /** 上次 wall-clock decay 基准 (ISO) · 缺失 = 尚未 decay 过 (首次 load 设为 now)。 */
  last_decay?: string;
  /** 已转正 (auto-promote) · 转正后不再 shadow · alert 只发一次。 */
  promoted?: boolean;
};

export type ShadowState = Record<string, ShadowEntry>;

/** policy.yaml `shadow_mode` 解析后的结构 (per-project · 详设 §4.4)。 */
export type ShadowConfig = {
  enabled: boolean;
  /** shadow 期总天数 (首次 init days_remaining)。 */
  days: number;
  /** 通过率达标线 (0..1 · approved/decided)。 */
  pass_threshold: number;
  /** shadow 期执行 (低) L · decide-high/execute-low 的 "low" · 默认 L1 (最保守 · 写全 plan-gated)。 */
  shadow_during: AutonomyLevel;
};

const DEFAULT_SHADOW_DAYS = 7;
const DEFAULT_PASS_THRESHOLD = 0.95;
const DEFAULT_SHADOW_DURING: AutonomyLevel = 'L1';

function isAutonomyLevel(v: unknown): v is AutonomyLevel {
  return typeof v === 'string' && (LEVEL_ORDER as readonly string[]).includes(v);
}

function stricterOrEqual(a: AutonomyLevel, b: AutonomyLevel): boolean {
  // a 比 b 更严或相等 (index 更小或相等)
  return LEVEL_ORDER.indexOf(a) <= LEVEL_ORDER.indexOf(b);
}

/**
 * 解析 policy.yaml 的 `shadow_mode` 值 → ShadowConfig。
 * - `false` / 缺失 / 非对象 → undefined (不 shadow)
 * - `true` → 用全默认 (enabled · 7 天 · 0.95 · shadow_during L1)
 * - object `{ enabled?, days?/days_remaining?, pass_threshold?, shadow_during? }` → 取值 + 默认兜底
 */
export function parseShadowConfig(raw: unknown): ShadowConfig | undefined {
  if (raw === true) {
    return {
      enabled: true,
      days: DEFAULT_SHADOW_DAYS,
      pass_threshold: DEFAULT_PASS_THRESHOLD,
      shadow_during: DEFAULT_SHADOW_DURING,
    };
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.enabled === false) return undefined;
  const days =
    typeof r.days === 'number'
      ? r.days
      : typeof r.days_remaining === 'number'
        ? r.days_remaining
        : DEFAULT_SHADOW_DAYS;
  const pass_threshold =
    typeof r.pass_threshold === 'number' &&
    r.pass_threshold > 0 &&
    r.pass_threshold <= 1
      ? r.pass_threshold
      : DEFAULT_PASS_THRESHOLD;
  return {
    enabled: true,
    days: days > 0 ? days : DEFAULT_SHADOW_DAYS,
    pass_threshold,
    shadow_during: isAutonomyLevel(r.shadow_during)
      ? r.shadow_during
      : DEFAULT_SHADOW_DURING,
  };
}

/** pass-rate = approved / decided (decided=0 → 0 · 无数据不算达标)。 */
export function passRate(entry: ShadowEntry): number {
  return entry.decided === 0 ? 0 : entry.approved / entry.decided;
}

/**
 * 是否该转正: 过期 (days_remaining≤0) + 有决策数据 + pass-rate≥threshold + 尚未转正。
 */
export function shouldPromote(entry: ShadowEntry, threshold: number): boolean {
  return (
    !entry.promoted &&
    entry.days_remaining <= 0 &&
    entry.decided > 0 &&
    passRate(entry) >= threshold
  );
}

/**
 * wall-clock 递减一个 entry 的 days_remaining (load 时调 · 跨重启保持)。
 * 按 last_decay 到 now 的整天数递减 (floor 0) · 更新 last_decay 到 now。纯函数 (返回新 entry)。
 */
export function decayEntry(entry: ShadowEntry, now: Date): ShadowEntry {
  const last = entry.last_decay ? new Date(entry.last_decay) : now;
  const daysElapsed = Math.floor((now.getTime() - last.getTime()) / MS_PER_DAY);
  if (daysElapsed <= 0) {
    // 同一天内多次 load 不重复递减 · 仅首次补 last_decay
    return entry.last_decay ? entry : { ...entry, last_decay: now.toISOString() };
  }
  return {
    ...entry,
    days_remaining: Math.max(0, entry.days_remaining - daysElapsed),
    last_decay: now.toISOString(),
  };
}

/** decay 整个 state (load 时全量 wall-clock 递减)。 */
export function decayState(state: ShadowState, now: Date = new Date()): ShadowState {
  const out: ShadowState = {};
  for (const [pid, entry] of Object.entries(state)) {
    out[pid] = decayEntry(entry, now);
  }
  return out;
}

export type ShadowDecision = {
  /** 当前是否在 shadow 期 (enabled + 未过期 + 未转正 + 确是升级)。 */
  inShadow: boolean;
  /** 执行 (enforcement) 用的 L · shadow 期 = shadow_during (低) · 否则 = 目标 L。 */
  effectiveLevel: AutonomyLevel;
  /** agent 决策参照的目标 (高) L。 */
  shadowLevel: AutonomyLevel;
  /** 是否达到转正条件 (caller 据此 promote + alert)。 */
  promote: boolean;
  passRate: number;
};

/**
 * decide-high / execute-low 决策 (纯函数)。
 *
 * - shadow 未配 / 未 enabled → inShadow=false · effectiveLevel=目标 (无影响)。
 * - **降级立即生效**: shadow_during 不比目标 L 更严 (≥) → 不是真升级 → 不 shadow · effectiveLevel=目标。
 * - shadow 期 (enabled + 是升级 + days_remaining>0 + 未转正) → effectiveLevel=shadow_during (低 · plan-gated)。
 * - 过期/已转正 → effectiveLevel=目标 L (转正后按目标执行)。
 */
export function resolveShadow(
  config: ShadowConfig | undefined,
  targetLevel: AutonomyLevel,
  entry: ShadowEntry | undefined,
): ShadowDecision {
  const noShadow: ShadowDecision = {
    inShadow: false,
    effectiveLevel: targetLevel,
    shadowLevel: targetLevel,
    promote: false,
    passRate: entry ? passRate(entry) : 0,
  };
  if (!config?.enabled) return noShadow;
  // 降级 / 非升级: shadow_during 不比目标更严 → 直接目标 L (立即生效)
  if (stricterOrEqual(targetLevel, config.shadow_during)) return noShadow;

  const promote = entry
    ? shouldPromote(entry, config.pass_threshold)
    : false;
  const inShadow = !!entry && entry.days_remaining > 0 && !entry.promoted;

  return {
    inShadow,
    effectiveLevel: inShadow ? config.shadow_during : targetLevel,
    shadowLevel: targetLevel,
    promote,
    passRate: entry ? passRate(entry) : 0,
  };
}

// ───────────────────────── 状态变更 (engine-managed) ─────────────────────────

/** 初始化一个 project 的 shadow entry (首次进 shadow)。 */
export function initEntry(config: ShadowConfig, now: Date = new Date()): ShadowEntry {
  return {
    days_remaining: config.days,
    decided: 0,
    approved: 0,
    last_decay: now.toISOString(),
  };
}

/** 记一次 shadow 决策 (agent 按高 L 决定了一个写 op)。返回新 entry。 */
export function recordDecision(entry: ShadowEntry): ShadowEntry {
  return { ...entry, decided: entry.decided + 1 };
}

/** 记一次 DBA 批准 (一个 shadow-decided 写被人工批准 = 一次 pass)。返回新 entry。 */
export function recordApproval(entry: ShadowEntry): ShadowEntry {
  return { ...entry, approved: entry.approved + 1 };
}

/** 转正: 标 promoted + alert (只发一次)。返回新 entry。 */
export function promoteEntry(
  entry: ShadowEntry,
  projectId: string,
): ShadowEntry {
  logger.warn('shadow auto-promote (feat-056/#4)', {
    projectId,
    decided: entry.decided,
    approved: entry.approved,
    pass_rate: passRate(entry),
  });
  return { ...entry, promoted: true, days_remaining: 0 };
}

// ───────────────────────── 文件 I/O (engine-managed · 非用户编辑) ─────────────────────────

/**
 * load shadow state + wall-clock decay (跨重启保持)。坏文件 / 缺失 → 空 state (fail-safe · 不 crash)。
 * @param path 测试可覆盖 (默认 ~/.openneon/.shadow-state.json)
 */
export function loadShadowState(
  path: string = SHADOW_PATH,
  now: Date = new Date(),
): ShadowState {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return {};
    return decayState(raw as ShadowState, now);
  } catch (err) {
    logger.warn('shadow-state load 失败 · 落空 state (fail-safe)', {
      err: (err as Error).message,
    });
    return {};
  }
}

/** 原子写 shadow state (engine-managed · 自动建 ~/.openneon 目录)。 */
export function saveShadowState(
  state: ShadowState,
  path: string = SHADOW_PATH,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logger.warn('shadow-state save 失败 (非致命)', {
      err: (err as Error).message,
    });
  }
}
