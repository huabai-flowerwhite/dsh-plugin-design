# Changelog

## 1.3.2 — 2026-10-23

补齐“服务名对、取值时机错”这一类静默失效：apply 时取到 `undefined`，被 `typeof` 固化成 `null`。

### Added

- `CLIENT_SERVICE_EAGER_LOOKUP`（HIGH）：检测 apply/顶层 `const x = ctx.get('service')` 后在 400 字符内出现 `x && typeof x.` / `x || null` 的写法。
- 框架服务白名单（`slots` / `loader` / `logger` / `effect` / `on` / `inject` 等）在 apply 时保证可用，不报。
- 延迟 helper 不误报：`const pickDirectory = function () { const x = ctx.get(...) }`、`var get = function () { return ctx.get(...) }` 视为正解。
- `official.client.eagerLookups`；`dshpd_ui_check` 返回 `eagerLookups`。
- 双向测试：top-level/apply 应报，lazy helper/framework/uncached 不应报；总计 40。

### Docs

- `docs/service-catalog-0.2.1.md` 增加“取值时机”章节与正解示例。
- README/contract 增加规则说明。

## 1.3.1 — 2026-10-23

补齐“服务名存在但方法用错”这一类规则缺口：`workspaces.pickDirectory()` 是合法语法、运行时静默失效。

### Added

- `src/services.js`：client 服务目录快照、旧服务映射、`ctx.get('...')` 提取、`workspaces.pickDirectory` 直接/别名调用检测。
- `CLIENT_WORKSPACES_PICKDIRECTORY`（HIGH）：`workspaces` 是 workspace controller，`pickDirectory()` 在 `uiWorkspace` 上。
- `CLIENT_UNKNOWN_SERVICE`（MEDIUM）：`ctx.get('...')` 不在当前服务目录；第三方自定义服务可忽略。
- `CLIENT_LEGACY_SERVICE`（HIGH）：已知已移除服务；`styles` 仍沿用 `CLIENT_STYLES_SERVICE`。
- `docs/service-catalog-0.2.1.md`：GitHub `ui-workspace` 源码、本地 0.2.1 bundle、共享模块基线的快照与更新流程。
- 规则测试覆盖服务目录、直接/别名 picker 调用、合法 API 不误报；总计 37。

### Changed

- `KNOWN_UI_SLOTS` 补上当前 `shell.*`、`deliverables.*`、`main.*`、`workspace.*` 等座位前缀。
- README/design/contract/recovery 文档补充服务目录检查。

## 1.3.0 — 2026-10-23

面向桌面版：把“挂载到错误 profile”变成可诊断、可修复、可校验的一等能力。

### Added

- `src/profiles.js`：解析 `profiles/<profile>/cordis.patch.yml` 的 insert rows，按 profile 检查包解析（`createRequire` + node_modules 回退），比较 desktop / web。
- `dshpd_mount`：默认 dryRun 返回要追加的 YAML；`apply:true` 先备份 desktop patch，再追加 `- insert: - id: <包名>`；返回 `restartRequired` 和验证命令。
- `dshpd_ui_check` 增加 `deployment` / `rootCause` / `fix`：`DESKTOP_PROFILE_NOT_MOUNTED`（web 挂载无效）、`CLIENT_NOT_DISCOVERED_IN_GRAPH`（已挂载需重启/修清单）。
- `dshpd_analyze`、`dshpd_verify`、`/analyze` 返回 desktop/web 挂载状态；verify 增加 `DESKTOP_PROFILE_MOUNT` / `DESKTOP_PACKAGE_RESOLVABLE`。
- `dshpd_design` 固定生成「Desktop Profile Deployment」章节 + M-PROFILE-* 项；`design.meta.json` 记录 `deployment.expected`。
- 设置页插件行显示「桌面 profile 已挂载 / 未挂载」。
- 测试新增 `tests/profiles.test.mjs`（解析、双 profile 检测、dryRun/apply 备份）与 mount 工具测试；总计 33。

### Docs

