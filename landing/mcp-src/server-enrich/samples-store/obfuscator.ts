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

import type { RawSample } from './raw-sample';
import type { QuerySample } from './types';
import { computeSignature } from '../plan-store/signature';

export type ObfuscatorMode = 'strict' | 'moderate';

/** 读 OBFUSCATOR_MODE env · 默认 strict (§4)。 */
export function getObfuscatorMode(): ObfuscatorMode {
  return process.env.OBFUSCATOR_MODE === 'moderate' ? 'moderate' : 'strict';
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
    if (ch === '$' && /[0-9]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql[j])) j++;
      const num = Number(sql.slice(i + 1, j));
      if (num > placeholder) placeholder = num;
      out += sql.slice(i, j);
      i = j;
      continue;
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
