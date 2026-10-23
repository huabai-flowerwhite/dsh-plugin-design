# dsh plugin design — 设计自述

本目录是 `dsh plugin design` 的**持久化插件项目**（npm 包 + 官方 bundle 形态），当前版本 `1.3.0`，对应顶层设计文档第 53 节的最终交付物。

## 定位

一个运行于 DeepSeek Harness 中的「第三方插件规范分析、自动修改与开发」元插件：分析先于修改、设计先于执行、用户确认后才修改、修改可校验、失败可回滚。它不只做“适配”，也可以按 `design.md` 继续修改现有插件、按规范重构，或从零开发新插件。

规则集 `0.2.1` 同时覆盖两套依据：

1. **官方契约**（Harness 运行时实际读取）：`package.json.dsh`（bundle / client / profile / manifestVersion）、`engines.dsh`、bundle patch、client factory bundle、`exports`、agent 平面服务。
2. **DH-TP-SDK**（本项目的工程化附加层）：`dsh.plugin.yaml`、权限/资源/生命周期/安全等级。官方运行时不读取它，缺失只降级为 INFO/MEDIUM，不再当作 BLOCKER。

## 两阶段执行模型

```text
Phase 1（只读分析）          Phase 2（用户确认后）
discover                     approve（门控，签发 approvalToken）
  → inspect                    → backup（快照 + hash + 分析摘要，落盘）
  → analyze                    → apply（单文件字面量替换）/ migrate（受限清单迁移）
  → design（design.md）        → verify（校验）→ rollback / report
```

核心安全边界：`dshpd_apply` / `dshpd_migrate` 三重校验（approvalToken + backupId + 文件在备份清单内），外加写前 hash 校验（文件在备份后被改动则拒绝）、`dryRun` 预览、journal 记录、`dshpd_verify` 校验、`dshpd_rollback` 从磁盘快照恢复。

## 使用话术（聊天框 3 步）

设置页与文档统一使用同一套话术，避免用户把 `design.md` 当成终点：

1. **出方案**：`使用 dsh plugin design 插件，分析 <插件路径>，输出 design.md。先只分析，不要修改代码。`
2. **你审核**：打开 `<插件>/.dsh-plugin-design/design.md`，把意见直接告诉 Agent，让它更新方案。
3. **修改 / 规范 / 开发**：`design.md 我已确认。请按它修改 / 规范 / 开发 <插件>，完成后调用 dshpd_verify 校验；出错时用 dshpd_rollback 回滚。`

`design.md` 是“施工图”：确认后可以继续修改现有代码、按规范重构，或从零开发新插件；只想看分析结果时停在第 1/2 步即可，不会改源码。

## 最终形态：官方 bundle + host composition

```text
dsh-plugin-design/
├── package.json               # engines.dsh / dsh.bundle / dsh.client / exports / icon
├── dsh.plugin.yaml            # DH-TP-SDK 附加清单
├── cordis.patch.yml           # bundle patch：新增自己的 row
├── lib/client.js              # 构建产物（factory-form）
├── scripts/build-client.mjs   # src/client.js → lib/client.js，支持 --check
└── src/
    ├── index.js               # Host 入口 → host.js
    ├── host.js                # 14 个工具 + 持久化状态 + 设置页只读路由
    ├── rules.js               # 纯规则引擎（无 I/O）
    └── client.js              # Client 半体源码
```

安装：官方 `dsh plugin --profile web add <本目录>` 把包加入 `dsh.profile.bundles`，由 `dsh.bundle.patch` 自动挂载；无 CLI 时 `install.ps1` / `install.sh` 回退到 node_modules 链接 + profile patch。两种路径互斥，避免双挂载。

## Host 半体 vs Client 半体

