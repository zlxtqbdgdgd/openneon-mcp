/**
 * local-meta.ts · ADR-0021 follow-up · 自托管单租户「控制面元信息」合成 (桶② · 永不连云)
 *
 * 自托管 dev 没有 Neon Cloud 账户 / 组织 / 多项目 → list_projects / find_instances /
 * list_organizations / describe_project 等元信息工具原打云控制面（`neonClient.listProjects`
 * / `getOrganization` …），自托管无 NEON_API_KEY 必 401。本模块在 isSelfHosted() 时合成一个
 * 固定的 `local-dev` 单租户视图，让这些工具返回本地视图而非 401（也绝不连云）。
 */
import { isSelfHosted } from './local-branch';

export { isSelfHosted };

export const LOCAL_PROJECT_ID = 'local-dev';
export const LOCAL_REGION = 'self-hosted';
export const LOCAL_MAIN_BRANCH = 'main';
const LOCAL_TS = '1970-01-01T00:00:00Z';

/** 合成 local-dev 项目（字段对齐 Neon API Project · 下游主要用 id / name / region_id / pg_version）。 */
export function localProject() {
  return {
    id: LOCAL_PROJECT_ID,
    name: LOCAL_PROJECT_ID,
    region_id: LOCAL_REGION,
    pg_version: 17,
    proxy_host: '127.0.0.1',
    created_at: LOCAL_TS,
    updated_at: LOCAL_TS,
    owner_id: LOCAL_PROJECT_ID,
  };
}

/** 合成 local-dev 的 main 分支。 */
export function localBranch() {
  return {
    id: LOCAL_MAIN_BRANCH,
    project_id: LOCAL_PROJECT_ID,
    name: LOCAL_MAIN_BRANCH,
    current_state: 'ready',
    default: true,
    created_at: LOCAL_TS,
    updated_at: LOCAL_TS,
  };
}

/**
 * 桶③: 云托管的独立服务（Neon Auth / Data API）自托管没有对应后端 → 抛清晰错误，
 * 而非裸 401。属"未来自建控制台"范畴（ADR-0021）。
 */
export function selfHostedUnsupported(feature: string): never {
  throw new Error(
    `${feature} 在自托管模式下暂不可用：该能力是 Neon Cloud 托管服务，自托管无对应后端` +
      `（属未来自建控制台范畴 · ADR-0021）。`,
  );
}

/** 合成一个最小的「local-dev」组织（list_organizations 用）。 */
export function localOrg() {
  return {
    id: LOCAL_PROJECT_ID,
    name: 'self-hosted',
    handle: LOCAL_PROJECT_ID,
    plan: 'self-hosted',
    created_at: LOCAL_TS,
    managed_by: 'console',
  };
}
