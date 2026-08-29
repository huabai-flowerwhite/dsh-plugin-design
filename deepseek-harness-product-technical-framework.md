# DeepSeek Harness 产品与技术框架

> 基于 DeepSeek Harness 官方仓库当前公开文档（`docs/architecture.md` / `architecture.zh.md`、`README.md`、release notes）整理。本文是技术分析文档，不等同于 DeepSeek 官方规范。

## 0. 版本与状态

DeepSeek Harness（`dsh`）由 DeepSeek AI 开源，采用“everything is a plugin”架构，由 Cordis 驱动。当前仍处于 **Developer Preview**，官方明确提示“未来将出现破坏兼容性的变更”。

截至本文整理时（对应 `@deepseek-ai/dsh` 包版本 `0.1.1-rc.2`），近期版本演进如下：

| 版本 | 关键变化 |
|---|---|
| `v0.1.0-rc.7` | 插件可自注册设置卡片（settings card）；Codex/Claude Code 子代理任务接入 Job Panel；MCP/ACP 持久化图片附件与 PTC Mode 嵌套图片转发；DeepSeek 模型新增 `low` 推理强度；英文内置预设 `Code mode` 更名 `PTC mode`；可折叠提问卡片 |
| `v0.1.0-rc.8` | 多模态增强（原生图片请求、`/goal` `/plan` 图文输入、`@` 菜单引用文件/会话）；Claude Code 与 Codex 子代理作为 Profile Bundle 按需安装（非交互权限模式、多命名实例）；Windows PTY 持久 PowerShell；SQLite 后端（存储格式不兼容）；品牌使用规范（“DeepSeek Harness”为注册商标）；Python SDK 覆盖 4 个内置预设 |
| `v0.1.1-rc.1` | DeepSeek 适配器新增多模态视觉模型 `DeepSeek-V4-Flash-Vision-Exp`；修复 Bubblewrap 沙箱 `/proc/<pid>/root` 逃逸；`ask_user_question` 支持多行输入 |
| `v0.1.1-rc.2` | DeepSeek 适配器优先经 Files API 上传图像并复用已上传文件；图像预处理按模型要求自动缩放/转格式 |

官方：
- https://github.com/deepseek-ai/deepseek-harness
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md

## 1. 产品定位

`dsh` 是 DeepSeek AI 开源的 Agent Harness。官方 README 明确采用“everything is a plugin”的架构，并由 Cordis 驱动；模型适配器、工具注册表、Session Log、Agent Loop 等都是插件，因而每一部分都可从配置替换，不存在需要打补丁的特权内核。

## 2. 总体架构

```text
DeepSeek Harness
      |
      v
    Cordis（plugin runtime）
      |
      +-- Services
      +-- Typed Events（session/* | agent/* | capability/*）
      +-- Reversible Effects
      |
      +-- Profile / Bundle 组合
      +-- Session / Session Log（append-only）
      +-- System Prompt / Tools / Agent / Agent Loop / LLM
      +-- Subagent / Agent Teams（实验）/ Workflow / Jobs
      +-- Goal / Plan Mode / Compaction / Spill
      +-- FS / Shell / Subprocess / Sandbox
      +-- Settings（settings namespace + cards）
      +-- Web Client（Conversation Node / Chat renderer）
```

官方架构文档指出：扩展 `dsh` 的方式是把插件挂载到其他插件旁边，各项注册都是副作用，会在其插件卸载时撤销。

## 3. Cordis

Cordis 是 Harness 的插件运行时。插件向共享 Context 提供：

- Service
- Typed Event
- Reversible Effect

关键原则：

> 插件的注册行为必须能够随插件卸载而撤销（`ctx.effect` / disposer）。

## 4. Profile 与 Bundle（组合包）

一个运行中的 `dsh` 是由有序配置层组合出来的插件树。

- **profile** 是存放在 Harness home 中的具名组装：它列出自己叠放的组合包、存放自己安装的树外插件，并保存用户自己的 `cordis.patch.yml`。`web` 与 `headless` 作为模板随发行版交付。
- **组合包（bundle）** 是 Cordis 配置项及其挂载代码的分发格式，它插入的内容始终可被其上各层 patch。

两者都在各自 `package.json` 的 `dsh` 字段中声明：`dsh.profile` 列出一个 profile 的组合包，`dsh.bundle` 指向一个组合包的 patch 文件。

`dsh-base` 是每个 profile 的第一层（模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测）；`dsh-web-app` 增加浏览器应用；`dsh-headless` 增加一次性运行器且完全不带服务器。

层次叠加顺序（应用在空条目列表之上）：

```text
profile 列出的各 bundle（按序）
      |
      v
profile/cordis.patch.yml
      |
      v
home/cordis.patch.yml
      |
      v
--patch overlay
```

一条 patch 按 row id 定位某条目并替换其整个 config，或插入新条目。

查看实际启动树：

```bash
dsh --profile web --dump-config
```

## 5. 核心 Service

| Package | 责任 | Context |
|---|---|---|
| core/session | append-only `SessionEvent` 日志与内存存储 | `ctx.sessions` |
| core/system-prompt | Prompt/tool schema 组装 | `ctx.systemPrompt` |
| core/tools | 作用域化 tool registry / 带把关的执行流水线 | `ctx.tools` |
| core/agent | `Agent` 接口、活跃 agent 注册表、`agent/*` 事件 | `ctx.agents` |
| core/agent-loop | 默认 Agent 驱动器 | `ctx.agentLoop` |
| core/scope | 按 agent 划分作用域的注册原语 | 库（无 ctx 键） |
| llm/llm | message/stream/adapter seam | `ctx.llm` |

