# DeepSeek Harness 第三方插件开发 SDK / 规范

**Document ID:** DH-TP-SDK  
**Version:** 1.2.1  
**Status:** 工程化第三方插件规范（非 DeepSeek 官方标准）  
**对齐的 Harness 版本：** `@deepseek-ai/dsh` `0.2.1-rc.2`（Developer Preview）

> 1.2.1 变更：新增 §48「官方契约对齐（0.2.x 增补）」——`package.json.dsh` / `engines.dsh` / bundle / client factory bundle / 服务平面 / 0.2.0 移除项；§47 保留 0.1.x 落地记录，冲突时以 §48 与官方契约为准。
>
> 1.1.0 变更：对齐 Harness `0.1.1-rc.2` 的真实版本号（原示例中的 `0.8.0`/`0.9.x` 为占位版本，已更正为 `0.1.x`）；新增 goal / subagent / agentTeams / workflow / compaction / settings card / conversation node 等能力 seam 的规范条目。

## 1. 目标

本规范将以下四部分统一为一套可执行的第三方插件标准：

1. 插件兼容性规范
2. 插件安全与 Sandbox 规范
3. 插件测试与认证规范
4. Plugin Manifest 规范

目标是让用户自制插件在 DeepSeek Harness 上实现：

```text
可安装 + 可验证 + 可运行 + 可恢复 + 可卸载 + 可升级 + 可隔离
```

官方参考：

- https://github.com/deepseek-ai/deepseek-harness
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md

> DeepSeek Harness 当前处于 Developer Preview，因此插件必须显式声明 Harness、Cordis API、Node、Profile 兼容范围，并通过兼容性测试。

---

# 2. 规范关键词

| 关键词 | 含义 |
|---|---|
| MUST | 必须 |
| MUST NOT | 严禁 |
| SHOULD | 强烈建议 |
| SHOULD NOT | 不建议 |
| MAY | 可选 |

---

# 3. 核心架构原则

## 3.1 Plugin-first

插件 MUST 通过 Harness/Cordis 的公开扩展机制接入。

优先使用：

```text
Service
Event
Tool
Capability Seam
Bundle
Agent Scope
Session Event
```

禁止：

```text
修改 Core
Monkey Patch
Prototype Patch
修改 globalThis
访问 undocumented private API
```

## 3.2 Capability-first

插件只能使用 Manifest 中声明的 Capability：

```text
LLM / Tool / Session / FS / Shell / Sandbox
Subprocess / Jobs / Terminal / Web
```

## 3.3 Session-first

模型可见状态必须能够从 Session Log 重建：

```text
Plugin State
    |
Session Event
    |
Session Log
    |
deriveMessages()
    |
LLM
```

禁止插件通过纯内存变量偷偷改变模型可见状态。

## 3.4 Reversible

所有 Effect 必须有反向操作：

```text
register -> unregister
subscribe -> unsubscribe
start -> stop
open -> close
spawn -> kill
allocate -> release
```

## 3.5 Least Privilege

默认关闭：

```text
filesystem
network
subprocess
shell
credentials
```

只有 Manifest 显式声明并获得授权后才启用。

---

# 4. Harness 扩展面

官方架构中的典型扩展面：

| 领域 | Extension / Context |
|---|---|
| Session | `ctx.sessions` |
| System Prompt | `ctx.systemPrompt` |
| Tools | `ctx.tools` |
| Agents | `ctx.agents` |
| Agent Loop | `ctx.agentLoop` |
| LLM | `ctx.llm` |
| Agent Scope | `agent.ctx` |
| FS | `ctx.fs` / `fs/*` |
| Sandbox | `ctx.sandbox` |
| Jobs | `ctx.jobs` |
| Commands | `ctx.commands` |
| Terminals | `ctx.terminals` |
| Subagent | `ctx.subagents`（按名注册的多提供方注册表） |
| Agent Teams | `ctx.agentTeams`（实验性，显式启用） |
| Goals | `ctx.goals` |
| Workflow | `ctx.workflowEngine` |
| Compaction | `ctx.compaction` |
| Session Title | `ctx.sessionTitle` |
| Session Fork | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| Model-visible context | `agent.inject()` |
| Settings | `installSettingsSection`（Host）/ `ctx.settingsScope`（Client） |
| Conversation Node | `ConversationNodeDefinition` + `conversation.chat.node` renderer |
| Session event broadcast | `session/event`（+ 扩展 `SessionEventMap`） |

典型 Agent/Event pipeline：

```text
turn/start
   |
agent/pre-step
   |
step/start
   |
agent/request
   |
llm/stream
   |
assistant/*
   |
tool/call
   |
tools/pre-execute
   |
tools/execute
   |
tools/post-execute
   |
tool/result
   |
step/end
```

