/**
 * hard-deny.ts · 3 层 hard-deny 的硬编码常量 (ADR-0007)
 *
 * 跨 project (G1) / DROP DATABASE 等极危 (G4) / destructive 速率超限 (G9):任何
 * autonomy_level 都 deny · **不读 policy.yaml** · 任何文件编辑都不可禁用 (防 prompt
 * injection 写 policy 文件拆护栏 · OWASP LLM06 · server 是策略权威)。
 *
 * #73 只落 G4 (op-class 级)。G1 (跨 project · 读 grant scope) + G9 (速率) 在 feat-056/#3 (#76)。
 */
import type { OpClass } from '../protection/destructive-detector';

/** G4: 命中即 deny 的 op-class · 编译期常量 (非 policy.yaml 字段) */
export const HARD_DENY_OP_CLASSES: ReadonlySet<OpClass> = new Set<OpClass>([
  'DROP_DATABASE_OR_TRUNCATE',
  'DROP_USER_OR_REVOKE',
  // CROSS_PROJECT (G1) 在 #76 由 grant scope vs project_id 判 · 不在此 op-class set
]);

export function isHardDenied(opClass: OpClass): boolean {
  return HARD_DENY_OP_CLASSES.has(opClass);
}
