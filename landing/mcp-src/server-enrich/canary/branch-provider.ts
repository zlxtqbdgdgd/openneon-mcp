/**
 * branch-provider.ts · feat-042 · canary branch 生命周期的后端无关 seam
 *
 * 设计依据: [ADR-0021 · branch 生命周期走自托管开源控制面 · 永不连官方 api.neon.tech](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/docs/adr/0021-branch-lifecycle-self-hosted-control-plane-never-official-cloud.md)
 *
 * 为什么有这层 (ADR-0021):
 *   - 原 `neon-api-client.ts` 把建分支硬编码到官方 `console.neon.tech/api/v2` REST 端点 (闭源云控制面)。
 *     项目奔自托管开源 · 永不连官方云 → 抽 `BranchProvider` seam · 实现指向自托管后端。
 *   - **两个实现都不含「官方云」那一档**: 近期 = neon_local CLI (NeonLocalBranchProvider · 详
 *     neon-local-branch-provider.ts) · 远期 = 自建 CP。没有 cloud impl。
 *   - 建分支本身是 pageserver 数据平面内核能力 (CoW timeline) · 云只是它的一个前端 (详 ADR-0021 §1)。
 *
 * 消费者: canary-runner.ts (createCanaryBranch + deleteBranch) · canary-cron.ts (listCanaryBranches
 *   + deleteBranch · 走 expiry_ts 过期清理)。
 */

// ──────────────────────────────────────────────────────────────
// 错误类型 (后端无关 · canary-runner 据 kind 分流 outcome)
// ──────────────────────────────────────────────────────────────

export type BranchProviderErrorKind =
  | 'provider_unavailable' // 后端不可用 (neon_local 二进制缺 / 集群不可达 · 取代旧 'api_key_missing')
  | 'rate_limit' //          后端限速 / 并发触顶
  | 'server_error' //        后端内部错 (CLI 非零退出 / pageserver 5xx)
  | 'client_error' //        请求侧错 (参数非法 / 4xx)
  | 'network' //             连接失败 (spawn 失败 / HTTP 不通 / timeout)
  | 'parse_error'; //        后端输出无法解析 (CLI stdout 格式不符 / 响应非 JSON)

export class BranchProviderError extends Error {
  readonly kind: BranchProviderErrorKind;
  readonly statusCode?: number;

  constructor(
    kind: BranchProviderErrorKind,
    message: string,
    statusCode?: number,
  ) {
    super(message);
    this.name = 'BranchProviderError';
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

// ──────────────────────────────────────────────────────────────
// 公开类型
// ──────────────────────────────────────────────────────────────

export type CanaryBranchMetadata = {
  /** 后端的分支唯一标识 (neon_local = timeline_id 32-hex hex) */
  branch_id: string;
  /** 人类可读分支名 (实际落到后端的名字 · neon_local 把 expiry 编进名里) */
  branch_name: string;
  /** unix-ts ms · canary retention 到期点 (cron 据此清理) */
  expiry_ts: number;
  /** 源分支 id (canary fork 自此 · 默认 main) */
  parent_id?: string;
};

export type NeonBranchListItem = {
  id: string;
  name: string;
  parent_id?: string;
  /**
   * 后端无关的元数据袋。cron 读 `annotations.expiry_ts` 判过期 (canary-cron.ts)。
   * 云后端用原生 annotations; neon_local 无 annotations · 实现把 expiry 编进 branch 名 ·
   * listCanaryBranches 解析后回填到这里 · 让 cron 逻辑零改动。
   */
  annotations?: Record<string, string>;
};

/**
 * canary branch 生命周期后端 · 后端无关接口。
 *
 * 实现约束:
 *   - createCanaryBranch: 建一条从 parent (默认 main) CoW 派生的分支 · 真数据快照。
 *   - deleteBranch: 销毁分支 (含其上 compute endpoint 的连带拆除)。
 *   - listCanaryBranches: 列本后端下 purpose=canary 的分支 · 带 expiry_ts (给 cron 清理)。
 *   - 失败一律抛 BranchProviderError (canary-runner / cron 据 kind 分流 / warn)。
 */
export type BranchProvider = {
  createCanaryBranch(
    projectId: string,
    opts: {
      name: string;
      parentBranchId?: string;
      expiryTsMs: number;
    },
  ): Promise<CanaryBranchMetadata>;

  deleteBranch(projectId: string, branchId: string): Promise<void>;

  listCanaryBranches(projectId: string): Promise<NeonBranchListItem[]>;
};
