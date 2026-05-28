/**
 * templates.ts · feat-068/#1 (#144) · 5 bpftrace 模板 enum 沙箱化
 *
 * 设计依据: feat-068 详设 §3 (沙箱化设计) + §3.x (5 模板示例)。
 *
 * 不允许自由 bpftrace 脚本 (sandbox 简化 + 防 prompt injection):
 *   - 模板用 enum 枚举 (TEMPLATE_NAMES)
 *   - 槽位 (function / pid / binary) 在 renderTemplate 内 escape · 不允许逃逸
 *   - 占位符 regex anchor (^[A-Za-z_][A-Za-z0-9_:]*$) · 防 ; / `/`/$() 等元字符注入
 *
 * 后续 (feat-068 详设 §3.x) 扩到 ~20 个常用模板 (histogram / count / stacktrace 等)。
 */

/** 5 PoC 模板的 enum · zod schema 用这个 .enum() 约束 */
export const TEMPLATE_NAMES = [
  'latency_buckets',
  'stacktrace_top',
  'lock_wait_histogram',
  'call_count',
  'lwlock_contention_top',
] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** 占位符 escape regex · 函数名 / binary 名只允许的字符 (defense in depth) */
export const SAFE_SYMBOL_RE = /^[A-Za-z_][A-Za-z0-9_:]*$/;
export const SAFE_BINARY_RE = /^[A-Za-z_][A-Za-z0-9_/.-]*$/;

/** 模板渲染输入 · function / binary / kind 必须先过白名单 + escape */
export type TemplateInputs = {
  function: string;
  binary: string;
  kind: 'usdt' | 'uprobe' | 'kprobe';
  /** target-pid 必填 (feat-068/#3) · 不允许 pid=0 全局 */
  pid: number;
  /** duration 秒 · 渲染到 `interval:s:${duration} { exit(); }` */
  duration_seconds: number;
};

export type TemplateDef = {
  name: TemplateName;
  description: string;
  /** 渲染成 bpftrace 单线脚本 · 不接受自由模板字符串 */
  render: (inputs: TemplateInputs) => string;
};

/**
 * escape 输入 · 任何 SAFE_*_RE 不过的输入直接抛 · 调用方负责先校验 (白名单 + denylist)。
 * 这里是 defense in depth · 攻击面双层。
 */
function escapeSymbol(name: string): string {
  if (!SAFE_SYMBOL_RE.test(name)) {
    throw new Error(
      `[dynamic-probe/templates] unsafe symbol "${name}" · expected ${SAFE_SYMBOL_RE} · 拒绝渲染`,
    );
  }
  return name;
}

function escapeBinary(bin: string): string {
  if (!SAFE_BINARY_RE.test(bin)) {
    throw new Error(
      `[dynamic-probe/templates] unsafe binary "${bin}" · expected ${SAFE_BINARY_RE} · 拒绝渲染`,
    );
  }
  return bin;
}

function escapePid(pid: number): number {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 4_194_304) {
    throw new Error(
      `[dynamic-probe/templates] invalid pid ${pid} · 必须正整数 ≤ 4_194_304 · 不允许 pid=0 全局`,
    );
  }
  return pid;
}

function escapeDuration(d: number): number {
  if (!Number.isFinite(d) || d <= 0 || d > 300) {
    throw new Error(
      `[dynamic-probe/templates] invalid duration ${d} · 必须 (0, 300] 秒`,
    );
  }
  return Math.floor(d);
}

/** probe 头 · kind/binary/function/pid → bpftrace probe 段 */
function probeHead(inputs: TemplateInputs): string {
  const fn = escapeSymbol(inputs.function);
  const bin = escapeBinary(inputs.binary);
  // bpftrace 不直接支持 -p pid 过滤模式 · 但 attach uprobe 时可以 attach 全局再用 if (pid == X)
  // 我们倾向 sidecar 启动时 bpftrace -p $PID (run-time CLI flag) · 模板里另在脚本头加 if 兜底。
  const _pid = escapePid(inputs.pid);
  switch (inputs.kind) {
    case 'usdt':
      return `usdt:${bin}:${fn}`;
    case 'uprobe':
      return `uprobe:${bin}:${fn}`;
    case 'kprobe':
      return `kprobe:${fn}`;
  }
}

