# feat-027/#74 SPIKE — MCP client elicitation capability 矩阵与降级决策

> 状态：desk-research（`@modelcontextprotocol/sdk` **1.25.3** 源码实证）+ Claude Code 2.1.150 真实客户端实测（2026-05-26）完成。Claude Desktop / Cursor **仍需人工真实客户端实测确认**（本文档明确标注）。
>
> 关联：issue #74 · 设计 [feat-027 §11.1](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/features/feat-027-L2-mcp-server-plan-mode-enforcement.html) · [ADR-0008](https://github.com/zlxtqbdgdgd/openneon-design/blob/main/docs/adr/0008-plan-mode-elicitation-and-confirm-token-reframe.md) · probe 代码 `landing/mcp-src/server/elicitation-probe.ts`。

## 1. 这份文档回答什么

feat-027 plan mode 走 MCP `elicitInput` 做人工审批（ADR-0008）。最大风险（feat-027 §11 OQ1）：不是所有 MCP client 都支持 elicitation。本 SPIKE 实测目标 client 并定降级策略，回答三个问题：

1. **支持矩阵**：Claude Code / Claude Desktop / Cursor 各自是否声明 elicitation capability、能否真弹给人审批。
2. **失败形态**：client 不支持时 `server.elicitInput` 怎么失败（决定 fail-closed 代码怎么写）。
3. **决策**：维持 ADR-0008 fail-closed，还是触发 ADR-0008 备选（两阶段 token + 人工 out-of-band 取 token）。

## 2. 失败形态（SPIKE AC2 · 已用 SDK 1.25.3 源码实证）

`server.elicitInput({ mode:'form', ... })`（`dist/esm/server/index.js`）对 capability 缺失是**同步抛 `Error`**（请求根本不发出去）：

- form 模式：`if (!this._clientCapabilities?.elicitation?.form) throw new Error('Client does not support form elicitation.')`
- 通用守卫 `assertCapabilityForMethod('elicitation/create')`：`if (!this._clientCapabilities?.elicitation) throw new Error('Client does not support elicitation ...')`

**含义**：fail-closed 实现 = `try { await elicitInput(...) } catch { deny }`。capability 缺失抛错被 orchestrator 捕获即 deny，绝不 fall-through 执行；无须额外探测协议。

**capability 归一化（消除一个误判风险）**：`ElicitationCapabilitySchema`（`types.js`）有 `z.preprocess`——客户端声明的空 `elicitation: {}` 被归一化成 `{ form: {} }`。按稳定版 spec（2025-06-18）只声明 `elicitation: {}` 的 client **不会**被 1.25.3 的 `.elicitation.form` 检查误判为不支持。probe 代码（`elicitation-probe.ts` `classifyElicitation`）复刻了这条归一化规则。

失败形态归类（`classifyElicitFailure`，仅做 audit 归因，任何归类结果都 → fail-closed deny）：

| 归类 | 触发 | server 行为 |
|---|---|---|
| `capability_missing` | SDK 同步抛 "Client does not support [form] elicitation" | deny（fail-closed） |
| `timeout` | `RequestOptions` timeout（默认 300s）→ request reject | deny（fail-closed） |
| `transport` | 连接断 / SSE 流断 | deny（fail-closed） |
| `other` | 其他异常 | deny（fail-closed · 保守） |

## 3. 目标 client 支持矩阵（SPIKE AC1）

| client | elicitation capability | 真弹人审批 | 置信度 | 状态 |
|---|---|---|---|---|
| **Claude Code 2.1.150** | 声明 `{ elicitation: { form: {} }, roots: {} }` | ✅ 真弹 yes/no 审批对话框 · reject + approve 双路径透传 | **高** | **2026-05-26 真实客户端实测通过**（见 §4） |
| **Claude Desktop** | 预期支持（Anthropic 参考 client · elicitation 2025 GA） | 预期 ✅ · 未验证 | 中 | **⚠ 需人工真实客户端实测确认** |
| **Cursor** | 历史滞后 · 不确定是否声明 | 不确定 | 低（最高风险项） | **⚠ 需人工真实客户端实测确认** |