- **Host 半体**：`inject: ['tools']`。`fs` / `sandboxPolicy` 是 agent 平面服务，**不能**在 host composition 硬注入；每次工具调用从 `exec.agent.ctx.get(...)` 取，插件上下文的 `ctx.get(...)` 只作为回退。
- **Client 半体**：必须 host composition。`dsh-client-modules` 只扫描 host Loader entries；client UI 是页面 boot 时按 `window.__DSH_BOOT__` 加载的全局 UI。
- **Client bundle**：`window.__ModuleLoader__.load({ id, factory })` 的 lazy-CJS；`id` 必须等于包名。源码只用平台基线模块（本插件只 `require('react')`）。
- **设置页路由**：`ctx.inject(['webServer'], ...)` 可选注入，避免 apply 早于 webServer 就绪；路由只读，使用 node:fs 适配器，因此可扫描 workspace 之外的插件目录。
- **生命周期**：工具注册、路由注册、slot 注册都通过 `ctx` / `ctx.effect` 完成，卸载自动清理；`apply` 不保留需要手动释放的资源。

## 设置页信息架构（1.2.1 起）

按「普通用户先看懂，技术细节按需展开」组织：

1. **主视图**：一句话定位 → 能帮你做什么（检查 / 出方案 / 动手）→ 聊天框 3 步（明确 `design.md` 后可以继续修改 / 规范 / 开发）→ 设置页三个按钮 → 扫描与分析列表。
2. **技术信息（折叠）**：规则集与兼容范围、14 个工具分组、安装/升级命令、安全边界、非官方认证声明。
3. **文案原则**：先说结果（“帮你检查并改好插件”），再说步骤（3 步 + 示例提示词），最后才出现 `engines.dsh`、factory bundle 等术语；不在首屏堆技术名词。

## Desktop Profile Deployment（1.3.0）

桌面版只读 `$DSH_HOME/profiles/desktop/cordis.patch.yml`；只挂在 `web` 的插件，client 半体不会进入桌面版的 `window.__DSH_BOOT__` graph。

- `src/profiles.js`：`resolveDshHome`、`parseMountRows`、`inspectProfile`、`inspectDeployment`、`ensureDesktopMount`。
- `dshpd_analyze` / `dshpd_ui_check` / `dshpd_verify` / `/analyze` 返回 `deployment.desktop` / `deployment.web`：`mounted`、`row`、`packageResolvable`、`patchPath`。
- `dshpd_ui_check` 额外返回 `rootCause`：`DESKTOP_PROFILE_NOT_MOUNTED` / `CLIENT_NOT_DISCOVERED_IN_GRAPH`，并给出修复步骤。
- `dshpd_mount`：默认 dryRun；`apply:true` 先备份 patch，再追加 `- insert: - id: <包名>`；返回 `restartRequired`。
- `dshpd_design` 固定生成「Desktop Profile Deployment」章节 + M-PROFILE-* 项；`design.meta.json` 记录 `deployment.expected`，`dshpd_verify` 未挂载时 FAIL（DESKTOP_PROFILE_MOUNT）。
- 桌面版重启是必需的：client-modules 的“非 client 包”判定会缓存到重启。

## 无 UI 插件的 UI 提案（1.2.3）

`dshpd_design` 默认 `ui: "auto"`；当目标插件没有 `dsh.client` 时，`buildUiProposal` 根据插件描述、已注册工具（`ctx.tools.register` 的 name）、是否已有 Config，生成一份可执行的 UI 提案：

- 入口：默认 `settings.section`；标题 `<包名> 设置`。
- 文字线框：顶部状态/版本、配置区或能力区、最近结果/操作、底部按钮。
- 数据方案：Host `/<包名>/status`、`/<包名>/config`（`ctx.inject(['webServer'], ...)`）；配置持久化优先走 Host settings/Config。
- 实现清单：`dsh.client` + `exports["./client"]` + factory bundle + `build:client` + `slots.inject` + 构建/刷新/`dshpd_ui_check`。
- `design.md` 增加「UI 方案建议（待用户确认）」章节；工具返回 `ui.wireframe` / `ui.userMessage` / `ui.sections` / `ui.dataPlan` / `ui.summary`，Agent 先向用户描述大致样貌。
- 同目录写 `design.meta.json`，记录 `ui.expected`；`dshpd_verify` 增加 `UI_EXPECTED` 检查，防止“design 写了 UI、实现时却没加 client 半体”。

