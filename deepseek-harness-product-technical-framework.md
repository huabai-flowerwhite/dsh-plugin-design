# DeepSeek Harness 产品与技术框架

> 基于 DeepSeek Harness 官方仓库当前公开文档整理（`docs/architecture*.md`、`docs/user/develop/**`、`docs/cookbook/**`、`docs/upgrade-guide/**`、package README 与源码类型）。本文是技术分析文档，不等同于 DeepSeek 官方规范。
>
> 对齐版本：`dsh-v0.2.1-rc.2`（`master`，commit `687f282`），整理时间 2026-10-23。

## 0. 版本与状态

DeepSeek Harness（`dsh`）由 DeepSeek AI 开源，采用 “everything is a plugin” 架构，由 Cordis 驱动。当前仍处于 **Developer Preview**，官方明确提示未来仍会有破坏兼容性的变更。

### 0.1 与插件开发相关的版本节点

| 版本 | 关键变化（插件视角） |
|---|---|
| `0.1.0-rc.7` | 插件可自注册设置卡片；新增 Codex / Claude Code 子代理、MCP/ACP 图片附件、PTC Mode 嵌套图片转发等 seam |
| `0.1.0-rc.8` | 多模态增强；子代理以 Profile Bundle 形式按需安装；SQLite 后端；品牌规范 |
| `0.1.1-rc.2` | 视觉模型、图像 Files API 复用、沙箱修复 |
| `0.1.5` | `dsh plugin` 安装/升级流程与 profile bundle 选择稳定；`@deepseek-ai/dsh-package-manifest` 统一 `package.json.dsh` 类型；settings card 仍在演进 |
| `0.1.6` / `0.1.7` | package manifest 类型完善；schedule 可选 bundle；transcript 视图迁移；若干 client 修复 |
| `0.2.0` | **移除 runtime invariants**（`@deepseek-ai/dsh-invariants`、`<pkg>/invariant`、`ctx.invariants`）；子路径插件不再读取 `<subpath>/package.json`；schedule bundle 退役；账户登录错误与 Python runtime 调整 |
| `0.2.1` | **`engines.dsh` 优先于 peerDependencies**；`dsh plugin` 的 `--profile` 位置收紧；HMR 下拒绝「已安装再安装」（升级须先 remove）；可选能力改为显式安装与组合；working directory / tool presentation / subagent activation 等升级项 |

### 0.2 常用命令

```bash
dsh --version
dsh --profile web --dump-config          # 查看组合后的插件树
dsh web                                  # 启动 web profile
dsh plugin --profile web add <spec>      # 安装 bundle / 插件包
dsh plugin --profile web remove <name>   # 移除（升级前必须先 remove）
```

桌面端使用由 Electron 托管的 `desktop` profile，CLI 不允许直接 `--profile desktop` 启动或安装；桌面端插件由应用自身管理，或用 profile patch 的 link 方式挂载。

官方仓库：<https://github.com/deepseek-ai/deepseek-harness>

## 1. 产品定位

`dsh` 是 DeepSeek AI 开源的 Agent Harness。官方 README 明确采用 “everything is a plugin” 的架构，并由 Cordis 驱动；模型适配器、工具注册表、Session Log、Agent Loop、Web UI 等都是插件，因而每一部分都可从配置替换，不存在需要打补丁的特权内核。

## 2. 总体架构

```text
DeepSeek Harness
      |
      v
    Cordis（plugin runtime）
      |
      +-- Services（tools / llm / fs / sessions / settings / clientModules ...）
      +-- Typed Events（session/* | agent/* | capability/*）
      +-- Reversible Effects
      |
      +-- Profile / Bundle 组合
      +-- 插件包（package.json.dsh：bundle / profile / client）
      +-- Session / Session Log（append-only）
      +-- System Prompt / Tools / Agent / Agent Loop / LLM
      +-- Subagent / Agent Teams（实验）/ Workflow / Jobs
      +-- Goal / Plan Mode / Compaction / Spill
      +-- FS / Shell / Subprocess / Sandbox
      +-- Settings（namespace + section + plugins tab + config cards）
      +-- Web Client（client modules：settings / chat / tool cards / conversation nodes）
      +-- Plugin Manager / Plugin Market
```

