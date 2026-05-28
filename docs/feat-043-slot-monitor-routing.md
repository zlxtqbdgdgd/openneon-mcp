# feat-043 · replication slot inactive 告警 · OTel collector → Slack / PagerDuty 路由 cookbook

> Q4C 拍板：openneon-mcp **仅 emit audit event** · 不内置 Slack / Email / Webhook push (overview §3.6.2 mcp 不内置告警 push 原则)。本 cookbook 教用户在自己的 OTel collector 端把 audit event 路由到目标 channel。

## 0. 前置条件

- openneon-mcp 已 ship feat-031 audit OTel pipeline (`OTEL_EXPORTER_OTLP_ENDPOINT` 已配)
- feat-043 cron 已注册并运行 (启动后看 mcp 日志确认 `replication-slot-monitor` job 已 register)
- 用户已部署 `opentelemetry-collector-contrib` (支持 Slack / PagerDuty exporter contribs)

## 1. 端到端流程

```
openneon-mcp slot-monitor cron
  → emitAuditEvent (feat-031 OTel SDK)
    → BatchSpanProcessor 异步 export
      → OTLP HTTP receiver (collector)
        → filter processor (按 event_type)
          → Slack / PagerDuty exporter
```

3 个新 audit event_type:

| event_type | severity | 路由建议 |
|---|---|---|
| `replication_slot_inactive_warn` | low | Slack `#ops-warn` (24h 工作时间响应) |
| `replication_slot_inactive_critical` | high | Slack `#ops-alert` + PagerDuty (oncall 立即响应) |
| `replication_slot_monitor_cron_summary` | low | (可选) 日志归档 · 不进 Slack 防 spam |

## 2. Step 1 · 部署 collector

按 [feat-031 §3.3 audit-vs-trace 路由文档](audit-otel-deployment.md) 部署 `opentelemetry-collector-contrib` · 配 OTLP HTTP receiver `http://localhost:4318` (跟 mcp `OTEL_EXPORTER_OTLP_ENDPOINT` 一致):

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
```

## 3. Step 2 · 配 filter processor (按 event_type 分流)

```yaml
processors:
  filter/slot_warn:
    spans:
      include:
        match_type: strict
        attributes:
          - key: openneon.audit.event_type
            value: replication_slot_inactive_warn

  filter/slot_critical:
    spans:
      include:
        match_type: strict
        attributes:
          - key: openneon.audit.event_type
            value: replication_slot_inactive_critical

  # 仅 audit 通道 · 防 trace 通道误进 Slack (feat-031 §3.3 audit-vs-trace 路由原则)
  filter/audit_only:
    spans:
      include:
        match_type: strict
        attributes:
          - key: target
            value: openneon::audit
```

## 4. Step 3 · 配 exporter routing

```yaml
exporters:
  slack/warn:
    endpoint: "https://hooks.slack.com/services/<warn-channel-webhook>"
    # warn → Slack #ops-warn (低优先级 · 24h 工作时间响应)

  slack/critical:
    endpoint: "https://hooks.slack.com/services/<critical-channel-webhook>"
    # critical → Slack #ops-alert (高优先级)

  pagerduty/critical:
    routing_key: "<pd-routing-key>"
    # critical 同时推 PagerDuty (oncall 立即响应)

service:
  pipelines:
    traces/slot_warn:
      receivers: [otlp]
      processors: [filter/audit_only, filter/slot_warn]
      exporters: [slack/warn]
    traces/slot_critical:
      receivers: [otlp]
      processors: [filter/audit_only, filter/slot_critical]
      exporters: [slack/critical, pagerduty/critical]
```

## 5. Step 4 · 跨 tenant routing (按 project_id 隔离)

> 关键: audit event 含 `openneon.slot_monitor.project_id` attribute · DBA 端按此字段分流 · 保证 Tenant A 不看到 Tenant B 的 slot alert (feat-043 §3.4 + feat-031 既有 cross-tenant routing pattern)。

用 collector `routing` processor:

```yaml
processors:
  routing/by_project:
    from_attribute: openneon.slot_monitor.project_id
    default_exporters: [slack/default]
    table:
      - value: proj-tenant-a
        exporters: [slack/tenant-a, pagerduty/tenant-a]
      - value: proj-tenant-b
        exporters: [slack/tenant-b, pagerduty/tenant-b]
