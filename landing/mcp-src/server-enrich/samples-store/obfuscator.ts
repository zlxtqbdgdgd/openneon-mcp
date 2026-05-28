/**
 * obfuscator.ts · feat-024/#2 · **唯一** RawSample → QuerySample 转换通路 (OWASP LLM02 主防御)。
 *
 * 详设 §3 脱敏 pipeline 规则 + §7 用例 1-13 + §11 OQ4/OQ5:
 *
 * strict mode (default · production 不可关):
 *   - 所有 numeric literal → $N
 *   - 所有 string literal (含 UUID / timestamp / enum-like) → $N
 *   - 保留 SQL keyword / table / column / function name / operator (schema 信息非 PII)
 *
 * moderate mode (仅明确 schema 无敏感数据时 · 启用记 audit warning):
 *   - 仅替换 string literal · numeric / dates 保留
 *
 * 实现策略 (§9 依赖 libpg-query AST walk 识别 literal):
 *   primary = literal-aware tokenizer —— 只匹配字面量 token 类 (string / number) · 不碰
 *   identifier / keyword / operator / 双引号 quoted identifier。这跟 Datadog obfuscator
 *   `replace_digits` / `replace_strings` 同源,且**确定性、无 WASM 依赖、可单测** (不受 libpg-query
 *   deparse API 版本影响)。
 *   verify (可选 · best-effort) = libpg-query parseSync 验证脱敏后 SQL 仍可 parse (结构未破坏) ·
 *   parse 失败不影响脱敏结果 (脱敏已发生 · 仅记 warn)。
 *
 * fail-closed: 任何无法判定的 token 倾向**不保留原值**风险时,tokenizer 设计上只主动保留
 * identifier/keyword/operator 这类**已知非 PII** 类,其余 (字面量) 一律替换。
 */

import { createHash } from 'node:crypto';
import type { RawSample } from './raw-sample';
import type { QuerySample } from './types';

/**
 * sha256(text) 前 16 hex · 跟 plan-store / T3 / T7 signature 同源 (详设 §4 QuerySample.signature)。
 * plan-store seam 尚未上 (feat-023 L3+) · 这里就近内联一个稳定的 16-hex 实现避免跨 seam 提前耦合;
 * 未来 plan-store seam 上线后,若两边对齐到同一 helper,直接换 import 不影响 store 内既有 signature。
 */
