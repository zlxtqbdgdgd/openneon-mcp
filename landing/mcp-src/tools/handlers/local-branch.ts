/**
 * local-branch.ts · ADR-0021 follow-up · 自托管「临时分支」seam（query-tuning / migration 复用）
 *
 * 背景：feat-042 已把 **canary** 的建/连/删迁到 `NeonLocalBranchProvider`（neon_local · 永不连云）。
 * 但 `prepare_query_tuning` / `prepare_database_migration` 走的「临时分支」路径仍调
 * 云 `neonClient.createProjectBranch` → 自托管（无 NEON_API_KEY）必 401。本模块复用同一套
 * neon_local seam 给临时分支建/连/删，并把 `branchId → 分支 endpoint connstr` 注册进内存表。
 *
 * 关键：所有 SQL handler 都经 `handleGetConnectionString(...) → createSqlClient(uri)` 取连接，
 * 而自托管下该 handler 默认对任何 branch 都返回 main 的 `NEON_LOCAL_URL`。本注册表让它对临时分支
 * 改返回**分支自己的** endpoint connstr（127.0.0.1:<port>），于是 explain / describe / run_sql /
 * 候选 CREATE INDEX 全部自动落到分支上（sql-driver 见 127.0.0.1 → pg TCP）。
 */

import {
  NeonLocalBranchProvider,
  createNeonLocalConnStringResolver,
} from '../../server-enrich/canary/neon-local-branch-provider';

/** 自托管模式 gate（与 connection-string.ts / sql-driver.ts / local-dev-auth.ts 同一把闸）。 */
export function isSelfHosted(): boolean {
  return !!process.env.NEON_LOCAL_URL;
}

// branchId(timeline tid) → 分支 compute endpoint connstr（postgresql://cloud_admin@127.0.0.1:<port>/...）。
const branchConnStr = new Map<string, string>();

/** 临时分支的 endpoint connstr（未注册 = 不是本进程建的自托管临时分支 → caller 回退 main）。 */
export function getLocalBranchConnString(branchId: string): string | undefined {
  return branchConnStr.get(branchId);
}

// 懒构造 provider + resolver（读 NEON_LOCAL_REPO_DIR 等 env；未配则首次调用抛 provider_unavailable，
// 比云 401 信息清晰）。
let _provider: NeonLocalBranchProvider | undefined;
let _resolver:
  | ReturnType<typeof createNeonLocalConnStringResolver>
  | undefined;
function provider(): NeonLocalBranchProvider {
  return (_provider ??= new NeonLocalBranchProvider());
}
function resolver(): ReturnType<typeof createNeonLocalConnStringResolver> {
  return (_resolver ??= createNeonLocalConnStringResolver());
}

// 临时分支兜底存活窗：complete_* 会显式删；这是泄漏兜底，canary-cron 据 expiry 清理。
const TEMP_BRANCH_TTL_MS = 60 * 60 * 1000; // 1h
let seq = 0;

/**
 * 在自托管 neon_local 上建一条临时分支（从 main CoW）+ 起 compute endpoint，注册其 connstr。
 * 返回 cloud `Branch` 兼容形状（下游只用 .id / .name / .project_id）。
 */
export async function createLocalTempBranch(
  projectId: string,
  branchName?: string,
): Promise<{ id: string; name: string; project_id: string }> {
  const name =
    branchName && /^[\w-]+$/.test(branchName)
      ? branchName
      : // `canary-` 前缀 → 泄漏时 canary-cron 也能据 expiry 清理（安全网）
        `canary-qt-${(seq = (seq + 1) % 1e6)}-${Date.now().toString(36)}`;
  const meta = await provider().createCanaryBranch(projectId, {
    name,
    expiryTsMs: Date.now() + TEMP_BRANCH_TTL_MS,
  });
  const connStr = await resolver()(projectId, meta.branch_id, meta.branch_name);
  branchConnStr.set(meta.branch_id, connStr);
  return { id: meta.branch_id, name: meta.branch_name, project_id: projectId };
}

/** 删自托管临时分支（拆 endpoint + 删 timeline）+ 反注册。幂等（重复删/未知 id 不抛）。 */
export async function deleteLocalTempBranch(
  projectId: string,
  branchId: string,
): Promise<void> {
  try {
    await provider().deleteBranch(projectId, branchId);
  } finally {
    branchConnStr.delete(branchId);
  }
}
