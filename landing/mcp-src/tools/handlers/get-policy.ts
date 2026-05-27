/**
 * get-policy.ts · feat-057 (#84) · get_neondb_policy handler
 *
 * agent 事前感知 L 边界(advisory 告示牌 · 非 enforcement)。派生自 feat-056:
 * resolvePolicy(project_id) + 遍历 §8.1 矩阵 → 各 op-class 的 verdict 清单 + override + hard-deny。
 * **advisory only** —— enforcement(feat-056 pipeline)才是 call-time 权威(§9.3)。只读 · 不改 policy。
 */
import { resolvePolicy } from '../../policy/loader';
import { lookupMatrix, type MatrixCell } from '../../policy/matrix';
import type { OpClass } from '../../protection/destructive-detector';

const ALL_OPS: readonly OpClass[] = [
  'READ_ONLY',
  'CREATE_OR_RESTORE_BRANCH',
  'CREATE_INDEX_CONCURRENTLY',
  'DDL_ADD_COLUMN',
  'ALTER_TABLE_BIG_LOCK',
  'DELETE_UPDATE_BULK',
  'DROP_TABLE_OR_INDEX',
  'DROP_REPLICATION_SLOT',
  // feat-028/#109 长锁
  'VACUUM_FULL_LOCK',
  'CLUSTER_LOCK',
  'DROP_DATABASE_OR_TRUNCATE',
  'DROP_USER_OR_REVOKE',
  'CROSS_PROJECT',
  // feat-028/#108 fail-closed bucket
  'OTHER',
];

// 3 层 hard-deny(任何 L 不可禁 · ADR-0007)· 给 agent 列出便于自省
const HARD_DENY = [
  '跨 project 越权 (G1)',
  'DROP DATABASE / TRUNCATE / DROP USER (G4)',
  'destructive ops 速率超限 (G9)',
];

export type PolicyAdvisory = {
  project_id: string;
  autonomy_level: string;
  advisory: true;
  source: 'configured' | 'defaults';
  ops: { op_class: OpClass; verdict: MatrixCell }[];
  overrides: { pattern: string; effective_level: string }[];
  hard_deny: string[];
  disclaimer: string;
};

export function handleGetPolicy(params: { projectId: string }): PolicyAdvisory {
  const resolved = resolvePolicy(params.projectId);
  return {
    project_id: resolved.project_id,
    autonomy_level: resolved.autonomy_level,
    advisory: true,
    source: resolved.source,
    ops: ALL_OPS.map((op) => ({
      op_class: op,
      verdict: lookupMatrix(op, resolved.autonomy_level),
    })),
    overrides: Object.entries(resolved.overrides).map(
      ([pattern, effective_level]) => ({ pattern, effective_level }),
    ),
    hard_deny: HARD_DENY,
    disclaimer:
      'advisory only · enforcement at call time is authoritative (feat-056 pipeline) · SQL-pattern overrides may apply to specific statements (see overrides).',
  };
}