Waterfall listener MUST 正确调用 `next()`，除非它明确是终止型 interceptor。

---

# 5. Plugin Manifest

每个插件 MUST 提供：

```text
dsh.plugin.yaml
```

标准模板：

```yaml
manifestVersion: 1

plugin:
  id: com.example.dsh.my-plugin
  name: My Plugin
  version: 1.0.0
  description: Example DeepSeek Harness plugin

runtime:
  harness:
    min: 0.1.1-rc.2
    max: "<0.2.0"

  node:
    min: 22
    max: "<25"

cordis:
  apiLevel: 1

capabilities:
  provides:
    - tools.example

  consumes:
    - ctx.tools
    - ctx.sessions

events:
  subscribes:
    - tools/pre-execute

  waterfall:
    - tools/pre-execute

permissions:
  filesystem:
    read:
      - workspace/**
    write:
      - workspace/tmp/**

  network:
    outbound: false
    hosts: []

  subprocess:
    enabled: false

  shell:
    enabled: false

  credentials:
    access: false

resources:
  maxRuntimeMs: 30000
  maxMemoryMb: 512
  maxOutputBytes: 1048576
  maxProcesses: 1
  maxConcurrentTasks: 8

lifecycle:
  unloadable: true
  reversible: true

session:
  modelVisibleState: false
  durableState: false

profiles:
  supported:
    - web
    - headless

security:
  level: S1
  sandboxRequired: true

compatibility:
  apiLevelPolicy: strict
  breakingChangesPolicy: semver
```

---

# 6. Plugin ID

ID MUST 全局唯一。

推荐：

```text
com.vendor.dsh.plugin
io.vendor.dsh.memory
org.example.dsh.search
```

Capability ID：

```text
com.vendor.plugin.tool.search
com.vendor.plugin.service.memory
com.vendor.plugin.command.index
```

禁止：

```text
tools
memory
agent
web
shell
search
```

---

# 7. Runtime Compatibility

插件 MUST 声明：

```text
Harness min/max
Cordis API level
Node min/max
Supported Profiles
```

不得假定未来 Harness 版本自动兼容。

---

# 8. API 隔离规则

允许：

```text
documented Context API
documented Service
documented Event
documented Tool API
documented Capability
```

禁止：

```ts
(ctx as any).privateField
```

禁止：

```ts
Agent.prototype.xxx = ...
```

禁止：

```ts
globalThis.xxx = ...
```

禁止直接依赖内部实现路径。

---

# 9. Service Contract

Service 采用：

```text
Definition
    |
Provider
    |
Consumer
```

推荐：

```ts
interface ExampleService {
  readonly apiVersion: 1;

  execute(input: ExampleInput): Promise<ExampleOutput>;
}
```

Service SHOULD：

- 支持 dependency check
- 支持 shutdown
- 不保存 request-global mutable state
- 提供稳定错误类型
- 提供 API version

---

# 10. Event Contract

普通监听：

```ts
async function listener(ctx) {
  // observe
}
```

Waterfall：

```ts
async function listener(ctx, next) {
  // before
  const result = await next();
  // after
  return result;
}
```

除非明确是 interceptor，否则 MUST NOT 吞掉 `next()`。

---

# 11. Agent Contract

插件 MUST NOT 假设：

```text
1 user message = 1 model request
1 turn = 1 step
```

必须兼容：

```text
Turn
  |
  +-- Step
  |     |
  |     +-- Model Request
  |     +-- Tool Calls
  |
  +-- Step
```

---

# 12. Session Contract

如果插件产生需要：

- resume
- replay
- fork
- transcript
- persistence

的状态，则相关事实 MUST 进入 Session Event。

核心不变量：

```text
model-visible state
==
derivable from session log
```

---

# 13. Tool Contract

标准 Tool：

```ts
interface Tool<I, O> {
  name: string;
  description: string;
  schema: JSONSchema;
  execute(
    input: I,
    context: ToolContext
  ): Promise<O>;
}
```

输入必须：

```text
schema validation
type validation
size validation
permission validation
```

推荐错误码：

```text
PLUGIN_INVALID_INPUT
PLUGIN_PERMISSION_DENIED
PLUGIN_TIMEOUT
PLUGIN_NOT_FOUND
PLUGIN_DEPENDENCY_ERROR
PLUGIN_CANCELLED
PLUGIN_RESOURCE_LIMIT
PLUGIN_INTERNAL_ERROR
```

---

# 14. Tool Schema Versioning

Tool Schema 是模型可见 API。

```text
PATCH
  bug fix

MINOR
  新增 optional field

MAJOR
  删除/重命名 field
  改变 required semantics
  改变行为契约
```

禁止无版本破坏 Schema。

---

# 15. Bundle / Config

