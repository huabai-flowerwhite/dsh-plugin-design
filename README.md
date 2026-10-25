# dsh plugin design

> DSH 第三方插件维护助手：**先取证，再修改；计划绑定批准，逐字节快照，可恢复部署，独立分发验证。**

一句话：**它先把插件现状、风险和 UI 问题讲清楚，再生成 `design.md` 和精确计划；你批准后，它才按计划修改、校验、部署或打包。**

它特别适合这几类事：

- **第三方插件部署 / 版本适配**：把只在 web 可用、或只兼容旧版 DSH 的插件，按当前契约迁移到目标 profile。
- **桌面端设置页 / 悬浮层 / 面板不出现**：区分 profile、client graph、渲染回执、构建产物、slot 或服务调用问题。
- **插件没有 UI**：先给出一份带文字线框的 UI 方案，你确认后再开发，不强行给所有插件加 UI。
- **改插件但怕改坏**：计划绑定批准、逐字节快照、CAS 写入、分层校验、可回滚。
- **要交付给别人**：审计包内容、生成确定性 `.tgz`、隔离加载、真实 DSH 安装/启动/卸载验证。

> **版本 1.4.4** · 契约基线：官方发布标签 `dsh-v0.2.1-rc.3`（提交 `1f81c04`）
>
> 本机实际验证运行时为 Desktop `0.2.1-rc.3`（Electron 44.7.0 / Node 24.21.0 / win32-x64）。历史 rc.2 交付保留在 `outputs/`，不升级为 rc.3 证据。
>
> 这是**静态预检 + 受控修改**工具，不是安全认证，也不能保证同进程第三方插件永不崩溃。同步死循环、OOM、`process.exit` 等只能在隔离运行环境中验证。
>
> DH-TP-SDK 的 Bronze/Silver/Gold、P0–P4、S0–S4 是工程化等级，不是 DeepSeek 官方认证。

---

## 30 秒判断：你可能正需要它

| 你遇到的现象 | 它怎么帮你 |
|---|---|
| 插件只兼容旧版 DSH | 对照当前契约检查 `engines.dsh`、`dsh` 清单、bundle、client、exports、构建产物 |
| 桌面端设置页没有入口 | 检查目标 profile、安装/启用状态、client graph 和渲染回执 |
| 设置页以前有，升级后消失 | 区分 profile 未挂载、client metadata 负缓存、bundle 过期、slot/路由/服务失效 |
| 插件没有 UI | 在 `design.md` 生成 UI 方案：入口、文字线框、页面区块、数据/路由、实现清单 |
| 想改但怕一改就坏 | 先生成 `planHash`，批准后备份、CAS 修改、分层校验；失败可回滚 |
| 想把插件发给别人 | 审计入口/chunk/assets/worker、生成 `.tgz` 和 SHA-256、隔离加载、真实 Host 验证 |
| 服务名对、功能却静默失效 | 检查服务目录、方法是否用错、以及 apply 时是否过早缓存了 `undefined` |

---

## 一条主线：从证据到可恢复交付

```text
发现 / 检查  →  设计  →  精确计划  →  批准
      →  逐字节快照  →  CAS 修改  →  分层校验
      →  官方部署 / 独立分发  →  隔离验证
```

| 阶段 | 工具 | 产出 |
|---|---|---|
| 发现 | `dshpd_discover` | 目录下插件清单 + 扫描覆盖率 |
| 检查 | `dshpd_inspect` / `dshpd_analyze` | 清单、真实入口、构建产物、规则命中、覆盖率 |
| UI 检查 | `dshpd_ui_check` | bundle、client graph、渲染回执、静态 UI 诊断 |
| 设计 | `dshpd_design` | `design.md`：目标分类、Host/Client 必要性、UI 决策、分发义务 |
| 计划 | `dshpd_plan` | 文件/哈希/操作/profile/运行时 → `planHash` |
| 批准 | `dshpd_approve` | 绑定 `planHash`、身份、有效期、使用次数的批准凭证 |
| 快照 | `dshpd_backup` | 逐字节快照 + schema 2 manifest |
| 修改 | `dshpd_apply` / `dshpd_write` / `dshpd_migrate` | CAS 写入；失败不提交 |
| 校验 | `dshpd_verify` | 分层 PASS / FAIL / UNKNOWN / NOT_RUN |
| 部署 | `dshpd_mount` | 官方 `pluginManager` 调用，或 dry-run 计划 |
| 恢复 | `dshpd_rollback` / `bin/dshpd-recover.mjs` | 校验后恢复；离线可用 |
| 分发 | `dshpd_distribute` | 包审计、确定性 `.tgz`、SHA-256、支持矩阵 |
| 验证 | `dshpd_validate` | 隔离包加载 / 真实 DSH Host 矩阵 |

