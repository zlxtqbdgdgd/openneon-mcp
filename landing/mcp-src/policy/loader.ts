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
import {
  CONFIG_BOUNDS,
  DEFAULT_RATE_COUNTER_CONFIG,
  type RateCounterConfig,
} from './rate-limiter';

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
  // feat-059/#1: per-project agent 角色 (tools/list 软过滤 default · per-key 优先兜底 · OQ1)
  agent_role?: string;
  shadow_mode?: unknown; // {enabled, days_remaining, pass_threshold} | boolean · 详见 feat-056 §4.4(#78 用)
  audit_severity?: 'info' | 'medium' | 'high';
  // feat-055/#1: per-project G9 rate counter (已 clamp 到 CONFIG_BOUNDS · undefined = 用 day-one defaults)
  rate_counter?: RateCounterConfig;
  // feat-060/#1 (#129): 本 project 接受的 authService 名列表 (未配 = 该 project 不走 feat-060 路径 ·
  // 向后兼容 feat-029-only 部署)。authService 详细配置在顶层 authServices 字典。
  authServices?: string[];
};

// feat-060/#1 (#129): per-call JWT 验证用的 OIDC authService 配置 · top-level 字典 · 多 project 共享。
// 设计: features/feat-060-L2-mcp-server-claim-binding.html §4.1。
export type AuthServiceConfig = {
  /** authService 名 (e.g. "saas-app-oidc") · 引用其他 project policy 的 authServices 名同 */
  name: string;
  /** OIDC issuer URL (e.g. "https://auth.saas-app.com") · 用于 JWT.iss 校验 */
  issuer: string;
  /** JWKS endpoint URL · 拉公钥用 (e.g. "https://auth.saas-app.com/.well-known/jwks.json") */
  jwks_url: string;
  /** JWT audience claim · mcp server 自身标识 (e.g. "openneon-mcp") · 防 token 重放到其他 audience */
  audience: string;
  /** JWKS 缓存 TTL 秒 · 默认 600 (10 min) · fail-closed: 过期后 JWKS 不可达 → 拒签 (不 stale 兜底) */
  jwks_cache_ttl_seconds: number;
};

export type PolicyConfig = {
  schema_version?: number;
  projects: Record<string, ProjectPolicy>; // key = Neon project_id
  defaults: { autonomy_level: AutonomyLevel; shadow_mode?: boolean };
  // feat-060/#1 (#129): 顶层 authService 配置字典 · key = authService 名 (project policy 的 authServices 数组引用此 key)
  authServices: Record<string, AuthServiceConfig>;
};

export type ResolvedPolicy = {
  project_id: string;
  autonomy_level: AutonomyLevel;
  overrides: Record<string, AutonomyLevel>;
  // feat-030/#79: per-project timeout 覆盖 (空 = 用 DEFAULT_TIMEOUTS · 见 timeout-injection.ts)
  timeout_overrides: Partial<Record<OpClass, TimeoutSpec>>;
  // feat-059/#1: per-project agent_role (undefined = 未配 · tools/list 不做 role 软过滤)
  agent_role?: string;
  shadow_mode?: unknown;
  // feat-055/#1: per-project G9 rate counter (恒有值 · 未配 project 落 DEFAULT_RATE_COUNTER_CONFIG)
  rate_counter: RateCounterConfig;
  source: 'configured' | 'defaults';
};

// 文件缺失/损坏时的最保守地板(L1 只读)
const FALLBACK_DEFAULTS: PolicyConfig['defaults'] = {
  autonomy_level: 'L1',
  shadow_mode: true,
};

// feat-060/#1 (#129): JWKS cache TTL 上下界 (clamp · 防 prompt injection 写 ttl=0 关掉 cache 或写很大数禁掉过期)
const JWKS_TTL_BOUNDS = { min: 60, max: 86400 }; // 1 min ~ 24h
const DEFAULT_JWKS_TTL_SECONDS = 600; // 10 min · per 详设 §4.1

// in-memory current policy · 热重载原子 swap(JS 单线程 · 引用赋值原子 · in-flight 读旧)
let current: PolicyConfig = {
  projects: {},
  defaults: FALLBACK_DEFAULTS,
  authServices: {},
};
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

/** clamp 一个数到 [min, max] · 越界返回 clamp 后值 + 标记 (给 warn log 用) */
function clampNumber(
  value: number,
  bounds: { min: number; max: number },
): { value: number; clamped: boolean } {
  if (value < bounds.min) return { value: bounds.min, clamped: true };
  if (value > bounds.max) return { value: bounds.max, clamped: true };
  return { value, clamped: false };
}