原则：

> 如果只是增加能力，就新增自己的 row，而不是替换 Core row。

推荐：

```text
新增 Plugin row
```

高风险：

```text
replace Core row
```

如果必须替换：

- 声明目标 row
- 声明 Harness 版本范围
- 冲突检测
- rollback
- CI 验证

检查最终配置：

```bash
dsh --profile web --dump-config
```

---

# 16. Filesystem Security

默认：

```yaml
filesystem:
  read: []
  write: []
```

推荐：

```yaml
filesystem:
  read:
    - workspace/**
  write:
    - workspace/tmp/**
```

必须防御：

```text
../
absolute path
symlink escape
archive traversal
TOCTOU
```

禁止默认访问：

```text
/etc
~/.ssh
~/.config
credential stores
```

优先使用 Harness FS capability。

---

# 17. Shell / Subprocess Security

默认：

```yaml
subprocess:
  enabled: false

shell:
  enabled: false
```

如必须启用：

```yaml
subprocess:
  enabled: true
  maxProcesses: 2
  timeoutMs: 30000
```

必须：

- timeout
- cancellation
- process quota
- memory quota
- output quota
- cleanup

优先：

```ts
spawn(command, args)
```

避免：

```ts
exec("command " + userInput)
```

---

# 18. Network Security

默认：

```yaml
network:
  outbound: false
```

需要网络时：

```yaml
network:
  outbound: true
  hosts:
    - api.example.com
```

必须：

- host allowlist
- timeout
- response-size limit
- redirect policy
- SSRF protection

必须特别限制：

```text
127.0.0.1
localhost
169.254.169.254
internal DNS
```

---

# 19. Secrets

插件 MUST NOT：

- 将 API Key 写入 Session
- 将 Token 放入 Tool Result
- 将 Credential 放进 model-visible prompt
- 将 Secret 打入普通日志
- 将 Secret 写入异常信息

必须进行 redaction。

---

# 20. Resource Quota

建议：

```yaml
resources:
  maxRuntimeMs: 30000
  maxMemoryMb: 512
  maxOutputBytes: 1048576
  maxProcesses: 4
  maxConcurrentTasks: 8
```

超限：

```text
cancel
cleanup
PLUGIN_RESOURCE_LIMIT
```

---

# 21. Concurrency

插件必须假定存在：

```text
multiple sessions
multiple agents
parallel tool calls
concurrent requests
```

禁止：

```ts
let currentSession;
let currentAgent;
let currentRequest;
```

状态必须绑定：

```text
agent scope
session scope
request scope
```

---

# 22. Lifecycle

标准生命周期：

```text
DISCOVER
  |
VALIDATE
  |
INSTALL
  |
LOAD
  |
START
  |
READY
  |
RUNNING
  |
STOP
  |
UNLOAD
  |
REMOVE / ROLLBACK
```

每个 Effect 必须存在 disposer：

```ts
const dispose = register(...);

return () => {
  dispose();
};
```

必须验证：

```text
load -> run -> unload -> load -> run
```

不能出现：

```text
duplicate listener
duplicate tool
duplicate command
stale state
memory leak
orphan process
```

---

# 23. Cancellation

```text
RUNNING
   |
CANCEL_REQUESTED
   |
CLEANUP
   |
CANCELLED
```

Cancellation 后不得继续产生新的不可逆 side effect。

---

# 24. Permission Model

| Level | 权限 |
|---|---|
| P0 | UI |
| P1 | 普通 Tool |
| P2 | Network / FS |
| P3 | Shell / Subprocess / Credentials |
| P4 | Runtime / Dynamic Code / Agent Interception |

建议：

```text
P0/P1 -> 可自动安装
P2    -> 明示权限
P3/P4 -> 人工确认 + Sandbox
```

---

# 25. Security Level

| Level | 定义 |
|---|---|
| S0 | Pure UI |
| S1 | Tool / Low privilege |
| S2 | Network / FS |
| S3 | Shell / subprocess / credential |
| S4 | Runtime / dynamic code / interception |

S3/S4 SHOULD 使用：

```text
Sandbox
resource quota
manual review
signed artifact
```

---

# 26. 测试规范

## Functional

```text
install
load
start
execute
stop
unload
reinstall
```

## Agent

```text
single turn
multi turn
tool call
parallel tool call
tool failure
retry
cancellation
```

## Session

```text
resume
reload
fork
transcript
replay
```

## Failure

```text
timeout
network failure
invalid input
permission denied
dependency failure
process killed
unload during execution
```

---

# 27. Lifecycle Test

必须验证：

```text
install
  |
load
  |
start
  |
run
  |
stop
  |
unload
  |
load again
  |
run again
```

检查：

