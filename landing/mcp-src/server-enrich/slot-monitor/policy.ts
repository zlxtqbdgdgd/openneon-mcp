/**
 * policy.ts · feat-043/#3 · per-endpoint slot_monitor 策略加载 + 阈值解析
 *
 * 设计依据: design#53 §3.5 policy.yaml per-endpoint 配置。
 *
 * policy.yaml 结构 (顶层 `slot_monitor` block · 跟 feat-016/017/018/038 既有 yaml 共存):
 * ```yaml
 * slot_monitor:
 *   warn_inactive_seconds: 86400      # 24h 全局默认 (Q4B 拍板)
 *   critical_inactive_seconds: 129600 # 36h 全局默认 (Q4B 拍板)
 *   cron_interval_seconds: 3600       # 1h (Q4A 拍板)
 *   disabled_endpoints: []            # endpoint_id 列表 · 跳过 alerts
 *   endpoint_overrides:
 *     <endpoint_id>:
 *       warn_inactive_seconds: <s>
 *       critical_inactive_seconds: <s>
 * ```
 *
 * **fail-safe defaults** (跟 policy/loader.ts 同 pattern): 文件缺失 / 字段缺失 → 全局默认 24h/36h
 * 兜底 · 不 throw · cron 永远跑 (degrade 优于 fail · §11)。
 *
 * **clamp**: warn_inactive_seconds < critical_inactive_seconds (强约束 · 反着配等于关 warn ·
 * 显式 reject 比静默 swap 安全 · throw 在 resolve 阶段 · cron loop 已 fail-safe catch)。
 */

/** 全局默认 (Q4B 拍板 · 24h warn / 36h critical) */
export const SLOT_MONITOR_DEFAULTS = {
  warn_inactive_seconds: 86400,
  critical_inactive_seconds: 129600,
  cron_interval_seconds: 3600,
} as const;

export type SlotMonitorEndpointOverride = {
  warn_inactive_seconds: number;
  critical_inactive_seconds: number;
};

export type SlotMonitorPolicy = {
  warn_inactive_seconds: number;
  critical_inactive_seconds: number;
  cron_interval_seconds: number;
  disabled_endpoints: string[];
  endpoint_overrides: Record<string, SlotMonitorEndpointOverride>;
};

/** policy.yaml 原始 `slot_monitor` block (loader 返回 unknown · 在此 narrow) */
export type SlotMonitorPolicyInput = {
  warn_inactive_seconds?: unknown;
  critical_inactive_seconds?: unknown;
  cron_interval_seconds?: unknown;
  disabled_endpoints?: unknown;
  endpoint_overrides?: unknown;
};

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return fallback;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

function parseEndpointOverride(
  raw: unknown,
  globalWarn: number,
  globalCritical: number,
): SlotMonitorEndpointOverride {
  if (raw == null || typeof raw !== 'object') {
    return {
      warn_inactive_seconds: globalWarn,
      critical_inactive_seconds: globalCritical,
    };
  }
  const r = raw as Record<string, unknown>;
  const warn = toPositiveInt(r.warn_inactive_seconds, globalWarn);
  const critical = toPositiveInt(r.critical_inactive_seconds, globalCritical);
  if (warn >= critical) {
    throw new Error(
      `[slot-monitor policy] override invalid: warn_inactive_seconds (${warn}) must be < critical_inactive_seconds (${critical})`,
    );
  }
  return {
    warn_inactive_seconds: warn,
    critical_inactive_seconds: critical,
  };
}

/**
 * 把 raw `slot_monitor` block (来自 yaml loader) 规范化为 SlotMonitorPolicy。
 *
 * fail-safe: 字段缺失 / 类型错 → 用 SLOT_MONITOR_DEFAULTS 兜底 · 仅 endpoint_overrides 内部
 * warn >= critical 才 throw (反着配是 fatal · 不能静默 swap)。
 */
export function resolveSlotMonitorPolicy(
  raw: SlotMonitorPolicyInput | null | undefined,
): SlotMonitorPolicy {
  const warn = toPositiveInt(
    raw?.warn_inactive_seconds,
    SLOT_MONITOR_DEFAULTS.warn_inactive_seconds,
  );
  const critical = toPositiveInt(
    raw?.critical_inactive_seconds,
    SLOT_MONITOR_DEFAULTS.critical_inactive_seconds,
  );
  if (warn >= critical) {
    throw new Error(
      `[slot-monitor policy] global invalid: warn_inactive_seconds (${warn}) must be < critical_inactive_seconds (${critical})`,
    );
  }
  const cronInterval = toPositiveInt(
    raw?.cron_interval_seconds,
    SLOT_MONITOR_DEFAULTS.cron_interval_seconds,
  );
  const disabled = toStringArray(raw?.disabled_endpoints);
  const overridesRaw =
    raw?.endpoint_overrides && typeof raw.endpoint_overrides === 'object'
      ? (raw.endpoint_overrides as Record<string, unknown>)
      : {};
  const overrides: Record<string, SlotMonitorEndpointOverride> = {};
  for (const [endpointId, val] of Object.entries(overridesRaw)) {
    overrides[endpointId] = parseEndpointOverride(val, warn, critical);
  }
  return {
    warn_inactive_seconds: warn,
    critical_inactive_seconds: critical,
    cron_interval_seconds: cronInterval,
    disabled_endpoints: disabled,
    endpoint_overrides: overrides,
  };
}

/**
 * 查 endpoint 的有效阈值 · per-endpoint override 优先 · fallback 全局。
 *
 * 注意: 这里**不**处理 disabled_endpoints (caller 在 cron 跨 endpoint 循环时 filter ·
 * disabled = 整个 endpoint 跳过 query · 比"查了再 skip emit"省 1 次 PG round-trip)。
 */
export function effectiveThresholdsFor(
  endpointId: string,
  policy: SlotMonitorPolicy,
): { warn_inactive_seconds: number; critical_inactive_seconds: number } {
  const override = policy.endpoint_overrides[endpointId];
  if (override) return override;
  return {
    warn_inactive_seconds: policy.warn_inactive_seconds,
    critical_inactive_seconds: policy.critical_inactive_seconds,
  };
}