/**
 * 校验 + clamp rate_counter (feat-055/#1 · §3.3 + CONFIG_BOUNDS)。
 *
 * **ADR-0007 内涵延伸**: window_ms / max_units / warn_ratio / weights[op] 用户可调 · 但都有
 * 编译期上下界 (CONFIG_BOUNDS)· 越界 → clamp + warn log。防 prompt injection 写文件改
 * max_units=999999 把 G9 关掉。缺段 / 非数 → 落 DEFAULT_RATE_COUNTER_CONFIG (不报错 · §4.5 兼容)。
 */
function validateRateCounter(pid: string, raw: unknown): RateCounterConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_RATE_COUNTER_CONFIG };
  }
  const rc = raw as Record<string, unknown>;
  const result: RateCounterConfig = { ...DEFAULT_RATE_COUNTER_CONFIG };

  if (typeof rc.window_ms === 'number') {
    const c = clampNumber(rc.window_ms, CONFIG_BOUNDS.windowMs);
    if (c.clamped)
      logger.warn(
        `project ${pid} rate_counter.window_ms=${rc.window_ms} 越界 · clamp 到 ${c.value} (CONFIG_BOUNDS · ADR-0007)`,
      );
    result.windowMs = c.value;
  }
  if (typeof rc.max_units === 'number') {
    const c = clampNumber(rc.max_units, CONFIG_BOUNDS.maxUnits);
    if (c.clamped)
      logger.warn(
        `project ${pid} rate_counter.max_units=${rc.max_units} 越界 · clamp 到 ${c.value} (CONFIG_BOUNDS · ADR-0007)`,
      );
    result.maxUnits = c.value;
  }
  if (typeof rc.warn_ratio === 'number') {
    const c = clampNumber(rc.warn_ratio, CONFIG_BOUNDS.warnRatio);
    if (c.clamped)
      logger.warn(
        `project ${pid} rate_counter.warn_ratio=${rc.warn_ratio} 越界 · clamp 到 ${c.value} (CONFIG_BOUNDS · ADR-0007)`,
      );
    result.warnRatio = c.value;
  }
  if (rc.weights && typeof rc.weights === 'object') {
    const weights: Partial<Record<OpClass, number>> = {};
    for (const [op, wRaw] of Object.entries(
      rc.weights as Record<string, unknown>,
    )) {
      if (typeof wRaw !== 'number') continue; // 非数忽略 (forward-compat · 不报错)
      const c = clampNumber(wRaw, CONFIG_BOUNDS.weight);
      if (c.clamped)
        logger.warn(
          `project ${pid} rate_counter.weights.${op}=${wRaw} 越界 · clamp 到 ${c.value} (CONFIG_BOUNDS · ADR-0007)`,
        );
      // op-class 名不强校验枚举 (未知 key 无害 · 永不匹配真实 op-class · 同 timeout_overrides 风格)
      weights[op as OpClass] = c.value;
    }
    if (Object.keys(weights).length > 0) result.weights = weights;
  }
  return result;
}

/**
 * 校验 + 规整 authServices 顶层段 (feat-060/#1 · 详设 §4.1)。
 *
 * 缺段 / 非 object → 返空字典 (向后兼容 · feat-029-only 部署不需要 authServices)。
 * 每条 authService 必须含 issuer / jwks_url / audience (string · 非空) · jwks_cache_ttl_seconds
 * 可省 (默认 600s · clamp 到 [60, 86400])。
 * 任一字段非法 → throw (调用方 fail-safe · 不 fail-open · 跟 timeout_overrides 同风格)。
 */
function validateAuthServices(
  raw: unknown,
): Record<string, AuthServiceConfig> {
  if (!raw || typeof raw !== 'object') return {};
  const result: Record<string, AuthServiceConfig> = {};
  for (const [name, svcRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!svcRaw || typeof svcRaw !== 'object') {
      throw new Error(`authServices "${name}" 不是 object`);
    }
    const svc = svcRaw as Record<string, unknown>;
    if (typeof svc.issuer !== 'string' || svc.issuer.length === 0) {
      throw new Error(`authServices "${name}" 的 issuer 非法 (必须非空 string)`);
    }
    if (typeof svc.jwks_url !== 'string' || svc.jwks_url.length === 0) {
      throw new Error(`authServices "${name}" 的 jwks_url 非法 (必须非空 string)`);
    }
    if (typeof svc.audience !== 'string' || svc.audience.length === 0) {
      throw new Error(`authServices "${name}" 的 audience 非法 (必须非空 string)`);
    }
    let ttl = DEFAULT_JWKS_TTL_SECONDS;
    if (svc.jwks_cache_ttl_seconds !== undefined) {
      if (typeof svc.jwks_cache_ttl_seconds !== 'number') {
        throw new Error(
          `authServices "${name}" 的 jwks_cache_ttl_seconds 非法 (须 number)`,
        );
      }
      const c = clampNumber(svc.jwks_cache_ttl_seconds, JWKS_TTL_BOUNDS);
      if (c.clamped) {
        logger.warn(
          `authServices "${name}" jwks_cache_ttl_seconds=${svc.jwks_cache_ttl_seconds} 越界 · clamp 到 ${c.value} (JWKS_TTL_BOUNDS · ADR-0007)`,
        );
      }
      ttl = c.value;
    }
    result[name] = {
      name,
      issuer: svc.issuer,
      jwks_url: svc.jwks_url,
      audience: svc.audience,
      jwks_cache_ttl_seconds: ttl,
    };
  }
  return result;
}