```text
duplicate listener = false
duplicate tool = false
duplicate command = false
memory leak = false
stale state = false
orphan process = false
```

---

# 28. Session / Replay Test

```text
original session
      |
persist
      |
restart
      |
resume
      |
compare
```

要求：

```text
model-visible state(original)
==
model-visible state(resumed)
```

---

# 29. Waterfall Test

针对：

```text
agent/pre-step
agent/request
llm/stream
tools/pre-execute
tools/execute
tools/post-execute
```

验证：

```text
A -> B -> C -> Core
```

而不是错误的：

```text
A -> STOP
```

除非 A 明确是 interceptor。

---

# 30. Concurrency Test

至少：

```text
1 concurrent
10 concurrent
100 concurrent
```

组合：

```text
Session A + Session B
Agent A + Agent B
Tool A + Tool B
```

要求无 cross-session contamination。

---

# 31. Compatibility Matrix

至少覆盖：

```text
Harness minimum supported
Harness latest supported
Node minimum
Node latest
web profile
headless profile
```

示例：

| Harness | Node | Web | Headless |
|---|---|---:|---:|
| min | min | PASS | PASS |
| min | latest | PASS | PASS |
| latest | min | PASS | PASS |
| latest | latest | PASS | PASS |

---

# 32. Plugin Combination Test

测试：

```text
Base
Base + A
Base + B
Base + A + B
Base + A + B + C
```

检查：

```text
ID collision
Service collision
Tool collision
Event ordering
Prompt mutation
Session mutation
Config collision
Permission collision
```

---

# 33. Security Test

至少：

```text
path traversal
symlink escape
command injection
SSRF
credential leakage
environment leakage
arbitrary subprocess
resource exhaustion
malformed input
oversized output
cancellation race
```

---

# 34. Static Analysis

CI MUST 检查：

```text
private API imports
prototype patch
global mutable state
undeclared dependency
undeclared permission
undeclared network
undeclared subprocess
```

推荐：

```text
TypeScript
ESLint
Semgrep
Dependency Scanner
SBOM
```

---

# 35. Certification

## Bronze

```text
Manifest
API compatibility
Lifecycle
Functional test
```

## Silver

Bronze +

```text
Session recovery
Concurrency
Security scan
Profile matrix
```

## Gold

Silver +

```text
Plugin combination
Sandbox verification
Resource quotas
Reproducible build
Signed artifact
```

---

# 36. Release Gate

```text
Source
  |
Build
  |
Static Analysis
  |
Manifest Validation
  |
Dependency Validation
  |
API Compatibility
  |
Functional Test
  |
Lifecycle Test
  |
Session / Replay Test
  |
Concurrency Test
  |
Security Test
  |
Combination Test
  |
Certification
  |
Publish
```

---

# 37. P0 拒绝发布条件

任意一项即 REJECTED：

1. Harness 无法启动
2. Agent Loop 永久阻塞
3. Waterfall 无条件吞 `next()`
4. Session 无法恢复
5. model-visible state 无法从 Session Log 重建
6. Plugin 无法 unload
7. unrestricted subprocess
8. workspace escape
9. secret leakage
10. prototype monkey patch
11. global session/agent/request state
12. 使用未声明 private API
13. 未声明 outbound network
14. 未声明 Core Bundle replacement
15. cancellation 后继续执行 side effect
16. 无资源上限导致无限增长

---

# 38. 推荐项目结构

```text
my-dsh-plugin/
├── package.json
├── dsh.plugin.yaml
├── cordis.patch.yml
├── README.md
├── LICENSE
├── src/
│   ├── index.ts
│   ├── plugin.ts
│   ├── service/
│   ├── tools/
│   ├── events/
│   ├── commands/
│   ├── providers/
│   ├── security/
│   └── types/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── lifecycle/
│   ├── session/
│   ├── concurrency/
│   ├── security/
│   └── compatibility/
└── .github/
    └── workflows/
        └── compatibility.yml
```

---

# 39. package.json 建议

```json
{
  "name": "@vendor/dsh-example",
  "version": "1.0.0",
  "type": "module",
  "engines": {
    "node": ">=22 <25"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "compatibility": {
      "apiLevel": 1,
      "harness": ">=0.1.1-rc.2 <0.2.0"
    }
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint .",
    "compatibility": "vitest run tests/compatibility",
    "security": "semgrep --config auto src"
  }
}
```

---

# 40. 最小插件骨架

```ts
export function createPlugin() {
  return {
    id: "com.example.dsh.my-plugin",

    start(ctx) {
      const disposeTool = ctx.tools.register({
        name: "example_tool",
        description: "Example tool",
        schema: {
          type: "object",
          properties: {
            input: { type: "string" }
          },
          required: ["input"]
        },

        async execute(input) {
          return {
            success: true,
            data: {
              echo: input.input
            }
          };
        }
      });

      return () => {
        disposeTool();
      };
    }
  };
}
```

