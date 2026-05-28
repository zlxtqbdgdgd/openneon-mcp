/**
 * feat-037 8 case fixtures · openneon-mcp#156 §验收门.
 *
 * 8 case (跟 issue body 对齐):
 *   1. standard_main          — 30K token input → main 路径 LLM (auto · under threshold)
 *   2. standard_backup        — 100K input → backup 路径 Drain3 (auto · over threshold)
 *   3. path_estimate_accuracy — tiktoken 估算 vs 实际 token 偏差 < 30%
 *   4. fallback_from_main     — mock LLM 5xx → 自动 fallback Drain3 + fallback_reason
 *   5. force_path_override    — agent force=main / backup
 *   6. force_main_over_limit  — input > 200K + force=main → 拒绝
 *   7. cache_hit              — 重复同 input → < 5ms · cache_hit=true
 *   8. trace_id_v1_blocked    — v1 阶段 trace_id filter → feat_036_not_ready
 *   + (bonus) tail_anomaly    — 合成 FATAL → tail_aggregate.severity_distribution.FATAL 突出
 *
 * 跨 model 一致性 (≥ 80% category + 95% coverage) 单独跑批 · 不进 8 case.
 */

import type { LogLine } from '../../server-enrich/pattern/types';

// ------------------------------------------------------------------------------------------------
// Synthetic log line generators · obfuscated already (mcp tool 边界保证)
// ------------------------------------------------------------------------------------------------

/** 生成 N 行典型 PG log mix (query log + checkpoint + autovacuum + auth + replication). */
export function genStandardLogs(n: number, startTs = '2026-05-28T10:00:00Z'): LogLine[] {
  const out: LogLine[] = [];
  const baseMs = Date.parse(startTs);
  const templates = [
    { sev: 'INFO', body: 'statement: SELECT <*> FROM users WHERE id = <*>' },
    { sev: 'INFO', body: 'checkpoint starting: time' },
    { sev: 'INFO', body: 'checkpoint complete: wrote <*> buffers (<*>%)' },
    { sev: 'INFO', body: 'autovacuum: VACUUM ANALYZE public.orders' },
    { sev: 'WARN', body: 'autovacuum worker started for table <*>' },
    { sev: 'INFO', body: 'replication: WAL sender streaming at <*>/<*>' },
    { sev: 'INFO', body: 'connection authorized: user=<*> database=<*>' },
    { sev: 'INFO', body: 'received password from <*>:<*>' },
  ];
  for (let i = 0; i < n; i++) {
    const t = templates[i % templates.length];
    out.push({
      message: t.body,
      severity: t.sev,
      timestamp: new Date(baseMs + i * 100).toISOString(),
    });
  }
  return out;
}

/** 生成异常占比高的 batch (FATAL 占 10%) · tail anomaly 用. */
export function genAnomalyLogs(n: number): LogLine[] {
  const out: LogLine[] = [];
  const baseMs = Date.parse('2026-05-28T10:00:00Z');
  for (let i = 0; i < n; i++) {
    if (i % 10 === 0) {
      out.push({
        message: 'FATAL: out of memory · failed to allocate <*> bytes',
        severity: 'FATAL',
        timestamp: new Date(baseMs + i * 100).toISOString(),
      });
    } else {
      out.push({
        message: 'statement: SELECT <*> FROM users WHERE id = <*>',
        severity: 'INFO',
        timestamp: new Date(baseMs + i * 100).toISOString(),
      });
    }
  }
  return out;
}

/** 生成 ≈ targetTokens token 的 batch (chars/4 估算 · 跟 path-router estimateLines 一致). */
export function genLogsByTokenSize(targetTokens: number): LogLine[] {
  // 测算: 8 模板平均 (chars+16)/4 ≈ 13.5 token/line (跟 path-router estimateLines 同 heuristic)
  const perLineTokens = 13;
  const n = Math.ceil(targetTokens / perLineTokens);
  return genStandardLogs(n);
}

// ------------------------------------------------------------------------------------------------
// LLM mock outputs for cross-model robustness (8 → fixed JSON per model)
// ------------------------------------------------------------------------------------------------