/**
 * 校验 project policy 的 authServices 字段 (feat-060/#1 · 详设 §4.1)。
 *
 * 缺段 → undefined (该 project 不走 feat-060 路径 · 向后兼容 feat-029-only)。
 * 非数组 / 元素非 string → throw (调用方 fail-safe)。
 * 已知未引用顶层 authServices · 此时不强校验存在 (验证延后到 verify 时 · 防 ordering 依赖)。
 */
function validateProjectAuthServices(
  pid: string,
  raw: unknown,
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`project ${pid} authServices 非法 (须 string 数组)`);
  }
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error(`project ${pid} authServices 数组元素非法 (须非空 string)`);
    }
  }
  return [...raw];
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
      // feat-059/#1: agent_role 不强校验枚举 (未知 role → 软过滤 no-op · forward-compat 自定义 role OQ4)
      agent_role: typeof p.agent_role === 'string' ? p.agent_role : undefined,
      shadow_mode: p.shadow_mode,
      audit_severity: p.audit_severity as ProjectPolicy['audit_severity'],
      // feat-055/#1: per-project G9 rate counter · clamp 到 CONFIG_BOUNDS (越界 warn + use clamped)
      rate_counter: validateRateCounter(pid, p.rate_counter),
      // feat-060/#1 (#129): per-project authServices 引用列表 (undefined = 未配 · 该 project 不走 feat-060)
      authServices: validateProjectAuthServices(pid, p.authServices),
    };
  }
  return {
    schema_version:
      typeof r.schema_version === 'number' ? r.schema_version : undefined,
    projects,
    defaults,
    // feat-060/#1 (#129): 顶层 authServices 字典 (缺 = 空字典 · 向后兼容)
    authServices: validateAuthServices(r.authServices),
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
      current = {
        projects: {},
        defaults: FALLBACK_DEFAULTS,
        authServices: {},
      };
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
      agent_role: p.agent_role,
      shadow_mode: p.shadow_mode,
      // feat-055/#1: 已 clamp 的 per-project rate counter (validate 时落了 defaults 兜底 · 恒有值)
      rate_counter: p.rate_counter ?? { ...DEFAULT_RATE_COUNTER_CONFIG },
      source: 'configured',
    };
  }
  return {
    project_id: projectId ?? '(unknown)',
    autonomy_level: current.defaults.autonomy_level,
    overrides: {},
    timeout_overrides: {},
    shadow_mode: current.defaults.shadow_mode,
    // feat-055/#1: 未配 project → day-one defaults (5/5min/0.8 · §4.5 兼容)
    rate_counter: { ...DEFAULT_RATE_COUNTER_CONFIG },
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

/**
 * feat-060/#1 (#129): 拉某 authService 的完整配置 · 给 jwks-cache / jwt-verify 用。
 * 未配置(name 不在 policy.yaml authServices 字典里) → 返 undefined · 调用方负责
 * 翻译为 deny_missing outcome (per 详设 §4 4-outcome 矩阵)。
 */
export function getAuthService(
  name: string,
): AuthServiceConfig | undefined {
  ensureLoaded();
  return current.authServices[name];
}

/**
 * feat-060/#1 (#129): 拉某 project 接受哪些 authService 名 · 给 claim-binding middleware 用。
 * 未配置(project 没 authServices 字段) → 返空数组 (该 project 不走 feat-060 路径 ·
 * 向后兼容 feat-029-only 部署 · 调用方不会 invoke verify · tool 该走啥走啥)。
 */
export function getProjectAuthServices(projectId: string): string[] {
  ensureLoaded();
  const p = current.projects[projectId];
  return p?.authServices ? [...p.authServices] : [];
}