- README 重写：前几部分先讲“部署第三方插件 + 适配当前 DSH”和“桌面端 UI 助力”，用“现象 → 根因 → 最短路径”说明，并把目录结构提前；后几部分保留 profile 机制、规则、状态持久化、工具与限制等专业细节。

## 1.2.3 — 2026-10-23

给**没有 UI** 的插件自动生成 UI 方案，并让实现阶段真正落地。

### Added

- `dshpd_design` 新增 `ui: "auto" | "off"`（默认 auto）：目标没有 `dsh.client` 时，`design.md` 增加「UI 方案建议（待用户确认）」——入口、文字线框、页面区块、数据/路由、实现清单。
- `buildUiProposal` 根据插件描述、`ctx.tools.register` 工具名、是否已有 Config 生成提案；工具结果返回 `ui.wireframe` / `ui.userMessage` / `ui.sections` / `ui.dataPlan` / `ui.summary`，Agent 可直接用 `ui.userMessage` 向用户描述 UI 大致样貌。
- `design.meta.json` 记录 `ui.expected` / `ui.proposed` / `ui.entry`；`dshpd_verify` 新增 `UI_EXPECTED`：design 要求 UI 但实现后仍没有 `dsh.client` 时 FAIL。
- 新增 [docs/client-ui-recovery.md](docs/client-ui-recovery.md) 的「插件原本没有 UI」章节。

## 1.2.2 — 2026-10-23

UI 恢复能力：新增运行时 client graph 检查、构建过期检测、UI 诊断规则与设计模板清单。

### Added (UI restoration)

- `dshpd_ui_check`：查询运行中的 `clientModules.graph()`，返回 `inGraph` / `rev` / `clientPath` / `bundleExists`，并汇总静态 UI 问题。
- `CLIENT_BUILD_STALE`：`src/client` 比 `lib/client.js` 新（页面加载旧 UI）→ 必须重新构建。
- `CLIENT_NO_BUILD_SCRIPT`：有 client 源码但没有可重复的 build/prepare 命令。
- `CLIENT_BUNDLE_NO_APPLY` / `CLIENT_BUNDLE_NO_INJECT`。
- `CLIENT_NO_UI_SLOT` / `CLIENT_LEGACY_SLOT`（旧版设置卡片 slot 名称）。
- `CLIENT_REACT_MISSING` / `CLIENT_STYLES_SERVICE`（已移除的 `styles.insert`）。
- `CLIENT_ROUTE_MISSING`：client `fetch` 的本地路由在 Host 源码中找不到。
- `WEBSERVER_NOT_INJECTED` / `HOST_FS_HARD_INJECT`。
- `dshpd_analyze`、`dshpd_verify`、`/analyze` 结果增加运行时 `ui` 状态；`dshpd_design` 增加 UI 恢复清单；`dshpd_apply` 修改 client 源码时返回 `rebuildRequired`。
- 新增 [docs/client-ui-recovery.md](docs/client-ui-recovery.md)（排查顺序、构建契约、当前座位）。

## 1.2.1 — 2026-10-23

设置页、文档与规则集的小版本更新；工具签名不变。

### Changed

- 设置页文案重写：首屏只保留「能帮你做什么」和聊天框 3 步用法，技术信息（工具、安装、安全、规则集）折叠到「查看技术信息」。
- 「在聊天框使用」明确为 3 步：产出 `design.md` → 用户审核 → 确认后修改 / 规范 / 开发插件；并明确 `design.md` 是施工图而非终点。
- 设置页的「规范修改」提示词同步带上「先分析出 design.md，确认后再修改/规范/开发」。
- README 重排为「是什么 → 安装 → 3 步使用 → 设置页 → 原理 → 工具/兼容性」，补充桌面端 profile、刷新页面、已知限制说明。
- `design.md` 增加「使用话术」与「设置页信息架构」；`dsh.plugin.yaml` 描述同步。
- 根目录与包内的 `deepseek-harness-product-technical-framework.md`、`DeepSeek-Harness-Third-Party-Plugin-SDK-Specification.md` 同步到 0.2.1-rc.2；SDK 规范升到 1.2.1（新增 §48）。
- 版本号 `1.2.0` → `1.2.1`。