关键模式：

```text
start()
   |
register()
   |
return disposer
```

---

# 41. 黄金规则

1. 不修改 Core。
2. 不使用 Private API。
3. 所有 Effect 必须可撤销。
4. Waterfall 默认调用 `next()`。
5. Model-visible state 必须可从 Session Log 重建。
6. 不使用 global mutable session/agent/request state。
7. Tool Schema 必须版本化。
8. Bundle 优先新增 row，不覆盖 Core row。
9. FS/Shell/Network/Subprocess 必须经过 Capability/Sandbox。
10. 权限必须 Manifest 化。
11. Plugin 必须支持 unload/reload。
12. 未通过 Compatibility + Security + Lifecycle 测试不得发布。

---

# 42. 推荐 CLI

如果将规范产品化，建议提供：

```bash
dsh plugin validate ./my-plugin
dsh plugin test ./my-plugin
dsh plugin security ./my-plugin
dsh plugin compatibility ./my-plugin
dsh plugin certify ./my-plugin
dsh plugin install ./my-plugin
dsh plugin uninstall <plugin-id>
```

最终生成：

```json
{
  "plugin": "com.example.dsh.my-plugin",
  "version": "1.0.0",
  "apiLevel": 1,
  "certification": "silver",
  "status": "passed",
  "securityLevel": "S1",
  "testedHarness": [
    "0.1.x"
  ],
  "profiles": [
    "web",
    "headless"
  ]
}
```

---

# 43. 生态模型

```text
                 DeepSeek Harness
                        |
                     Cordis
                        |
             Official Extension APIs
                        |
             +----------+----------+
             |                     |
             v                     v
       Official Plugins      Third-party Plugins
                                   |
                                   v
                             DH-TP-SDK
                                   |
        +--------------------------+--------------------------+
        |             |             |            |            |
        v             v             v            v            v
     Manifest       API         Security      Testing    Certification
        |             |             |            |            |
        +-------------+-------------+------------+------------+
                                   |
                                   v
                              Plugin Registry
                                   |
                                   v
                              User Install
```

最终：

```text
Plugin != Core Patch

Plugin =
Manifest
+
Capability
+
Event Contract
+
Session Contract
+
Security Policy
+
Lifecycle
+
Compatibility Tests
+
Certification
```

---

# 44. 最终验收 Checklist

```text
[ ] Manifest valid
[ ] Harness version compatible
[ ] Cordis API compatible
[ ] No private API
[ ] No Core modification
[ ] Event contract valid
[ ] Session replay valid
[ ] Tool schema valid
[ ] Lifecycle reversible
[ ] Concurrency safe
[ ] Permissions declared
[ ] Sandbox policy valid
[ ] Resource limits valid
[ ] Security tests pass
[ ] Compatibility matrix pass
[ ] Combination tests pass
[ ] Unload/reload pass
[ ] Documentation complete
```

全部通过后：

```text
CERTIFIED
```

否则：

```text
REJECTED
```

---

# 45. 扩展面新增契约（对齐 Harness 0.1.x）

`0.1.0-rc.7` 起的 Harness 引入了一批新的公开扩展面。第三方插件应优先使用这些 seam，而不是退回修改 Core / private API。以下条目是本规范对它们的补充约定。

## 45.1 Settings Card（插件配置卡片）

自 `0.1.0-rc.7` 起，插件可把自己的配置放进 Web 设置页。路径不需要改动 Harness 仓库：

- **Host 半侧**：注册一个 settings 命名空间（`installSettingsSection(ctx, ns, schema, config, {...})`，来自 `@deepseek-ai/dsh-settings`；命名空间用 `settingsNamespace('my-plugin')` 生成）。带 `role('secret')` 的字段不落入任何响应；`applies: 'restart'` 声明下次启动才生效。
- **Client 半侧**：以命名空间为键在 `settings.plugin.item` slot 注册卡片（keyed slot，`key` = 命名空间），通过 `ctx.settingsScope`（按 revision 设栅）读写配置。

规则：

1. 命名空间只挑一次，并在两个半侧都写出；被服务却无人认领的命名空间不渲染。
2. Client 卡片自行渲染外观与控件，不得跨插件值导入（bundle 纯净度门禁）。
3. `dsh.client` 需声明 `platform` 与可选的 `inject`（依赖的 client 插件）；bundle 必须是 lazy-CJS factory 产物。
4. 只声明插件实际拥有的命名空间，避免污染「插件配置」标签页。

## 45.2 Conversation Node（Web Client Chat 业务节点）

需要向 Web Client Chat 视图贡献业务行的插件，注册 `ConversationNodeDefinition` 与 keyed Chat renderer：