---

## 目录结构（先认识它）

```text
dsh-plugin-design/
├── install.ps1 / install.sh      # 官方安装封装；-Link 仅开发
├── package.json                  # engines.dsh / dsh.bundle / dsh.client / exports / icon
├── dsh.plugin.yaml               # DH-TP-SDK 工程化清单（运行时可选）
├── cordis.patch.yml              # bundle patch 层
├── bin/dshpd-recover.mjs         # 离线恢复 CLI
├── src/
│   ├── host.js                   # 18 个工具、设置页路由、Host 半体
│   ├── design.js                 # 目标分类、UI 决策、design.md 模板
│   ├── rules.js / services.js    # 规则引擎与 client 服务目录
│   ├── profiles.js               # 本插件自身的 profile 辅助
│   ├── change/                   # plan / approval / snapshot / CAS / journal
│   ├── deploy/                   # 官方 pluginManager 适配器
│   ├── distribution/             # 包审计、tar、导出
│   ├── recovery/                 # 离线恢复
│   ├── runtime/                  # 运行时指纹
│   ├── scan/                     # worker 扫描与预算
│   ├── validation/               # 隔离加载 / Host 矩阵
│   └── client.js                 # Client 半体源码（factory body）
├── lib/client.js                 # 构建产物（不要手改）
├── docs/                         # 契约、UI、服务目录、分发、安全模型
├── updates/                      # rc.3 干净环境验证材料
├── outputs/                      # rc.2 历史交付
└── tests/                        # 103 个用例/子测试
```

- 你主要接触 `src/`、`docs/`、`tests/`、`lib/client.js`；
- 构建产物统一走 `npm run build:client`，不要手改；
- 本插件自己的状态目录默认是 `$DSH_HOME/plugin-design-state`，与被审插件分离。

---

## 核心场景 1：桌面端 UI 不出现

### 先分清“哪一层”坏了

`dshpd_ui_check` 按层判断，不会把“模块存在”当成“UI 已渲染”：

```text
bundle 已提供?          runtime.stages.served
  └─ 否 → 构建 / exports / lib/client.js 问题
module 在 client graph?  runtime.stages.registered
  └─ 否 → profile 未挂载、client metadata 负缓存、重启问题
Client 半体上报 rendered 回执?  runtime.stages.rendered
  └─ 否 → UI 健康为 UNKNOWN，不是 PASS
静态诊断通过?
  └─ buildStale / route / slot / service / eager lookup
```

| 结果 | 含义 |
|---|---|
| `runtime.stages.served=true` | 构建产物存在且可被加载（前置诊断） |
| `runtime.stages.registered=true` | 模块已在运行中的 client graph 里 |
| `runtime.stages.rendered=true` | 加载后的 Client 半体主动上报了渲染回执 |
| `status=PASS` | `registered` 且回执 fresh/rendered；`served` 用于解释“为什么没加载” |

> 重要：rc.3 的 client metadata 有**负缓存**。修改 `dsh.client`、`exports["./client"]`、入口文件或安装新包后，刷新/HMR 不够，必须重启整个 Host/Desktop，再运行 `dshpd_ui_check`。

### 常见静态问题

