/**
 * rate-limiter.ts · G9 destructive ops 速率计数 (feat-055/#1 · ADR-0007 hard-deny 第 3 层)
 *
 * **架构边界 (ADR-0007)**: 本模块只是 *rate counter*——维护 per-project 滑窗加权计数 ·
 * 返结构化 Verdict (OK / WARN / EXCEEDED) 给 feat-056 pipeline 的 G9 stage。**counter 不拥有 deny
 * 决策**: G9 stage 把 EXCEEDED 翻译成 `Verdict { action:'deny', terminal:true }`。本模块只负责:
 *   1. per-project 滑窗加权计数 (Map<projectId, HitEntry[]>)
 *   2. 三档判定 OK / WARN(达 warn_ratio) / EXCEEDED(超 max_units)
 *   3. WARN / EXCEEDED 两个 audit event 内部 emit (near-pure stage 原则 · audit 是只写副作用)
 *
 * day-one (feat-056/#3 · 51 LOC) 是 flat global counter + 固定 5/5min。本 feature (L2b) 升级到
 * 商用对齐: per-project 隔离 + per-OpClass 加权 + warn/exceeded 双档 + policy.yaml 可调 (CONFIG_BOUNDS
 * clamp · 防 prompt injection 写 max_units=999999 关掉 G9 · ADR-0007 内涵延伸)。
 *
 * 注:单进程 in-memory (够 L2b)· 多实例需共享存储 (Redis 等 · 后续)。任何 autonomy_level 不可禁 (hard-deny)。
 */
import type { OpClass } from '../protection/destructive-detector';
import { emitAuditEvent } from '../observability/audit-emit';

// ──────────────────────────────────────────────────────────────
// 默认值 (day-one 同口径 · policy.yaml 缺 rate_counter 段时回落到这些)
// ──────────────────────────────────────────────────────────────
const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 分钟滑窗
const DEFAULT_MAX_UNITS = 5; // 窗内加权上限
const DEFAULT_WARN_RATIO = 0.8; // 达 80% (4/5) 触发 WARN

/**
 * 计入速率的 destructive op-class (删/改类 · CREATE INDEX / ADD COLUMN / 只读 / 分支 不计)。
 * day-one 集合保持不动。
 */
const RATE_LIMITED_OPS: ReadonlySet<OpClass> = new Set<OpClass>([
  'DROP_TABLE_OR_INDEX',
  'DROP_REPLICATION_SLOT',
  'DELETE_UPDATE_BULK',
  'ALTER_TABLE_BIG_LOCK',
  // feat-028/#109 长锁 (ACCESS EXCLUSIVE LOCK · 阻 SELECT · 跟其他写一样计速率)
  'VACUUM_FULL_LOCK',
  'CLUSTER_LOCK',
  // 以下虽被 G4 hard-deny 先拦 (走不到 G9)· 列出保持语义完整 + defense-in-depth
  'DROP_DATABASE_OR_TRUNCATE',
  'DROP_USER_OR_REVOKE',
]);

/**
 * DEFAULT_WEIGHTS · 编译期常量 (跟 G4 hard-deny 同等地位 · §4.2)。
 * OpClass → 加权单位。policy.yaml `weights` 可 per-op 覆盖 (loader clamp [1,10])。
 * 未列出的 op-class 缺省权重 1 (见 weightOf)。
 */
export const DEFAULT_WEIGHTS: Readonly<Partial<Record<OpClass, number>>> = {
  DROP_TABLE_OR_INDEX: 1, //       基准 (DROP IF EXISTS · 误删可重建 schema)
  DROP_REPLICATION_SLOT: 1, //     同上 · 下游有外部 consumer 时影响中等
  DELETE_UPDATE_BULK: 1, //        行级 (非 schema)· 量大时跟 schema 同等
  ALTER_TABLE_BIG_LOCK: 1, //      DDL 长锁 · 影响可用性但不毁数据
  VACUUM_FULL_LOCK: 2, //          feat-028 · 整表 ACCESS EXCLUSIVE LOCK · 长时间阻 SELECT
  CLUSTER_LOCK: 2, //              同上
  DROP_DATABASE_OR_TRUNCATE: 5, // 整库/整表无回滚 · G4 先拦 · 列出保持语义完整 (defense in depth)
  DROP_USER_OR_REVOKE: 5, //       权限毁伤 · G4 先拦 · 同上
};