function computeSignature(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export type ObfuscatorMode = 'strict' | 'moderate';

/**
 * 读 OBFUSCATOR_MODE env · 默认 strict (§4)。
 *
 * **production 强制 strict (§6 · OWASP LLM02)**: NODE_ENV==='production' 时无视
 * OBFUSCATOR_MODE 一律返回 'strict' —— production 配 moderate 会让数字字面量逐字泄漏,
 * 这里 fail-closed 强制覆盖 (不给 moderate 生效机会),并 warn 说明被强制。
 * 非 production (dev/staging) 才允许 moderate。
 */
export function getObfuscatorMode(): ObfuscatorMode {
  const requested =
    process.env.OBFUSCATOR_MODE === 'moderate' ? 'moderate' : 'strict';
  if (process.env.NODE_ENV === 'production' && requested !== 'strict') {
    console.warn(
      `[obfuscator] OBFUSCATOR_MODE='${process.env.OBFUSCATOR_MODE}' 在 production 被强制覆盖为 'strict' (feat-024 §6 · OWASP LLM02 · 数字字面量必须脱敏)。`,
    );
    return 'strict';
  }
  return requested;
}

/**
 * 字面量-aware tokenizer 脱敏。返回脱敏后文本 + 替换计数。
 *
 * 识别并替换的 literal token 类:
 *   - 单引号字符串 '...' (含转义 '' · UUID / email / timestamp / enum 都是字符串字面量)
 *   - 数字字面量 (整数 / 小数 / 科学计数 / 可带 :: 类型转换前的值)
 *
 * **保留** (不替换):
 *   - 双引号 quoted identifier "col name" (是 identifier 非字面量)
 *   - 裸 identifier / keyword (SELECT, users, sale_date, ...)
 *   - operator (= > < IN LIKE AND OR ...)
 *   - 占位符 $1 $2 (已是参数化 · 不动)
 *
 * @param mode strict = 替换 string + numeric · moderate = 仅替换 string (numeric/dates 保留)
 */
export function obfuscateText(
  sql: string,
  mode: ObfuscatorMode = 'strict',
): { text: string; redactCount: number } {
  let out = '';
  let i = 0;
  let placeholder = 0;
  let redactCount = 0;
  const n = sql.length;

  const nextPlaceholder = (): string => {
    placeholder += 1;
    redactCount += 1;
    return `$${placeholder}`;
  };

  while (i < n) {
    const ch = sql[i];

    // 已有占位符 $1 $2 → 原样保留 + 推进 placeholder 计数 (避免新占位符冲突)。
    // 注: 先于 dollar-quoted 判断 —— $1 是参数占位符 (数字紧跟 $) · 非 dollar-quote tag。
    if (ch === '$' && /[0-9]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql[j])) j++;
      const num = Number(sql.slice(i + 1, j));
      if (num > placeholder) placeholder = num;
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // dollar-quoted 字符串字面量 (安全 · fail-closed · §3/§11 OQ5):
    //   $$...$$  /  $tag$...$tag$  —— body 内容是字面量 (可含 PII / 密码 / 函数体)。
    //   tag = 合法标识符 (字母/下划线开头 · 后接字母数字下划线 · 不以数字开头)。
    //   到此处的 $ 已排除 $1/$2 占位符 (上一分支先吃)。识别到完整配对的 dollar-quote →
    //   整段 (含两端 $tag$) 替换为单个 $N。判不定 (无配对结束标记) 也 fail-closed:
    //   把从开标记到串尾整段替换 (绝不逐字符原样输出 body · 防明文泄漏)。
    if (ch === '$') {
      // 解析开标记 $tag$。
      let k = i + 1;
      while (k < n && /[A-Za-z0-9_]/.test(sql[k])) k++;
      if (sql[k] === '$') {
        const tag = sql.slice(i, k + 1); // 含两端 $ · 如 "$$" 或 "$body$"
        // 找配对的结束 tag。
        const endIdx = sql.indexOf(tag, k + 1);
        out += nextPlaceholder();
        if (endIdx === -1) {
          // fail-closed: 没有配对结束标记 → 整段 (开标记到串尾) 都当字面量吞掉。
          i = n;
        } else {
          i = endIdx + tag.length;
        }
        continue;
      }
      // 不是 dollar-quote 开标记 (单个 $ 后非 $) → 落到末尾兜底原样输出。
    }

    // 单引号字符串字面量。
    //  - strict: 始终替换 → $N (string 含 UUID/email/timestamp/enum 一律脱敏 · §3/§11 OQ5)
    //  - moderate: 短 enum-like 串 (≤8 char · 纯 [a-z_]) 保留 (诊断 "哪个 status 慢" · §7 用例 8) ·
    //    其余 (email / UUID / 长串) 仍替换 (PII 风险)
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2; // 转义 ''
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      const literal = sql.slice(i, j); // 含两端引号
      const inner = literal.slice(1, -1);
      const isEnumLike = inner.length <= 8 && /^[a-z_]+$/.test(inner);
      if (mode === 'moderate' && isEnumLike) {
        out += literal; // moderate 保留 enum-like 短串
      } else {
        out += nextPlaceholder();
      }
      i = j;
      continue;
    }

    // 双引号 quoted identifier → 保留原样 (是列/表名 · 非字面量)。
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

    // E'...' / e'...' (escape string) → 当字符串字面量替换。
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
      out += nextPlaceholder();
      i = j;
      continue;
    }

    // 数字字面量 → strict 替换 / moderate 保留。
    // 仅当前一个非字母数字 (防把 identifier 里的数字误当字面量 · 如 col1 / md5)。
    if (/[0-9]/.test(ch)) {
      const prev = out.length > 0 ? out[out.length - 1] : '';
      const prevIsIdent = /[A-Za-z0-9_$"]/.test(prev);
      let j = i;
      while (j < n && /[0-9.eE+\-]/.test(sql[j])) {
        // 科学计数 e/E 后只接 +/- 或数字 · 否则停 (防吃掉后面 identifier)。
        if ((sql[j] === 'e' || sql[j] === 'E') && !/[0-9+\-]/.test(sql[j + 1] ?? '')) break;
        if ((sql[j] === '+' || sql[j] === '-') && !/[eE]/.test(sql[j - 1] ?? '')) break;
        j += 1;
      }
      const token = sql.slice(i, j);
      if (prevIsIdent) {
        // identifier 内部的数字 (col1 / x2) → 不是字面量 · 原样保留。
        out += token;
      } else if (mode === 'strict') {
        out += nextPlaceholder();
      } else {
        // moderate: numeric 保留 (§3 / §11 OQ4)。
        out += token;
      }
      i = j;
      continue;
    }

    // 其余 (identifier / keyword / operator / 空白 / 标点) → 原样。
    out += ch;
    i += 1;
  }

  return { text: out, redactCount };
}