- 先设计**可回放的事件族**：每条事件携带稳定业务 id；`(kind, id)` 最多一条 start；delta 按日志 `seq` 升序回放能确定性产出 State。
- Host 记录事件（扩展 `SessionEventMap`），Client 插件 `ctx.conversationEvents.register(definition)` 并在 `conversation.chat.node` slot 注册 keyed renderer。
- `match(event)` 是身份提取器，`start`/`update` 返回引擎采纳的 State；`publication` 控制物化频率（`immediate` / `animation-frame` / `none`）。

MUST：Definition 的 append 热路径不得遍历整个事件窗口、所有 Context 或已渲染 Node 集合。

## 45.3 Subagent seam

`ctx.subagents` 是**按名注册的多提供方**注册表（不同于单执行器的 shell）。同一上下文可共存 `spawn-in-process` / `fork` / `acp` / `codex` / `claude-code` / `dsh-sdk` 等多个提供方。

- `SubagentCapabilities` 描述提供方启动时能力（`outputSchema` / `depthLimit` / `toolFilter` / `persona`）；请求依赖缺失能力时以类型化错误 `UNSUPPORTED_CAPABILITY` 拒绝，而非接受后静默忽略。
- `SubagentStartRequest` 携带 `parent`（会话 cwd/谱系/深度）、`signal`（唯一取消通道）、可选的 `outputSchema`/`maxDepth`/`toolFilter`/`persona`。
- 消费者是 `dsh-tool-subagent`（委派）、`dsh-tool-subagent-control`（`send_message`/`interrupt_agent`/`list_agents`）、`dsh-tool-subagent-report`（child 侧 `report`）。
- 可继续后台 subagent 是一份持久化子会话 + 至多一个进程内 Activation，不创建 Task。

规则：MUST NOT 假设「1 user message = 1 model request = 1 turn = 1 step」（§11）；MUST 遵守 `signal` 取消。

## 45.4 Agent Teams（实验性）

`ctx.agentTeams` 是**显式启用**的私有协作 seam，在可继续 subagent 之上提供持久 roster、任务板与 mailbox。核心语义：

- `TeamId` 是 Root `SessionId` 的 branded id；`TeamTaskId` 在 Team 内按 `task-<n>` 单调分配；`TeamMessageId` 全局随机。
- 任务通过 compare-and-set（`revision` 递增）变更，`blockedBy` 必须维持无环图；`writeScopes` 是提示性路径前缀而非锁。
- mailbox 由「queued-minus-delivered」构成，只有 target 的 pending inbox 条目或已记录用户消息完成持久化才写独立 ack。

MUST：该 seam 为实验性，插件不得假定其 API 长期稳定；依赖它的插件须显式声明能力范围与降级路径。

## 45.5 Goal / Plan Mode

- **Goal**：`ctx.goals` 管理同会话持久目标；`dsh-goal-round-driver` 经公共 `Agent` 调度同会话 Round；命令/工具生产方分别提供人类/模型控制。同一会话内应使用 goal 工具，而非自建 `let taskState = {}` 保存 model-visible workflow state。
- **Plan Mode**：落日志的 `plan/mode` 状态 + `plan:policy` 引导段 + `/plan` 入口 + 经用户评审的 `exit_plan_mode` 出口；强制约束留在沙箱/审批轴。

## 45.6 Workflow / Compaction / Spill

- **动态工作流**：`ctx.workflowEngine` + worker-thread 引擎 + `workflow` 工具；结构化进程内子任务通过作用域化提示词/工具注册、单调工具守卫、最终 `tools/result` 提交与结构化输出的 `concludeTurn()` 标记来强制输出。
- **上下文压缩**：`ctx.compaction` seam + `dsh-compaction-basic`；自动压力检查在 serial `agent/pre-step`，溢出恢复在 `agent/request-error`。
- **Spill**：`ctx.spill` seam（+ `dsh-spill-local`/`dsh-spill-policy`）；面向模型的中间值执行期间不被持久化，只有外层 `run_code` 日志/结果受可配置输出上限与 spill 流水线约束。

## 45.7 Tool 展示（UI cards）

Tool 的 `output.render` 返回模型可见内容；其 **UI 卡片**是独立关注点，通过 `presentCall(args)` / `presentResult(args, { content, isError, meta? })` 声明（卡片类型 `generic` / `terminal` / `diff` / `search` / `web`）。

硬性规则：

1. 展示方法是**纯函数**（实时流式输出与会话回放都会运行）——不做 I/O、不读会话状态、不用时钟/随机数。
2. UI 格式不进入模型结果：围栏、diff、相对化路径不应仅为服务 UI 而进入规范值或 `output.render` 内容。
3. `output.presentationMeta(args, value)` 从规范值派生可回放 JSON，持久化在 `tool/result` 上；需要结果期事实的卡片（如 diff）用它而非持久化规范值。

