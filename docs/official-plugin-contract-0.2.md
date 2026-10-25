# DSH 第三方插件官方契约（固定基线索引）

> **基线（发布合同）**：官方标签 `dsh-v0.2.1-rc.3`，提交
> `1f81c047fc48fa190a683e469daa699857e9afe8`。
> **历史研究基线**：`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`（清单也写 rc.3，
> 但包含发布标签之外的变更；两者接口不完全相同）。
> **本机实际运行**：Desktop `0.2.1-rc.3`（`E:/运行包/DSHpc`，Electron 44.7.0 /
> Node 24.21.0 / win32-x64，`app.asar` SHA-256 `04b32e3a…eff1f0`）。工作区
> `E:/运行包/DSHpc.new-{GUID}` 是旧 rc.2 暂存目录，不是当前安装。
>
> 本文件不再是“0.2.x 通用说明”，而是对发布基线的字段与行为索引。破坏性变化、后续版本
> 新增字段必须单独记录并绑定版本，不得用 `0.2.x` 覆盖全部差异。
>
> 规则集 `0.2.1-r2`。运行时以 `package.json.dsh` 为准；`dsh.plugin.yaml`（DH-TP-SDK）
> 是本项目附加的工程化清单，Harness 运行时**不读取**它，其权限/资源字段也**不被强制**。
>
> 相关：`docs/security-model.md`（信任边界）、`docs/distribution-contract.md`（分发）、
> `SUPPORT-MATRIX.md`（已测组合）。

## 0.0 rc.3 发布标签与历史研究 master 的已知差异

以下差异由实际安装的 rc.3 `app.asar` 源码与发布源码核对（2026-10-25 增量核验）：

| 合同 | rc.3 发布版（`1f81c04`） | 研究 master（`22ddee3`） | 本项目处理 |
|---|---|---|---|
| Plugin Manager 更新 | **没有** `updateBundle` / `listVersions`；有 `installBundle`/`removeBundle`/`setBundleEnabled`/`setPluginEnabled`/`listBundles`/`listPlugins`/`inspect`/`registries`/`waitForInstall`/`cancelInstall` | 有 `updateBundle`/`listVersions` | 能力逐项探测；缺失项 `UNSUPPORTED`；更新用精确 spec 的 `installBundle` 或官方 CLI |
| Client 包元数据 | `client-modules` 的 `pkgMeta` 按 loader specifier + baseUrl 缓存，**包含 null（非 Client）负结果**，直到 Host 重启 | 重协调时重新读取 | 清单/Client 导出变化后要求整机重启，再 `dshpd_ui_check` |
| `dsh.bundle.listedByDefault` | 发布类型不含 | 类型含 | 不生成、不宣称发布版支持 |
| `optionalDependencies` 清单类型 | 发布接口未列出 | 类型含 | 只标类型差异，不推断 npm 不支持 |
| Client 路径/file URL 发现、preset `serviceFor` | 存在 | 存在 | 不当作缺失；按真实上下文验证 |

## 0. 与 1.3.2 文档的差异（以本节为准）

- 旧文中的“所有插件都应挂到 desktop profile”“升级必须 remove 再 add”“mtime 可证明
  构建新鲜”“Loader row 必须是裸包名”等结论已移除。部署目标由调用方显式指定；
  升级使用官方 pluginManager；mtime 只是提示；row 解析按实际 patch 语义。
- `engines.dsh` 的判定使用 node-semver `{ includePrerelease: true }`，`engines.dsh`
  存在时单独决定兼容性（peer 不再参与）。
- 静态规则命中不是认证；运行时安全只能由隔离运行验证。

## 1. 权威来源

- 仓库：<https://github.com/deepseek-ai/deepseek-harness>，commit `22ddee3`
- 兼容性判定：`packages/boot/app-boot/src/plugin-compatibility.ts`
- 插件管理：`packages/boot/plugin-manager/src/index.ts`、`src/types.ts`
- 审批通道：`packages/interaction/user-approval/src/index.ts`、`src/types.ts`
- fs 契约：`packages/fs/fs/src/index.ts`、`src/types.ts`
- profile 锁：`packages/util/atomic-write/src/index.ts`
- 客户端模块：`packages/client/modules/README.md`、`src/client/manifest.ts`
- 预设 realm：`packages/preset/agent-preset-registry/src/index.ts`、`src/mount.ts`
- 打包与安装：`docs/user/develop/basic/publish.md`