/**
 * **唯一** RawSample → QuerySample 转换 (§3 三层防御之运行期唯一通路)。
 * 任何 store 内的 QuerySample 都经过本函数 → store 内永远 0 raw param。
 */
export function obfuscate(
  raw: RawSample,
  projectId: string,
  mode: ObfuscatorMode = getObfuscatorMode(),
): QuerySample {
  const { text, redactCount } = obfuscateText(raw.raw_query, mode);
  const params_obfuscated = Array.from(
    { length: raw.raw_params.length },
    (_, k) => `$${k + 1}`,
  );
  return {
    __brand: 'obfuscated',
    signature: computeSignature(text),
    query_text_obfuscated: text,
    params_obfuscated,
    duration_ms: raw.duration_ms,
    captured_at: raw.captured_at,
    sensitive_redact_count: redactCount,
    projectId,
  };
}

/**
 * 启动期 production guard (§11 OQ7): NODE_ENV=production 且 OBFUSCATOR_MODE !== 'strict'
 * → log error + warn (不 throw · staging 可能复用 production code)。
 * 返回 true 表示检测到不安全配置 (测试断言用)。
 */
export function assertProductionObfuscatorMode(
  log: { error: (m: string) => void; warn: (m: string) => void } = console,
): boolean {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.OBFUSCATOR_MODE !== undefined &&
    process.env.OBFUSCATOR_MODE !== 'strict'
  ) {
    log.error(
      `[obfuscator] OBFUSCATOR_MODE='${process.env.OBFUSCATOR_MODE}' in production · MUST be 'strict' (feat-024 §6 · OWASP LLM02). Falling back to strict at runtime.`,
    );
    log.warn('[obfuscator] production deployment misconfigured OBFUSCATOR_MODE · review deployment manifest');
    return true;
  }
  return false;
}

// ------------------------------------------------------------------------------------------------
// feat-037/#4 · obfuscateLogLine · log pattern 聚类 hybrid path 强制复用 (主备路径都过)
// ------------------------------------------------------------------------------------------------

/**
 * obfuscateLogLine · feat-037/#4 · log line 脱敏 (OWASP LLM02 主防御).
 *
 * 跟 obfuscateText 复用同一个 literal-aware tokenizer · 但针对 log line 调优:
 *   - log 不是 SQL · 不走 libpg-query verify (parseSync 会 fail · log 不是合法 SQL)
 *   - 直接走 obfuscateText 的 fail-closed 字面量替换通路 · 已支持 numeric / string literal /
 *     UUID / timestamp / IP 等替换 ('<>' 占位形如 $N)
 *   - production NODE_ENV='production' 走 getObfuscatorMode() 强制 strict
 *
 * **复用点 (feat-024 T11)**: 跟 search-samples / auto-explain collector 共用同一脱敏通路 ·
 * "raw log 不出 mcp 边界" 这一条 fail-closed 保证由本函数承担。
 *
 * @param line raw log line (含 PII 可能 · numeric / UUID / IP / hostname / SQL 字面量)
 * @returns obfuscated log line (literal token 全 $N · 关键字 / identifier / log structure 保留)
 */
export function obfuscateLogLine(line: string): string {
  const mode = getObfuscatorMode();
  const { text } = obfuscateText(line, mode);
  return text;
}