## 45.8 Session fork / SessionEventMap / session/event

- **fork**：`ctx.sessions.fork(source, boundary?, childSessionId?)`。
- **扩展 `SessionEventMap`**：任何模型可见输入/持久事实都要新增一个会话事件类型（§12），从日志渲染与回放。
- **`session/event` 广播**：持久事实 append 到日志后经 `session/event` 广播；UI/遥测/外部协议驱动都监听它（`assistant/chunk` 的 `text-delta` 等），输入经 `agent.followup()` / `agent.steer()` 驱动回去。

---

# 46. 规范边界声明

`DH-TP-SDK`、Bronze/Silver/Gold、P0-P4、S0-S4 等名称属于本工程化规范，不代表 DeepSeek 官方已经发布的认证、权限或安全等级。

DeepSeek Harness 官方架构是本规范的技术依据；本规范是在其插件、Cordis、Event、Session、Capability、Profile/Bundle 模型之上增加第三方生态所需的兼容、安全、生命周期和认证约束。

---

# 47. 落地验证：dsh-plugin-design 参考实现

本节记录 `dsh plugin design` 作为本规范的**参考实现**落地后，验证/修正了哪些规范条目。它既是本规范的「可运行样例」，也是本规范与真实 DSH 运行时之间差异的实测记录。

## 47.1 已验证可落地的条目

| 规范条目 | 落地方式 |
|---|---|
| Plugin Manifest（§5） | `dsh.plugin.yaml` 按模板提供 `manifestVersion/plugin/runtime/cordis/capabilities/permissions/resources/lifecycle/session/profiles/security/compatibility` |
| Plugin ID（§6） | `com.example.dsh.plugin-design`（全局唯一、含 vendor 前缀） |
| Tool Contract（§13） | 10 个 `dshpd_*` 工具，`name/description/schema/execute` + 输入校验 |
| Lifecycle / Reversible（§22） | `start → register → return disposer`；工具随 fiber 卸载 |
| Session-first（§12） | 只读分析不写源码；修改前必先备份、失败可回滚 |
| 两阶段门控（§24 权限模型） | `dshpd_approve` 生成 approvalToken，`dshpd_apply` 三重校验（token + backupId + 文件清单） |
| 修改原子性 | `dshpd_apply` 基于 `fs.editText`（`{oldString,newString,replaceAll}`） |
| 恢复 | `dshpd_backup` 快照 + `dshpd_rollback` 恢复 |
| 静态分析（§34） | `dshpd_analyze` 确定性启发式规则（manifest 字段/private API/global state/monkey patch/命令注入/密钥泄漏/waterfall next 等） |
| Bundle 原则（§15） | `cordis.patch.yml` 新增 row，不替换 Core row |

## 47.2 落地时发现、需修正规范假设的条目

1. **ToolDefinition 结构（§40 最小骨架需修正）**：真实 DSH 的 `ToolDefinition` 必须声明 `output: { schema, render }`（`render` 返回 `ContentBlock[]`），`execute(args, exec)` 是双参数（第二参数为执行上下文，含 `signal`），`parameters` 是 JSON Schema。§40 的 `{ name, schema, execute(input) }` 是简化示意，不可直接照抄。
2. **插件加载机制（§42 CLI 是提案，非现状）**：真实 DSH 的第三方插件持久化加载是 **agent preset**（`$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`，行 `name` 支持相对路径/绝对路径/裸包名），而非 `dsh plugin install` CLI。§42 的 CLI 属于「若将规范产品化」的建议，当前 DSH 未提供。
3. **Client 半体门槛（§5 未覆盖）**：client 插件（Settings UI 等）要求 entry 是裸包名 + `package.json` 的 `dsh.client` 声明 + `exports["./client"]` 指向**预构建的 factory-form bundle**。即 Host 半体可「源码直挂」，Client 半体需 npm 包 + 构建工具链（esbuild/rollup），二者门槛不同。
4. **preset 目录必须是物理目录**：agent preset 的发现不 follow junction/symlink（`standingKeyFor` 报 `preset not found`），因此「源码在工作区 + preset 用 symlink 指向」不可行；分发形态应为「自包含目录 + 相对路径」，安装时复制到 `.agent-presets/`。
5. **Settings 入口有两套机制（§45.1 对齐）**：真实 DSH 的 Web 设置页同时存在 `settings.section`（整页设置入口，list slot，`{ id, order, label }`）与 `settings.plugin.item`（插件配置卡片，keyed slot，key = settings 命名空间，配合 Host `installSettingsSection` + Client `ctx.settingsScope`，自 `0.1.0-rc.7` 引入）。前者适合纯说明/工具型页面（参考实现当前采用），后者适合暴露**可持久化配置**（如默认扫描根、安全等级、凭据引用）。§5 的原假设「Settings UI 是 capability-dependent」已被修正：该能力在当前 Harness 真实存在，且提供了两档入口。