> **必须人工实测的部分**：Claude Desktop 与 Cursor 两行的"是否声明 capability / 是否真弹窗"无法由 server 侧或 desk-research 单方确定 —— 必须用真实客户端连 dev server，按 §5 取证流程跑一遍 approve / reject 双路径，把 `elicitation-probe.ts` 探到的 capability 快照 + 实际弹窗行为记进本表。在此之前，矩阵里 Claude Desktop / Cursor 行的结论是**预期值，非实测结论**。

## 4. Claude Code 2.1.150 实测取证（2026-05-26 · openneon-mcp main + 自托管 dev server）

**传输前提（关键工程依赖）**：`mcp-handler` **1.0.6** streamable HTTP 传输是 stateless（`sessionIdGenerator: void 0`）· 每次 tool call 重建 `McpServer` 实例 · initialize-time 拿到的 `clientCapabilities` 不持久 · `getClientCapabilities()` 在 tool handler 内返回 `null` · 触发 SDK 同步抛 "Client does not support form elicitation" → fail-closed deny。**能跑通 elicitation 的传输是 SSE**（stateful · redis-backed session memory）。

> 注：issue #100 后续引入了 redis-backed `capability-cache`（`landing/mcp-src/server/capability-cache.ts`），用 `(accountId, userAgent)` 作 stable identity 把真 initialize 时的 capability 写 redis，reconnect 拿不到 initialize 时从 cache 注回 `server.server._clientCapabilities`。这把"SSE 重连不重发 initialize 导致 capability 丢失"这一类失败从 fail-closed deny 救了回来，但**不改变** ADR-0008 语义：cache 未命中且 initialize 没来 = 真 fail-closed deny（非软降级）。

**取证 1 · reject path** · traceId `f53ff708-3c5e-4a26-a37c-5485b70e8ac7`：

```
tool call: run_sql · opClass=CREATE_INDEX_CONCURRENTLY
plan mode · attempting elicitation:
  clientCaps: { elicitation: { form: {} }, roots: {} }   ← SSE session 透传成功（contrast: streamable HTTP 此处为 null）
  clientName: claude-code
(3min 26s 后 · 用户在 Claude Code 终端 dialog 里 decline)
plan mode deny:
  failClosed: false          ← 不是降级 · 是真人 decline
  reason: "审批"              ← 用户在 dialog reason 字段输入的文本（content.reason 透回）
```

**取证 2 · approve path** · traceId `af8dedb2-7c4f-42dd-a402-229119c93859`：

```
tool call: run_sql · opClass=CREATE_INDEX_CONCURRENTLY
plan mode · attempting elicitation:（同 clientCaps）
(12s 后 · 用户 accept)
plan mode approved: reason="ok"   ← Verdict 放行 → 进下游 tool 执行
```

**结论**：

1. ADR-0008 "elicitation 是硬限 · 必有人参与 · 不能软降级" 在 Claude Code 上**双路径实证成立**：reject 路径 `failClosed:false` + reason 来自真实用户输入 → 不是 server 编的降级；approve 路径真透传下游 → 不是空跑 stub。
2. **mcp-handler 1.0.6 工程依赖**：streamable HTTP 跑不了 elicitation → 默认 fail-closed deny 所有高危 op。SSE 传输（+ redis）是 ADR-0008 elicitation 路径的工程前提。production 部署必须 SSE + redis 才能拿到"有人审批"能力，否则就是"全部 deny"——结构性正确但 UX 不可用。

## 5. SPIKE AC1 真实客户端实测取证流程（给 Claude Desktop / Cursor 补做用）

按这套跑，把结果填回 §3 矩阵：

