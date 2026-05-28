/**
 * risk-classifier.ts · feat-042/#1 (#161) · DDL canary 风险判定
 *
 * 设计依据: [feat-042 详设 §3.1 + §3.3](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-042-L3-mcp-server-branch-canary-ddl.html)
 *
 * 职责 (Q2 已锁):
 *   op-class + 表 size 双判定 → 决定一条 DDL 是否需要先在 Neon canary branch 预演。
 *   - HARD_CANARY 6 类: ALTER_TABLE_HEAVY / CREATE_INDEX / DROP_TABLE_OR_INDEX /
 *     VACUUM_FULL_LOCK / CLUSTER_LOCK / ALTER_CONSTRAINT_VALIDATE — 无条件 canary
 *   - 表 size 兜底: ALTER TABLE / CREATE INDEX 命中表行数 > 1M (CANARY_TABLE_ROW_THRESHOLD)
 *     → canary
 *   - SKIP: READ_ONLY / CREATE_INDEX_CONCURRENTLY / ALTER_TABLE_LIGHT (ADD COLUMN NULLable 等
 *     非 rewrite ALTER)
 *   - OTHER (parser 解析失败 / 未识别 stmt) → fail-closed default canary (跟 feat-028 OTHER →
 *     plan mode 同 pattern · 不退 SKIP)
 *   - force_canary override: 调用方显式传 true → 直接 canary (不查 op-class / size)
 *
 * 复用约束 (issue #161 验收门): **不引新 OpClass enum** · 直接消费 feat-028
 * destructive-detector.ts 给的 OpClass · 在此模块本地做 HARD_CANARY mapping。
 * ADR-0005 single source · 0 drift。
 *
 * OQ1: ALTER_TABLE_BIG_LOCK 内部需要二级 regex 区分是否是 light 子集 (ADD COLUMN NULLable
 * / RENAME / SET DEFAULT 等无 rewrite 子句) · 二级 regex 在本模块内 · 不动 feat-028。
 *
 * 工程量: ~1 day (issue #161)。
 */

import {
  classifySql,
  type OpClass,
} from '../../protection/destructive-detector';

// ──────────────────────────────────────────────────────────────
// HARD_CANARY 6 类 (feat-042 §3.1)
// ──────────────────────────────────────────────────────────────

/**
 * canary 内部分类 · 跟 issue #161 验收门 1:1 对齐。
 * 非 OpClass · feat-028 OpClass 是 SQL 操作分类 · 此处是 canary policy 分类。
 */
export type CanaryRiskClass =
  | 'ALTER_TABLE_HEAVY' //         ALTER TABLE 含 rewrite (改类型 / ADD COLUMN NOT NULL / SET TYPE)
  | 'CREATE_INDEX' //              CREATE INDEX (非 CONCURRENTLY · 阻塞写)
  | 'DROP_TABLE_OR_INDEX' //       DROP TABLE/INDEX/MATERIALIZED VIEW · 不可逆
  | 'VACUUM_FULL_LOCK' //          VACUUM FULL · ACCESS EXCLUSIVE LOCK
  | 'CLUSTER_LOCK' //              CLUSTER · ACCESS EXCLUSIVE LOCK
  | 'ALTER_CONSTRAINT_VALIDATE' // ALTER TABLE ... VALIDATE CONSTRAINT · 全表 scan + AccessShare
  // —— skip 类 ——
  | 'READ_ONLY'
  | 'CREATE_INDEX_CONCURRENTLY' // 非阻塞 · skip canary
  | 'ALTER_TABLE_LIGHT' //         ADD COLUMN NULLable / RENAME / SET DEFAULT (无 rewrite)
  // —— fail-closed ——
  | 'OTHER';

/** issue 161 验收: HARD_CANARY 6 类 (无条件 canary)。 */
const HARD_CANARY_LIST: ReadonlySet<CanaryRiskClass> = new Set([
  'ALTER_TABLE_HEAVY',
  'CREATE_INDEX',
  'DROP_TABLE_OR_INDEX',
  'VACUUM_FULL_LOCK',
  'CLUSTER_LOCK',
  'ALTER_CONSTRAINT_VALIDATE',
]);

/** issue 161 验收: SKIP 列表 (canary 跳过 · 直接放行)。 */
const SKIP_LIST: ReadonlySet<CanaryRiskClass> = new Set([
  'READ_ONLY',
  'CREATE_INDEX_CONCURRENTLY',
  'ALTER_TABLE_LIGHT',
]);

// ──────────────────────────────────────────────────────────────
// 配置 (env-based · 未来迁 policy.yaml canary.* )
// ──────────────────────────────────────────────────────────────

/** policy.yaml `canary.table_row_threshold` GUC (默认 1M)。 */
export function getCanaryTableRowThreshold(): number {
  const raw = process.env.CANARY_TABLE_ROW_THRESHOLD;
  if (!raw) return 1_000_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 1_000_000;
  return Math.floor(n);
}

// ──────────────────────────────────────────────────────────────
// 二级 regex: ALTER TABLE light vs heavy (OQ1 · 不动 feat-028)
// ──────────────────────────────────────────────────────────────

