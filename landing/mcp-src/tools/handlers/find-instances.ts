/**
 * T1 find_neondb_instances handler · L1 day-one ship · feat-001 #1.
 *
 * Detail design: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-001-L1-mcp-tool-t1-find-instances.html
 *
 * Sales 剧本入口工具 (L1 ship narrative §3 主 demo)：用户问 "列我所有 active 项目"·
 * agent 1 次调用拿到 project + branch_id + endpoint_id + status + branch count 全部必要
 * 信息·  不用 2-3 次串调 Neon API (list_projects → list_branches → list_endpoints)。
 *
 * Algorithm (per detail design §3 怎么做):
 * 1. listProjects (with org filter if provided · uses handleListProjects helper)
 * 2. apply region filter early (saves API calls)
 * 3. apply limit (default 100 · hard ceiling 500 per §5 token budget)
 * 4. per-project parallel enrichment (Promise.all listBranches + listEndpoints inside pool of 10)
 * 5. apply status filter post-enrichment (status derived from primary endpoint state)
 *
 * Status mapping (Neon API EndpointState → user-facing status per §4):
 * - `active`  → `running`
 * - `idle`    → `suspended`
 * - `init`    → `creating`
 * - (no primary endpoint) → `null` (per §8 graceful degradation)
 *
 * Related sub-issues (this is #1 · others depend on this PR):
 * - feat-001 #1 (this file) · handler with parallel Neon API call + pool helper
 * - feat-001 #2 (next PR) · tool registry T1 entry (annotation/category/depth)
 * - feat-001 #3 (next PR) · cache layer (30s · key=(api_key,filter) · 防 rate-limit)
 * - feat-001 #4 (next PR) · prompt template (tool description guidance)
 * - feat-001 #5 (next PR) · feat-061 fixture step 6 (anti-hallucination case 5)
 */

import type { Api } from '@neondatabase/api-client';
import { startSpan } from '@sentry/node';
import { handleListProjects } from './list-projects';
import type { ToolHandlerExtraParams } from '../types';

/**
 * Project status values exposed to agents (per detail design §4 Output schema).
 *
 * NOTE: `failed` is in the design spec but has no direct Neon EndpointState mapping ·
 * day-one we never emit it (handler returns `null` for "no primary endpoint exists" case).
 * L2a may revisit if Neon control-plane exposes a richer state signal.
 */
export type InstanceStatus = 'running' | 'suspended' | 'creating' | 'failed';

export type FindInstancesInput = {
  filter?: {
    /** Filter by project status (derived from primary read_write endpoint state). */
    status?: InstanceStatus;
    /** Filter by Neon region (matched against `project.region_id`). */
    region?: string;
    /** Filter by Neon organization ID (passed through to listProjects). */
    org?: string;
  };
  /** Max number of projects to return. Default 100 · hard ceiling 500 (per §5 token budget). */
  limit?: number;
};

export type FindInstancesResult = {
  project_id: string;
  name: string;
  region: string;
  /** Project status derived from primary read_write endpoint · null when no endpoint exists. */
  status: InstanceStatus | null;
  /** Total branch count · null when enrichment fails. */
  branch_count: number | null;
  /** Endpoints with `current_state === 'active'` · null when enrichment fails. */
  active_endpoint_count: number | null;
  /** Project-level last activity timestamp (from `compute_last_active_at`) · undefined when absent. */
  last_active_time: string | null;
  /** Default branch (`default: true`) · fallback to first branch · null when no branches. */
  primary_branch_id: string | null;
  /** Primary read_write endpoint · fallback to first endpoint · null when no endpoints. */
  primary_endpoint_id: string | null;
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const POOL_CONCURRENCY = 10;

/**
 * Run `fn` over `items` with at most `limit` concurrent in-flight promises.
 *
 * Standard worker-pool pattern · workers pull next index until exhausted ·
 * results preserve input order. Lighter than adding `p-limit` dependency.
 *
 * @param items input array
 * @param limit max concurrent in-flight (clamped to items.length)
 * @param fn per-item async function
 * @returns results in input order
 */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function mapEndpointStateToStatus(
  state: 'init' | 'active' | 'idle' | undefined,
): InstanceStatus | null {
  switch (state) {
    case 'active':
      return 'running';
    case 'idle':
      return 'suspended';
    case 'init':
      return 'creating';
    default:
      return null;
  }
}

type ProjectListItem = {
  id: string;
  name: string;
  region_id: string;
  compute_last_active_at?: string;
};

type BranchListItem = {
  id: string;
  default: boolean;
};

type EndpointListItem = {
  id: string;
  type: 'read_write' | 'read_only';
  current_state: 'init' | 'active' | 'idle';
};

type NeonClientLike = {
  listProjectBranches: (
    params: { projectId: string },
  ) => Promise<{ data: { branches: BranchListItem[] } }>;
  listProjectEndpoints: (
    projectId: string,
  ) => Promise<{ data: { endpoints: EndpointListItem[] } }>;
};

async function enrichProject(
  project: ProjectListItem,
  neonClient: NeonClientLike,
): Promise<FindInstancesResult> {
  const baseResult: FindInstancesResult = {
    project_id: project.id,
    name: project.name,
    region: project.region_id,
    status: null,
    branch_count: null,
    active_endpoint_count: null,
    last_active_time: project.compute_last_active_at ?? null,
    primary_branch_id: null,
    primary_endpoint_id: null,
  };

  try {
    const [branchesResp, endpointsResp] = await Promise.all([
      neonClient.listProjectBranches({ projectId: project.id }),
      neonClient.listProjectEndpoints(project.id),
    ]);
    const branches = branchesResp.data.branches;
    const endpoints = endpointsResp.data.endpoints;

    const primaryBranch = branches.find((b) => b.default) ?? branches[0];
    const primaryEndpoint =
      endpoints.find((e) => e.type === 'read_write') ?? endpoints[0];
    const activeEndpointCount = endpoints.filter(
      (e) => e.current_state === 'active',
    ).length;

    return {
      ...baseResult,
      status: mapEndpointStateToStatus(primaryEndpoint?.current_state),
      branch_count: branches.length,
      active_endpoint_count: activeEndpointCount,
      primary_branch_id: primaryBranch?.id ?? null,
      primary_endpoint_id: primaryEndpoint?.id ?? null,
    };
  } catch {
    // Per detail design §8 回滚策略: 单 project Neon API 失败 fallback 仅 base fields ·
    // 不 fail 整个 handler call · agent 仍能拿到 project list 做后续决策。
    return baseResult;
  }
}

export async function handleFindNeondbInstances(
  args: FindInstancesInput,
  neonClient: Api<unknown>,
  extra: ToolHandlerExtraParams,
): Promise<FindInstancesResult[]> {
  return await startSpan(
    {
      name: 'find_neondb_instances',
    },
    async () => {
      const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

      const projects = (await handleListProjects(
        args.filter?.org ? { org_id: args.filter.org } : {},
        neonClient,
        extra,
      )) as ProjectListItem[];

      let candidates = projects;
      if (args.filter?.region) {
        const region = args.filter.region;
        candidates = candidates.filter((p) => p.region_id === region);
      }
      candidates = candidates.slice(0, limit);

      const enriched = await pool(
        candidates,
        POOL_CONCURRENCY,
        (project) => enrichProject(project, neonClient as unknown as NeonClientLike),
      );

      if (args.filter?.status) {
        const status = args.filter.status;
        return enriched.filter((r) => r.status === status);
      }

      return enriched;
    },
  );
}
