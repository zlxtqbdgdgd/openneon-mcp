/**
 * Drain3 TS 手写 · feat-037/#1 (L3) · 大样本 log pattern 备路径.
 *
 * Detail design: zlxtqbdgdgd/openneon-design#51 §3.1 + §3.3 +
 * features/feat-037-L3-hybrid-log-pattern-clustering.html §3 Drain3 实现.
 *
 * 一句话: 在线学习的固定深度前缀树聚类算法 · IBM 2017 论文实现 · TS 复刻 ~350 LOC ·
 * 单遍 O(N) 扫一百万行 log → ≤ 50 pattern + tail aggregate · 零 LLM 成本。
 *
 * 算法 (Du et al. 2017 · "Drain: An Online Log Parsing Approach with Fixed Depth Tree"):
 *   1. **tokenize**: 按空白 + 标点切分 · 跳过空 token · 数字 / IP / UUID 推迟到 sim 阶段判断
 *   2. **前缀树定位**: 第一层按 token_count 分桶 · 之后按 token[0..max_node_depth-1] 逐层下沉
 *      · 遇 `*` 通配子节点合并相同长度 · 减少树深度爆炸
 *   3. **sim_th 相似度**: 同 leaf 里 cluster 按 token-overlap (相同 token 数 / total token 数) ·
 *      取 max · ≥ sim_th 则归入该 cluster + 把不一致 token 置 `*` (template generalization)
 *   4. **新 cluster**: max sim < sim_th → 新建 cluster · template = 当前行 tokens
 *   5. **top N + tail**: 按 cluster size 降序 · 取 top_n · 剩余 cluster 聚合成 tail (severity
 *      分布 + total_count + first/last_seen)
 *
 * **跟 Python `drain3.TemplateMiner` 对照** (build-time fixture):
 *   - pattern_count diff ≤ 5%
 *   - template 重叠率 ≥ 90% (Jaccard of templates as token-sets)
 *
 * **fail-closed**: 任何无法解析的行不丢失 · 进 fallback bucket `"<unparseable>"` ·
 *   不静默 drop · DBA 可见 (§6 evidence-first)。
 *
 * **GUC** (4 个 · 由 mcp tool input + env 暴露):
 *   - `drain3.max_node_depth`           前缀树最大深度 · 默认 4
 *   - `drain3.sim_th`                   相似度阈值 · 默认 0.4
 *   - `drain3.top_n_patterns`           top N · 默认 50
 *   - `drain3.tail_threshold_percentage` tail 聚合阈值 (cluster size < total × 该比例 → tail) · 默认 0.01
 */

import type {
  Drain3Config,
  LogPattern,
  PatternClusterResult,
  TailAggregate,
  LogLine,
  Severity,
} from './types';

// ------------------------------------------------------------------------------------------------
// Defaults · all 4 GUC exposed via env vars + policy.yaml (mcp tool input override)
// ------------------------------------------------------------------------------------------------

export const DRAIN3_DEFAULTS: Required<Drain3Config> = {
  max_node_depth: 4,
  sim_th: 0.4,
  top_n_patterns: 50,
  tail_threshold_percentage: 0.01,
} as const;

export function readDrain3ConfigFromEnv(): Drain3Config {
  return {
    max_node_depth: numEnv('DRAIN3_MAX_NODE_DEPTH', DRAIN3_DEFAULTS.max_node_depth),
    sim_th: numEnv('DRAIN3_SIM_TH', DRAIN3_DEFAULTS.sim_th),
    top_n_patterns: numEnv('DRAIN3_TOP_N_PATTERNS', DRAIN3_DEFAULTS.top_n_patterns),
    tail_threshold_percentage: numEnv(
      'DRAIN3_TAIL_THRESHOLD_PERCENTAGE',
      DRAIN3_DEFAULTS.tail_threshold_percentage,
    ),
  };
}