| 检查 | 处理 |
|---|---|
| `CLIENT_BUILD_STALE` | 重新构建 `lib/client.js`，确认 mtime 晚于源码 |
| `CLIENT_NO_BUILD_SCRIPT` | 补 `build:client` / `prepare`，或改成 factory-body + 包装脚本 |
| `CLIENT_ROUTE_MISSING` | client fetch 的本地路由在 Host 源码中找不到 |
| `WEBSERVER_NOT_INJECTED` | 用 `ctx.inject(['webServer'], ...)` 等待服务 |
| `CLIENT_NO_UI_SLOT` / `LEGACY_SLOT` | slot 名称不匹配或用了旧名字 |
| `CLIENT_STYLES_SERVICE` | 已移除的 `styles.insert` |
| `CLIENT_WORKSPACES_PICKDIRECTORY` | `workspaces` 不是目录选择器，正确是 `uiWorkspace.pickDirectory()` |
| `CLIENT_SERVICE_EAGER_LOOKUP` | apply/顶层缓存非框架服务，把 `undefined` 固化成 `null` |

### 没有 UI 的插件

`dshpd_design` 的 `ui` 模式是 `auto` / `propose` / `off`：

- `auto`（默认）：只有存在用户面需求时才建议 UI；
- `propose`：强制生成 UI 方案；
- `off`：完全不生成 UI 内容。

方案会包含入口、文字线框、页面区块、数据/路由和实现清单，例如：

```text
┌──────────────────────────────┐
│ <插件名> 设置          v0.1.0 │
│ 状态：运行中 / 未配置         │
├──────────────────────────────┤
│ 配置区：字段 A [____]        │
│         字段 B [x]           │
├──────────────────────────────┤
│ [保存] [重载] [查看最近结果] │
└──────────────────────────────┘
```

> 最短路径：在聊天框输入
> `使用 dsh plugin design 检查 <插件路径> 的 UI，告诉我为什么没显示、要怎么修。`
> 先看 `profile`、`inGraph`、`rendered` 三层，再决定是安装/重启、重建 bundle，还是改 slot/服务调用。

更完整的排查见 [docs/client-ui-recovery.md](docs/client-ui-recovery.md)。

---

## 核心场景 2：改插件，但不想改坏

### 先计划，再批准，再执行

```text
dshpd_design  →  dshpd_plan(files, operations, targetProfile)
      →  你审核 design.md 和 plan
      →  dshpd_approve(planHash)
      →  dshpd_backup
      →  dshpd_apply / dshpd_write / dshpd_migrate
      →  dshpd_verify
      →  失败：dshpd_rollback
```

- **批准绑定具体计划**：`dshpd_approve` 必须收到 `dshpd_plan` 返回的同一个 `planHash`；
- receipt 绑定 design 哈希、每个文件基线哈希、操作集合、目标 profile、调用身份、过期时间与使用次数；
- 设计、文件或计划发生变化，旧批准立即失效；
- 授权来自官方 approval 通道（`ctx.get('approval')`，仅 `allowed-once` 放行），或在部署已是 `danger-full-access` 时按权限预设授权并记录依据；
- 策略为 `never` 且沙箱更窄时不签发 token，但仍返回计划与差异。

### 快照是字节，不是文本

- 任一文件失败，整次快照不提交；
- `dshpd_rollback` 先校验全部 payload 哈希，用户已改动的文件保留为冲突，不覆盖；
- 只有全部必需文件恢复并重新哈希通过，才报告 `ROLLED_BACK`。

### 写入方式

| 工具 | 用途 |
|---|---|
| `dshpd_apply` | 单文件字面量替换，CAS 校验 |
| `dshpd_write` | 新建或整文件替换，`create` / `replace` 模式 |
| `dshpd_migrate` | 仅改 `package.json` 的受限迁移，如 `manifest-version` / `engines-dsh` |

`dshpd_migrate` 的 `engines-dsh` 必须显式给出合法范围；它不会自动扩大兼容范围，也不代表该范围已被测试。

---

## 核心场景 3：部署、分发、验证

### 部署

```text
dshpd_mount(packageName, profile, spec)               dry-run
dshpd_mount(..., apply=true, approvalToken=...)       调用官方 pluginManager
```