/**
 * CONFIG_BOUNDS · 配置上下界 (编译期常量 · 不可禁用 · ADR-0007)。
 * loader.ts 加载 policy.yaml 时 clamp 用户值到这区间 (越界 → clamp + warn log)。
 * 防 prompt injection 写文件改 max_units=999999 把 G9 关掉。
 */
export const CONFIG_BOUNDS = {
  windowMs: { min: 60_000, max: 3_600_000 }, //   1 min .. 1 hour
  maxUnits: { min: 1, max: 100 },
  warnRatio: { min: 0.5, max: 0.95 },
  weight: { min: 1, max: 10 },
} as const;

// ──────────────────────────────────────────────────────────────
// schema (§4.1 / §4.2 / §4.3)
// ──────────────────────────────────────────────────────────────

/** per-project 配置 (由 feat-056 loader.ts clamp 后传入 · 本模块不读文件) */
export interface RateCounterConfig {
  windowMs: number; //  滑窗长度 · loader clamp [60_000, 3_600_000]
  maxUnits: number; //  加权单位上限 · loader clamp [1, 100]
  warnRatio: number; // warn 阈值比 · loader clamp [0.5, 0.95]
  /** 覆盖默认权重 · 每条 loader clamp [1, 10] · 缺省回落 DEFAULT_WEIGHTS */
  weights?: Partial<Record<OpClass, number>>;
}

/** 滑窗里的一次 hit */
interface HitEntry {
  ts: number; //        时间戳 ms
  weight: number; //    该 op 的加权
  opClass: OpClass; //  留给 audit 详情
}

export type RateOutcome = 'OK' | 'WARN' | 'EXCEEDED';

/** feat-055 → feat-056 G9 stage 的输出 (数据 · 非 deny 决策) */
export interface RateCounterVerdict {
  outcome: RateOutcome;
  weightedCount: number; //    含当前这次 op 后的窗内加权总和
  maxUnits: number; //         当前 config 上限 (给 audit)
  windowMs: number; //         当前 config 窗 (给 audit)
  warnedThreshold: number; //  = maxUnits * warnRatio (给 audit)
  recentOps: ReadonlyArray<OpClass>; // 窗内全部 hit 的 opClass (EXCEEDED 详情 + debug)
}

/** day-one 默认配置 (policy.yaml 无 rate_counter 段时由调用方传这个) */
export const DEFAULT_RATE_COUNTER_CONFIG: Readonly<RateCounterConfig> = {
  windowMs: DEFAULT_WINDOW_MS,
  maxUnits: DEFAULT_MAX_UNITS,
  warnRatio: DEFAULT_WARN_RATIO,
};

// ──────────────────────────────────────────────────────────────
// state · per-project Map<projectId, HitEntry[]>
// ──────────────────────────────────────────────────────────────
const hits = new Map<string, HitEntry[]>();

/**
 * memory leak protection (同 feat-026 confirm-token-store TTL evict 模式)。
 *
 * 滑窗每次 record 都会过滤掉本 project 的过期 hit · 但**从不再被 record 的 project** (grant 撤销 /
 * agent 停了) 会留下永久旧数组。周期性扫全 Map · 删掉所有 hit 都过期的 project entry。
 * 用最大窗上界 (CONFIG_BOUNDS.windowMs.max = 1h) 当过期判据 · 保证不误删活跃 project。
 */
const SWEEP_INTERVAL_MS = CONFIG_BOUNDS.windowMs.max; // 1 小时扫一次
let sweepTimer: NodeJS.Timeout | undefined;

function sweepExpired(now: number): void {
  const maxWindow = CONFIG_BOUNDS.windowMs.max;
  for (const [key, arr] of hits) {
    // 该 project 全部 hit 都超过了最大可能窗 → 不可能再被任何 config 计入 · 整 entry 删
    if (arr.length === 0 || arr.every((h) => now - h.ts >= maxWindow)) {
      hits.delete(key);
    }
  }
}

function ensureSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweepExpired(Date.now()), SWEEP_INTERVAL_MS);
  // 不阻止进程退出 (后台清理 · 同 confirm-token-store 风格)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

// ──────────────────────────────────────────────────────────────
// public API (§4.4 · 扩展 day-one · 保留 isRateLimitedOp / recordAndCheckRateLimit / RATE_LIMIT_CONFIG 名)
// ──────────────────────────────────────────────────────────────

