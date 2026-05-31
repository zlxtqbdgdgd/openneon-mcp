/**
 * attach-id.ts · feat-068 重设计 (#210) · attach_id 生成 helper
 *
 * 原 newAttachId 在 sidecar.ts (随 bpftrace+sidecar 一起删)。SQL 驱动下仍需 attach_id 串联
 * audit (probe_attached / probe_detached) + rate-limit active 集合 · 抽到独立小文件。
 */
import { randomUUID } from 'node:crypto';

/** uuid helper · attach_id 生成 */
export function newAttachId(): string {
  return `probe-${randomUUID()}`;
}