1. **部署前提**：dev server 设 `REDIS_URL`（或 `KV_URL`），客户端配置用 SSE 端点 `--transport sse /api/sse?include=all`（**不是** `--transport http /api/mcp` · streamable HTTP 拿不到 capability）。
2. **探 capability**：连上后看 server 日志里 `plan mode · attempting elicitation` 的 `clientCaps` 字段，或调 probe（`probeElicitation(server.server)` · 见 §6）→ 记录 `support` 档位与原始快照。
   - `support === 'none'` → 该 client 确定不支持，矩阵填"不支持 · fail-closed"。
   - `support === 'form' | 'url' | 'form+url'` → 进第 3 步验真弹窗。
   - `support === 'unknown'`（快照不可得）→ 八成是传输/session 问题（回第 1 步确认 SSE + redis），不是 client 不支持。
3. **跑 reject 路径**：让 client 触发高危 op（如 `run_sql("CREATE INDEX CONCURRENTLY ...")`），在弹出的 dialog 里 decline，确认 server 日志 `plan mode deny · failClosed:false`（真人拒，非降级）。
4. **跑 approve 路径**：同上但 accept，确认 `plan mode approved` 且 tool 真执行。
5. **取证**：记 traceId + clientCaps + 两路径结果到 §3 矩阵对应行，置信度升"高 · 实测通过"。

## 6. probe 代码（SPIKE AC1 server 侧自报）

`landing/mcp-src/server/elicitation-probe.ts`：

- `classifyElicitation(caps)`：把 `ClientCapabilities` 快照分类成 `form / url / form+url / none / unknown`，复刻 SDK 1.25.3 空 `elicitation:{}` → form 的归一化。`canElicit` 字段直接给 fail-closed 决策用（`none`/`unknown` → false）。
- `probeElicitation(server.server)`：运行时**非破坏性**读 `getClientCapabilities()` 并分类（纯读 · 不发 `elicitation/create` · 不弹窗）。用于诊断端点 / 日志 / 矩阵实测取证 / capability-cache 命中后复核。
- `classifyElicitFailure(err)`：把 `elicitInput` 抛错归类（`capability_missing / timeout / transport / other`），供 audit 归因。

**与 route.ts 主路径的关系**：生产 fail-closed gate 仍以 `resolvePlanApproval` 的 try/catch 为准（`plan-mode.ts`），route.ts 故意**不预检** `getClientCapabilities()`（streamable HTTP 下快照可能 null 会误判）。本 probe 是**诊断/可观测**工具，不替代主路径：probe 返回 `supported` 不保证一定弹窗成功（传输/session 仍可能丢 capability，见 §4 + issue #100）；probe 的 `none` 才是确定性 fail-closed 结论。

## 7. 决策（SPIKE AC3 · 落锤）

- **维持 ADR-0008 fail-closed**：失败形态（§2）+ 实现模式（§2 + §6）+ 主力 client（Claude Code）实测（§4）四项齐备。client 不支持 elicitation / 超时 / 断连 → deny，绝不 fall-through。
- **不触发 ADR-0008 备选**：备选（两阶段 token + out-of-band 取 token）仅当实测发现 **Claude Desktop 也不支持** elicitation 时才重开讨论。Cursor 单独不支持 → 该 client 高危 op 退化为 deny-only（可接受 · 非全盘备选）。
- **#77 plan mode 解锁 ship**：fail-closed 结构性正确 + Claude Code 主力 client 实测通过。Claude Desktop / Cursor 实测可在后续 client 接入时按 §5 补做（不阻塞 #77 ship）。
- **production 部署前置**：必须 `REDIS_URL`/`KV_URL` set + 客户端用 SSE 端点。streamable HTTP 部署 = 所有 elicitation 走 fail-closed deny（等价禁用所有高危 op）。已加进 ADR-0008 后果列表。

## 8. 待办 / 未实测项（明确清单）

- [ ] **Claude Desktop** 真实客户端实测（按 §5）—— 当前为预期值，非实测。
- [ ] **Cursor** 真实客户端实测（按 §5）—— 最高风险项；若 `support==='none'` 则该 client 高危 op deny-only。
- [ ] 实测后把 §3 矩阵对应行从"⚠ 需人工实测"更新为实测结论 + traceId 取证。
- [ ] 若发现 Claude Desktop 不支持 → 按决策 §7 重开 ADR-0008 备选讨论。
