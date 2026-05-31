/**
 * denylist.ts · feat-068 重设计 (#210 · ADR-0017) · denylist FLOOR 加载 + 匹配
 *
 * 动态探针治理从 "whitelist 强制" 改为 "denylist floor" (详 denylist.yaml 头注释):
 *   - 不再要求探测函数 ∈ whitelist (agent 熟代码自挑任意导出函数 = form-shift 价值点)
 *   - denylist 是 FLOOR · 唯一硬约束 · 命中即 reject + audit severity=critical · 不可绕过
 *
 * 匹配语义: `re.fullmatch` 等价 (Python) → JS `new RegExp('^(' + pat + ')$')` · 整串匹配 ·
 *   case-sensitive (ELF 导出符号大小写敏感 · 如 denylist `Password_encryption`)。
 *
 * 同步策略: denylist.yaml mirror from openneon `pgxn/neon/probes/denylist.yaml` (#91 floor 语义) ·
 *   build-time copy · 跨仓自治。upgrade path: openneon 仓变更 → 本仓 PR 同步 mirror 整文件 +
 *   刷 $source_commit + 复跑 drift fixture。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// ESM: __dirname 等价 (mcp 是 ESM · CommonJS __dirname 在 ESM 运行时未定义 · #212 验收发现)
const __dirname_esm = dirname(fileURLToPath(import.meta.url));

/** denylist FLOOR 结构 · usdt (PG C 符号) + uprobe (Rust 符号) pattern 分集合 */
export type Denylist = {
  version: 1;
  denylist: {
    /** PG C 函数 deny pattern (re.fullmatch · ELF 导出符号名) */
    usdt_probe_patterns?: string[];
    /** Rust uprobe symbol deny pattern (feat-069 L4 · 暂留占位) */
    uprobe_symbol_patterns?: string[];
  };
};

let cached: Denylist | null = null;

/**
 * 加载 denylist.yaml · 默认路径 = 同目录 mirror (build-time copy) ·
 * 生产部署可通过 OPENNEON_PROBE_DENYLIST_PATH env 覆盖到 openneon 仓的 denylist.yaml。
 *
 * fail-closed: 文件不存在或解析失败 → 抛 (启动期 fail-closed · 没 floor 不放任何 attach)。
 */
export function loadDenylist(path?: string): Denylist {
  if (cached && !path) return cached;
  const resolved =
    path ??
    process.env.OPENNEON_PROBE_DENYLIST_PATH ??
    join(__dirname_esm, 'denylist.yaml');
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (e) {
    throw new Error(
      `[dynamic-probe/denylist] denylist not found at ${resolved} · fail-closed (无 floor 不放 attach)`,
      { cause: e },
    );
  }
  const parsed = yamlLoad(raw) as Denylist | undefined;
  validateDenylistShape(parsed, resolved);
  if (!path) cached = parsed!;
  return parsed!;
}

/** shape 校验 · version=1 + denylist 是 object (有 usdt/uprobe pattern array 子字段) */
function validateDenylistShape(
  parsed: unknown,
  resolvedPath: string,
): asserts parsed is Denylist {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      `[dynamic-probe/denylist] denylist at ${resolvedPath} 不是 object · fail-closed`,
    );
  }
  const d = parsed as Partial<Denylist>;
  if (d.version !== 1) {
    throw new Error(
      `[dynamic-probe/denylist] denylist at ${resolvedPath} version 必须 = 1 · 收到 ${JSON.stringify(d.version)} · fail-closed`,
    );
  }
  if (!d.denylist || typeof d.denylist !== 'object' || Array.isArray(d.denylist)) {
    throw new Error(
      `[dynamic-probe/denylist] denylist at ${resolvedPath} 顶层 denylist 必须是 object (有 usdt_probe_patterns / uprobe_symbol_patterns) · fail-closed`,
    );
  }
  for (const key of ['usdt_probe_patterns', 'uprobe_symbol_patterns'] as const) {
    const v = d.denylist[key];
    if (v !== undefined && !Array.isArray(v)) {
      throw new Error(
        `[dynamic-probe/denylist] denylist.${key} 必须是 array · fail-closed`,
      );
    }
  }
}

/** 测试用 · 重置缓存 */
export function __resetDenylistCacheForTest(): void {
  cached = null;
}

/** 测试用 · 注入 in-memory denylist · 不读文件 · 仍走 shape 校验 */
export function __setDenylistForTest(d: Denylist | null): void {
  if (d !== null) {
    validateDenylistShape(d, '<inline-test>');
  }
  cached = d;
}

/**
 * `re.fullmatch` 等价 · 整串匹配 · case-sensitive。
 * 无效 regex → fail-closed 视为命中 (拒绝)。
 */
function fullmatch(pattern: string, name: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp('^(' + pattern + ')$');
  } catch {
    return true; // 无效 pattern · fail-closed 拒
  }
  return re.test(name);
}

export type DenylistCheckResult =
  | { ok: true }
  | { ok: false; pattern: string; set: 'usdt' | 'uprobe' };

/**
 * floor 校验 · function 命中 denylist 任一 pattern → 拒 (hard-deny · 不可绕过)。
 * target=pg → 查 usdt_probe_patterns · target=rust → 查 uprobe_symbol_patterns。
 * 默认 (无明确 target) 两个集合都查 (defense in depth)。
 */
export function checkDenylist(
  functionName: string,
  target: 'pg' | 'rust' | 'both' = 'both',
  denylist?: Denylist,
): DenylistCheckResult {
  const dl = denylist ?? loadDenylist();
  const usdt = dl.denylist.usdt_probe_patterns ?? [];
  const uprobe = dl.denylist.uprobe_symbol_patterns ?? [];
  if (target === 'pg' || target === 'both') {
    for (const pat of usdt) {
      if (fullmatch(pat, functionName)) {
        return { ok: false, pattern: pat, set: 'usdt' };
      }
    }
  }
  if (target === 'rust' || target === 'both') {
    for (const pat of uprobe) {
      if (fullmatch(pat, functionName)) {
        return { ok: false, pattern: pat, set: 'uprobe' };
      }
    }
  }
  return { ok: true };
}