function numEnv(key: string, dflt: number): number {
  const v = process.env[key];
  if (v === undefined) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// ------------------------------------------------------------------------------------------------
// Tokenizer · 跟 Python drain3.LogClusterer 的 default `add_log_message` 同步
// ------------------------------------------------------------------------------------------------

const WILDCARD = '<*>';
const NUM_RE = /^-?\d+(?:\.\d+)?$/;
const HEX_RE = /^0x[0-9a-f]+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T?[\d:.]*Z?$/;

/**
 * tokenize · 按空白切分 + 强制 numeric/uuid/ip/timestamp 预通配 (跟 drain3 默认 masking 一致).
 *
 * 预通配是 Drain3 论文里的 "preprocess masking" —— 模板里的具体值不应参与树定位 · 否则
 * 每个时间戳都开一个 cluster · pattern_count 爆炸。
 */
export function tokenize(line: string): string[] {
  const tokens = line.trim().split(/\s+/).filter((t) => t.length > 0);
  return tokens.map((t) => maskToken(t));
}

function maskToken(t: string): string {
  if (NUM_RE.test(t)) return WILDCARD;
  if (HEX_RE.test(t)) return WILDCARD;
  if (UUID_RE.test(t)) return WILDCARD;
  if (IP_RE.test(t)) return WILDCARD;
  if (TS_RE.test(t)) return WILDCARD;
  return t;
}

// ------------------------------------------------------------------------------------------------
// 前缀树 · 第一层 token_count · 之后按 token[i] · 叶子持 cluster 列表
// ------------------------------------------------------------------------------------------------

type Cluster = {
  /** Tokens (含 `<*>` generalized) · `[]` if unparseable */
  template: string[];
  /** 命中次数 */
  size: number;
  /** Severity 分布 (FATAL/ERROR/WARN/INFO/DEBUG) · 用于 tail aggregate */
  severity: Record<Severity, number>;
  /** ISO 时间戳 · first / last 命中 */
  firstSeen: string | null;
  lastSeen: string | null;
  /** 全局唯一 id · stable across batches */
  id: string;
};

type TreeNode = {
  /** key → child · key = stringified token */
  children: Map<string, TreeNode>;
  /** Only set on leaf node · cluster 列表 */
  clusters: Cluster[];
};

function newNode(): TreeNode {
  return { children: new Map(), clusters: [] };
}

/** Drain3 主类 · 不持有 logger 不持有 IO · 纯算法 (跟 ttl-cache.ts 同 style). */
export class Drain3 {
  private root: TreeNode = newNode();
  private clusterCounter = 0;
  private readonly cfg: Required<Drain3Config>;

  constructor(cfg: Drain3Config = {}) {
    this.cfg = { ...DRAIN3_DEFAULTS, ...cfg };
    if (this.cfg.max_node_depth < 2) {
      throw new Error('drain3.max_node_depth must be ≥ 2');
    }
    if (this.cfg.sim_th < 0 || this.cfg.sim_th > 1) {
      throw new Error('drain3.sim_th must be in [0, 1]');
    }
  }

  /** 在线学习单行 · O(max_node_depth) · 返回命中的 cluster id (新建或既有). */
  addLogLine(line: LogLine): string {
    const tokens = tokenize(line.message);
    if (tokens.length === 0) {
      // 空行进 unparseable fallback bucket (fail-closed · §6)
      return this.addUnparseable(line);
    }

    // 第一层: token_count
    const countKey = `len=${tokens.length}`;
    let node: TreeNode = this.root.children.get(countKey) ?? (() => {
      const fresh = newNode();
      this.root.children.set(countKey, fresh);
      return fresh;
    })();

    // 中间层: token[0], token[1], ... up to max_node_depth - 1
    const inner = Math.min(this.cfg.max_node_depth - 1, tokens.length);
    for (let i = 0; i < inner; i++) {
      const tok = tokens[i];
      // 通配 token 合并到 `<*>` 子节点 (减少树深度爆炸 · 论文 §3.2)
      const key = tok === WILDCARD ? WILDCARD : tok;
      let child: TreeNode | undefined = node.children.get(key);
      if (!child) {
        child = newNode();
        node.children.set(key, child);
      }
      node = child;
    }

    // 叶子: 按 sim_th 匹配 cluster
    return this.matchOrCreate(node, tokens, line);
  }

  /** Bulk · O(N·max_node_depth) one-pass. */
  addLogLines(lines: LogLine[]): void {
    for (const line of lines) this.addLogLine(line);
  }

  /** 出 Top N pattern + tail aggregate · §3 输出 schema. */
  finalize(): PatternClusterResult {
    const allClusters = this.collectClusters();
    const totalCount = allClusters.reduce((s, c) => s + c.size, 0);

    // 按 size 降序排
    allClusters.sort((a, b) => b.size - a.size);

    // Tail threshold: cluster size < total × tail_threshold_percentage → tail
    const tailCutoff = Math.max(
      1,
      Math.floor(totalCount * this.cfg.tail_threshold_percentage),
    );

    const top: LogPattern[] = [];
    const tailClusters: Cluster[] = [];
    for (const c of allClusters) {
      if (top.length < this.cfg.top_n_patterns && c.size >= tailCutoff) {
        top.push(toPattern(c, totalCount));
      } else {
        tailClusters.push(c);
      }
    }

    const tail: TailAggregate = aggregateTail(tailClusters);

    return {
      patterns: top,
      tail_aggregate: tail,
      total_lines: totalCount,
      total_clusters: allClusters.length,
    };
  }

  // -- internals --------------------------------------------------------------------------------

  private collectClusters(): Cluster[] {
    const out: Cluster[] = [];
    const stack: TreeNode[] = [this.root];
    while (stack.length > 0) {
      const n = stack.pop()!;
      for (const c of n.clusters) out.push(c);
      for (const child of n.children.values()) stack.push(child);
    }
    return out;
  }

  private matchOrCreate(leaf: TreeNode, tokens: string[], line: LogLine): string {
    let best: Cluster | null = null;
    let bestSim = -1;
    for (const c of leaf.clusters) {
      if (c.template.length !== tokens.length) continue; // 长度必须等 · 已被第一层桶分隔但 leaf 共享 token_count
      const sim = tokenOverlap(c.template, tokens);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best && bestSim >= this.cfg.sim_th) {
      // 命中 · generalize 不一致位置
      generalize(best.template, tokens);
      bumpCluster(best, line);
      return best.id;
    }
    // 新 cluster
    const cluster: Cluster = {
      template: tokens.slice(),
      size: 0,
      severity: emptySeverity(),
      firstSeen: null,
      lastSeen: null,
      id: `c${++this.clusterCounter}`,
    };
    bumpCluster(cluster, line);
    leaf.clusters.push(cluster);
    return cluster.id;
  }

  private addUnparseable(line: LogLine): string {
    let unparsed = this.root.children.get('<unparseable>');
    if (!unparsed) {
      unparsed = newNode();
      this.root.children.set('<unparseable>', unparsed);
    }
    if (unparsed.clusters.length === 0) {
      unparsed.clusters.push({
        template: [],
        size: 0,
        severity: emptySeverity(),
        firstSeen: null,
        lastSeen: null,
        id: `c${++this.clusterCounter}`,
      });
    }
    const c = unparsed.clusters[0];
    bumpCluster(c, line);
    return c.id;
  }
}

// ------------------------------------------------------------------------------------------------
// helpers (pure)
// ------------------------------------------------------------------------------------------------

function tokenOverlap(a: string[], b: string[]): number {
  if (a.length !== b.length) return 0;
  if (a.length === 0) return 1;
  let same = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i] || a[i] === WILDCARD || b[i] === WILDCARD) same++;
  }
  return same / a.length;
}