/**
 * 5 个模板渲染函数 (feat-068 详设 §3.x)。
 * 每个产物是合法 bpftrace 单线脚本 · 用 sidecar `bpftrace -p $PID -e '<script>'` 执行。
 */
export const TEMPLATES: Readonly<Record<TemplateName, TemplateDef>> = {
  // 1. latency_buckets · uprobe + uretprobe 配对 · log2 直方图
  latency_buckets: {
    name: 'latency_buckets',
    description: '函数入口/出口配对 · log2 直方图统计 p50/p95/p99 延迟分布',
    render: (inp) => {
      const head = probeHead(inp);
      const retHead = head.replace(/^uprobe:/, 'uretprobe:').replace(/^usdt:/, 'usdt:');
      const dur = escapeDuration(inp.duration_seconds);
      const pid = escapePid(inp.pid);
      return [
        `${head} / pid == ${pid} / { @start[tid] = nsecs; }`,
        `${retHead} / pid == ${pid} && @start[tid] != 0 / { @lat_ns = hist(nsecs - @start[tid]); delete(@start[tid]); }`,
        `interval:s:${dur} { exit(); }`,
      ].join('\n');
    },
  },

  // 2. stacktrace_top · 函数入口栈采样 · count by ustack(5)
  stacktrace_top: {
    name: 'stacktrace_top',
    description: '函数入口取 5 帧用户栈 · 聚合 top hot 栈',
    render: (inp) => {
      const head = probeHead(inp);
      const dur = escapeDuration(inp.duration_seconds);
      const pid = escapePid(inp.pid);
      return [
        `${head} / pid == ${pid} / { @stack[ustack(5)] = count(); }`,
        `interval:s:${dur} { exit(); }`,
      ].join('\n');
    },
  },

  // 3. lock_wait_histogram · 锁等待时间 log2 直方图 (feat-068 详设 §3.3 PG LWLock 用例)
  lock_wait_histogram: {
    name: 'lock_wait_histogram',
    description: '锁等待 (LWLockAcquire 进/出配对) log2 直方图 · 看锁热点',
    render: (inp) => {
      const head = probeHead(inp);
      const retHead = head.replace(/^uprobe:/, 'uretprobe:').replace(/^usdt:/, 'usdt:');
      const dur = escapeDuration(inp.duration_seconds);
      const pid = escapePid(inp.pid);
      return [
        `${head} / pid == ${pid} / { @wait_start[tid] = nsecs; }`,
        `${retHead} / pid == ${pid} && @wait_start[tid] != 0 / { @lock_wait_ns = hist(nsecs - @wait_start[tid]); delete(@wait_start[tid]); }`,
        `interval:s:${dur} { exit(); }`,
      ].join('\n');
    },
  },

  // 4. call_count · 简单计数器 · per-second 平均调用频率
  call_count: {
    name: 'call_count',
    description: '函数入口计数 · 算 calls/sec',
    render: (inp) => {
      const head = probeHead(inp);
      const dur = escapeDuration(inp.duration_seconds);
      const pid = escapePid(inp.pid);
      return [
        `${head} / pid == ${pid} / { @calls = count(); }`,
        `interval:s:${dur} { exit(); }`,
      ].join('\n');
    },
  },

  // 5. lwlock_contention_top · per-lock-name 等待计数 (PG LWLock 专用 · arg0 = lock name str)
  lwlock_contention_top: {
    name: 'lwlock_contention_top',
    description: 'PG LWLock 按 lock name 聚合 wait 次数 · 看哪个 lock 最堵',
    render: (inp) => {
      const head = probeHead(inp);
      const dur = escapeDuration(inp.duration_seconds);
      const pid = escapePid(inp.pid);
      // usdt 参数: PG LWLock USDT arg0 = lock name string · str(arg0) 安全 (kernel 边界 copy)
      return [
        `${head} / pid == ${pid} / { @by_lock[str(arg0)] = count(); }`,
        `interval:s:${dur} { exit(); }`,
      ].join('\n');
    },
  },
};

/** 渲染入口 · 调用方传 template 名 + 槽位 · 抛错 = 拒绝执行 (fail-closed) */
export function renderTemplate(
  template: TemplateName,
  inputs: TemplateInputs,
): string {
  const def = TEMPLATES[template];
  if (!def) {
    throw new Error(`[dynamic-probe/templates] unknown template "${template}"`);
  }
  return def.render(inputs);
}
