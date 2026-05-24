/**
 * loader.ts · feat-056/#2 (#75) · policy.yaml 加载 + resolvePolicy + override
 *
 * 读 ~/.openneon/policy.yaml (js-yaml) · per-project_id keyed · defaults 兜底 ·
 * **fail-safe**(坏文件保 last-good / 启动落最保守 L1 defaults · 绝不 fail-open) ·
 * fs.watch 原子热重载(parse+validate→指针 swap · in-flight 用旧 snapshot)。
 *
 * hard-deny 不在此(硬编码在 hard-deny.ts · 不读 policy · ADR-0007)。
 * override(SQL-pattern → 更严 level)day-one 用 glob regex · feat-028 升级 PG parser 精确匹配。
 */
import { readFileSync, existsSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { logger } from '../utils/logger';
import type { AutonomyLevel } from './pipeline';
import type { OpClass } from '../protection/destructive-detector';
import {
  isValidPgTimeoutValue,
  type TimeoutSpec,
} from './stages/timeout-injection';

const POLICY_PATH = join(homedir(), '.openneon', 'policy.yaml');
const VALID_LEVELS: ReadonlySet<string> = new Set([
  'L1',
  'L2a',
  'L2b',
  'L3',
  'L4',
]);
// 严 → 松(index 越小越严)
const LEVEL_ORDER: readonly AutonomyLevel[] = ['L1', 'L2a', 'L2b', 'L3', 'L4'];

export type ProjectPolicy = {
  display_name?: string;
  autonomy_level: AutonomyLevel;
  overrides: Record<string, AutonomyLevel>; // SQL-pattern → 更严 level
  // feat-030/#79: op-class → 覆盖 DEFAULT_TIMEOUTS 的注入值 (校验过的合法 PG interval · 详设 §4.2)
  timeout_overrides: Partial<Record<OpClass, TimeoutSpec>>;
  shadow_mode?: unknown; // {enabled, days_remaining, pass_threshold} | boolean · 详见 feat-056 §4.4(#78 用)
  audit_severity?: 'info' | 'medium' | 'high';
};

export type PolicyConfig = {
  schema_version?: number;
  projects: Record<string, ProjectPolicy>; // key = Neon project_id
  defaults: { autonomy_level: AutonomyLevel; shadow_mode?: boolean };
};

export type ResolvedPolicy = {
  project_id: string;
  autonomy_level: AutonomyLevel;
  overrides: Record<string, AutonomyLevel>;
  // feat-030/#79: per-project timeout 覆盖 (空 = 用 DEFAULT_TIMEOUTS · 见 timeout-injection.ts)
  timeout_overrides: Partial<Record<OpClass, TimeoutSpec>>;
  shadow_mode?: unknown;
  source: 'configured' | 'defaults';
};

// 文件缺失/损坏时的最保守地板(L1 只读)
const FALLBACK_DEFAULTS: PolicyConfig['defaults'] = {
  autonomy_level: 'L1',
  shadow_mode: true,
};

// in-memory current policy · 热重载原子 swap(JS 单线程 · 引用赋值原子 · in-flight 读旧)
let current: PolicyConfig = { projects: {}, defaults: FALLBACK_DEFAULTS };
let loaded = false;

function isAutonomyLevel(v: unknown): v is AutonomyLevel {
  return typeof v === 'string' && VALID_LEVELS.has(v);
}

function stricter(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return LEVEL_ORDER.indexOf(a) <= LEVEL_ORDER.indexOf(b) ? a : b;
}

/**
 * 校验 + 规整 timeout_overrides (feat-030/#79 · 详设 §4.2)。
 *
 * key = op-class 名 (不校验枚举 · 未知 key 无害 · 永不匹配真实 op-class · forward-compat feat-028
 * 扩 taxonomy)。value 的 lock_timeout 必给且必须是合法 PG interval (防 SQL 注入 · 注入走字符串拼接)
 * · statement_timeout 可省 · 给则同样校验。非法 → 抛错 (调用方 fail-safe · 绝不 fail-open)。
 */
function validateTimeoutOverrides(
  pid: string,
  raw: unknown,
): Partial<Record<OpClass, TimeoutSpec>> {
  const result: Partial<Record<OpClass, TimeoutSpec>> = {};
  const ovRaw = (raw ?? {}) as Record<string, unknown>;
  for (const [opClass, specRaw] of Object.entries(ovRaw)) {
    const spec = (specRaw ?? {}) as Record<string, unknown>;
    if (!isValidPgTimeoutValue(spec.lock_timeout)) {
      throw new Error(
        `project ${pid} timeout_overrides "${opClass}" 的 lock_timeout 非法 (须合法 PG interval): ${String(spec.lock_timeout)}`,
      );
    }
    const out: TimeoutSpec = { lock_timeout: spec.lock_timeout };
    if (spec.statement_timeout !== undefined) {
      if (!isValidPgTimeoutValue(spec.statement_timeout)) {
        throw new Error(
          `project ${pid} timeout_overrides "${opClass}" 的 statement_timeout 非法 (须合法 PG interval): ${String(spec.statement_timeout)}`,
        );
      }
      out.statement_timeout = spec.statement_timeout;
    }
    result[opClass as OpClass] = out;
  }
  return result;
}

/** 校验 + 规整 js-yaml load 结果 → PolicyConfig · 非法抛错(调用方 fail-safe) */
export function validate(raw: unknown): PolicyConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('policy.yaml 顶层不是 object');
  }
  const r = raw as Record<string, unknown>;
  const defaultsRaw = (r.defaults ?? {}) as Record<string, unknown>;
  const defaults: PolicyConfig['defaults'] = {
    autonomy_level: isAutonomyLevel(defaultsRaw.autonomy_level)
      ? defaultsRaw.autonomy_level
      : 'L1',
    shadow_mode:
      typeof defaultsRaw.shadow_mode === 'boolean'
        ? defaultsRaw.shadow_mode
        : true,
  };
  const projects: Record<string, ProjectPolicy> = {};
  const projectsRaw = (r.projects ?? {}) as Record<string, unknown>;
  for (const [pid, pRaw] of Object.entries(projectsRaw)) {
    const p = (pRaw ?? {}) as Record<string, unknown>;
    if (!isAutonomyLevel(p.autonomy_level)) {
      throw new Error(
        `project ${pid} 的 autonomy_level 非法: ${String(p.autonomy_level)}`,
      );
    }
    const overrides: Record<string, AutonomyLevel> = {};
    const ovRaw = (p.overrides ?? {}) as Record<string, unknown>;
    for (const [pat, lvl] of Object.entries(ovRaw)) {
      if (!isAutonomyLevel(lvl)) {
        throw new Error(`project ${pid} override "${pat}" 的 level 非法`);
      }
      overrides[pat] = lvl;
    }
    projects[pid] = {
      display_name:
        typeof p.display_name === 'string' ? p.display_name : undefined,
      autonomy_level: p.autonomy_level,
      overrides,
      timeout_overrides: validateTimeoutOverrides(pid, p.timeout_overrides),
      shadow_mode: p.shadow_mode,
      audit_severity: p.audit_severity as ProjectPolicy['audit_severity'],
    };
  }
  return {
    schema_version:
      typeof r.schema_version === 'number' ? r.schema_version : undefined,
    projects,
    defaults,
  };
}