- 目标 `profile` 是显式参数，不再默认 desktop；
- 只有官方 `pluginManager` 可用时才调用 `installBundle`；
- 服务不可用时**不写 profile**，返回 dry-run 计划和官方命令；
- rc.3 发布版没有 `updateBundle` / `listVersions`，适配器把它们标为 `UNSUPPORTED`，而不是因此判定整个管理器不可用；
- 更新使用带精确 spec 的 `installBundle` 或官方 CLI。

### 分发

```text
dshpd_distribute(mode=audit)                       只读审计
dshpd_distribute(mode=export, outputDir=<dir>)     生成发布材料
dshpd_validate(mode=package-load)                  隔离消费目录加载同一个 tgz
dshpd_validate(mode=dsh-host, cliCommand=[...])    真实 DSH 安装/启动/重启/卸载
```

导出目录包含：`source/`、`package/<name>-<version>.tgz`、`SHA256SUMS`、`FILELIST.json`、`INSTALL.md`、`SUPPORT-MATRIX.md/json`、`BUILD-LOCK.json`、`distribution-report.json`。

报告明确区分本机修改、分发验证、发布准备与实际发布；**本工具不会上传任何内容**。

---

## 怎么用（聊天框，3 步）

### 第 1 步：检查并产出 `design.md`

```text
使用 dsh plugin design 分析 <插件路径>，输出 design.md。
先只分析，不要修改代码。
如果插件没有 UI，请说明是否有用户界面需求，并给出建议。
```

产物：

```text
<插件目录>/.dsh-plugin-design/design.md
```

插件目录不可写时，降级写到 `$DSH_HOME/plugin-design-state`；两个位置都以工具返回的 `designPath` 为准。

`design.md` 会写清楚：现状、契约差异、Host/Client 必要性、UI 决策、修改项、部署/分发义务、验证方式。

### 第 2 步：审核 design 和计划

```text
design.md 已确认。请生成 plan，列出要改的文件、操作、目标 profile；
先不要执行。
```

Agent 会调用 `dshpd_plan`，返回：

- 精确文件集合与当前哈希；
- 允许的操作；
- 目标 profile；
- `planHash`。

你确认后再调用 `dshpd_approve(planHash, 与 plan 相同的 files/designPath)`。**没有批准凭证，不执行修改。**

### 第 3 步：批准后执行并校验

```text
planHash 已确认。请按 approve → backup → apply/write/migrate → verify 执行；
UI 插件再跑 dshpd_ui_check；失败用 dshpd_rollback。
```

执行后：

- 备份在 `$DSH_HOME/plugin-design-state`（可用 `DSHPD_STATE_ROOT` 覆盖）；
- 校验失败或结果不满意，用 `dshpd_rollback` 或离线恢复 CLI；
- 需要部署时再走 `dshpd_mount`；
- 需要发布时再走 `dshpd_distribute` / `dshpd_validate`。

---

## 安装 / 升级

优先使用官方插件管理器（不要先 remove 再 add）：

```sh
dsh plugin --profile <profile> add /path/to/dsh-plugin-design-1.4.4.tgz
```

`install.ps1` / `install.sh` 只是同一命令的封装：

- stdout 与退出码分开；
- 失败时不会先删除已安装版本；
- 不会自动回退到 link；
- `-Link` / `--mode link` 仅供开发，安装后依赖本机源码目录，不能作为分发方式。

安装/升级后需要**重启对应客户端**；rc.3 的 client metadata 负缓存也必须靠重启失效。

本插件自身也可独立分发：`updates/dsh-0.2.1-rc.3/` 记录了 `dsh-plugin-design-1.4.4.tgz` 在 rc.3 干净环境中的验证（无作者源码、无 link、全新 `DSH_HOME`）；`outputs/` 保留 rc.2 历史证据。

---

## 在设置页使用

「设置 → dsh plugin design」提供只读入口：

- **扫描**：列出一个目录下的第三方插件项目，并显示扫描覆盖率；
- **分析**：检查清单、真实入口、构建产物、规则命中、UI 健康与 profile 状态；
- **规范修改**：生成一段带插件路径的聊天框提示词，复制到聊天框继续第 1 步。

设置页的扫描和分析都是只读的，不会修改文件；真正的修改只发生在聊天框第 3 步。

