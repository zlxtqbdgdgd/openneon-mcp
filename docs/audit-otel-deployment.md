# Audit log OTel export — collector 部署指南 (feat-031)

> feat-031 把 agent 触发的 destructive ops / 越权尝试 / 高危调用按统一 OTel attribute
> schema 导出到**用户自部署**的 OpenTelemetry collector。本文档说明怎么部署 collector
> 并把 audit 事件接到 Datadog / Grafana / Honeycomb。
>
> 完整 attribute schema(`openneon.audit.*` 命名空间 · 13 类 event_type)+ 跨 mcp/neon
> 内核一致性见 [feat-031 详设 §3.2](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-031-L2-neon-audit-log-otel-export.html)。

## 1. 数据流

```
openneon-mcp (Node)  ──┐
neon pageserver       ─┤
neon compute_ctl      ─┼──> OTLP/HTTP ──> OTel collector ──┬──> audit 后端 (Datadog Log / Loki / Honeycomb)
neon safekeeper       ─┤   (:4318)        (filter 路由)    └──> trace 后端 (APM / Tempo / Jaeger)
neon proxy            ─┘
```

- mcp 侧 + neon 内核 4 组件**共用同一 OTLP endpoint**(`OTEL_EXPORTER_OTLP_ENDPOINT`)。
- collector 端按 **`target=openneon::audit`** 属性把 audit 事件跟普通 trace 分流(详 §3)。
- 一条 `traceparent`(W3C trace context)串起 mcp span + neon 内核 span,DBA 端可 1:1 还原
  "审批 → 颁发 token → 执行 DDL" 全链。

## 2. mcp 侧环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | 用户 collector OTLP/HTTP 端点(自动补 `/v1/traces`) |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | (派生自上一项) | 仅 traces signal 的端点 override |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | 跟 neon `libs/tracing-utils` 一致 |
| `OTEL_SDK_DISABLED` | `false` | 设 `true` 完全禁用 OTel exporter(audit 仍走 winston log · 紧急 unblock) |
| `OTEL_DEPLOYMENT_ENV` | `NODE_ENV` | `deployment.environment` resource attribute |
| `OTEL_EXPORTER_LOCAL_FALLBACK_PATH` | (disabled) | 设为路径后 collector 不可达时同时落本地 JSONL · 100MB rotate |

**fail-safety(非 fail-closed)**:OTLP collector 不可达**不阻塞** tool 调用 —— audit
best-effort,可选 local file fallback 保不丢。金融 / 合规要求 "audit 必有" 的 fail-closed
路径(`OTEL_REQUIRE_EXPORT`)留待 L3+。

## 3. audit-vs-trace 路由原理

所有 audit span 都带属性 `target=openneon::audit`(mcp 侧 `emitAuditEvent` 自动注入 ·
neon 侧 `tracing::info!(target: "openneon::audit", ...)` 经 tracing-opentelemetry 映射)。
collector 用 `filter` processor 按这个属性二路分流:audit 走审计后端,其余走 APM。

## 4. 示例 collector 配置

3 份示例见同目录 `collector-samples/`:

- [`collector-datadog.yaml`](collector-samples/collector-datadog.yaml) — audit → Datadog Logs · trace → Datadog APM
- [`collector-grafana.yaml`](collector-samples/collector-grafana.yaml) — audit → Loki · trace → Tempo
- [`collector-honeycomb.yaml`](collector-samples/collector-honeycomb.yaml) — audit + trace → Honeycomb 不同 dataset

启动(opentelemetry-collector-contrib):

```bash
otelcol-contrib --config ./docs/collector-samples/collector-datadog.yaml
```

## 5. 高频事件抽样

`ddl_executed` / `compute_audit_log_record` 可能高频。**默认 100% 采样**(audit 不抽样 ·
跟金融 audit 一致)。高频场景在 collector 端用 `tail_sampling` processor 抽样,**不改
mcp/neon 代码**(详设 §11 OQ4)。

## 6. 校验

```bash
# 触发一次高危 op(plan mode → approve → confirm token verify → 执行),collector 端应收到:
#   openneon.audit.event_type=plan_mode_approved   principal=human:<dba-id>
#   openneon.audit.event_type=confirm_token_verified  token_id=...
#   (neon 侧) openneon.audit.event_type=ddl_executed  db.system=postgresql
# 三条同一 traceId。
```