官方架构文档指出：扩展 `dsh` 的方式是把插件挂载到其他插件旁边，各项注册都是副作用，会在其插件卸载时撤销。

## 3. Cordis

Cordis 是 Harness 的插件运行时。插件向共享 Context 提供：

- Service
- Typed Event
- Reversible Effect

关键原则：

> 插件的注册行为必须能够随插件卸载而撤销（`ctx.effect` / disposer）。

插件有三种形态：函数、对象（`export default { name, inject, apply }`）和 `Service` 类。依赖通过 `inject` 声明，框架会等服务就绪后再执行 `apply`；`ctx.inject([...], callback)` 可在插件内部等待**可选**服务出现。

## 4. 插件包、Profile 与 Bundle

一个运行中的 `dsh` 是由有序配置层组合出来的插件树。

- **profile** 是 `$DSH_HOME/profiles/<name>` 下的具名组装：`package.json` 的 `dsh.profile.bundles` 列出组合包，`cordis.patch.yml` 是用户自己的覆盖层。
- **组合包（bundle）** 是 npm 包 + `cordis.patch.yml` 的分发形态：`package.json.dsh.bundle.patch` 指向 patch（字符串或按序数组），patch 里的 row 按包名挂载插件。
- **插件包** 至少声明 `name` / `version`；可有多个角色：bundle、profile、client。

两者都在 `package.json` 的 `dsh` 字段中声明：

```jsonc
{
  "name": "my-plugin",
  "version": "1.0.0",
  "engines": { "dsh": ">=0.2.0 <0.3.0" },
  "exports": {
    ".": "./src/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

### 4.1 Profile 层次叠加顺序

```text
profile 列出的各 bundle（按序）
      |
      v
profile/cordis.patch.yml
      |
      v
$DSH_HOME/cordis.patch.yml
      |
      v