## 6. Event 分类

事件即扩展点，选对事件域是大多数改动的第一个决定。

### Session Event

持久事实，append 到日志并通过 `session/event` 广播。适用于必须跨 reload 保留的数据。原始 `assistant/chunk` 事件保证回放与 UI 保真。

### Agent Event

携带活跃 `Agent`：inbox、step、状态、请求、验证、续跑，例如 `agent/*`。用于观察或拦截进行中的工作。

### Capability Event

无需 import 循环即可向某个 seam（`fs/*`、`tools/*`、`telemetry/*`）附加策略和适配器。

官方另提供「事件生产方/消费方映射」文档（`docs/event-producer-consumer.zh.md`）。

## 7. Agent Turn Flow

一个 **step** 是一次模型请求加上它调用的工具；一个 **turn** 包含零个或多个 step。

```text
turn/start
  claim next-step input + one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step                 reject | enter(messages)
     reject / first enter rewritten empty -> close the turn with no step
     step/start
     append entered messages as user/message
     derive model history from the log
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 是持久会话事件；其余分属三个事件域的实时扩展点。`agent/pre-step`、`agent/request`、`llm/stream` 与三个 `tools/*` 是 waterfall（监听器必须调用 `next()` 继续委派）；`agent/turn-stopping` 是 serial 事件（无 `next()`）。

`agent/pre-step` 决定模型看到什么：监听器可以改写已领取消息，也可以拒绝它们；首次领取被拒绝或被改写为空时，仍关闭一个不含 step 的持久轮次，日志会记录这次尝试。

## 8. Session Log

核心原则：

> Model-visible means logged.（模型可见即已记录。）

`deriveMessages()` 从日志投影模型历史；fork、resume、transcript、telemetry、persistence 都派生自这条事件流，并由运行时不变量断言“抵达模型请求的一切都能从日志重建”。

因此，新增一项模型可见输入就要新增一个会话事件：扩展 `SessionEventMap` 并从日志渲染。第三方插件不能偷偷修改 model-visible state 而不记录。

## 9. Capability Seams

一个 capability seam 通常由三个角色组成：

```text
Service Definition
        |
Service Provider
        |
Consumer（通常是面向模型的工具）
```

例如：

- LLM provider
- FS provider
- Shell backend
- Sandbox backend
- **Subagent provider**（`ctx.subagents` 按名注册，同一上下文可共存多个实现：spawn-in-process / fork / acp / codex / claude-code / dsh-sdk）
- **Agent Teams**（实验性，`ctx.agentTeams`：持久 roster + 任务板 + mailbox）
- Tool provider

seam 正是“替换一个提供方就能改变整个产品”的原因：FS 与进程提供方共享同一执行世界，把它们指向远程沙箱也就把 Bash、PTY、LSP 一并搬过去。

## 10. 官方推荐的扩展位置

| 需求 | 扩展机制 |
|---|---|
| 添加模型 Provider | 在 `ctx.llm` 注册 adapter（`registerAdapter(['provider'], adapter)`） |
| 添加模型能力 | 在 `ctx.tools` 注册（`defineTool` 或 raw JSON Schema `ToolDefinition`） |
| Session 独立能力集 | Agent preset / isolate realm |
| Shell | `ctx.shell` backend（本地经 `ctx.subprocess` spawn） |
| Persistent terminal | `ctx.terminals` backend + `dsh-tool-terminal` |
| Human command | `ctx.commands`（无需模型轮次即可分派） |
| Background work | `ctx.jobs`（`job_*` 工具收集/停止；`run_in_background` 工具） |
| FS / policy | `ctx.fs` 或 `fs/*` |
| Sandbox | `ctx.sandbox` backend（消费方 spawn 前包装 argv） |
| Intercept request/tool/turn | `agent/*` / `tools/*`；`agent/turn-stopping` 停止轮次 |
| Model-visible context | `agent.inject()`（落到下一次获准的请求） |
| Durable session state | 扩展 `SessionEventMap` |
| Agent-scoped registration | `agent.ctx` |
| 管理同会话目标 | `ctx.goals`（经 `agent/*` 续跑） |
| Fork 活跃会话 | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| 生成会话标题 | 注册唯一 `ctx.sessionTitle` 提供方 |
| 子代理委派 | `ctx.subagents` 提供方注册表 + `dsh-tool-subagent` |
| 多智能体协作 | `ctx.agentTeams`（实验性显式启用） |
| 动态工作流 | `ctx.workflowEngine` + `workflow` 工具 |
| 上下文压缩 | `ctx.compaction` seam + `dsh-compaction-basic` |
| 插件配置/设置卡片 | `installSettingsSection`（Host）+ `settings.plugin.item`（Client） |
| Web Client Chat 业务节点 | `ConversationNodeDefinition` + `conversation.chat.node` keyed renderer |
| UI（GUI）/ 遥测 | 监听 `session/event`；输入 → `agent.followup()` / `agent.steer()` |
| 插件热重载 | 每个注册都是 `ctx.effect` → 随仓库 HMR 生效 |

## 11. 技术结论

Harness 的核心不是“插件调用 API”，而是：

```text
Cordis Runtime
    +
Capability Seams
    +
Event Pipeline（session/agent/capability 三域）
    +
Session Event Log（model-visible means logged）
    +
Profile / Bundle Composition
```

因此插件兼容性的主要风险也集中在这五个边界。相较早期版本，当前 Harness 新增了大量能力 seam（subagent、agentTeams、workflow、compaction、goal、plan-mode、settings card、conversation node），第三方插件应优先挂载在这些公开扩展点上，而非修改 Core 或依赖 private API。
