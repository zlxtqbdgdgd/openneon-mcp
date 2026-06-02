/**
 * neon-local-branch-provider.ts · feat-042 · BranchProvider 的自托管实现 (近期后端)
 *
 * 设计依据: [ADR-0021](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/docs/adr/0021-branch-lifecycle-self-hosted-control-plane-never-official-cloud.md)
 *   · 近期后端 = neon_local CLI 驱动 dev server 上已在跑的开源 pageserver/safekeeper/storage_controller/compute_ctl 栈。
 *   · 远期 = 自建 CP (另起实现 · 接同一 BranchProvider 接口)。永不连官方 api.neon.tech。
 *
 * 前提: mcp server 与 neon 栈**同机** (能 spawn neon_local + 连本地 pageserver HTTP)。这是 ADR-0021
 *   近期形态; 远期 mcp 与 CP 分离时换 storage_controller HTTP 实现。
 *
 * 命令序列 (dev server 实证 · 详 feat-042 §3.2):
 *   - 建分支: `neon_local timeline branch --branch-name <name> --ancestor-branch-name main`
 *             → stdout "Created timeline '<tid>' at Lsn <lsn> ..."
 *   - 起 compute (connStringResolver): `endpoint create <ep> --branch-name <name> --pg-version <v>
 *             --pg-port <P> --external-http-port <P+1> --internal-http-port <P+2>` + `endpoint start
 *             <ep> --allow-multiple` → stdout "Starting postgres node at '<connstr>'"
 *   - 删分支: `endpoint list` 找该 timeline 的 endpoint → `endpoint stop` + rm endpoint 目录 →
 *             pageserver HTTP `DELETE /v1/tenant/<t>/timeline/<tid>` (neon_local 无 timeline delete)
 *   - 列分支: `timeline list` → 解析 `<name> [<tid>]` · 过滤 canary- 前缀
 *
 * 坑 (实证踩过):
 *   - endpoint 端口必须显式分配 · 自动分配会撞 main compute 的 internal-http-port → postgres exit 1。
 *   - endpoint 起在已存在 endpoint 上需 `--allow-multiple` (否则 "duplicate primary endpoint")。
 *   - neon_local timeline 无 annotations → expiry 编进 branch 名 (`<name>--exp<ms>`) · list 时解析回填。
 */

import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';

import {
  type BranchProvider,
  BranchProviderError,
  type CanaryBranchMetadata,
  type NeonBranchListItem,
} from './branch-provider';

const execFileAsync = promisify(execFile);

// ──────────────────────────────────────────────────────────────
// 配置 (env-based · 自托管 dev server 现实)
// ──────────────────────────────────────────────────────────────

export type NeonLocalConfig = {
  /** neon 栈仓库根 (含 target/debug/neon_local + .neon/) · 必配 */
  repoDir: string;
  /** neon_local 二进制路径 · 默认 ${repoDir}/target/debug/neon_local */
  binPath: string;
  /** pageserver HTTP mgmt API base · 删 timeline 用 · 默认 http://127.0.0.1:9898 */
  pageserverHttp: string;
  /** tenant id · 未配则启动期查 pageserver /v1/tenant 取第一个 */
  tenantId?: string;
  /** canary compute 的 PG 版本 · 默认 17 */
  pgVersion: string;
  /** canary endpoint 端口分配基址 · 默认 55460 (避开 main 的 55432/33/34) */
  portBase: number;
  /** 单次 CLI 调用超时 ms · 默认 90000 (compute 冷启可能慢) */
  cmdTimeoutMs: number;
};