--patch overlay
```

后应用的层按 row 胜出：一条 patch 按 `id` 定位条目并替换其整个 `config`，或插入新条目。`dsh plugin add` 把包加入 `dsh.profile.bundles` 并安装依赖；移除时同时取消选择。

### 4.2 安装与兼容性

```bash
dsh plugin --profile web add ./my-plugin
dsh plugin --profile web add my-plugin@1.2.0
dsh plugin --profile web add github:you/my-plugin
dsh plugin --profile web add ./my-plugin-0.1.0.tgz
```

- `--profile` 必须写在转发的 pnpm 参数之前（0.2.1-alpha.1 起）。
- 安装/启动先看 `engines.dsh`；没有才回退 `@deepseek-ai/dsh*` peerDependencies。
- `engines.dsh` 中出现 `workspace:` 会被判为不兼容；非对象 `engines` 或非字符串 `engines.dsh` 会让清单不可读。
- HMR 下对已安装包再次 `add` 会报 `already-installed`；升级流程是 `remove` → `add`。
- git 安装拉源码，需要 `prepare` 构建；npm / tarball 应带预构建产物。
- 构建脚本需在 profile 的 `pnpm-workspace.yaml` 里用 `allowBuilds` 授权，这是「允许包代码在本机执行」的权限。

### 4.3 插件包展示信息

- `description`：插件管理器卡片摘要。
- `icon`：SVG/PNG/JPEG/WebP，位于包目录内，≤256 KiB。
- 0.2.0 起子路径插件的标题/描述来自 `<subpath>/locale/*.json`，图标来自 `<subpath>/icon` 导出；不再读取 `<subpath>/package.json`。
- 插件市场（Plugin Market）使用独立 JSON 索引，列出 bundle 包、版本、标题、图标与 Git/npm 安装源。

## 5. 核心 Service

| Package | 责任 | Context |
|---|---|---|
| core/session | append-only `SessionEvent` 日志与内存存储 | `ctx.sessions` |
| core/system-prompt | Prompt / tool schema 组装 | `ctx.systemPrompt` |
| core/tools | 作用域化 tool registry / 带把关的执行流水线 | `ctx.tools` |
| core/agent | `Agent` 接口、活跃 agent 注册表、`agent/*` 事件 | `ctx.agents` |
| core/agent-loop | 默认 Agent 驱动器 | `ctx.agentLoop` |
| core/scope | 按 agent 划分作用域的注册原语 | 库（无 ctx 键） |
| llm/llm | message / stream / adapter seam | `ctx.llm` |
| fs/fs | 文件系统 Service Definition（agent 平面） | `ctx.fs` |
| sandbox/sandbox-policy | 每调用沙箱策略（workspaceRoot / mode） | `ctx.sandboxPolicy` |
| settings/settings | 用户设置命名空间与持久化 | `ctx.settings` |
| client/ui-settings | 浏览器设置镜像与组件服务 | `ctx.settingsScope` / `ctx.settingsSchema` |
| client/modules | `dsh.client` 扫描、boot graph、bundle 路由 | `ctx.clientModules` |
| boot/plugin-manager | profile 插件启用/安装/移除 | `ctx.pluginManager` |
| host/webserver | HTTP 路由与 index 注入 | `ctx.webServer` |
| interaction/commands | 人类命令 | `ctx.commands` |
| jobs/jobs | 后台任务 | `ctx.jobs` |
| schedule/schedule | 定时任务 | `ctx.schedule` |
| skill/skill | 技能加载 | `ctx.skills` |
| subagent/subagent | 按名注册的子代理提供方 | `ctx.subagents` |
| workflow/workflow | 动态工作流 | `ctx.workflowEngine` |
| goal/goal | 同会话持久目标 | `ctx.goals` |
| compaction/compaction | 上下文压缩 | `ctx.compaction` |
| spill/spill | 大输出溢出 | `ctx.spill` |

> `fs` / `sandboxPolicy` 等是 **agent 平面**服务：host composition 的全局 context 通常拿不到；工具应在执行时从 `exec.agent.ctx.get(...)` 取。

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

`deriveMessages()` 从日志投影模型历史；fork、resume、transcript、telemetry、persistence 都派生自这条事件流。新增一项模型可见输入就要新增一个会话事件：扩展 `SessionEventMap` 并从日志渲染。第三方插件不能偷偷修改 model-visible state 而不记录。

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
- **Client module provider**（`dsh.client`：每个插件的浏览器半体）
- **Plugin manager / market**（安装、启用、市场索引）

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
| FS / policy | `ctx.fs` 或 `fs/*`（agent 平面） |
| Sandbox | `ctx.sandboxPolicy.resolve()`；spawn 前包装 argv |
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
| 插件配置/设置卡片 | Host `ctx.settings` 命名空间 + Client `ctx.settingsScope`；`settings.section` / `settings.plugins.tab` / `settings.general.item` / `plugins.item`（`ctx.configForms`） |
| 插件安装/启用 | `dsh plugin` CLI 或 `ctx.pluginManager`（Web 插件页 / `plugin_manager` 工具） |
| Web Client Chat 业务节点 | `ConversationNodeDefinition` + `conversation.chat.node` keyed renderer |
| UI（GUI）/ 遥测 | 监听 `session/event`；输入 → `agent.followup()` / `agent.steer()` |
| 插件热重载 | 每个注册都是 `ctx.effect` → 随仓库 HMR 生效 |

## 11. 第三方插件官方契约（0.2.x 摘要）

完整细节见 [`docs/official-plugin-contract-0.2.md`](docs/official-plugin-contract-0.2.md) 与 [`DH-TP-SDK §48`](DeepSeek-Harness-Third-Party-Plugin-SDK-Specification.md)。

| 对象 | 约定 |
|---|---|
| 清单 | `package.json`：`name` / `version` / `description` / `icon` / `engines` / `exports` / `dsh` |
| 兼容性 | `engines.dsh` 优先；无则回退 `@deepseek-ai/dsh*` peer；`workspace:` 在 engines 中非法 |
| 组合包 | `dsh.bundle.patch`（字符串或数组，路径相对包目录） |
| 浏览器半体 | `dsh.client.platform = "web"` + `exports["./client"]` + lazy-CJS factory bundle（`window.__ModuleLoader__.load({ id, factory })`，id = 包名） |
| 共享模块 | 平台基线（react 等）自动可用；其它模块列入 `dsh.client.external`（精确 specifier） |
| Host 入口 | `exports["."]`；插件导出 `apply` / `inject`（或函数 / Service 类） |
| 工具 | `ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })`；`output` 必填 |
| 服务作用域 | `fs` / `sandboxPolicy` 从 `exec.agent.ctx` 取；`webServer` 用 `ctx.inject(['webServer'], ...)` 可选注入 |
| 设置页 | `settings.section`（整页）/ `settings.plugins.tab`（插件区标签页）/ `settings.general.item`（通用行）；配置卡片用 `plugins.item` + `ctx.configForms` |
| 卸载 | 所有注册都随 fiber / `ctx.effect` 反向清理 |

## 12. 0.2.0 / 0.2.1 插件相关破坏性变更

- `@deepseek-ai/dsh-invariants`、所有 `<pkg>/invariant` 子路径、`ctx.invariants` 移除；残留 import / patch 行会加载失败。
- 子路径插件的 `<subpath>/package.json` 展示清单移除；改用 `<subpath>/locale/*.json` 与 `<subpath>/icon`。
- `dsh plugin` 的 `--profile` 只能写在转发参数之前。
- HMR 下安装已安装的包报 `already-installed`；升级必须先 `remove`。
- `engines.dsh` 出现后单独决定兼容性，peer 范围不再放宽/收紧它；`workspace:` 在 engines 中不合法。
- `sdk-minimal` 的五个 invariant 行移除，patch 里 target 它们会报 `entry not found`。
- 可选能力（hooks、webhooks、ralph、badge 等）改为显式安装与组合；只启用被移除的 row 不会自动插入插件。

## 13. 与 dsh-plugin-design 的关系

`dsh-plugin-design`（当前 1.2.3）是本文与 DH-TP-SDK 的参考实现与自动化工具：

- 规则集 `0.2.1` 检查官方 `package.json.dsh`、`engines.dsh`、bundle、client、exports、图标、服务作用域、0.2.0 移除项与源码风险。
- 两阶段工作流：`discover → inspect → analyze → design` 产出 `design.md`；确认后 `approve → backup → apply/migrate → verify → rollback/report`。
- `design.md` 是施工图，不是终点：确认后可以继续修改现有插件、按规范重构，或从零开发新插件。
- UI 恢复：`dshpd_ui_check` 同时检查静态产物（bundle 是否过期、`apply`/`inject`、slot、Host 路由）与运行中的 `clientModules.graph()`（`inGraph` / `rev` / `clientPath`），用于定位“DSH 升级后设置页消失”这类问题。
- UI 提案：插件没有 `dsh.client` 时，`dshpd_design` 自动在 `design.md` 生成「UI 方案建议」（入口、文字线框、数据/路由、实现清单），并返回 `ui.wireframe` 供 Agent 先向用户描述；`design.meta.json` + `UI_EXPECTED` 保证实现阶段真的补上 UI。

## 14. 技术结论

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
Profile / Bundle / 插件包组合
    +
Client Module Graph（Host 与浏览器两个半体）
```

因此插件兼容性的主要风险也集中在这六个边界。相较早期版本，0.2.x 把第三方插件生态收敛到「标准 package.json 清单 + 可安装 bundle + 明确 client 半体 + agent 平面服务」；第三方插件应优先使用这些公开扩展点，而非修改 Core 或依赖 private API。

## 15. 参考链接

- 仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 打包与安装：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md>
- 插件配置：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md>
- 工具开发：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md>
- 设置卡片：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-settings-card.md>
- 客户端模块：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/client-modules.md>
- 插件管理：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md>
- 插件市场：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md>
- 清单类型：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/package-manifest/src/types.ts>
- 升级指南：<https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/upgrade-guide>