```

接到 pipeline:

```yaml
service:
  pipelines:
    traces/slot_critical:
      receivers: [otlp]
      processors:
        - filter/audit_only
        - filter/slot_critical
        - routing/by_project
      exporters: [slack/default, slack/tenant-a, slack/tenant-b, pagerduty/tenant-a, pagerduty/tenant-b]
```

## 6. Step 5 · 验证 alert 链路

### 6.1 单测验证 emit 链路 (本仓 fixture)

mcp 详设 §7 fixture case 2/3 可作端到端 mock 验证:

```bash
cd landing && pnpm test:unit -- feat-043-slot-monitor
```

预期：6 case PASS · 含 warn / critical / per-endpoint / cross-endpoint isolation。

### 6.2 生产部署后 24h 真实验证

部署后 24h 内若环境有真实 inactive slot (≥ 24h)：

1. mcp 日志含 `replication_slot_inactive_warn` 或 `_critical` 文字
2. collector 日志 (`--log-level=debug`) 含对应 OTLP span 接收记录
3. 目标 channel (Slack / PagerDuty) 收到 alert

若没收到：

- 查 mcp `OTEL_EXPORTER_OTLP_ENDPOINT` 配对 · collector 端 OTLP receiver 端口对
- 查 `OTEL_EXPORTER_LOCAL_FALLBACK_PATH` (feat-031 fallback) 路径有无 `replication_slot_*` JSON line · 有 = OTel 发出去了 · 链路上某节点过滤掉了
- 查 collector filter processor 的 `match_type` 是不是 `strict` (regexp 误用 strict 会全 miss)

## 7. 噪声调优 (告警量预期)

healthy 环境每周预期：

| event_type | 健康量 | spam 红线 |
|---|---|---|
| warn | 0-20 / week | > 100 / h → 加 collector 端 rate limit |
| critical | 0-5 / week | > 50 / h → 同上 + 调高全局 `critical_inactive_seconds` 到 72h 紧急降噪 |
| cron_summary | 168 / week (每小时 1) | 不路由到 Slack |

降噪手段 (按严重度递增)：

1. `policy.yaml endpoint_overrides[<dev-endpoint>].warn_inactive_seconds = 172800` (单 endpoint 调到 48h)
2. `policy.yaml slot_monitor.disabled_endpoints += <noisy-endpoint>` (整个 endpoint 关 alerts)
3. 全局 `warn_inactive_seconds: 259200` / `critical_inactive_seconds: 604800` (72h / 7d · 紧急降噪 · L3 ship 后调研发现噪声超预期时用)

## 8. 与商用 DBM 对照

| 维度 | Datadog DBM | openneon-mcp feat-043 |
|---|---|---|
| `pg_replication_slots` 原生监控 | **无** (PG-side metric · 不在 query plan / row counter / wait event 类) | 有 (后台 cron 主动巡检) |
| 阈值告警 | 用户自写 dashboard + alert | 双级 24h warn / 36h critical · per-endpoint override |
| 告警路由 | Datadog 内置 (Slack / PagerDuty / Email integration) | OTel collector 端 (用户灵活选) |
| WAL 撑爆磁盘事故防护 | 用户自查 + 自配 | G10 防护栏 ship · audit pipeline 原生兜底 |

## 9. 参考

- [PG pg_replication_slots view 文档](https://www.postgresql.org/docs/current/view-pg-replication-slots.html)
- [feat-031 §3.3 audit-vs-trace 路由](audit-otel-deployment.md)
- [OTel collector contrib · Slack exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/slackexporter)
- [OTel collector contrib · PagerDuty exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/pagerdutyexporter)
- [R10 §3.5 WAL 撑爆磁盘真实事故](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/research/R10/)
- design#53 feat-043 详设 §11 用户 cookbook