function readConfig(override?: Partial<NeonLocalConfig>): NeonLocalConfig {
  const repoDir =
    override?.repoDir ?? process.env.NEON_LOCAL_REPO_DIR ?? '';
  if (!repoDir) {
    throw new BranchProviderError(
      'provider_unavailable',
      'NEON_LOCAL_REPO_DIR 未配 · 自托管 canary 无法定位 neon_local 仓库 (ADR-0021)',
    );
  }
  return {
    repoDir,
    binPath:
      override?.binPath ??
      process.env.NEON_LOCAL_BIN ??
      `${repoDir}/target/debug/neon_local`,
    pageserverHttp:
      override?.pageserverHttp ??
      process.env.NEON_PAGESERVER_HTTP ??
      'http://127.0.0.1:9898',
    tenantId: override?.tenantId ?? process.env.NEON_TENANT_ID,
    pgVersion: override?.pgVersion ?? process.env.NEON_CANARY_PG_VERSION ?? '17',
    portBase:
      override?.portBase ??
      Number(process.env.NEON_CANARY_PORT_BASE ?? '55460'),
    cmdTimeoutMs:
      override?.cmdTimeoutMs ??
      Number(process.env.NEON_CANARY_CMD_TIMEOUT_MS ?? '90000'),
  };
}

// ──────────────────────────────────────────────────────────────
// 注入式 fetch (单测可 mock pageserver HTTP)
// ──────────────────────────────────────────────────────────────

export type FetchLike = (
  url: string,
  init: { method: string },
) => Promise<{ ok: boolean; status: number; statusText: string }>;

export type NeonLocalDeps = {
  /** 注入式命令执行器 (单测替身) · 默认 execFile(binPath, args, {cwd: repoDir}) */
  exec?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** 注入式 fetch · 删 timeline 走 pageserver HTTP */
  fetcher?: FetchLike;
  /** 注入式 endpoint 目录删除 (单测替身) · 默认 fs.rm */
  rmEndpointDir?: (epName: string) => Promise<void>;
};

const EXP_NAME_SUFFIX = /--exp(\d+)$/;

