# Changelog

## 1.4.4 — 2026-10-25

`npm test` 运行时指纹修复。

### Fixed

- npm 会设置 `npm_package_name=dsh-plugin-design`、`npm_package_version=1.4.3`；旧逻辑把后者当作运行中 DSH 版本，使兼容性从 UNKNOWN 变成 false，并让 `tests/host.test.mjs` 的 unknown-runtime 用例在 `npm test` 下失败（`node --test` 正常）。
- 现在仅当 `npm_package_name` 属于已知 DSH 包（`@deepseek-ai/dsh`、`@deepseek-ai/dsh-desktop`、`@deepseek-ai/dsh-desktop-runtime`、`@deepseek-ai/dsh-app-boot`、`deepseek-harness`）时才采信 `npm_package_version`，并作为最后兜底；`DSH_VERSION`、`DSH_RUNTIME_VERSION`、asar manifest 优先。
- 新增 `tests/runtime.test.mjs`：插件自身 npm 版本被忽略、DSH 包名被采信、`DSH_VERSION` 优先。
- 验证：`npm test` 与 `node --test` 均 103/103 通过（含服务目录与 eager lookup 用例）。

### Docs

- README 按 1.3.2 的叙事/视觉结构重写（30 秒判断、主线、目录前置、核心场景、3 步使用），并更新 1.4.4 的 plan/approve/mount/distribute/validate、UI health 分层与 rc.3 行为。

## 1.4.3 — 2026-10-25

真实渲染器错误提示修复。

### Fixed

- 扫描一个不可读/不存在的目录时，设置页只显示 `HTTP 200`：`/discover` 在
  `ok:false` 时没有 `error` 字段，客户端回退成状态码。现在优先使用
  `error`，其次使用 `scan.reasons`（例如 `扫描未完成：ROOT_UNREADABLE`），
  最后才回退到状态码。
- 真实 Chromium 复测：扫描测试目录 → 分析 → 问题/结论渲染正常 → 非法路径
  显示可读原因；无 console 异常。

## 1.4.2 — 2026-10-25

真实渲染器回归发现并修复一个 rc.3 Client 崩溃；补上真实 Chromium 证据。

### Fixed

- **`FindingList` 在真实渲染器中崩溃**：`h(...).concat(...)` 把 React element
  当数组调用，只要有分析结果（issues > 0）就抛出
  `TypeError: h(...).concat is not a function`，设置页槽位整体空白。
  此前所有测试只做源码/产物与 React stub 检查，没有触发这条渲染路径。
  现在先构造 children 数组再交给 `h()`，并使用稳定的 key。
- 回归保护：`client-build.test.mjs` 增加“client 源码不得对 `h()` 结果调用
  `.concat(`”的检查，防止同类写法回归。

### Added

- **真实 Chromium renderer 验证**（rc.3 Web Host）：在无头 Chrome 中打开真实
  rc.3 Web UI → 进入设置 → “dsh plugin design”页签 → 扫描测试目录 → 列表出现
  5 个 fixture → 点击“分析” → 结果/问题正常渲染 → 非法路径错误提示；
  同时读取 `/dsh-plugin-design/health` 确认 `activated=true, rendered=true`。
  这是真实浏览器渲染，不是 React stub；仍**不是** Desktop 窗口/preload。
- 证据与脚本位于 `updates/dsh-0.2.1-rc.3/evidence/browser-renderer/`。

### Changed

- 版本 1.4.2；rc.3 Host/安装/重启/卸载证据重新绑定到新包。
- 真实 Desktop 窗口仍为 `NOT_RUN`（单实例锁，未触碰用户真实 profile）。

## 1.4.1 — 2026-10-25

DSH Desktop `0.2.1-rc.3`（发布标签 `dsh-v0.2.1-rc.3`，提交 `1f81c04`）增量兼容。

### Fixed

- **部署适配不再要求 `updateBundle`/`listVersions`。** 实际安装的 rc.3 发布版
  plugin-manager 只公开 `listBundles` / `listPlugins` / `installBundle` /
  `removeBundle` / `setBundleEnabled` / `setPluginEnabled` / `inspect` /
  `registries` / `waitForInstall` / `cancelInstall`；旧适配器把
  `updateBundle` 列为必需，会把整个官方管理器误判为不可用。
  现在必需能力是 `listBundles` + `installBundle` + `removeBundle` +
  `setBundleEnabled`，其余逐项探测并报告 `UNSUPPORTED`；安装/移除仍只走官方
  事务，缺失能力时明确拒绝，不写 profile。
- 适配器输出新增 `required`、`missingRequired`、`optional`、`capabilities`
  （install/remove/enable/update/versionDiscovery/…）与 `unsupported[]`，并在
  `dshpd_mount`、`dshpd_status`、`/info` 中原样展示；`updateBundle` 缺失时的
  受支持更新路径为“带精确 spec 的 `installBundle` 或官方 CLI”。

### Changed

- `dshpd_ui_check` 明确报告 rc.3 的 client-modules **metadata 负缓存**：
  “非 Client 包”的结论按 loader specifier + baseUrl 缓存，直到 Host/Desktop
  重启才失效；清单、`dsh.client`、`exports["./client"]` 或入口变化后只刷新
  页面/HMR 不够。`dshpd_verify` 的 `CLIENT_GRAPH` 失败详情同样提示整机重启。
- 文档补充 rc.3 发布版与后续研究分支的能力差异（Manager 方法、Client
  metadata 缓存），不把研究分支接口当作已发布能力。

### Verified