> 以下各节保留 1.3.2 时期的字段说明，作为固定基线参考；与本节冲突时以本节和第 9 节
> “部署/运行时”为准。

## 2. `package.json` 官方字段

```jsonc
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "插件管理器卡片摘要",
  "icon": "assets/icon.svg",          // SVG/PNG/JPEG/WebP，≤256 KiB，须在包目录内
  "type": "module",
  "engines": {
    "dsh": ">=0.2.0 <0.3.0",          // 存在时「单独」决定兼容性
    "node": ">=22 <25"
  },
  "exports": {
    ".": "./src/index.js",             // Host 半体
    "./client": "./lib/client.js",     // Client 半体（构建产物）
    "./package.json": "./package.json" // 兼容旧版 client-modules 的定位方式
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" }, // 也接受按序应用的数组
    "client": { "platform": "web" }               // 可选 external / immediately
  }
}
```

| 字段 | 作用 | 缺失后果 |
|---|---|---|
| `dsh.bundle.patch` | 声明组合包（bundle）及要应用的 patch 文件（相对包目录，字符串或数组） | `dsh plugin add` 不会把包当作 bundle 选择，插件不会被挂载 |
| `dsh.client.platform` | 声明浏览器半体，当前只支持 `"web"` | `dsh-client-modules` 不扫描该包，Settings 页面等 UI 永不出现 |
| `exports["./client"]` | 指向构建好的 lazy-CJS bundle | 同上；声明了 `dsh.client` 却没有导出会直接报错 |
| `engines.dsh` | SemVer 兼容范围 | 缺省时回退 `peerDependencies` 中的 `@deepseek-ai/dsh*`；两者都没有则兼容性不可验证 |
| `icon` | 插件管理器展示图 | 显示通用图标 |
| `description` | 插件管理器卡片摘要 | 只显示技术名 |
| `files` | npm 发布白名单 | 漏掉 `cordis.patch.yml` / `lib/client.js` / `icon` 时，安装后的包缺少运行时或展示产物 |

> 图标支持 SVG / PNG / JPEG / WebP，位于包目录内且 ≤256 KiB；源码使用 ESM 时 `package.json` 需要 `"type": "module"`。

## 3. 兼容性检查（0.2.1 起）

1. 有 `engines.dsh` → **只看它**，忽略 `@deepseek-ai/dsh*` peer。
2. 无 `engines.dsh` → 检查 `peerDependencies` 中的 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`。
3. `engines.dsh` 中出现 `workspace:` → 直接判定不兼容（`workspace:` 只允许在 peer 中）。
4. `engines` 不是对象、或 `engines.dsh` 不是字符串 → 清单不可读，安装被拒。
5. 预发布版本参与范围比较（`includePrerelease`），所以 `>=0.1.5-rc.1 <0.3.0` 能覆盖 `0.1.5-rc.2`、`0.2.1-rc.2`。
6. 不满足时可逐版本放行：`dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <runtime> --accept-risk`。

## 4. 安装与升级

```bash
# 安装本地目录 / npm 包 / git / tarball
dsh plugin --profile web add ./my-plugin
dsh plugin --profile web add my-plugin@1.2.0