![How‑to Showcase](<How‑to Showcase.png>)

---

# 以下是详细说明（面向开发与排障）

## UI：方案与恢复

### 没有 UI 时

`dshpd_design` 默认 `ui: "auto"`，只有存在用户面需求时才建议 UI；`propose` 强制生成，`off` 完全关闭。

工具结果与 `design.meta.json` 会记录：

- `ui.expected`；
- `ui.mode`；
- `ui.entry` / `ui.title`；
- 是否需要后续 `UI_EXPECTED` 校验。

用户确认后按 `M-UI-*` 实施：

1. `package.json` 增加 `dsh.client` / `exports["./client"]` / `files`；
2. 新增 `src/client.js` 与构建脚本，产出 factory-form `lib/client.js`；
3. Host 增加状态/配置路由（`ctx.inject(['webServer'], ...)`）；
4. client 注册 `settings.section`（或 design 确定的其它座位）；
5. 重新构建 → 重启 → `dshpd_ui_check` → `dshpd_verify`。

如果明确不需要 UI，告诉 Agent“不做 UI”，或传 `ui: "off"`。

### 已经有 UI 时

`dshpd_ui_check` 返回：

- `runtime.stages.served`：构建产物是否可加载；
- `runtime.stages.registered`：模块是否在 client graph；
- `runtime.stages.rendered`：是否收到 Client 半体的渲染回执；
- `status`：PASS / FAIL / UNKNOWN / NOT_APPLICABLE；
- `services` / `unknownServices` / `legacyServices` / `eagerLookups`；
- 静态问题列表。

UI 健康判定：

```text
served 是前置诊断（bundle 在不在）
registered && fresh rendered  → PASS
缺 rendered 回执               → UNKNOWN
```

> `registered=true` 只表示“模块已提供”，不等于“UI 已渲染”。

### 服务与时机

| 规则 | 说明 |
|---|---|
| `CLIENT_WORKSPACES_PICKDIRECTORY` | `workspaces` 是 controller，目录选择器在 `uiWorkspace.pickDirectory()` |
| `CLIENT_SERVICE_EAGER_LOOKUP` | apply/顶层缓存非框架服务，会把 `undefined` 固化成 `null` |
| `CLIENT_UNKNOWN_SERVICE` | `ctx.get('...')` 不在当前 client 服务目录（第三方自定义服务可忽略） |
| `CLIENT_LEGACY_SERVICE` | 已知已移除服务；`styles` 仍用 `CLIENT_STYLES_SERVICE` |

框架服务（`slots` / `loader` / `logger` / `effect` / `on` / `inject` 等）在 apply 时保证可用，不按 eager lookup 报。延迟 helper 与参考 getter 也不会被误报。

服务目录快照与更新流程见 [docs/service-catalog-0.2.1.md](docs/service-catalog-0.2.1.md)。

## 安全变更：计划、批准、快照

### 计划

`dshpd_plan` 是只读的，返回：

- 规范化后的插件根目录；
- `design.md` 哈希；
- 每个文件的当前哈希、版本、是否存在；
- 允许的操作集合；
- 目标 profile；
- 运行时指纹；
- 确定性 `planHash`。

任何文件、design 或操作集变化都会改变 `planHash`，旧批准自动失效。

### 批准

`dshpd_approve` 要求：

- 显式用户同意；
- 与 `dshpd_plan` 完全一致的 `planHash`；
- 有效期与使用次数；
- 操作的调用身份。

授权通道：

- 官方 approval 服务（`ctx.get('approval')`，仅 `allowed-once`）；
- 部署已经是 `danger-full-access` 时，按权限预设授权并记录依据；
- 策略 `never` 且沙箱更窄时不签发 token（仍返回计划与差异）。

### 快照与回滚

- 快照是逐字节的，不是文本 diff；
- 任一文件失败，整次快照不提交；
- 回滚先校验所有 payload 哈希；
- 用户已改动的文件保留为冲突，不覆盖；
- 全部必需文件恢复并重新哈希通过，才报告 `ROLLED_BACK`。

## 扫描与规则

目录遍历、读取和规则执行在 worker 中完成，预算包括：