export class NeonLocalBranchProvider implements BranchProvider {
  private readonly cfg: NeonLocalConfig;
  private readonly exec: (
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;
  private readonly fetcher: FetchLike;
  private readonly rmEndpointDir: (epName: string) => Promise<void>;
  private resolvedTenantId?: string;

  constructor(opts: Partial<NeonLocalConfig> & NeonLocalDeps = {}) {
    this.cfg = readConfig(opts);
    this.exec =
      opts.exec ??
      (async (args) => {
        const { stdout, stderr } = await execFileAsync(this.cfg.binPath, args, {
          cwd: this.cfg.repoDir,
          timeout: this.cfg.cmdTimeoutMs,
          maxBuffer: 8 * 1024 * 1024,
        });
        return { stdout, stderr };
      });
    this.fetcher =
      opts.fetcher ??
      ((url, init) =>
        fetch(url, init).then((r) => ({
          ok: r.ok,
          status: r.status,
          statusText: r.statusText,
        })));
    this.rmEndpointDir =
      opts.rmEndpointDir ??
      ((epName) =>
        rm(`${this.cfg.repoDir}/.neon/endpoints/${epName}`, {
          recursive: true,
          force: true,
        }));
  }

  // ── createCanaryBranch: neon_local timeline branch ──────────────
  async createCanaryBranch(
    _projectId: string,
    opts: { name: string; parentBranchId?: string; expiryTsMs: number },
  ): Promise<CanaryBranchMetadata> {
    // expiry 编进 branch 名 (neon_local timeline 无 annotations · list 时解析回填)
    const branchName = `${opts.name}--exp${opts.expiryTsMs}`;
    // canary 永远 fork 自 prod = main (parentBranchId 是云遗留 id · 自托管用 branch 名)
    const ancestor =
      opts.parentBranchId && /^[a-z][\w-]*$/i.test(opts.parentBranchId)
        ? opts.parentBranchId
        : 'main';

    const { stdout } = await this.run([
      'timeline',
      'branch',
      '--branch-name',
      branchName,
      '--ancestor-branch-name',
      ancestor,
    ]);

    // stdout: "Created timeline '<tid>' at Lsn <lsn> for tenant: <t>. Ancestor timeline: 'main'"
    const m = stdout.match(/Created timeline '([0-9a-f]{32})'/i);
    if (!m) {
      throw new BranchProviderError(
        'parse_error',
        `timeline branch 输出未含 timeline id: ${stdout.slice(0, 200)}`,
      );
    }
    return {
      branch_id: m[1],
      branch_name: branchName,
      expiry_ts: opts.expiryTsMs,
      parent_id: ancestor,
    };
  }

  // ── deleteBranch: 拆 endpoint + pageserver HTTP delete timeline ──
  async deleteBranch(_projectId: string, branchId: string): Promise<void> {
    // 1. 找该 timeline 上的 endpoint · stop + rm (neon_local 无 endpoint delete)
    for (const epName of await this.endpointsOnTimeline(branchId)) {
      await this.run(['endpoint', 'stop', epName]).catch(() => {
        /* endpoint 可能已半死 (pgdata 缺) · rm 目录兜底 */
      });
      await this.rmEndpointDir(epName).catch(() => {});
    }
    // 2. pageserver HTTP DELETE timeline (neon_local timeline 无 delete 子命令)
    const tenant = await this.tenantId();
    const url = `${this.cfg.pageserverHttp}/v1/tenant/${tenant}/timeline/${branchId}`;
    let resp;
    try {
      resp = await this.fetcher(url, { method: 'DELETE' });
    } catch (err) {
      throw new BranchProviderError(
        'network',
        `pageserver DELETE timeline 不通: ${(err as Error).message}`,
      );
    }
    // 202 Accepted (异步删) / 404 (已不存在 · 幂等当成功) 都算清理到位
    if (!resp.ok && resp.status !== 404) {
      throw new BranchProviderError(
        'server_error',
        `pageserver DELETE timeline ${resp.status} ${resp.statusText}`,
        resp.status,
      );
    }
  }

  // ── listCanaryBranches: timeline list + 名字前缀过滤 + 解析 expiry ──
  // projectId 在自托管单租户下无意义 (后端不分 project) · TS 允许少参实现接口
  async listCanaryBranches(): Promise<NeonBranchListItem[]> {
    const { stdout } = await this.run(['timeline', 'list']);
    const items: NeonBranchListItem[] = [];
    // 每行形如 "main [<tid>]" 或 "┗━ @<lsn>: <name> [<tid>]"
    const lineRe = /([^\s:[\]]+)\s+\[([0-9a-f]{32})\]/gi;
    let mm: RegExpExecArray | null;
    while ((mm = lineRe.exec(stdout)) !== null) {
      const name = mm[1];
      const tid = mm[2];
      if (!name.startsWith('canary-')) continue;
      const expMatch = name.match(EXP_NAME_SUFFIX);
      items.push({
        id: tid,
        name,
        annotations: {
          purpose: 'canary',
          ...(expMatch ? { expiry_ts: expMatch[1] } : {}),
        },
      });
    }
    return items;
  }

  // ── 内部 helpers ────────────────────────────────────────────────

  /** 跑 neon_local · 失败映射成 BranchProviderError。 */
  private async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await this.exec(args);
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stderr?: string;
        killed?: boolean;
        code?: string | number;
      };
      if (e.code === 'ENOENT') {
        throw new BranchProviderError(
          'provider_unavailable',
          `neon_local 二进制不存在 (${this.cfg.binPath}) · 自托管 canary 不可用`,
        );
      }
      if (e.killed) {
        throw new BranchProviderError(
          'network',
          `neon_local ${args[0]} ${args[1]} 超时 (>${this.cfg.cmdTimeoutMs}ms)`,
        );
      }
      const stderr = (e.stderr ?? e.message ?? '').slice(0, 300);
      // 参数/状态类错 (已存在 / 非法) 归 client_error · 其余归 server_error
      const kind = /exists already|duplicate|not found|invalid/i.test(stderr)
        ? 'client_error'
        : 'server_error';
      throw new BranchProviderError(
        kind,
        `neon_local ${args[0]} ${args[1]} 失败: ${stderr}`,
      );
    }
  }

  /** endpoint list → 该 timeline 上的 endpoint 名 (deleteBranch 拆除用)。 */
  private async endpointsOnTimeline(branchId: string): Promise<string[]> {
    const { stdout } = await this.run(['endpoint', 'list']);
    const names: string[] = [];
    for (const line of stdout.split('\n')) {
      const cols = line.trim().split(/\s+/);
      // 列: ENDPOINT ADDRESS TIMELINE BRANCH_NAME LSN STATUS... · 跳表头
      if (cols.length < 3 || cols[0] === 'ENDPOINT') continue;
      if (cols[2] === branchId) names.push(cols[0]);
    }
    return names;
  }

  /** tenant id · env 优先 · 否则查 pageserver /v1/tenant 取第一个 (缓存)。 */
  private async tenantId(): Promise<string> {
    if (this.cfg.tenantId) return this.cfg.tenantId;
    if (this.resolvedTenantId) return this.resolvedTenantId;
    let resp: Response;
    try {
      resp = await fetch(`${this.cfg.pageserverHttp}/v1/tenant`, {
        method: 'GET',
      });
    } catch (err) {
      throw new BranchProviderError(
        'network',
        `pageserver /v1/tenant 不通: ${(err as Error).message}`,
      );
    }
    if (!resp.ok) {
      throw new BranchProviderError(
        'server_error',
        `pageserver /v1/tenant ${resp.status}`,
        resp.status,
      );
    }
    const arr = (await resp.json()) as Array<{ id: string }>;
    const id = arr?.[0]?.id;
    if (!id) {
      throw new BranchProviderError(
        'provider_unavailable',
        'pageserver 无 tenant · 自托管集群未初始化',
      );
    }
    this.resolvedTenantId = id;
    return id;
  }
}