# 升级：HMR 下不允许覆盖安装，必须先移除
dsh plugin --profile web remove my-plugin
dsh plugin --profile web add ./my-plugin
```

- `dsh plugin` 的 `--profile` 必须写在转发的 pnpm 参数**之前**（0.2.1-alpha.1 起）。
- 安装会校验 `engines.dsh` / peer，不满足时在 pnpm 运行前拒绝。
- 安装会构建脚本（`prepare`）需要 `pnpm-workspace.yaml` 的 `allowBuilds` 授权；那是「允许包代码在本机执行」的权限。
- 安装成功 = `profile/package.json` 的 `dsh.profile.bundles` 增加该包名（并保留依赖）。
- 回退方案（无 `dsh` CLI）：`node_modules` 链接 + profile `cordis.patch.yml` 的 insert 行。**两种方式不能同时使用**，否则同一插件会被挂载两次。

## 5. Client 半体

- 包声明 `dsh.client`，并导出 `exports["./client"]`；构建产物必须是 lazy-CJS factory：

  ```js
  window.__ModuleLoader__.load({
    id: '<package name>',
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      // 模块体：可以 require('react') 等平台基线模块
      return module.exports;
    },
  });
  ```

- factory 的 `id` 必须等于包名。
- 平台基线模块：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
- 其它模块必须列入 `dsh.client.external`（精确 specifier）；跨插件**值导入**被构建门禁拒绝，应改为 cordis service 协作。
- 浏览器半体只挂在「Loader 行 name 恰为裸包名」的那一行上；用子路径挂载的行不会带 UI。
- 0.2.0 起子路径插件不再读取 `<subpath>/package.json`：标题/描述放 `<subpath>/locale/*.json`，图标导出 `<subpath>/icon`。

## 6. 设置座位（slots）

| slot | 形态 | 用途 |
|---|---|---|
| `settings.section` | list | 设置面板里的整页入口（本插件使用） |
| `settings.plugins.tab` | list | 「插件」区里的标签页 |
| `settings.general.item` | list | 「通用」区的一行偏好 |
| `plugins.detail.actions` / `badge` / `section` | keyed/list | 插件详情页的扩展位（0.2.x） |
| `plugins.item` | keyed | 插件配置卡片（`ctx.configForms.whileServed`） |

注册必须包在 `ctx.slots.inject(key, () => ctx.slots.register(...))` 中：座位只在声明它的插件挂载期间存在。

## 7. 工具定义

- 注册通过 `ctx.tools.register(definition)`，卸载自动反注册。
- `ToolDefinition` 必填 `output: { schema, render }`；`execute(args, exec)` 返回符合 `output.schema` 的 JSON 值。
- `parameters` 既可用 `defineTool` 的 DSL，也可直接给 JSON Schema（本插件使用裸 JSON Schema，因为链接目录无法解析 `@deepseek-ai/dsh-tools`）。
- `exec.signal` 是取消通道；`exec.agent.ctx` 是 agent 作用域上下文（`fs`、`sandboxPolicy` 等按需服务在这里）。
- 可选 `isConcurrencySafe(args)` 声明可并行；`presentCall` / `presentResult` 是纯函数，用于 UI 卡片。
- Web 端自定义渲染走 `tool.call.toolview` keyed slot，不消费 Host 的 `presentResult`。

## 8. 0.2.0 移除项（插件相关）

| 移除 | 影响 |
|---|---|
| `@deepseek-ai/dsh-invariants`、所有 `<pkg>/invariant` 子路径、`ctx.invariants` | 残留 import / patch 行会直接加载失败 |
| 子路径插件的 `<subpath>/package.json` 展示清单 | 标题/描述改由 locale 文件；图标改由 `<subpath>/icon` 导出 |
| `dsh-invariants` 相关 sdk-minimal 行 | patch 里 target 这些 id 会报 `entry not found` |

## 9. 服务平面（Host Composition 的关键）

- `fs`、`sandboxPolicy` 等是 **agent 平面**服务：host composition 的全局 context 里通常拿不到。
- Host 半体插件应从 `exec.agent.ctx.get('fs')` / `get('sandboxPolicy')` 取每调用的服务，或在 `apply` 里用 `ctx.inject([...], cb)` 等待可选服务出现。
- 硬 `inject: ['fs']` 的 host composition 插件可能永远等不到依赖而无法加载。
- `webServer` 是 host 平面服务；用它注册 HTTP 路由时应 `ctx.inject(['webServer'], ...)`，避免 apply 早于服务就绪。

## 9.1 UI 恢复检查（client 插件）

> 完整排查/构建指南见 [`client-ui-recovery.md`](client-ui-recovery.md)；client 服务目录快照见 [`service-catalog-0.2.1.md`](service-catalog-0.2.1.md)。

### 插件原本没有 UI

`dshpd_design` 默认 `ui: "auto"`：目标没有 `dsh.client` 时，`design.md` 增加「UI 方案建议（待用户确认）」——入口（默认 `settings.section`）、文字线框、页面区块、数据/路由、实现清单；工具结果返回 `ui.wireframe` / `ui.sections` / `ui.dataPlan` / `ui.summary`，Agent 应先向用户描述 UI 大致样貌。`design.meta.json` 记录 `ui.expected`，`dshpd_verify` 用 `UI_EXPECTED` 检查实现后是否真的有 `dsh.client`。不需要 UI 时传 `ui: "off"`。

### 插件原本有 UI

浏览器半体的 UI 不出现，通常不是单点问题，按下面顺序排查：

1. **是否进入运行中的 client graph**：`dshpd_ui_check` 的 `runtime.inGraph`；为 false 时检查 Loader row 是否裸包名、`dsh.client`、`exports["./client"]`、`lib/client.js` 是否存在，然后重启/刷新。
2. **构建是否过期**：`CLIENT_BUILD_STALE` 表示 `src/client` 比 `lib/client.js` 新；必须重新构建，否则页面永远加载旧 bundle。
3. **bundle 是否可执行**：factory-form、`exports.apply`、`exports.inject`；缺 apply 会注册空模块。
4. **UI 座位是否还叫这个名字**：`CLIENT_NO_UI_SLOT` 表示没有注册已知座位；旧版 `styles.insert` 已移除（`CLIENT_STYLES_SERVICE`）；`workspaces` 不是目录选择器（正确是 `uiWorkspace.pickDirectory()`，见 `CLIENT_WORKSPACES_PICKDIRECTORY`）；服务名对但 apply 时取值会固化 undefined 的，见 `CLIENT_SERVICE_EAGER_LOOKUP`。
5. **client 与 Host 的路由是否对得上**：`CLIENT_ROUTE_MISSING` 会让 fetch 落到 SPA fallback，表现为 `Unexpected token "<"` 或空白页；`WEBSERVER_NOT_INJECTED` 会让路由根本没注册。
6. **是否用了 React 却没有 require/import**：`CLIENT_REACT_MISSING`，apply 时直接抛错。

修复顺序：改源码 → 重新构建 → 刷新页面 → `dshpd_ui_check` 确认 `inGraph=true`、`buildStale=false` → `dshpd_verify`。

## 9.2 桌面版 profile（0.2.x 实际部署）

- 桌面版加载 `desktop` profile，第三方插件通过 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 的 insert row 挂载；`profiles/web` 的挂载对桌面版无效。
- `dsh-client-modules` 只扫描当前 host Loader 中已挂载的 entries；包没挂载时 `clientPath=null`，client 半体不会进入 `window.__DSH_BOOT__` graph。
- `dshpd_analyze` / `dshpd_ui_check` / `dshpd_verify` 返回 `deployment.desktop` / `deployment.web`：`mounted`、`packageResolvable`、`patchPath`。
- `dshpd_mount` 默认 dryRun；`apply:true` 先备份 patch，再追加 `- insert: - id: <包名>`。追加后必须重启桌面版（client-modules 的“非 client 包”判定会缓存到重启）。
- `design.md` 固定包含「Desktop Profile Deployment」；`design.meta.json` 的 `deployment.expected=true` 会让 `dshpd_verify` 在未挂载时 FAIL。

## 10. 规则集映射

| Rule ID | 严重度 | 维度 | 修复 |
|---|---|---|---|
| `PKG_MISSING` / `PKG_INVALID_JSON` | BLOCKER | manifest | 补 package.json / 修 JSON |
| `ENGINES_DSH_MISSING` | HIGH | compatibility | `dshpd_migrate engines-dsh` |
| `ENGINES_DSH_WORKSPACE` | CRITICAL | compatibility | 换成真实 SemVer 范围 |
| `ENGINES_DSH_UNSATISFIED` | CRITICAL | compatibility | 放宽范围或放宽运行时 |
| `BUNDLE_NOT_DECLARED` | HIGH | bundle | `dshpd_migrate bundle-patch` |
| `BUNDLE_PATCH_MISSING` | CRITICAL | bundle | 补 patch 文件或修正路径 |
| `CORE_ROW_REPLACE` | CRITICAL | bundle | 只新增 row |
| `CLIENT_EXPORT_MISSING` / `CLIENT_BUNDLE_MISSING` | BLOCKER | client | `dshpd_migrate client-meta` + 构建 |
| `CLIENT_BUNDLE_FORMAT` | BLOCKER | client | 用 factory-form 构建 |
| `CLIENT_BUNDLE_ID` | HIGH | client | 构建 id = 包名 |
| `CLIENT_NOT_DECLARED` | HIGH | client | 声明 `dsh.client` |
| `HOST_EXPORT_MISSING` | HIGH | manifest | 补 `exports["."]` 或 `main` |
| `CLIENT_INJECT_INVALID` / `CLIENT_EXTERNAL_INVALID` | HIGH | client | 改成字符串数组 |
| `CLIENT_IMMEDIATELY_INVALID` | MEDIUM | client | 改成布尔值 |
| `CLIENT_EXTERNAL_SELF` | HIGH | client | 移除自身包名 |
| `CLIENT_EXTERNAL_BASELINE` | INFO | client | 移除多余基线模块 |
| `CLIENT_EXTERNAL_UNLISTED` | MEDIUM | client | 加 `dsh.client.external` 或改 service |
| `CLIENT_BUILD_STALE` | HIGH | client | 重新构建 `lib/client.js` 后刷新 |
| `CLIENT_NO_BUILD_SCRIPT` | MEDIUM | client | 补 build/prepare 构建命令 |
| `UI_EXPECTED`（verify） | — | client | design 要求 UI 但实现后仍无 `dsh.client` |
| `CLIENT_BUNDLE_NO_APPLY` | HIGH | client | 构建出口补 `exports.apply` |
| `CLIENT_BUNDLE_NO_INJECT` | MEDIUM | client | 补 `exports.inject` |
| `CLIENT_NO_UI_SLOT` | INFO | client | 检查 slot 名称 / 是否本应有 UI |
| `CLIENT_LEGACY_SLOT` | MEDIUM | client | 改用 `settings.section` / `settings.plugins.tab` / `plugins.item` |
| `CLIENT_REACT_MISSING` | HIGH | client | `require("react")` / `import React` |
| `CLIENT_STYLES_SERVICE` | HIGH | client | 改插件自有 `<style>` 或内联 style |
| `CLIENT_WORKSPACES_PICKDIRECTORY` | HIGH | client | `uiWorkspace.pickDirectory()`；`workspaces` 是 controller |
| `CLIENT_SERVICE_EAGER_LOOKUP` | HIGH | client | 不要在 apply/顶层缓存非框架服务；点击时重取或 `ctx.inject` |
| `CLIENT_UNKNOWN_SERVICE` | MEDIUM | client | 核对 provider；若由其他插件提供可忽略 |
| `CLIENT_LEGACY_SERVICE` | HIGH | client | 按 `docs/service-catalog-0.2.1.md` 替换 |
| `CLIENT_ROUTE_MISSING` | HIGH | client | 补 Host `webServer.register({ path })` |
| `WEBSERVER_NOT_INJECTED` | HIGH | lifecycle | `inject` 或 `ctx.inject(['webServer'], ...)` |
| `HOST_FS_HARD_INJECT` | MEDIUM | lifecycle | 改 `exec.agent.ctx.get('fs')` |
| `PKG_ICON_FORMAT` / `PKG_ICON_TOO_LARGE` | MEDIUM | install | 换 SVG/PNG/JPEG/WebP，压到 ≤256 KiB |
| `PKG_NO_TYPE_MODULE` | HIGH | manifest | 加 `"type": "module"` 或改 CJS |
| `PKG_FILES_BUNDLE_PATCH` / `PKG_FILES_CLIENT_BUNDLE` / `PKG_FILES_ICON` | MEDIUM/LOW | install | 把产物加入 `package.json.files` |
| `BUNDLE_DECL_INVALID` / `CLIENT_DECL_INVALID` / `PROFILE_DECL_INVALID` | HIGH/MEDIUM | manifest | 改成对象 |
| `INVARIANTS_DEP` / `INVARIANTS_IMPORT` | BLOCKER | compatibility | `dshpd_migrate remove-invariants-dep` + 改源码 |
| `INVARIANTS_ROW` | HIGH | compatibility | 删除 patch 行 |
| `SUBPATH_PACKAGE_JSON` | MEDIUM | compatibility | 改用 locale + icon 导出 |
| `TOOL_NO_OUTPUT` | HIGH | tool | 补 `output.schema/render` |
| `GLOBALTHIS_PATCH` / `PROTOTYPE_PATCH` / `DANGEROUS_COMMAND` / `SECRET_LEAK` | BLOCKER | security | 移除 |
| `GLOBAL_MUTABLE_STATE` / `PRIVATE_API` / `COMMAND_INJECTION` | CRITICAL | session/compat/security | 改作用域 / 公开 API / spawn |
| `TIMER_NO_CLEANUP` | MEDIUM | lifecycle | `ctx.effect` 清理 |
| `NO_TESTS` | MEDIUM | testing | 补测试 |

规则集是**启发式**的，不构成 DeepSeek 官方认证。