- 单文件 2 MiB；
- 总字节 64 MiB；
- 文件/目录数上限；
- 30 秒墙钟；
- 并发队列。

超时或超限返回 `INCOMPLETE`，不会当成“没问题”。`discover` / `inspect` / `analyze` 都报告实际扫描覆盖率。

规则覆盖：

- 官方 `package.json.dsh`、`engines.dsh`、bundle、client、exports、图标、`type: module`、npm `files`；
- 0.2.0 移除项（invariants、子路径 manifest）；
- Host 入口、真实构建产物、lockfile；
- UI 构建/路由/slot/服务/时机；
- 安全与生命周期风险；
- DH-TP-SDK 工程化清单。

SemVer 使用 `includePrerelease: true` 的官方语义（内置实现与 semver 7.8.5 差分测试 435 例）；运行时未知时兼容性为 `UNKNOWN`，不是通过。

## DSH 0.2.1-rc.3 已知行为

- **Manager 能力**：rc.3 发布版公开 `listBundles` / `listPlugins` / `installBundle` / `removeBundle` / `setBundleEnabled` / `setPluginEnabled` / `inspect` / `registries` / `waitForInstall` / `cancelInstall`，但**没有** `updateBundle` / `listVersions`。
- **Client metadata 负缓存**：rc.3 的 `client-modules` 按 loader specifier + baseUrl 缓存包元数据，包含“这不是 Client 包”的负结果，直到 Host/Desktop 重启才失效。
- **真实 renderer 证据**：已在 rc.3 Web Host + 无头 Chromium 中打开真实 UI，验证设置页、扫描、分析、问题渲染、错误提示与 client-health 回执。
- **未验证项**：真实 Desktop 窗口/preload/原生目录选择仍未验证；HTTP 200、无窗口 Web Host、React stub 都不能替代真实桌面交互，未实测组合保持 `NOT_RUN`。

## 工具清单（18 个）

| 阶段 | 工具 | 作用 |
|---|---|---|
| 发现 | `dshpd_discover` | 目录下插件清单与扫描覆盖率 |
| 检查 | `dshpd_inspect` | 清单、真实入口、构建产物 |
| 检查 | `dshpd_analyze` | 规则命中、契约快照、评分、覆盖率 |
| UI | `dshpd_ui_check` | bundle / graph / 渲染回执 / 静态 UI 诊断 |
| 设计 | `dshpd_design` | `design.md` + UI 决策 + 部署/分发义务 |
| 计划 | `dshpd_plan` | 精确文件/哈希/操作/profile → `planHash` |
| 批准 | `dshpd_approve` | 绑定 `planHash` 的批准凭证 |
| 快照 | `dshpd_backup` | 逐字节快照 + schema 2 manifest |
| 修改 | `dshpd_apply` | 单文件字面量替换 + CAS |
| 修改 | `dshpd_write` | 新建/整文件替换 + CAS |
| 修改 | `dshpd_migrate` | 受限 `package.json` 迁移 |
| 部署 | `dshpd_mount` | 官方 `pluginManager` 或 dry-run |
| 校验 | `dshpd_verify` | 分层 PASS/FAIL/UNKNOWN/NOT_RUN |
| 恢复 | `dshpd_rollback` | 校验后回滚；冲突保留 |
| 状态 | `dshpd_status` | 任务、备份、journal、遗留状态 |
| 报告 | `dshpd_report` | 备份、修改、校验、前后分析 |
| 分发 | `dshpd_distribute` | 包审计、导出、确定性 tgz |
| 验证 | `dshpd_validate` | 隔离加载 / 真实 Host 矩阵 |

## 恢复 CLI

```sh
node bin/dshpd-recover.mjs --state-root <state-root> --list
node bin/dshpd-recover.mjs --state-root <state-root> --verify <backupId>
node bin/dshpd-recover.mjs --state-root <state-root> --preview <backupId>
node bin/dshpd-recover.mjs --state-root <state-root> --restore <backupId> --yes
node bin/dshpd-recover.mjs --state-root <state-root> --operations
node bin/dshpd-recover.mjs --undo-enable --dsh-home <dir> --profile web <package>
```