/**
 * ALTER TABLE light 子集判定 · 命中 = 无 rewrite · skip canary。
 *
 * light 子句 (无表 rewrite · 无长锁):
 *   - ADD COLUMN ... (无 NOT NULL · 无 DEFAULT 非常量)
 *   - RENAME TO / RENAME COLUMN
 *   - SET DEFAULT / DROP DEFAULT
 *   - SET (storage_parameter)
 *
 * heavy 标识 (任一命中 → heavy):
 *   - ALTER COLUMN ... TYPE
 *   - ADD COLUMN ... NOT NULL (无 DEFAULT) · 表 rewrite
 *   - DROP COLUMN
 *   - ADD CONSTRAINT (非 NOT VALID) · 全表 validate
 *   - SET NOT NULL
 */
function isAlterTableLight(sql: string): boolean {
  const s = sql.toUpperCase();
  // 任一 heavy 子句命中 → 立即 heavy
  if (/\bALTER\s+COLUMN\s+[\w."]+\s+TYPE\b/.test(s)) return false;
  if (/\bDROP\s+COLUMN\b/.test(s)) return false;
  if (/\bSET\s+NOT\s+NULL\b/.test(s)) return false;
  // ADD COLUMN ... NOT NULL (无 DEFAULT)
  // 启发式: NOT NULL 出现 + 未紧跟 DEFAULT (best-effort)
  if (/\bADD\s+COLUMN\b/.test(s) && /\bNOT\s+NULL\b/.test(s)) {
    if (!/\bDEFAULT\b/.test(s)) return false;
  }
  // ADD CONSTRAINT 非 NOT VALID
  if (/\bADD\s+CONSTRAINT\b/.test(s) && !/\bNOT\s+VALID\b/.test(s)) {
    return false;
  }
  // 余下视为 light
  return true;
}

/** ALTER TABLE 是否含 VALIDATE CONSTRAINT 子句 (HARD_CANARY 第 6 类)。 */
function isAlterConstraintValidate(sql: string): boolean {
  return /\bVALIDATE\s+CONSTRAINT\b/i.test(sql);
}

/** 是否 CREATE INDEX CONCURRENTLY (skip)。 */
function isCreateIndexConcurrently(sql: string): boolean {
  return /\bCREATE\s+INDEX\s+CONCURRENTLY\b/i.test(sql);
}

// ──────────────────────────────────────────────────────────────
// 映射: OpClass → CanaryRiskClass
// ──────────────────────────────────────────────────────────────

/**
 * 由 feat-028 OpClass + SQL 二级 regex 推 CanaryRiskClass · 不引入新 enum。
 *
 * - ALTER_TABLE_BIG_LOCK + VALIDATE CONSTRAINT → ALTER_CONSTRAINT_VALIDATE
 * - ALTER_TABLE_BIG_LOCK + light 子句 → ALTER_TABLE_LIGHT (skip)
 * - ALTER_TABLE_BIG_LOCK 其余 → ALTER_TABLE_HEAVY
 * - DDL_ADD_COLUMN 含 CREATE INDEX (非 CONCURRENTLY) → CREATE_INDEX
 * - DDL_ADD_COLUMN 含 CREATE INDEX CONCURRENTLY → CREATE_INDEX_CONCURRENTLY
 * - DDL_ADD_COLUMN 其余 (CREATE TABLE / ADD COLUMN 简单) → ALTER_TABLE_LIGHT (skip)
 * - CREATE_INDEX_CONCURRENTLY → CREATE_INDEX_CONCURRENTLY (skip)
 * - DROP_TABLE_OR_INDEX → DROP_TABLE_OR_INDEX
 * - VACUUM_FULL_LOCK / CLUSTER_LOCK → 同名
 * - READ_ONLY / 分支操作 → READ_ONLY (skip)
 * - OTHER (parser 失败) → OTHER (fail-closed → canary)
 * - DML (DELETE_UPDATE_BULK) → 不进 canary scope · 返 READ_ONLY skip · DDL canary 不管 DML
 */
export function classifyCanaryRisk(sql: string): CanaryRiskClass {
  const op: OpClass = classifySql(sql);

  if (op === 'OTHER') return 'OTHER';
  if (op === 'READ_ONLY') return 'READ_ONLY';
  if (op === 'CREATE_OR_RESTORE_BRANCH') return 'READ_ONLY';

  if (op === 'VACUUM_FULL_LOCK') return 'VACUUM_FULL_LOCK';
  if (op === 'CLUSTER_LOCK') return 'CLUSTER_LOCK';
  if (op === 'DROP_TABLE_OR_INDEX') return 'DROP_TABLE_OR_INDEX';

  if (op === 'CREATE_INDEX_CONCURRENTLY') return 'CREATE_INDEX_CONCURRENTLY';

  if (op === 'ALTER_TABLE_BIG_LOCK') {
    if (isAlterConstraintValidate(sql)) return 'ALTER_CONSTRAINT_VALIDATE';
    if (isAlterTableLight(sql)) return 'ALTER_TABLE_LIGHT';
    return 'ALTER_TABLE_HEAVY';
  }

  if (op === 'DDL_ADD_COLUMN') {
    if (isCreateIndexConcurrently(sql)) return 'CREATE_INDEX_CONCURRENTLY';
    if (/\bCREATE\s+INDEX\b/i.test(sql)) return 'CREATE_INDEX';
    return 'ALTER_TABLE_LIGHT';
  }

  // DML / DROP_REPLICATION_SLOT / DROP_DATABASE_OR_TRUNCATE / DROP_USER_OR_REVOKE /
  // CROSS_PROJECT 不在 DDL canary scope · skip 出 canary 流程 · 由 feat-028 / feat-029 兜底。
  return 'READ_ONLY';
}

// ──────────────────────────────────────────────────────────────
// 顶层判定 (issue 161 验收门主入口)
// ──────────────────────────────────────────────────────────────

export type CanaryDecisionReason =
  | 'hard_canary' //          HARD_CANARY 6 类命中
  | 'table_size_threshold' // 表 size 超阈值兜底
  | 'force_canary' //         调用方 override
  | 'fail_closed' //          OTHER bucket
  | 'skip' //                 SKIP 列表 (低风险)
  | 'out_of_scope'; //        DML / 非 DDL ops (canary 不管)

export type CanaryDecision = {
  /** true = 需在 Neon canary branch 预演 · false = 直接在 prod 跑 */
  requires_canary: boolean;
  risk_class: CanaryRiskClass;
  reason: CanaryDecisionReason;
  /** 判定时用的表 size 阈值 (debug · audit 用) */
  threshold_rows?: number;
  /** 实际看到的表 size 估算 (若调用方传了 table_size_estimate) */
  observed_rows?: number;
};

export type CanaryClassifyInput = {
  sql: string;
  /** 可选 · 调用方 (handler) 估算的表行数 (T1 describe_table_schema / pg_class.reltuples) */
  table_size_estimate?: number;
  /** 强制 canary · skip 类也 canary (DBA 谨慎模式) */
  force_canary?: boolean;
};

/**
 * 顶层 canary 风险判定 (op-class + 表 size 双判定 + force_canary override + fail-closed)。
 *
 * 调用约定:
 *   1. force_canary=true → 直接 canary (force_canary)
 *   2. classifyCanaryRisk(sql) 拿 risk_class
 *   3. risk_class ∈ HARD_CANARY → canary (hard_canary)
 *   4. risk_class === 'OTHER' → canary (fail_closed · feat-028 OTHER 同 pattern)
 *   5. risk_class === 'ALTER_TABLE_LIGHT' / 'CREATE_INDEX_CONCURRENTLY' 且
 *      table_size_estimate > threshold → canary (table_size_threshold · ALTER TABLE light /
 *      CREATE INDEX CONCURRENTLY 也可能因表大耗时 · 仍 canary 测 lock_contention)
 *   6. 其余 → skip
 *   7. READ_ONLY / 非 DDL → out_of_scope (requires_canary=false · 调用方应在 router 层早退)
 */
export function classifyCanaryDecision(
  input: CanaryClassifyInput,
): CanaryDecision {
  const threshold = getCanaryTableRowThreshold();
  const observed = input.table_size_estimate;

  if (input.force_canary) {
    return {
      requires_canary: true,
      risk_class: classifyCanaryRisk(input.sql),
      reason: 'force_canary',
      threshold_rows: threshold,
      observed_rows: observed,
    };
  }

  const riskClass = classifyCanaryRisk(input.sql);

  if (riskClass === 'READ_ONLY') {
    return {
      requires_canary: false,
      risk_class: riskClass,
      reason: 'out_of_scope',
      threshold_rows: threshold,
      observed_rows: observed,
    };
  }

  if (riskClass === 'OTHER') {
    return {
      requires_canary: true,
      risk_class: riskClass,
      reason: 'fail_closed',
      threshold_rows: threshold,
      observed_rows: observed,
    };
  }

  if (HARD_CANARY_LIST.has(riskClass)) {
    return {
      requires_canary: true,
      risk_class: riskClass,
      reason: 'hard_canary',
      threshold_rows: threshold,
      observed_rows: observed,
    };
  }

  // SKIP 列表 · 进表 size 兜底判定
  if (SKIP_LIST.has(riskClass)) {
    if (observed !== undefined && observed > threshold) {
      return {
        requires_canary: true,
        risk_class: riskClass,
        reason: 'table_size_threshold',
        threshold_rows: threshold,
        observed_rows: observed,
      };
    }
    return {
      requires_canary: false,
      risk_class: riskClass,
      reason: 'skip',
      threshold_rows: threshold,
      observed_rows: observed,
    };
  }

  // 兜底 fail-closed (理论不可达 · CanaryRiskClass 全部覆盖)
  return {
    requires_canary: true,
    risk_class: riskClass,
    reason: 'fail_closed',
    threshold_rows: threshold,
    observed_rows: observed,
  };
}