// ──────────────────────────────────────────────────────────────
// connStringResolver: 起 compute endpoint → connstr (canary-runner 注入)
// ──────────────────────────────────────────────────────────────

/** branchId → 确定性、互不冲突的端口三元组 (避开 main 的 55432/33/34)。 */
function portsFor(branchId: string, base: number): {
  pg: number;
  ext: number;
  int: number;
} {
  let h = 0;
  for (let i = 0; i < branchId.length; i++) {
    h = (h * 31 + branchId.charCodeAt(i)) | 0;
  }
  const slot = (Math.abs(h) % 300) * 3; // 每 canary 占 3 个连号端口
  const pg = base + slot;
  return { pg, ext: pg + 1, int: pg + 2 };
}

/**
 * 自托管 connStringResolver · 在 canary 分支上 create + start 一个 compute endpoint · 返 connstr。
 * (canary-runner 拿到后用注入的 sqlRunner 跑 DDL; deleteBranch 时连带拆掉本 endpoint。)
 */
export function createNeonLocalConnStringResolver(
  opts: Partial<NeonLocalConfig> & Pick<NeonLocalDeps, 'exec'> = {},
): (
  projectId: string,
  branchId: string,
  branchName: string,
) => Promise<string> {
  const cfg = readConfig(opts);
  const exec =
    opts.exec ??
    (async (args: string[]) => {
      const { stdout, stderr } = await execFileAsync(cfg.binPath, args, {
        cwd: cfg.repoDir,
        timeout: cfg.cmdTimeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout, stderr };
    });

  return async (_projectId, branchId, branchName) => {
    const epName = `canary-ep-${branchId.slice(0, 12)}`;
    const { pg, ext, int } = portsFor(branchId, cfg.portBase);
    try {
      await exec([
        'endpoint',
        'create',
        epName,
        '--branch-name',
        branchName,
        '--pg-version',
        cfg.pgVersion,
        '--pg-port',
        String(pg),
        '--external-http-port',
        String(ext),
        '--internal-http-port',
        String(int),
      ]);
      const { stdout } = await exec([
        'endpoint',
        'start',
        epName,
        '--allow-multiple',
      ]);
      // stdout: "Starting postgres node at 'postgresql://cloud_admin@127.0.0.1:<pg>/postgres'"
      const m = stdout.match(/(postgresql:\/\/\S+)'/);
      if (m) return m[1];
      // 输出未含 connstr 时按约定拼 (endpoint create 已定端口)
      return `postgresql://cloud_admin@127.0.0.1:${pg}/postgres`;
    } catch (err) {
      const e = err as Error & { stderr?: string };
      throw new BranchProviderError(
        'server_error',
        `neon_local endpoint create/start 失败: ${(e.stderr ?? e.message).slice(0, 300)}`,
      );
    }
  };
}
