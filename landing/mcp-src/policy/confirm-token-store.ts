/**
 * confirm-token-store.ts · feat-026/#1 · in-memory ConfirmToken 存储 (audit artifact)
 *
 * 设计: https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-026-L2-mcp-server-confirm-token-gate.html (§4 §5 §6)
 *
 * 职责 (ADR-0008 reframe 后):
 * - 颁发的 ConfirmToken 短时驻留 server (默认 TTL 300s · 跟 elicitation timeout 一致) ·
 *   step 7 stage verify 后标 used (single-use) · TTL 过期自动 evict ·
 *   cap 10000 + LRU 兜底 (满则 LRU evict 已过期 token · 全未过期则颁发失败 · 详设 §5 OQ1)。
 * - **不持久化** · server 重启失效 (重启换 HMAC key · outstanding token 全失效 · 详设 §11 OQ1/OQ5)。
 *
 * source 字段:
 * - 'plan-mode-approval' = feat-027 elicitation approve 后颁发 (L1-L3 路径)
 * - 'odd-pre-approved' = L4 ODD/MRC 自动颁发 (feat-049/051 ready 后接通 · L2a stub throw)
 */
import { createHmac, randomBytes, createHash } from 'node:crypto';
import type { OpClass } from '../protection/destructive-detector';

export type ConfirmTokenSource = 'plan-mode-approval' | 'odd-pre-approved';

export type ConfirmToken = {
  id: string;                    // 12 bytes cryptorandom · base64url
  source: ConfirmTokenSource;
  op_class: OpClass;
  args_digest: string;           // sha256(args) first 16 hex · 防 args 篡改 (详设 §6)
  principal: string;             // 'human:<elicitation-responder-id>' | 'system:odd-mrc'
  issued_at: number;             // epoch ms
  ttl_ms: number;                // 默认 300_000 (5 min) · 跟 elicitation timeout 一致
  used: boolean;                 // single-use 标记 (verify 通过后 true)
  hmac: string;                  // HMAC-SHA256(server-key, canonical fields) · 详 computeHmac()
};

/**
 * 对外可见的 token 形态 · 注入 EnforcementCtx · 跨 pipeline stage 传递。
 * 不含 hmac (内部 verify 用) · 不外发给 agent (server-internal · 详设 §6)。
 */
export type ConfirmTokenSnapshot = {
  id: string;
  source: ConfirmTokenSource;
};

/** cap 10000 · 100 op/sec × 300s TTL ≈ 30K · 不够则调 cap (详设 §5 §11 OQ1) */
export const STORE_CAP = 10000;
/** 默认 TTL 5 min · 跟 elicitation timeout 一致 (详设 §5) */
export const DEFAULT_TTL_MS = 300_000;

// HMAC key · 启动期 cryptorandom 32 byte · server 重启换新 · outstanding 全失效 (详设 §6 §11 OQ5)
let HMAC_KEY: Buffer = randomBytes(32);

/**
 * 测试用 · 重置 HMAC key (模拟 server 重启 · 详设 §7 用例 8)。生产代码不调。
 */
export function __resetHmacKeyForTest(): void {
  HMAC_KEY = randomBytes(32);
}

/**
 * 计算 token 的 HMAC-SHA256 (canonical 字符串)。**任一字段变动 hmac 即变** · 防 ctx 篡改 (详设 §6)。
 * canonical = id|source|op_class|args_digest|principal|issued_at|ttl_ms (顺序固定)
 */
export function computeHmac(
  partial: Omit<ConfirmToken, 'hmac' | 'used'>,
): string {
  const canonical = [
    partial.id,
    partial.source,
    partial.op_class,
    partial.args_digest,
    partial.principal,
    String(partial.issued_at),
    String(partial.ttl_ms),
  ].join('|');
  return createHmac('sha256', HMAC_KEY).update(canonical).digest('hex');
}

/** args sha256 first 16 hex · 防"批了 ALTER A 偷偷换 ALTER B" (详设 §6) */
export function computeArgsDigest(args: unknown): string {
  const serialized =
    typeof args === 'string' ? args : JSON.stringify(args ?? null);
  return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}

/** 12 byte cryptorandom · base64url · token id 唯一性极高 (96 bit) */
export function newTokenId(): string {
  return randomBytes(12).toString('base64url');
}

// ─────────────────────────── in-memory store ───────────────────────────

const STORE = new Map<string, ConfirmToken>();

function evictExpired(now: number): void {
  for (const [id, t] of STORE) {
    if (now - t.issued_at > t.ttl_ms) STORE.delete(id);
  }
}

/**
 * 把 token 落 store。cap 满时先 evictExpired · 仍满则 throw (颁发失败 · 详设 §5)。
 * Map.set + size 达 cap 时 LRU evict: Map 迭代顺序 = 插入顺序 · 删第一个 (最旧的) 已过期 token。
 */
export function putToken(token: ConfirmToken): void {
  const now = Date.now();
  if (STORE.size >= STORE_CAP) {
    evictExpired(now);
    if (STORE.size >= STORE_CAP) {
      throw new Error(
        `confirm-token store cap (${STORE_CAP}) 已满且无过期 token 可 evict · 颁发失败`,
      );
    }
  }
  STORE.set(token.id, token);
}

/** 按 id 取 token (不做 TTL/used 校验 · 留给 verify 路径区分 reject reason) */
export function getToken(id: string): ConfirmToken | undefined {
  return STORE.get(id);
}

/** 标记 used (verify 通过后调 · single-use 防重放 · 详设 §7 用例 2) */
export function markUsed(id: string): void {
  const t = STORE.get(id);
  if (t) t.used = true;
}

/** 测试用 · 清 store + 重置 HMAC key (模拟 server 重启 · 详设 §7 用例 8) */
export function __resetStoreForTest(): void {
  STORE.clear();
  __resetHmacKeyForTest();
}

/** 测试用 · 仅清 store · 不换 HMAC key (用于跨用例隔离 · 不模拟重启) */
export function __clearStoreForTest(): void {
  STORE.clear();
}

export function __storeSizeForTest(): number {
  return STORE.size;
}