export function isRateLimitedOp(opClass: OpClass): boolean {
  return RATE_LIMITED_OPS.has(opClass);
}

/** 取某 op 的加权:config.weights 覆盖 > DEFAULT_WEIGHTS > 缺省 1 */
function weightOf(opClass: OpClass, config: RateCounterConfig): number {
  const override = config.weights?.[opClass];
  if (typeof override === 'number') return override;
  const dflt = DEFAULT_WEIGHTS[opClass];
  return typeof dflt === 'number' ? dflt : 1;
}

/**
 * 记一次 destructive op 并返回结构化 Verdict (滑窗加权 · 三档判定)。
 *
 * **breaking change vs day-one**: 由 `(key, now) => boolean` 升级为结构化入参 + Verdict。
 * 唯一调用方是 feat-056 pipeline.ts G9 stage (同 PR 一起改)。
 *
 * WARN / EXCEEDED 两路在本函数内部 emit audit (near-pure · audit 是只写副作用 · ADR-0007 不冲突)。
 * deny 决策不在这里——G9 stage 把 EXCEEDED 翻译成 terminal deny Verdict。
 */
export function recordAndCheckRateLimit(args: {
  projectId: string;
  opClass: OpClass;
  config: RateCounterConfig;
  now?: number;
}): RateCounterVerdict {
  ensureSweeper();
  const { projectId, opClass, config } = args;
  const now = args.now ?? Date.now();

  // 1-4. 取窗 + 过滤过期 + 新增本次 hit (sliding window · ts > now - windowMs 才保留)
  const prior = (hits.get(projectId) ?? []).filter(
    (h) => now - h.ts < config.windowMs,
  );
  prior.push({ ts: now, weight: weightOf(opClass, config), opClass });
  hits.set(projectId, prior);

  // 5. 求和
  const weightedCount = prior.reduce((s, h) => s + h.weight, 0);
  const warnedThreshold = config.maxUnits * config.warnRatio;
  const recentOps = prior.map((h) => h.opClass);

  // 6-7. 判定 (EXCEEDED > WARN > OK · 顺序敏感)
  let outcome: RateOutcome;
  if (weightedCount > config.maxUnits) {
    outcome = 'EXCEEDED';
  } else if (weightedCount >= warnedThreshold) {
    outcome = 'WARN';
  } else {
    outcome = 'OK';
  }

  const verdict: RateCounterVerdict = {
    outcome,
    weightedCount,
    maxUnits: config.maxUnits,
    windowMs: config.windowMs,
    warnedThreshold,
    recentOps,
  };

  // audit emit (WARN medium · EXCEEDED high)· 不记录原始 SQL (audit-emit PII redact)
  if (outcome === 'WARN') {
    emitAuditEvent({
      event_type: 'g9_rate_limit_warned',
      outcome: 'allow', // WARN 不拦 · 仅信号
      severity: 'medium',
      op_class: opClass,
      project_id: projectId,
      extra: {
        'openneon.audit.weighted_count': weightedCount,
        'openneon.audit.max_units': config.maxUnits,
        'openneon.audit.window_ms': config.windowMs,
        'openneon.audit.current_op_class': opClass,
      },
    });
  } else if (outcome === 'EXCEEDED') {
    emitAuditEvent({
      event_type: 'g9_rate_limit_exceeded',
      outcome: 'deny', // EXCEEDED → feat-056 G9 stage 翻译成 hard-deny
      severity: 'high',
      op_class: opClass,
      project_id: projectId,
      extra: {
        'openneon.audit.weighted_count': weightedCount,
        'openneon.audit.max_units': config.maxUnits,
        'openneon.audit.window_ms': config.windowMs,
        'openneon.audit.current_op_class': opClass,
        'openneon.audit.recent_ops': recentOps.join(','),
      },
    });
  }

  return verdict;
}

/** 测试用: 清空全部 project 计数 */
export function __resetRateLimitForTest(): void {
  hits.clear();
}

/**
 * 兼容保留: day-one 暴露的常量 (RATE_LIMIT_CONFIG)。
 * 名保留 (issue acceptance criteria)· 值映射到新默认。
 */
export const RATE_LIMIT_CONFIG = {
  WINDOW_MS: DEFAULT_WINDOW_MS,
  MAX_DESTRUCTIVE: DEFAULT_MAX_UNITS,
  WARN_RATIO: DEFAULT_WARN_RATIO,
} as const;