## 47.3 参考实现的分发形态

`dsh-plugin-design/` 目录本身即自包含 agent preset：`agent.cordis.yml` 用相对路径 `./src/host.js`，用户下载后整体放入 `$DSH_HOME/.agent-presets/dsh-plugin-design/` 即用（无需 npm 包、无需编译 Host 半体）。

## 47.4 边界

本规范仍是**工程化规范**，Bronze/Silver/Gold、P0–P4、S0–S4 非 DeepSeek 官方认证；`dsh-plugin-design` 的 `dshpd_analyze` 为启发式静态扫描，非权威认证。

---

# 48. 官方契约对齐（0.2.x 增补）

本节记录 2026-10 官方仓库 `dsh-v0.2.1-rc.2` 对第三方插件契约的调整。冲突时**以官方 `package.json.dsh` 为准**；本规范的 `dsh.plugin.yaml` 是附加工程化清单，Harness 运行时不读取。

## 48.1 清单来源

- 官方：`package.json` 的 `name` / `version` / `icon` / `engines` / `exports` / `dsh`。
- `dsh.manifestVersion`（当前 1）、`dsh.bundle.patch`（字符串或有序数组）、`dsh.client`（`platform: "web"`、可选 `inject` / `immediately` / `external`）、`dsh.profile`。
- 本规范的 `dsh.plugin.yaml` 继续用于权限/资源/生命周期/安全等级等工程化声明；缺失时应降级报告，而不是 BLOCKER。

## 48.2 兼容性

1. 有 `engines.dsh` 时单独决定兼容性，忽略 `@deepseek-ai/dsh*` peer。
2. 无 `engines.dsh` 时回退 peer 范围；两者都没有则兼容性不可验证。
3. `engines.dsh` 中出现 `workspace:` 直接判定不兼容；`engines` 非对象或 `engines.dsh` 非字符串会让清单不可读。
4. 不满足时可逐版本豁免：`dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <runtime> --accept-risk`。

## 48.3 安装

- 官方命令：`dsh plugin --profile <p> add <spec>`；`--profile` 必须位于转发的 pnpm 参数之前。
- 升级：先 `remove` 再 `add`；HMR 下对已安装包再次 `add` 会报 `already-installed`。
- 安装成功以 `profile/package.json` 的 `dsh.profile.bundles` 增加包名为准。
- 手写「node_modules 链接 + profile patch」仅作为无 CLI 回退；与 bundle 安装不能同时使用，否则双挂载。

## 48.4 Client 半体

- 声明 `dsh.client` 并导出 `exports["./client"]`；产物必须是 `window.__ModuleLoader__.load({ id, factory })` 的 lazy-CJS，`id` 等于包名。
- 只允许平台基线模块与 `dsh.client.external` 中的精确 specifier；跨插件值导入应在构建期拒绝，改用 cordis service。
- 浏览器半体只挂在「裸包名 row」上；子路径 row 不带 UI。
- 0.2.0 起子路径插件不再读取 `<subpath>/package.json`，改用 locale 文件与 `<subpath>/icon` 导出。

## 48.5 服务平面

- `fs`、`sandboxPolicy` 等为 agent 平面服务；host composition 插件应在工具执行时从 `exec.agent.ctx.get(...)` 取，不要硬 `inject`。
- `webServer` 为 host 平面服务；路由注册应放在 `ctx.inject(['webServer'], ...)` 中，避免 apply 早于服务就绪。
- 工具注册必须声明 `output.schema` 与 `output.render`；`execute(args, exec)` 返回符合 schema 的 JSON 值；只读工具可声明 `isConcurrencySafe`。

## 48.6 0.2.0 移除项（插件相关）

- `@deepseek-ai/dsh-invariants`、所有 `<pkg>/invariant` 子路径、`ctx.invariants`。
- 子路径插件的 `<subpath>/package.json` 展示清单。
- `sdk-minimal` 中五个 invariant 行（`invariants` / `session-invariant` / `agent-invariant` / `scope-invariant` / `agent-loop-invariant`）。

## 48.7 参考实现

`dsh-plugin-design` 1.2.1 的规则集 `0.2.1` 实现了上述检查、受限清单迁移、持久化备份/journal、修改后校验与回滚；详细规则映射见其 `docs/official-plugin-contract-0.2.md`。Bronze/Silver/Gold、P0–P4、S0–S4 仍为本规范的工程化等级，不是 DeepSeek 官方认证。