/**
 * sidecar.ts · feat-068/#3 (#142) · ephemeral probe sidecar pod dispatcher
 *
 * 设计 (详 feat-068 详设 §3 容器化部署 + §6 capability 安全):
 *
 *   - sidecar = 独立 pod (跟 compute 在同 Node) · 跑完自销 (TTL secondsAfterFinished)
 *   - resources: cpu=0.5 / mem=256Mi · watchdog overhead cap
 *   - shareProcessNamespace + hostPID = true · 让 sidecar 看到 compute 的 PID
 *   - /sys/kernel/debug mount RO · BPF maps 读取
 *   - capability 选型:
 *       kernel ≥ 5.8: CAP_BPF + CAP_PERFMON (最小权限 · 推荐)
 *       kernel 4.14-5.7: 退化到 SYS_ADMIN (dev/test only · prod 必须 5.8+)
 *   - target-pid 显式 (bpftrace -p $PID 注入 · sidecar 不允许 pid=0 全局)
 *   - mcp → sidecar 派单线: gRPC API (生产) · 或 kubectl exec (dev/test)
 *
 * 本文件提供 Dispatcher 接口 + 一个 NoopDispatcher (test) + 一个 K8sDispatcher 占位
 * (真 k8s API 依赖留给运维 / 后续 issue 接通 · 此处 contract first)。
 */
import { randomUUID } from 'node:crypto';

/** sidecar 部署的 capability 选型 · 内核版本探测后由运维选 */
export type SidecarCapability = 'CAP_BPF_PERFMON' | 'SYS_ADMIN';

/** mcp 派给 sidecar 的 attach 请求 · sidecar 跑 `bpftrace -p <pid> -e '<script>'` */
export type AttachRequest = {
  /** attach UUID · mcp 生成 · 后续 detach / watchdog / audit 都用这个 */
  attachId: string;
  /** target compute PID · 必填 · 不允许 pid=0 全局 */
  targetPid: number;
  /** 已渲染的 bpftrace 单线脚本 (templates.renderTemplate 输出) */
  bpftraceScript: string;
  /** duration 秒 · sidecar 内 watchdog 兜底 timeout · mcp 侧 watchdog 也有 */
  durationSeconds: number;
  /** 用于审计的元数据 */
  meta: {
    template: string;
    function: string;
    tenant: string;
    endpointId?: string;
  };
};

/** sidecar 返回的结果 (probe 跑完 + 自销) */
export type AttachResult = {
  attachId: string;
  status: 'completed' | 'detached_early' | 'failed';
  /** sidecar 收集的 enriched JSON · p50/p95/p99 / count / stack 等 (模板决定) */
  output?: Record<string, unknown>;
  /** 实际跑了多少 ms (post-condition 计算 overhead 用) */
  elapsedMs: number;
  /** sidecar 期间观察到的 cpu overhead 峰值 (%) · post-condition 校验 */
  observedOverheadPct?: number;
  /** detach 原因 (early 时) */
  detachReason?: string;
};

/** 派单线 dispatcher 接口 (mcp 用) · 生产 = K8sDispatcher · 测试 = MockDispatcher */
export interface Dispatcher {
  /** 把 attach 请求派到 sidecar pod · 阻塞至 sidecar 跑完返结果 */
  dispatch(req: AttachRequest, signal?: AbortSignal): Promise<AttachResult>;
  /** 主动 detach (watchdog 触发) · 通过 abort signal 或独立 API */
  detach(attachId: string, reason: string): Promise<void>;
  /** post-condition 用 · 查 sidecar 真实跑出来的 overhead */
  getObservedOverhead(attachId: string): Promise<number | undefined>;
}

/**
 * Mock dispatcher (单元测试 / e2e fixture 用)。
 * 不真起 sidecar · 按 fixture 配置返结果。
 */
export class MockDispatcher implements Dispatcher {
  /** test 注入: 让某个 attachId 在 dispatch 时模拟 overhead 超阈值早退 */
  forceOverheadPct: number | null = null;
  forceFail: boolean = false;
  /** test 注入: dispatch 真实 sleep 多少 ms (默认 0 · 立即返) */
  fakeDurationMs: number = 0;
  /** 已 detach 的 attachId set · detach() 调过即记录 */
  detached = new Set<string>();
  /** 全部 dispatch 调用记录 (test inspect 用) */
  dispatches: AttachRequest[] = [];

  async dispatch(req: AttachRequest, signal?: AbortSignal): Promise<AttachResult> {
    this.dispatches.push(req);
    const start = Date.now();
    if (this.fakeDurationMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.fakeDurationMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    if (this.forceFail) {
      return {
        attachId: req.attachId,
        status: 'failed',
        elapsedMs: Date.now() - start,
        detachReason: 'mock dispatcher force-fail',
      };
    }
    const observedOverheadPct = this.forceOverheadPct ?? 0.5;
    return {
      attachId: req.attachId,
      status: this.detached.has(req.attachId) ? 'detached_early' : 'completed',
      elapsedMs: Date.now() - start,
      observedOverheadPct,
      output: {
        template: req.meta.template,
        function: req.meta.function,
        p50_us: 120,
        p95_us: 480,
        p99_us: 1500,
        count: 1234,
      },
    };
  }

  async detach(attachId: string, _reason: string): Promise<void> {
    this.detached.add(attachId);
  }

  async getObservedOverhead(attachId: string): Promise<number | undefined> {
    if (this.detached.has(attachId)) return this.forceOverheadPct ?? 0.5;
    return this.forceOverheadPct ?? 0.5;
  }
}

/**
 * K8sDispatcher 占位 · 生产实现接 k8s API (gRPC to sidecar / 或 kubectl exec)。
 * 不在本 PR scope · contract 已定 · 后续 issue 接通。
 */
export class K8sDispatcher implements Dispatcher {
  constructor(
    private readonly opts: {
      namespace: string;
      sidecarImage: string;
      capability: SidecarCapability;
    },
  ) {}

  async dispatch(_req: AttachRequest): Promise<AttachResult> {
    throw new Error(
      `[K8sDispatcher] not implemented · placeholder · 生产部署接 k8s API (config: ns=${this.opts.namespace} cap=${this.opts.capability})`,
    );
  }
  async detach(_attachId: string, _reason: string): Promise<void> {
    throw new Error('[K8sDispatcher] not implemented');
  }
  async getObservedOverhead(_attachId: string): Promise<number | undefined> {
    throw new Error('[K8sDispatcher] not implemented');
  }
}

/** uuid helper · attach_id 生成 */
export function newAttachId(): string {
  return `probe-${randomUUID()}`;
}