### Added (rules)

- `HOST_EXPORT_MISSING`：声明 client 但没有 `exports["."]` / `main`。
- `CLIENT_INJECT_INVALID` / `CLIENT_EXTERNAL_INVALID` / `CLIENT_IMMEDIATELY_INVALID` / `CLIENT_EXTERNAL_SELF` / `CLIENT_EXTERNAL_BASELINE`。
- `PKG_ICON_FORMAT` / `PKG_ICON_TOO_LARGE`（SVG/PNG/JPEG/WebP，≤256 KiB）。
- `PKG_NO_TYPE_MODULE`：源码用 ESM 但缺少 `"type": "module"`。
- `PKG_FILES_BUNDLE_PATCH` / `PKG_FILES_CLIENT_BUNDLE` / `PKG_FILES_ICON`：npm `files` 漏发布关键产物。
- `BUNDLE_DECL_INVALID` / `CLIENT_DECL_INVALID` / `PROFILE_DECL_INVALID`。

## 1.2.0 — 2026-10-23

对齐 DeepSeek Harness 0.2.1-rc.2（`dsh-v0.2.1-rc.2`，commit `687f282`），同时保持 0.1.5-rc.x 可加载。

### Added

- 规则集 `0.2.1`：官方 `package.json.dsh`（manifestVersion / bundle / client / profile）、`engines.dsh`、bundle patch、client bundle、`exports`、图标、子路径展示清单。
- `dshpd_migrate`：受限清单迁移（`manifest-version` / `engines-dsh` / `bundle-patch` / `client-meta` / `remove-invariants-dep`），只改 `package.json`。
- `dshpd_verify`：备份完整性、文件可解析、冲突标记、client bundle 形态、分析退化检查。
- 持久化备份清单与 `journal.jsonl`；`status` / `report` / `rollback` 支持跨进程读取。
- `dshpd_apply` 增加写前 hash 校验、`dryRun`、`allowStale`。
- 设置页增加 `/info` 与 `/analyze` 路由、插件行「分析」按钮、版本/规则集/兼容范围徽标。
- `src/client.js` → `lib/client.js` 构建脚本与防漂移测试；`assets/icon.svg`。

### Changed

- `engines.dsh` 改为 `>=0.1.5-rc.1 <0.3.0`（原对齐 0.1.1-rc.2）。
- Host 半体不再硬注入 `fs`，改为从 `exec.agent.ctx.get('fs')` 取；`webServer` 改为可选注入。
- `dshpd_discover` 报告官方角色；`dshpd_analyze` 输出 `official` 快照与 `migrations`。
- `dshpd_inspect` / `dshpd_design` / `dshpd_status` / `dshpd_report` 输出与备注更新。
- 安装脚本优先 `dsh plugin add`，link 模式回退；两种方式互斥，避免双挂载。
- 客户端目录选择修正为 `uiWorkspace` service；修复原 `styles.insert` 遗留源码。

### Fixed

- 0.2.0 移除项检测：`@deepseek-ai/dsh-invariants`、`<pkg>/invariant`、子路径 `package.json`。
- `isTestSource` 使用相对插件根路径，避免 `tests/fixtures/**` 整树被跳过。
- `INVARIANTS_IMPORT` 只匹配 import/require 语句，避免迁移代码字符串自指误报。
- 工具定义 `parameters.additionalProperties`、只读工具 `isConcurrencySafe`。

### Compatibility

- Harness：`>=0.1.5-rc.1 <0.3.0`（0.1.5-rc.x 与 0.2.1-rc.2）。
- Node：`>=22 <25`。
- 安装：官方 `dsh plugin --profile web add` 或 `install.ps1` / `install.sh` link 回退。

## 1.1.0 — 2026-08-29

- 对齐 `@deepseek-ai/dsh` 0.1.1-rc.2；新增 manifest 测试、SDK 规范与产品技术框架文档。

## 1.0.0 — 2026-08-21

- 初始版本：10 个 `dshpd_*` 工具、两阶段门控、Settings 说明页。
