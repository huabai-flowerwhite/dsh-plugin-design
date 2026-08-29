# dsh plugin design — 设计自述

本目录是 `dsh plugin design` 的**持久化插件项目**（npm 包形态），对应顶层设计文档第 53 节的最终交付物。

## 定位

一个运行于 DeepSeek Harness 中的「第三方插件规范适配与自动修改」元插件：分析先于修改、设计先于执行、用户确认后才修改、修改可验证、失败可回滚。

## 两阶段执行模型

```text
Phase 1（只读分析）       Phase 2（用户确认后）
discover                  approve（门控，生成 approvalToken）
  → inspect                 → backup（快照待改文件）
  → analyze                 → apply（逐项，fs.editText 原子替换）
  → design（design.md）     → rollback / report
```

核心安全边界：`dshpd_apply` 三重校验（approvalToken + backupId + 文件在备份清单内），任一不符即 `DENIED`；修改前必先 `dshpd_backup`，失败可用 `dshpd_rollback` 恢复。

## 最终形态：npm 包 + host composition

```text
dsh-plugin-design/                 # npm 包（name: dsh-plugin-design）
├── install.ps1 / install.sh       # 一键安装脚本（node_modules 链接 + cordis.patch.yml insert）
├── package.json                   # exports["."]=host 入口, exports["./client"]=bundle, dsh.client 声明
├── dsh.plugin.yaml                # DH-TP-SDK manifest
├── cordis.patch.yml               # 挂载参考（host composition insert row）
├── lib/client.js                  # Client 半体：factory-form bundle（Settings 页）
└── src/
    ├── index.js                   # 入口 → host.js
    ├── host.js                    # Host 半体：10 个 dshpd_* 工具
    └── client.js                  # Client 源码（构建产物见 lib/client.js）
```

挂载：`$DSH_HOME/profiles/web/cordis.patch.yml` 用 `insert` 加一行 `{ id: dsh-plugin-design, name: 'dsh-plugin-design' }`，工具全局注册 + Settings UI 全局加载。

## Host 半体 vs Client 半体的挂载位置（关键架构结论）

- **Host 半体（工具）**：既可在 agent preset（per-session）也可在 host composition（全局）。它 `inject: ['tools']`，通过 `ctx.tools.register` 注册工具。
- **Client 半体（Settings UI）**：**必须 host composition**。`dsh-client-modules` 只扫描 host Loader entries（`ctx.loader.entries()` + `internal/plugin` 事件），且 client UI 是浏览器 boot 时按 `window.__DSH_BOOT__` graph 加载的全局 UI —— agent preset 的 client 不会被扫描/加载。因此本包统一挂到 host composition。

## 实现要点

- Host 半体 `src/host.js`：ESM 模块，`export default { inject: ['tools'], apply(ctx) {...} }`；工具注册用 **raw ToolDefinition**（`parameters` 裸 JSON Schema + `output.schema` + `output.render` + `execute(args, exec)`），避免 `import '@deepseek-ai/dsh-tools'`（工作区目录无法解析 harness 内部依赖）。
- Client 半体 `lib/client.js`：**factory-form bundle**（`window.__ModuleLoader__.load({ id, factory })`），`factory(require)` 内 `require("react")` 取 React，`exports.apply`/`exports.inject` 挂插件，`inject: ['slots']`；无 `styles` service，样式用内联 style。
- package.json 需三处导出：`exports["."]`（host 入口）、`exports["./client"]`（client bundle）、`exports["./package.json"]`（**client-modules 靠 `require.resolve('<pkg>/package.json')` 定位包，缺此导出会 MISS**）。
- discover 排除 DSH 自身 npx 安装目录（package.json 含 `_npx`/`@deepseek-ai/dsh` 标记）。
- 规范依据：`DeepSeek-Harness-Third-Party-Plugin-SDK-Specification.md`（DH-TP-SDK）与 `deepseek-harness-product-technical-framework.md`。

## 一键安装（install.ps1 / install.sh）

用户下载后一条命令完成两步安装，幂等、可重复运行：

- **Windows**：`powershell -ExecutionPolicy Bypass -File install.ps1`
- **Linux/macOS**：`bash install.sh`

脚本自动：
1. 把插件目录链接进 `$DSH_HOME/profiles/node_modules/dsh-plugin-design`（Windows junction / Unix symlink；或发布 npm 后 `npm install` 亦可）；
2. 向 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 追加 insert row（`DSH_HOME` 默认 `~/.dsh`，`DSH_PROFILE` 默认 `web`，均可用环境变量覆盖）；
3. 幂等：已存在链接则重建、已含该 row 则跳过；profile 目录不存在时提示先运行一次 dsh。

`install.ps1`/`install.sh` 是各插件仓库根目录的普通文件，用户在各自 clone 目录执行，互不冲突。

## 命名约定与冲突避免

每个第三方插件都挂到同一份 `cordis.patch.yml` / `node_modules`，必须保证全局唯一：

| 命名对象 | 约定（本插件取值） | 冲突后果 |
|---|---|---|
| 包名 / row id / 设置页 slot id | `dsh-<插件名>`（`dsh-plugin-design`） | 同名 → node_modules 链接与 patch row 互相覆盖 |
| 模型工具名 | `<缩写>_*`（`dshpd_*`） | 同名工具同层注册 throw |
| HTTP 路由前缀 | `/<包名>/<动作>`（`/dsh-plugin-design/discover`） | 同名路由注册 throw |

## 落地经验与踩坑记录（host composition 持久化）