用户不需要 UI 时传 `ui: "off"`，或在审核阶段明确拒绝。

## 规则引擎（src/rules.js）

纯函数、无 I/O；`host.js` 的 `collectModel` 先把插件目录读成模型，再交给 `analyzeModel`。这样规则可以单测，也能被 route（node:fs）与 tool（ctx.fs）共用。

- 官方契约：`engines.dsh`（含 `workspace:` 拒绝、运行时版本满足性）、`dsh.manifestVersion`、`dsh.bundle.patch`（字符串/数组、越界、缺失、npm files 覆盖）、`dsh.client`（platform / `exports["./client"]` / bundle 存在性 / factory 形态 / 注册 id / `inject`/`external`/`immediately` 类型 / 自引用 / 基线模块）、Host 入口、`exports["./package.json"]`、子路径 `package.json`、图标格式与 256 KiB 上限、`type: module`、npm `files` 完整性。
- 0.2.0 移除项：`@deepseek-ai/dsh-invariants` / `<pkg>/invariant` 依赖与 import、patch 中的 invariant 行。
- 源码：globalThis/window/prototype patch、类型断言绕过、模块级 session 状态、危险命令、命令注入、硬编码密钥、eval/new Function、定时器未清理、工具缺 `output`、waterfall 缺 `next()`。
- UI：`CLIENT_BUILD_STALE`（源码比 bundle 新）、`CLIENT_NO_BUILD_SCRIPT`（没有可重复构建命令）、`CLIENT_BUNDLE_NO_APPLY` / `NO_INJECT`、`CLIENT_NO_UI_SLOT`、`CLIENT_REACT_MISSING`、`CLIENT_STYLES_SERVICE`、`CLIENT_ROUTE_MISSING`（client fetch 无 Host 路由）、`WEBSERVER_NOT_INJECTED`、`HOST_FS_HARD_INJECT`；`dshpd_ui_check` 还会查询运行中的 `clientModules.graph()` 判断 `inGraph` / `rev` / `clientPath`。详见 [docs/client-ui-recovery.md](docs/client-ui-recovery.md)。
- 结论：`BLOCKED`（任意 BLOCKER）/ `NEEDS_REVIEW`（任意 CRITICAL）/ `READY_TO_MODIFY`；维度分从 100 扣严重度权重。
- 迁移项：`manifest-version`、`engines-dsh`、`bundle-patch`、`client-meta`、`remove-invariants-dep`，由 `dshpd_migrate` 执行（只改 package.json）。

## 持久化状态

- `backup/<backupId>/manifest.json`：插件路径、design 路径、token hash、文件列表（路径 / 备份名 / 字节数 / sha256）、备份时的分析摘要。
- `journal.jsonl`：`backup` / `apply` / `migrate` / `verify` / `rollback` 条目，保留最近 500 条。
- `design.md` / `design.vN.md`：由 `dshpd_design` 生成，不覆盖既有文件（除非显式模式）。
- 审批 token 不落盘：进程重启后需重新 `approve`；但备份与 journal 可被 `status` / `report` / `rollback` 读取。

## 落地经验与踩坑记录

