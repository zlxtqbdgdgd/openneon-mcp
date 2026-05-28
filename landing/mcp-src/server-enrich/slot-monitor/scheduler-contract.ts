/**
 * scheduler-contract.ts · feat-043/#1 · cron scheduler 接口契约 (W2-A1 feat-038 stub)
 *
 * **此文件是 contract programming 的临时落点**。
 *
 * feat-043 §3.6 拍板：slot-monitor cron 不起新 node-cron 实例 · 注册 job 到 feat-038
 * `landing/mcp-src/server-enrich/stl-cron.ts` 暴露的 `registerCronJob` API · 共享调度器
 * 实例 + p-limit 并发常量 + 失败 retry pattern (§10.2.1 防重复实现)。
 *
 * W2-A1 (feat-038 #149/#150/#148) 在 W2-A5 启动时尚未 push · 本文件按 design#47 §3.3 +
 * §3.6 给出的契约形态先定义 `RegisterCronJobOptions` + `CronJobHandle` + `registerCronJob`
 * stub · 允许 feat-043 单测立刻跑 (mock register 直接 invoke handler · 跟 design#53 §7
 * fixture 一致)。
 *
 * **W2-A1 push 后 rebase 计划**:
 *   1. 删本文件
 *   2. 把 `slot-monitor-cron.ts` 的 import 从 `./scheduler-contract` 切回 `../stl-cron`
 *   3. 确保 `RegisterCronJobOptions` field 跟 feat-038 final API 字段名一致
 *      (name / cronExpression / handler · design#47 §3.3 已锁)
 *   4. 重跑 npm test 确认零 drift
 *
 * **drift 风险**: feat-038 W2-A1 实现可能调字段名 (e.g. `expr` vs `cronExpression`)。
 * 此 stub 用 design#47 §3.3 给定的命名 `cronExpression`/`handler`/`name`。若 W2-A1 选了
 * 别的名 · rebase 时 grep `registerCronJob` 调用点改一处即可 (slot-monitor-cron.ts)。
 */

export interface RegisterCronJobOptions {
  /** job 名 · 调度器实例内全局唯一 · feat-043 用 'replication-slot-monitor' */
  name: string;
  /** cron expression · 5-field POSIX cron · feat-043 用 '0 * * * *' (每小时 0 分) */
  cronExpression: string;
  /**
   * job handler · async · scheduler 会捕获 throw 走 retry (跟 feat-038 cron framework
   * pattern 一致 · 详 design#47 §3.3.4 失败 retry)
   */
  handler: () => Promise<void>;
}

export interface CronJobHandle {
  /** 同 RegisterCronJobOptions.name */
  name: string;
  /** 停 job (test 用 · 生产 cron 持续运行) */
  stop: () => void;
}

/**
 * 注册 cron job 到 feat-038 共享调度器实例 (contract stub)。
 *
 * **此 stub 实现在生产里被 feat-038 W2-A1 替换**。当前 stub 行为:
 *   - 仅记录 job options 到 module-level registry · 不真起 cron
 *   - 测试通过 `__getRegisteredJob(name)` 直接 invoke handler 验 cron 行为
 *
 * 生产 wire 后 (feat-038 ship) · 本 stub 整个文件删除 · slot-monitor-cron.ts 直接 import
 * `../stl-cron` 即可 (字段兼容 · design#47 §3.6 锁定 contract)。
 */
const registry = new Map<string, RegisterCronJobOptions>();

export function registerCronJob(opts: RegisterCronJobOptions): CronJobHandle {
  if (registry.has(opts.name)) {
    throw new Error(
      `[scheduler-contract stub] duplicate cron job name: ${opts.name}`,
    );
  }
  registry.set(opts.name, opts);
  return {
    name: opts.name,
    stop: () => {
      registry.delete(opts.name);
    },
  };
}

/** test-only · 取回已注册的 job options (生产路径不暴露) */
export function __getRegisteredJob(
  name: string,
): RegisterCronJobOptions | undefined {
  return registry.get(name);
}

/** test-only · 清 registry (各 test 之间隔离) */
export function __clearRegistry(): void {
  registry.clear();
}