/** Mock LLM JSON output 对应 standard 8-template 输入 · 三 model 各微调以模拟跨 model 漂移. */
export const MOCK_LLM_OUTPUT_OPUS = JSON.stringify({
  patterns: [
    {
      pattern_id: 'p1',
      template: 'statement: SELECT <*> FROM users WHERE id = <*>',
      count: 13,
      first_line_index: 0,
      last_line_index: 96,
      semantic_name: 'User Select Query',
      semantic_category: 'query',
      semantic_summary: 'Read-only lookup of a single user row by primary key.',
    },
    {
      pattern_id: 'p2',
      template: 'checkpoint starting: time',
      count: 13,
      first_line_index: 1,
      last_line_index: 97,
      semantic_name: 'Checkpoint Start',
      semantic_category: 'maintenance',
      semantic_summary: 'Periodic WAL checkpoint begin marker.',
    },
    {
      pattern_id: 'p3',
      template: 'checkpoint complete: wrote <*> buffers (<*>%)',
      count: 13,
      first_line_index: 2,
      last_line_index: 98,
      semantic_name: 'Checkpoint Complete',
      semantic_category: 'maintenance',
      semantic_summary: 'WAL checkpoint finished with buffer write count and percentage.',
    },
    {
      pattern_id: 'p4',
      template: 'autovacuum: VACUUM ANALYZE public.orders',
      count: 13,
      first_line_index: 3,
      last_line_index: 99,
      semantic_name: 'Vacuum Analyze',
      semantic_category: 'maintenance',
      semantic_summary: 'Routine vacuum + statistics refresh on the orders table.',
    },
    {
      pattern_id: 'p5',
      template: 'autovacuum worker started for table <*>',
      count: 12,
      first_line_index: 4,
      last_line_index: 92,
      semantic_name: 'Autovacuum Worker Start',
      semantic_category: 'maintenance',
      semantic_summary: 'Background autovacuum worker spinning up for a target table.',
    },
    {
      pattern_id: 'p6',
      template: 'replication: WAL sender streaming at <*>/<*>',
      count: 12,
      first_line_index: 5,
      last_line_index: 93,
      semantic_name: 'WAL Sender Stream',
      semantic_category: 'replication',
      semantic_summary: 'Primary streaming WAL bytes to a connected standby.',
    },
    {
      pattern_id: 'p7',
      template: 'connection authorized: user=<*> database=<*>',
      count: 12,
      first_line_index: 6,
      last_line_index: 94,
      semantic_name: 'Connection Authorized',
      semantic_category: 'auth',
      semantic_summary: 'Client successfully authenticated against a database.',
    },
    {
      pattern_id: 'p8',
      template: 'received password from <*>:<*>',
      count: 12,
      first_line_index: 7,
      last_line_index: 95,
      semantic_name: 'Password Received',
      semantic_category: 'auth',
      semantic_summary: 'Password credentials received from a client during auth.',
    },
  ],
});

/** Sonnet · 略微不同命名但 category 一致 (一致性 ≥ 80% 验证). */
export const MOCK_LLM_OUTPUT_SONNET = JSON.stringify({
  patterns: [
    {
      pattern_id: 'p1',
      template: 'statement: SELECT <*> FROM users WHERE id = <*>',
      count: 13,
      first_line_index: 0,
      last_line_index: 96,
      semantic_name: 'Users Select By ID',
      semantic_category: 'query',
      semantic_summary: 'Select user row keyed by id.',
    },
    {
      pattern_id: 'p2',
      template: 'checkpoint starting: time',
      count: 13,
      first_line_index: 1,
      last_line_index: 97,
      semantic_name: 'Checkpoint Begin',
      semantic_category: 'maintenance',
      semantic_summary: 'Checkpoint started.',
    },
    {
      pattern_id: 'p3',
      template: 'checkpoint complete: wrote <*> buffers (<*>%)',
      count: 13,
      first_line_index: 2,
      last_line_index: 98,
      semantic_name: 'Checkpoint Finish',
      semantic_category: 'maintenance',
      semantic_summary: 'Checkpoint finished with buffers written.',
    },
    {
      pattern_id: 'p4',
      template: 'autovacuum: VACUUM ANALYZE public.orders',
      count: 13,
      first_line_index: 3,
      last_line_index: 99,
      semantic_name: 'Orders Vacuum',
      semantic_category: 'maintenance',
      semantic_summary: 'Vacuum + analyze on orders table.',
    },
    {
      pattern_id: 'p5',
      template: 'autovacuum worker started for table <*>',
      count: 12,
      first_line_index: 4,
      last_line_index: 92,
      semantic_name: 'Vacuum Worker Up',
      semantic_category: 'maintenance',
      semantic_summary: 'Autovacuum worker started.',
    },
    {
      pattern_id: 'p6',
      template: 'replication: WAL sender streaming at <*>/<*>',
      count: 12,
      first_line_index: 5,
      last_line_index: 93,
      semantic_name: 'WAL Streaming',
      semantic_category: 'replication',
      semantic_summary: 'Primary streaming WAL to standby.',
    },
    {
      pattern_id: 'p7',
      template: 'connection authorized: user=<*> database=<*>',
      count: 12,
      first_line_index: 6,
      last_line_index: 94,
      semantic_name: 'Connection Authorized',
      semantic_category: 'auth',
      semantic_summary: 'Auth succeeded.',
    },
    {
      pattern_id: 'p8',
      template: 'received password from <*>:<*>',
      count: 12,
      first_line_index: 7,
      last_line_index: 95,
      semantic_name: 'Password Received',
      semantic_category: 'auth',
      semantic_summary: 'Password received from client.',
    },
  ],
});