1. **fs 是 per-agent 服务**：host composition 全局 context 里 `ctx.get('fs')` 不可靠；硬 `inject: ['fs']` 可能永远等不到依赖。正确做法是工具执行时从 `exec.agent.ctx.get('fs')` 取，`ctx.get` 只作为回退。
2. **webServer 有时序**：必须 `ctx.inject(['webServer'], ...)`；否则 `apply` 早于服务就绪，设置页 fetch 落到 SPA fallback，报 `Unexpected token '<'`。
3. **client 半体必须 host composition**：`dsh-client-modules` 只扫 host Loader entries（`ctx.loader.entries()` + `internal/plugin` 事件），agent preset 的 client 不会被加载。
4. **client bundle 是 factory-form**：`window.__ModuleLoader__.load({ id, factory })`，`id` 必须等于包名；只挂「裸包名 row」，子路径 row 不带 UI。
5. **`exports["./package.json"]`**：旧版 client-modules 用 `require.resolve('<pkg>/package.json')` 定位包；0.2.x 已不强制，但保留兼容更广。
6. **client-modules 有 pkgMeta 失败缓存**：一次解析失败缓存 `null`，修复后必须重启 dsh（HMR 不清缓存）。
7. **选文件夹**：client 用 `ctx.get('uiWorkspace').pickDirectory()`（0.1.5 与 0.2.x 的服务名都是 `uiWorkspace`，不是 `workspaces`）；失败回退手动输入路径。
8. **两阶段门控**：approvalToken + backupId + 文件在备份清单内；`dshpd_apply` 额外做写前 hash 校验，防止覆盖备份后的外部修改。
9. **启发式自指误报**：规则描述/注释里写字面 `as any` / `as unknown` 会让本插件自己的源码扫描命中 `PRIVATE_API`；规则实现里用正则转义写法规避。同理，`INVARIANTS_IMPORT` 只匹配 import/require 语句，不匹配迁移代码里的依赖名字符串。
10. **测试目录会污染 fixture**：`isTestSource` 早期用绝对路径判断，`.../dsh-plugin-design/tests/fixtures/...` 整棵样本树都被当测试跳过；现在用相对插件根的 `file.relative`。
11. **官方安装与手写 patch 互斥**：`dsh plugin add` 会把包加入 `dsh.profile.bundles` 并由 bundle patch 挂载；再往 profile patch 塞同一 row 会双挂载。安装脚本必须先检查 bundles。
12. **0.2.0/0.2.1 的破坏性变更**：`dsh-invariants` 全系移除、子路径 `package.json` 展示清单移除、`dsh plugin` 的 `--profile` 位置变化、HMR 下「已安装再安装」报 `already-installed`（升级必须先 remove）。
13. **发布形态**：git 安装拉源码，需要 `prepare` 构建 client/TypeScript；npm 发布应预构建 `lib/`。本包 `lib/client.js` 预构建并纳入 `files`。

## 验证计划

- **静态**：`npm test`（33 个 case）——自身清单/图标/导出、DH-TP-SDK、bundle patch、源码安全、SemVer、三类 fixture 规则命中、UI 诊断、无 UI 插件的 UI 提案、14 工具/3 路由、desktop/web profile 挂载、完整备份-修改-校验-回滚、清单迁移、client 构建防漂移。
- **运行时**：重启 dsh 后确认 14 个 `dshpd_*` 工具注册、`/dsh-plugin-design/{info,discover,analyze}` 可用、`dshpd_ui_check` 能读到 `clientModules.graph()` 并返回 desktop/web 挂载状态、设置页扫描/分析返回 JSON。
- **生命周期**：插件卸载后工具、路由、slot 全部消失（由 `ctx` 注册与 `ctx.effect` 保证）。
- 完整的 DH-TP-SDK 认证矩阵（§26–§34）需在 dsh 运行时内由 `dshpd_analyze` + 人工验证完成，属启发式 + 手动范畴。

## 已知限制

1. `dsh.plugin.yaml` 为启发式解析，非完整 YAML。
2. 静态分析为启发式规则，非权威认证；client 共享模块检查是 import 语句级。
3. 审批 token 为进程内状态；备份/journal/report 持久化。
4. git 状态 / 真实测试执行依赖 Agent 侧 shell 工具。
5. `dshpd_migrate` 只做受限的 `package.json` 迁移，不改源码。
6. 设置页只读路由使用 node:fs（用户主动选择目录），不经过 workspace 沙箱。
7. SemVer 检查支持 `^ ~ > >= < <= =`、通配符、部分版本、`||`；不支持 hyphen range 与 `!=`。
8. npm `files` 覆盖检查是目录前缀启发式；ESM 检测是 `.js/.mjs` 源码的 `import/export` 语法扫描，不做 npm pack 模拟。
9. UI 构建过期基于 mtime；重新检出可能重置 mtime，以 `dshpd_ui_check` 的 `runtime.inGraph` / `buildStale` 为准。`CLIENT_ROUTE_MISSING` 只识别字面量 `fetch('/x')` 与 `path: '/x'`。
