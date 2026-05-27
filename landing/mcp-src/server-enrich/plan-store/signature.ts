/**
 * query signature · feat-023/#1 (L2b)。
 *
 * 详设 §3.2 数据契约 + §11 OQ7: signature 算法跟 feat-019 T3 / feat-022 T7 统一 ——
 * `sha256(normalized_query)` 取前 16 hex。
 *
 * 现状对齐 (实施前 grep 结论 · 见 PR 说明): feat-019 T3 handler 本身**没有**沉淀 query signature
 * 实现 (handleExplainPlans 只解析 plan signals · 不算 query 维度的 signature) · feat-022 T7
 * query_signature 是入参 (由上游/调用方给)。因此**本子层是 signature 算法的首个落地点** ·
 * 统一在此定义 normalize + sha256(first 16 hex) · 后续 T3/T7 若要算 signature 复用本 helper
 * (single source · §11 OQ7 "不一致就 align")。
 *
 * normalize 规则 (day-one · 轻量 · 不依赖 AST):
 * - **字面量参数化**: 字符串字面量 / dollar-quoted 串 / 数字字面量 → 统一占位符 `$?`
 * - 已有的 `$1`/`$2` 占位符 → 同样归一为 `$?`
 * - 折叠所有空白为单空格 + trim
 * - 大小写统一为小写 (SQL keyword / identifier 习惯)
 * - 去掉结尾分号
 *
 * **为什么要字面量参数化 (修跨源 signature 不一致 · PR #125 review)**:
 * pg_stat_statements 给的 query 已被 PG 参数化成 `WHERE id=$1` 形态 · 而 on-demand path
 * (feat-019 T3) 拿到的是含字面量的原始 SQL `WHERE id=42`。若只折空白+小写,两者 normalized
 * 文本不同 → sha256 不同 → 同一条逻辑 query 在 background (pg_stat_statements) 与 on-demand
 * 两个来源算出两个 signature · 跨源关联彻底失效。这里把字面量与 `$N` 都归一到同一个
 * 占位符 token `$?` · 让 `id=42` 与 `id=$1` 收敛成同一 normalized 形态 → signature 对齐。
 *
 * tokenizer 思路复用 feat-024 obfuscator 的字面量识别 (单引号串 / dollar-quote / 数字 · 不碰
 * 双引号 quoted identifier / keyword / operator)。这里用统一 `$?` (不编号) · 因为 pg_stat_statements
 * 的占位符编号与 on-demand 参数化的编号未必一致 · 不编号才能让两源对齐。
 *
 * 已知局限: PG14+ pg_stat_statements 会把 `IN (1,2,3)` 这类常量列表合并标注 · 这里逐个字面量
 * 归一成 `$?, $?, $?` · 与之偏细但仍确定 (同一来源内部一致 · 跨源差异仅限常量列表长度不同的 query)。
 */
import { createHash } from 'node:crypto';

const LITERAL_PLACEHOLDER = '$?';

/**
 * 字面量参数化 tokenizer (复用 feat-024 obfuscator 思路): 把字符串 / dollar-quote / 数字字面量
 * 以及已有的 `$N` 占位符统一替换为 `$?` · 保留 identifier / keyword / operator / 双引号标识符。
 */
function parameterizeLiterals(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    // 已有占位符 $1 $2 → 归一为 $? (跨源对齐核心: pg_stat_statements 的 $N 与 on-demand 字面量同形)。
    if (ch === '$' && /[0-9]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql[j])) j++;
      out += LITERAL_PLACEHOLDER;
      i = j;
      continue;
    }

    // dollar-quoted 串 $$...$$ / $tag$...$tag$ → $? (fail-closed: 无配对结束标记则吞到串尾)。
    if (ch === '$') {
      let k = i + 1;
      while (k < n && /[A-Za-z0-9_]/.test(sql[k])) k++;
      if (sql[k] === '$') {
        const tag = sql.slice(i, k + 1);
        const endIdx = sql.indexOf(tag, k + 1);
        out += LITERAL_PLACEHOLDER;
        i = endIdx === -1 ? n : endIdx + tag.length;
        continue;
      }
    }

    // 单引号字符串字面量 (含转义 '') → $?。
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += LITERAL_PLACEHOLDER;
      i = j;
      continue;
    }

    // E'...' / e'...' escape string → $?。
    if ((ch === 'E' || ch === 'e') && sql[i + 1] === "'") {
      let j = i + 2;
      while (j < n) {
        if (sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      out += LITERAL_PLACEHOLDER;
      i = j;
      continue;
    }

    // 双引号 quoted identifier → 原样保留 (是列/表名 · 非字面量)。
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // 数字字面量 → $? (仅当前一个非标识符字符 · 防把 col1 / md5 里的数字误当字面量)。
    if (/[0-9]/.test(ch)) {
      const prev = out.length > 0 ? out[out.length - 1] : '';
      const prevIsIdent = /[A-Za-z0-9_$"]/.test(prev);
      let j = i;
      while (j < n && /[0-9.eE+\-]/.test(sql[j])) {
        if ((sql[j] === 'e' || sql[j] === 'E') && !/[0-9+\-]/.test(sql[j + 1] ?? '')) break;
        if ((sql[j] === '+' || sql[j] === '-') && !/[eE]/.test(sql[j - 1] ?? '')) break;
        j += 1;
      }
      if (prevIsIdent) {
        out += sql.slice(i, j); // identifier 内部数字 · 原样保留
      } else {
        out += LITERAL_PLACEHOLDER;
      }
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/** 轻量 normalize + 字面量参数化 (详见文件头)。 */
export function normalizeQuery(sql: string): string {
  return parameterizeLiterals(sql)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;+\s*$/, '')
    .toLowerCase();
}

/** signature = sha256(normalize(sql)) 前 16 hex (§4 · 跟 T3/T7 统一)。 */
export function computeSignature(sql: string): string {
  return createHash('sha256')
    .update(normalizeQuery(sql))
    .digest('hex')
    .slice(0, 16);
}

/** query_text_sha256 = sha256(原文 SQL) 全长 hex · for T11 (feat-024) 联动区分 (§4)。 */
export function queryTextSha256(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}