1. **fs 是 per-agent 服务**：host composition 全局 context 里 `ctx.get('fs')` 不可靠（`apply` 早期执行时返回 undefined）。要么 `inject: ['fs']` 硬依赖（等就绪），要么 host 平面直接用 `node:fs`（dsh-plugin-manager 的做法，扫描任意目录不受 sandbox 限制）。
2. **webServer 有就绪时序**：必须 `inject: ['webServer']` + `ctx.webServer`，否则 `apply` 提前执行导致 HTTP 路由不注册——设置页 fetch 落到 SPA fallback，返回 `<!doctype html>` 报 `Unexpected token '<'`。
3. **client 半体必须 host composition**：`dsh-client-modules` 只扫 host Loader entries（`ctx.loader.entries()` + `internal/plugin` 事件），agent preset 的 client 不会被加载；且 client UI 是 boot 时按 `window.__DSH_BOOT__` graph 加载的全局 UI。
4. **package.json 必须导出 `exports["./package.json"]`**：client-modules 用 `require.resolve('<pkg>/package.json')` 定位包，缺失报 `Package subpath './package.json' is not defined by exports` 并 MISS。
5. **client-modules 有 `pkgMeta` 失败缓存**：一次解析失败缓存 `null`，修复后必须**重启 dsh**（HMR 不清缓存）才会重新解析。
6. **client bundle 是 factory-form**：`window.__ModuleLoader__.load({ id, factory })`，`factory(require)` 内 `require("react")` 取 React，`exports.apply`/`exports.inject` 挂插件，`inject: ['slots']`；**无 `styles` service**，样式用内联 style。
7. **选文件夹**：client 用 `ctx.get('workspaces').pickDirectory()`（系统目录选择器，失败回退手动输入路径）；Host 用 `node:fs` 扫描任意目录（不受 sandbox 限制）。
8. **两阶段门控**：`dshpd_apply` 三重校验（approvalToken + backupId + 文件在备份清单内），配合 `dshpd_backup` 快照与 `dshpd_rollback` 恢复，实现「分析先于修改、确认后才改、失败可回滚」。
9. **dshpd_analyze 的启发式自指误报（须主动规避）**：`dshpd_analyze` 是启发式扫描，规则描述/注释里**字面 `as any`**（含 `as unknown`）仍会命中 `PRIVATE_API`。本项目曾因 PRIVATE_API 规则的描述字符串写了「使用 as any / as unknown 绕过类型」而让 `tests/manifest.test.mjs` 的源码安全断言自指失败；已改为「类型断言绕过类型检查」规避。
   - `parseManifestHeuristic` 已升级为**缩进感知**解析：按父级 + 缩进子级拼出 `plugin.id` / `runtime.harness` / `cordis.apiLevel` 等点路径（同时按 `\r?\n` 切分，兼容 CRLF），不再对嵌套字段误报 `MANIFEST_NO_ID` 等。仍需注意：它非完整 YAML 解析（无 anchor / 折叠标量 / flow map）。
   - `WATERFALL_NEXT` 判定已收紧：仅当源码**确实注册了 waterfall 事件监听**（`.on('agent/request')` / `.on('llm/stream')` / `waterfall(...)` 等）且全文未见 `next(` 时才报；同时排除 tests/spec 文件，避免把注释/字符串/测试描述误判为 listener。
   - 写入型工具（`dshpd_design`/`dshpd_backup`/`dshpd_apply`/`dshpd_rollback`）现在通过 `ctx.sandboxPolicy.resolve({ session })` 传入每调用沙箱策略与 `signal`，使 `fs.writeText`/`fs.editText` 在 workspace-write 模式下按会话 cwd 正确围栏（之前漏传 policy，落入部署默认 root 导致误拒绝）。
10. **版本对齐（0.1.1-rc.2）**：本包 manifest/package.json 的 harness 兼容范围已对齐到 `>=0.1.1-rc.2`。`0.1.0-rc.7` 起 Harness 引入「插件自注册设置卡片」：除当前 `settings.section`（整页入口）外，还有 `settings.plugin.item`（keyed，key = settings 命名空间）+ Host `installSettingsSection` + Client `ctx.settingsScope`。当前设置页是纯静态说明页（走 `settings.section`）；若后续要暴露**可持久化配置**（默认扫描根、安全等级），应迁移到 `settings.plugin.item` 那一档。

## 验证计划（DH-TP-SDK §26–§34）

- **静态合规冒烟**：`npm test`（`node --test tests/`）校验 manifest 必填字段、最小权限、三处导出、cordis.patch.yml 不替换 Core row、源码无高危模式。
- **运行时验证**：重启 dsh 后确认 10 个 `dshpd_*` 工具注册、`/dsh-plugin-design/discover` 路由可用、设置页「选文件夹扫描」返回 JSON。
- **生命周期**：`apply` 的 disposer 卸载全部工具注册、HTTP 路由与 settings.section 注册。
- 完整的 Agent/Session/Concurrency/Security/Compatibility 认证矩阵（DH-TP-SDK §26–§34）需在 dsh 运行时内由 `dshpd_analyze` + 人工验证完成，属启发式 + 手动范畴。

## 已知限制

1. manifest 解析为「缩进感知」的启发式解析（支持嵌套点路径、兼容 CRLF），但仍非完整 YAML 解析（无 anchor/折叠标量/flow map）。
2. 静态分析为启发式规则，非权威认证；`WATERFALL_NEXT` 仅对「确实注册了 waterfall 监听」的非测试源码生效。
3. 任务状态（approval/backup/journal）为进程内内存态，进程重启即失。
4. git 状态/测试运行依赖 Agent 侧 shell 工具。
5. `dshpd_analyze` 的启发式自指误报（如字面 `as any`）见「落地经验」第 9 条。
