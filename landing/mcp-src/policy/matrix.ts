/**
 * matrix.ts · §8.1 操作类别 × L 级别 策略矩阵 (overview §8.1)
 *
 * lookupMatrix(opClass, level) → 该格的 MatrixCell。feat-056 pipeline 的 matrix stage 据此
 * 判 per-project verdict。hard-deny op-class (DROP DATABASE 等) 在矩阵也标 deny (冗余安全 ·
 * G4/G1 hard-deny stage 已先 terminal 拦 · 走不到 matrix)。
 *
 * #75: 'require_plan' 格由 matrix stage 在 feat-027 plan mode (#77) 实现**前** fail-closed
 * deny (没有审批机制就不放行写 · 保守);#77 后 plan stage 接管 elicitation 审批放行。
 */
import type { OpClass } from '../protection/destructive-detector';
import type { AutonomyLevel } from './pipeline';

// allow = 放行 · deny = 拒 (含 L1 human-only · 及 hard-deny 行冗余) · require_plan = 需审批 (gated)
export type MatrixCell = 'allow' | 'deny' | 'require_plan';

// 列顺序固定
const LEVELS: readonly AutonomyLevel[] = [
  'L1',
  'L2a',
  'L2b',
  'L3',
  'L4',
] as const;

// 行 = op-class · 列 = [L1, L2a, L2b, L3, L4] (overview §8.1 · 含 §4.5 补的 L1 列)
const MATRIX: Record<
  OpClass,
  readonly [MatrixCell, MatrixCell, MatrixCell, MatrixCell, MatrixCell]
> = {
  READ_ONLY: ['allow', 'allow', 'allow', 'allow', 'allow'],
  CREATE_OR_RESTORE_BRANCH: ['deny', 'allow', 'allow', 'allow', 'allow'],
  CREATE_INDEX_CONCURRENTLY: [
    'deny',
    'require_plan',
    'require_plan',
    'require_plan',
    'allow',
  ],
  DDL_ADD_COLUMN: [
    'deny',
    'require_plan',
    'require_plan',
    'require_plan',
    'allow',
  ],
  // L4 的 ALTER/DELETE/DROP TABLE/slot = "ODD 内 MRC" (§8.1) · #75 无 ODD (L4 feat-049/051) →
  // 保守 require_plan · L4 ODD 实现后改。
  ALTER_TABLE_BIG_LOCK: [
    'deny',
    'require_plan',
    'require_plan',
    'require_plan',
    'require_plan',
  ],
  DELETE_UPDATE_BULK: [
    'deny',
    'require_plan',
    'require_plan',
    'require_plan',
    'require_plan',
  ],
  DROP_TABLE_OR_INDEX: [
    'deny',
    'require_plan',
    'require_plan',
    'require_plan',
    'require_plan',
  ],
  DROP_REPLICATION_SLOT: [
    'deny',
    'require_plan',
    'require_plan',
    'require_plan',
    'require_plan',
  ],
  // feat-028/#109 长锁 (VACUUM FULL / CLUSTER · ACCESS EXCLUSIVE LOCK · 阻塞 SELECT)
  // L1 deny · L2a/L2b/L3/L4 require_plan (走 plan mode 显式审批 + 注入 lock_timeout 兜底)
  // **联动**: design 仓 features/overview.html §8.1 + feat-056 §4 矩阵 需加 2 行 · 留 follow-up
  // (习惯 9 跨文档联动同 commit · 此处分支单仓改 · landing party 同步 design 仓)
  VACUUM_FULL_LOCK: [
    'deny',
    'require_plan',
    'require_plan',
    'require_plan',
    'require_plan',
  ],
  CLUSTER_LOCK: [
    'deny',
    'require_plan',
    'require_plan',
    'require_plan',
    'require_plan',
  ],
  // hard-deny 行 (G4/G1 stage 已先 terminal 拦 · 此处冗余安全地板)
  DROP_DATABASE_OR_TRUNCATE: ['deny', 'deny', 'deny', 'deny', 'deny'],
  DROP_USER_OR_REVOKE: ['deny', 'deny', 'deny', 'deny', 'deny'],
  CROSS_PROJECT: ['deny', 'deny', 'deny', 'deny', 'deny'],
  // feat-068 动态探针 attach (eBPF / USDT / uprobe)
  // L1/L2 deny · L3/L4 require_plan (走 plan mode · L4 走 ODD 预审批跳 plan · 接 feat-049 MRC 状态机)
  // 不接受自由 bpftrace · 只允许模板 enum (templates.ts 5 个 PoC · escape 在 schema.ts + templates.ts)
  DYNAMIC_PROBE_ATTACH: [
    'deny',
    'deny',
    'deny',
    'require_plan',
    'require_plan',
  ],
  // feat-028/#108 fail-closed bucket · PG parser 解析失败 / 未识别 stmt 兜底
  // L1 deny · 其他 L 都 require_plan (不放行未知 SQL · 走 plan mode 让人/agent 看一眼)
  OTHER: [
    'deny',
    'require_plan',
    'require_plan',
    'require_plan',
    'require_plan',
  ],
};

export function lookupMatrix(
  opClass: OpClass,
  level: AutonomyLevel,
): MatrixCell {
  const idx = LEVELS.indexOf(level);
  return MATRIX[opClass][idx];
}

/** feat-027/#2: 该 (op-class, level) 是否需 plan mode 审批 (matrix cell === 'require_plan')。 */
export function matrixRequiresPlan(
  opClass: OpClass,
  level: AutonomyLevel,
): boolean {
  return lookupMatrix(opClass, level) === 'require_plan';
}
