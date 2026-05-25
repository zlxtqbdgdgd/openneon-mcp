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
  // hard-deny 行 (G4/G1 stage 已先 terminal 拦 · 此处冗余安全地板)
  DROP_DATABASE_OR_TRUNCATE: ['deny', 'deny', 'deny', 'deny', 'deny'],
  DROP_USER_OR_REVOKE: ['deny', 'deny', 'deny', 'deny', 'deny'],
  CROSS_PROJECT: ['deny', 'deny', 'deny', 'deny', 'deny'],
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