function loadFromFile(): PolicyConfig {
  if (!existsSync(POLICY_PATH)) {
    throw new Error(`policy.yaml 不存在: ${POLICY_PATH}`);
  }
  return validate(load(readFileSync(POLICY_PATH, 'utf8')));
}

/**
 * (重新)加载 policy 到内存 · fail-safe:
 * - 启动缺/坏 → 落 FALLBACK_DEFAULTS(L1 · 不 crash · loud alert)
 * - 热重载坏 → 保 last-good in-memory(不应用坏 config · alert) · **绝不 fail-open**
 */
export function loadPolicy(): boolean {
  try {
    current = loadFromFile(); // 原子 swap
    logger.info('policy loaded', {
      projects: Object.keys(current.projects).length,
      defaultLevel: current.defaults.autonomy_level,
    });
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    if (Object.keys(current.projects).length > 0) {
      logger.warn(
        'policy reload 失败 · 保留 last-good (fail-safe · 不 fail-open)',
        {
          err: msg,
        },
      );
    } else {
      current = { projects: {}, defaults: FALLBACK_DEFAULTS };
      logger.warn(
        'policy 启动加载失败 · 落 L1 defaults (fail-safe · 不 fail-open)',
        {
          err: msg,
        },
      );
    }
    return false;
  }
}

let watchTimer: NodeJS.Timeout | undefined;
function startPolicyWatcher(): void {
  if (!existsSync(POLICY_PATH)) return;
  try {
    watch(POLICY_PATH, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => loadPolicy(), 200); // debounce 200ms
    });
  } catch (err) {
    logger.warn('policy watcher 启动失败 (非致命)', {
      err: (err as Error).message,
    });
  }
}

/** 首次使用时懒加载 + 启动热重载 watcher(避免 module import side-effect) */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  loadPolicy();
  startPolicyWatcher();
}

/** resolvePolicy(project_id) → 该 project 有效策略 · 未配置 → defaults(L1) */
export function resolvePolicy(projectId?: string): ResolvedPolicy {
  ensureLoaded();
  const p = projectId ? current.projects[projectId] : undefined;
  if (p) {
    return {
      project_id: projectId as string,
      autonomy_level: p.autonomy_level,
      overrides: p.overrides,
      timeout_overrides: p.timeout_overrides,
      shadow_mode: p.shadow_mode,
      source: 'configured',
    };
  }
  return {
    project_id: projectId ?? '(unknown)',
    autonomy_level: current.defaults.autonomy_level,
    overrides: {},
    timeout_overrides: {},
    shadow_mode: current.defaults.shadow_mode,
    source: 'defaults',
  };
}

/**
 * 应用 SQL-pattern override → effective autonomy_level。匹配某 override pattern 则取**更严**的 level。
 * day-one: glob(`*`→`.*`) regex 搜索 SQL · feat-028 升级 PG parser 精确匹配。
 */
export function applyOverrides(
  sql: string | undefined,
  resolved: ResolvedPolicy,
): AutonomyLevel {
  if (!sql) return resolved.autonomy_level;
  let effective = resolved.autonomy_level;
  for (const [pattern, lvl] of Object.entries(resolved.overrides)) {
    const regexSrc = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    if (new RegExp(regexSrc, 'i').test(sql)) {
      effective = stricter(effective, lvl);
    }
  }
  return effective;
}

/** 测试用: 直接注入 in-memory policy(绕过文件 · 测 resolvePolicy/override/matrix) */
export function __setPolicyForTest(config: PolicyConfig): void {
  current = config;
  loaded = true;
}