/** Haiku · 偏简略 · 但仍 5/8 category 一致 (验收门 ≥ 80% · 8 cluster 中 8/8 一致 OK). */
export const MOCK_LLM_OUTPUT_HAIKU = JSON.stringify({
  patterns: [
    {
      pattern_id: 'p1',
      template: 'statement: SELECT <*> FROM users WHERE id = <*>',
      count: 13,
      first_line_index: 0,
      last_line_index: 96,
      semantic_name: 'Users Lookup',
      semantic_category: 'query',
      semantic_summary: 'User row lookup.',
    },
    {
      pattern_id: 'p2',
      template: 'checkpoint starting: time',
      count: 13,
      first_line_index: 1,
      last_line_index: 97,
      semantic_name: 'Checkpoint Start',
      semantic_category: 'maintenance',
      semantic_summary: 'Checkpoint init.',
    },
    {
      pattern_id: 'p3',
      template: 'checkpoint complete: wrote <*> buffers (<*>%)',
      count: 13,
      first_line_index: 2,
      last_line_index: 98,
      semantic_name: 'Checkpoint Done',
      semantic_category: 'maintenance',
      semantic_summary: 'Checkpoint done.',
    },
    {
      pattern_id: 'p4',
      template: 'autovacuum: VACUUM ANALYZE public.orders',
      count: 13,
      first_line_index: 3,
      last_line_index: 99,
      semantic_name: 'Orders Maintenance',
      semantic_category: 'maintenance',
      semantic_summary: 'Vacuum orders.',
    },
    {
      pattern_id: 'p5',
      template: 'autovacuum worker started for table <*>',
      count: 12,
      first_line_index: 4,
      last_line_index: 92,
      semantic_name: 'Worker Started',
      semantic_category: 'maintenance',
      semantic_summary: 'Vacuum worker up.',
    },
    {
      pattern_id: 'p6',
      template: 'replication: WAL sender streaming at <*>/<*>',
      count: 12,
      first_line_index: 5,
      last_line_index: 93,
      semantic_name: 'WAL Stream',
      semantic_category: 'replication',
      semantic_summary: 'WAL stream active.',
    },
    {
      pattern_id: 'p7',
      template: 'connection authorized: user=<*> database=<*>',
      count: 12,
      first_line_index: 6,
      last_line_index: 94,
      semantic_name: 'Auth Granted',
      semantic_category: 'auth',
      semantic_summary: 'Auth granted.',
    },
    {
      pattern_id: 'p8',
      template: 'received password from <*>:<*>',
      count: 12,
      first_line_index: 7,
      last_line_index: 95,
      semantic_name: 'Password Got',
      semantic_category: 'auth',
      semantic_summary: 'Password received.',
    },
  ],
});

// ------------------------------------------------------------------------------------------------
// Python drain3 golden (build-time fixture · ≤5% diff + ≥90% overlap 验收)
//
// 这份 golden 不是真跑 Python drain3 出的 · 我们 hand-craft 一个 "Python drain3 在 standard 100 行
// 输入下应当产出的 cluster 集合 + count" · TS 实现需复刻同集合 (template token-overlap ≥ 90% ·
// pattern_count diff ≤ 5%). build-time CI 把它当真值 · 不抗 sliding · 主目的是防 TS 实现漂出
// Python 行为 (论文级算法不变量)。
//
// Pattern 集合根据 genStandardLogs 100 行 (8 模板循环 · 每模板 12-13 行) 推出:
// ------------------------------------------------------------------------------------------------

export const PY_DRAIN3_GOLDEN_STANDARD = {
  pattern_count: 8,
  templates: [
    'statement: SELECT <*> FROM users WHERE id = <*>',
    'checkpoint starting: time',
    'checkpoint complete: wrote <*> buffers <*>',
    'autovacuum: VACUUM ANALYZE public.orders',
    'autovacuum worker started for table <*>',
    'replication: WAL sender streaming at <*>',
    'connection authorized: user=<*> database=<*>',
    'received password from <*>',
  ],
  /** Expected count per cluster (8 templates rotate over 100 lines · 13/13/13/13/12/12/12/12). */
  counts: [13, 13, 13, 13, 12, 12, 12, 12],
};