- rc.3 Desktop 安装：`E:\运行包\DSHpc`，Desktop / 内嵌 runtime / app-boot /
  CLI / desktop-host / plugin-manager / client-modules 均为 `0.2.1-rc.3`，
  Electron 44.7.0、Node 24.21.0、win32-x64；`app.asar` SHA-256
  `04b32e3a…eff1f0`。旧 `DSHpc.new-{GUID}` 目录才是 rc.2。
- 测试增至 99 项（新增 7 项适配器能力协商回归）。
- rc.3 配套 CLI、全新 `DSH_HOME` 下维护插件与最小 Host+Client 目标插件的
  安装/冷启动/功能探测/重启/卸载证据见
  `updates/dsh-0.2.1-rc.3/`（Host 与真实 Desktop renderer 分开记录）。

## 1.4.0 — 2026-10-25

安全、证据与独立分发版本。目标：不再越权写 profile、不把失败报成功、不靠无界同步
扫描拖住 Host，并让被改造的插件能在没有本插件的干净 DSH 环境独立安装。

### Security / correctness (breaking behaviour)

- `dshpd_mount` 不再直接写 `profiles/*/cordis.patch.yml`：只调用官方
  `pluginManager`（installBundle/removeBundle/setBundleEnabled/updateBundle），
  服务缺失时仅返回 dry-run + 官方命令；包名先做 npm 名称校验再进入 YAML。
- 新增 `dshpd_plan`。`dshpd_approve` 必须回传同一 `planHash`；receipt 绑定
  design 哈希、文件基线、操作集合、目标 profile、agent/session、有效期与使用次数。
  设计/文件/计划变化即失效；跨会话/跨 agent 复用被拒绝。
  授权走官方 `ctx.get('approval')`（仅 `allowed-once`），或已在
  `danger-full-access` 预设下按部署授权并记录依据；更窄沙箱 + `never` 不签发 token。
- 快照 schema 2：原始字节、presence、size、SHA-256、编码与捕获版本；任一文件
  失败则整次不提交。状态目录移到 `$DSH_HOME/plugin-design-state`，位于被审插件之外。
- `dshpd_rollback` 先校验全部 payload 哈希；不覆盖用户已改文件（`ROLLBACK_CONFLICT`），
  部分失败为 `ROLLBACK_PARTIAL`，只有全部恢复并重新哈希才 `ROLLED_BACK`；
  需要 `confirmBackupId` 显式确认。
- `dshpd_apply`/`dshpd_write`/`dshpd_migrate` 使用 fs 版本守卫 + 批准基线哈希，
  删除 `allowStale` 静默覆盖；journal 先 prepare 后 commit，commit 失败单独报告。
- `dshpd_verify` 分层：snapshot/static/authorization/deployment/runtime；任一 FAIL
  即失败，缺证据为 `INCOMPLETE`；`ok=true` 仅代表 `status=PASS`。新增
  `intent=local-modification|deployment`，部署意图才要求 profile/graph/health。

### Added

- Worker 扫描（`src/scan/`）：单文件/总字节/文件/目录/墙钟预算、并发队列、
  取消与终止；超限/超时显式 `INCOMPLETE`，不再静默截断。检查真实 Host/Client
  入口与 `lib/dist` 构建产物，输出 coverage。
- 官方 SemVer 语义（`src/semver.js` + 435 例 semver 7.8.5 差分 fixture）。
- 运行时指纹（asar app-boot 版本、carrier、capabilities、service realm）。
- `dshpd_ui_check` 分层 served/registered/activated/rendered；新增
  `POST /dsh-plugin-design/client-health` 与 `GET /dsh-plugin-design/health`。
- `dshpd_write`（创建/替换）、`dshpd_distribute`（审计/导出）、
  `dshpd_validate`（隔离包加载 / 真实 dsh-host 矩阵）。
- 独立恢复 CLI `bin/dshpd-recover.mjs`：不 import Host/rules/被审插件；
  list/verify/preview/restore/operations/undo-enable，退出码 0/1/2/64。
- 分发包审计与导出：入口/chunk/assets/worker、可移植性、依赖闭包、维护私有数据、
  公共文档；确定性 `.tgz`、SHA-256、FILELIST、SUPPORT-MATRIX、BUILD-LOCK、
  distribution-report（发布状态始终为未上传）。
- `dshpd_design` 目标分类与 Host/Client 必要性矩阵；无 UI 需求不自动创建 Client；
  不再默认 desktop；增加独立分发义务章节。
- `SUPPORT-MATRIX.md`、`docs/security-model.md`、`docs/distribution-contract.md`。

### Fixed

- `install.ps1` 把 stdout 与退出码混为返回值；现在只返回整数退出码，失败不再
  remove 已安装版本，link 模式必须显式 `-Link`。`install.sh` 同步。
- `engines.dsh` 合法性用范围语法判断（`*` 合法、空范围不通过）；运行时未知为
  UNKNOWN；`dshpd_migrate engines-dsh` 必须显式范围，不再自动扩大。
- 扫描不再跳过 `lib`；不可读/超限/截断有明确 coverage 记录。

### Tests

- 92 个测试/子测试：计划绑定、身份、design 漂移、越界/junction、CAS、部分快照、
  篡改回滚、冲突、journal 恢复、worker 预算/取消/心跳、SemVer 差分、部署适配、
  分发审计与负例、隔离包加载、离线恢复、安装器退出码。
- 真实环境：在全新 `DSH_HOME` 中用官方 CLI 安装 `dsh-plugin-design-1.4.0.tgz`
  与 Host+Client 最小目标包，验证冷启动/路由/重启/卸载/再次启动；见
  `SUPPORT-MATRIX.md` 与 `outputs/independent-validation/`。

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