状态目录默认是 `$DSH_HOME/plugin-design-state`，独立于被审插件，可用 `DSHPD_STATE_ROOT` 覆盖。

旧版放在插件目录里的 `.dsh-plugin-design` 只作为**不可信导入材料**：`dshpd_status` 会显示它，但不会自动恢复。

退出码：`0` 成功，`1` 失败/完整性不通过，`2` 部分恢复或冲突，`64` 用法错误。`--undo-enable` 只打印官方卸载计划，不修改 profile。

## 兼容性

- 本插件 `engines.dsh` 为 `>=0.1.5-rc.1 <0.3.0`，覆盖 rc.2 与 rc.3；
- 契约基线：`dsh-v0.2.1-rc.3`（提交 `1f81c04`）；
- 本机验证：Desktop `0.2.1-rc.3` / Electron 44.7.0 / Node 24.21.0 / win32-x64；
- 未列出的组合不是已支持；详见 `SUPPORT-MATRIX.md`。

## 测试

```sh
node --test
node scripts/build-client.mjs --check
node scripts/recovery-drill.mjs <output-dir>
node scripts/clean-env-matrix.mjs --cli-json-file <cli.json> --tgz <pkg.tgz> --probe /path
```

测试包含 **103 个用例/子测试**：修改事务安全（计划绑定、身份、design 漂移、越界、junction、CAS、部分快照、篡改回滚、冲突、journal 恢复）、worker 扫描预算与取消、SemVer 差分、部署适配（含 rc.3 缺 `updateBundle`/`listVersions` 的能力协商）、分发审计与负例、隔离包加载、离线恢复、安装器退出码。

真实 DSH 与干净环境证据单独记录，不用单元测试代替。

## 已知限制

- 静态规则是启发式预检；命中不等于必然崩溃，未命中也不等于安全。
- 同进程 Host/Client 插件仍可能阻塞或终止宿主；隔离运行需要外部监督进程、独立账户或 VM/容器，临时 `DSH_HOME` 不是 OS 沙箱。
- Client 渲染回执依赖插件自己的 Client 半体发送；没有回执就是 UNKNOWN。
- 文件创建可回滚记录为“需人工删除”（公开 `ctx.fs` 没有删除操作）。
- `dshpd_validate(mode=dsh-host)` 需要显式 CLI argv，不能从插件内部安全猜测。
- 已测试矩阵见 `SUPPORT-MATRIX.md`；未列出的组合不是已支持。

## 1.4.4 更新要点

- **计划绑定批准**：`dshpd_plan` → `dshpd_approve(planHash)`；design/文件/计划变化后旧批准失效。
- **逐字节快照 + CAS**：`dshpd_backup` / `dshpd_apply` / `dshpd_write` / `dshpd_rollback`，失败不提交。
- **官方部署**：`dshpd_mount` 只调用 `pluginManager`；不可用时 dry-run，不直接写 profile。
- **分发与验证**：`dshpd_distribute` / `dshpd_validate`，确定性 tgz、SHA-256、隔离加载、真实 Host 矩阵。
- **扫描移出主线程**：worker、预算、`INCOMPLETE`。
- **UI 健康分层**：`bundleServed` / `inGraph` / `rendered`，无回执为 UNKNOWN。
- **rc.3 适配**：Manager 缺失 `updateBundle` / `listVersions` 报 `UNSUPPORTED`；client metadata 负缓存需重启。
- **1.4.4 修复**：`npm test` 下运行时指纹误取插件自身版本。

## 更多文档

- [官方插件契约（0.2.x）与规则映射](docs/official-plugin-contract-0.2.md)
- [UI 分层诊断与恢复](docs/client-ui-recovery.md)
- [client 服务目录快照](docs/service-catalog-0.2.1.md)
- [独立分发合同](docs/distribution-contract.md)
- [安全模型](docs/security-model.md)
- [实现设计与落地经验](design.md)
- [变更记录](CHANGELOG.md)
- [DH-TP-SDK 工程化规范](DeepSeek-Harness-Third-Party-Plugin-SDK-Specification.md)