function generalize(template: string[], tokens: string[]): void {
  for (let i = 0; i < template.length; i++) {
    if (template[i] !== tokens[i] && template[i] !== WILDCARD) {
      template[i] = WILDCARD;
    }
  }
}

function bumpCluster(c: Cluster, line: LogLine): void {
  c.size += 1;
  const sev: Severity = normalizeSeverity(line.severity);
  c.severity[sev] = (c.severity[sev] ?? 0) + 1;
  if (line.timestamp) {
    if (!c.firstSeen || line.timestamp < c.firstSeen) c.firstSeen = line.timestamp;
    if (!c.lastSeen || line.timestamp > c.lastSeen) c.lastSeen = line.timestamp;
  }
}

function emptySeverity(): Record<Severity, number> {
  return { FATAL: 0, ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 };
}

function normalizeSeverity(s: string | undefined): Severity {
  const up = (s ?? '').toUpperCase();
  if (up === 'FATAL' || up === 'PANIC') return 'FATAL';
  if (up === 'ERROR' || up === 'ERR') return 'ERROR';
  if (up === 'WARN' || up === 'WARNING') return 'WARN';
  if (up === 'DEBUG' || up === 'TRACE') return 'DEBUG';
  return 'INFO';
}

function toPattern(c: Cluster, totalCount: number): LogPattern {
  return {
    pattern_id: c.id,
    template: c.template.length === 0 ? '<unparseable>' : c.template.join(' '),
    count: c.size,
    percentage: totalCount > 0 ? c.size / totalCount : 0,
    severity_distribution: { ...c.severity },
    first_seen: c.firstSeen,
    last_seen: c.lastSeen,
    semantic_name: null, // 备路径不填 · LLM 主路径才填
    semantic_category: 'other', // 备路径默认 other · LLM 主路径才精细分类
  };
}

function aggregateTail(clusters: Cluster[]): TailAggregate {
  const sev = emptySeverity();
  let total = 0;
  let firstSeen: string | null = null;
  let lastSeen: string | null = null;
  for (const c of clusters) {
    total += c.size;
    for (const k of Object.keys(c.severity) as Severity[]) {
      sev[k] += c.severity[k];
    }
    if (c.firstSeen && (!firstSeen || c.firstSeen < firstSeen)) firstSeen = c.firstSeen;
    if (c.lastSeen && (!lastSeen || c.lastSeen > lastSeen)) lastSeen = c.lastSeen;
  }
  return {
    total_count: total,
    cluster_count: clusters.length,
    severity_distribution: sev,
    first_seen: firstSeen,
    last_seen: lastSeen,
  };
}
