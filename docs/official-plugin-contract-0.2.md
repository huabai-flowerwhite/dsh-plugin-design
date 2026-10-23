# DSH 第三方插件官方契约（0.1.5 → 0.2.1）

本文件是 `dsh plugin design` 规则集 `0.2.1` 的事实依据，供 `dshpd_analyze` 的结论追溯与人工复核使用。

> 官方契约以 `package.json` 的 `dsh` 字段为准；`dsh.plugin.yaml`（DH-TP-SDK）是本项目附加的工程化清单，Harness 运行时**不读取**它。

## 1. 权威来源

- 仓库：<https://github.com/deepseek-ai/deepseek-harness>（`master`，tag `dsh-v0.2.1-rc.2`，commit `687f282`）
- 打包与安装：`docs/user/develop/basic/publish.md`
- 插件配置：`docs/user/develop/basic/config.md`
- 工具开发：`docs/user/develop/basic/tool.md`、`docs/cookbook/adding-a-tool.md`
- 设置卡片：`docs/cookbook/adding-a-settings-card.md`
- 客户端模块：`docs/subsystems/client-modules.md`、`packages/client/modules/README.md`
- 版本升级指南：`docs/upgrade-guide/v0.2.0-rc.2/*`、`docs/upgrade-guide/v0.2.1-alpha.*/*`
- 插件清单类型：`packages/util/package-manifest/src/types.ts`

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
| `CLIENT_EXTERNAL_UNLISTED` | MEDIUM | client | 加 `dsh.client.external` 或改 service |
| `INVARIANTS_DEP` / `INVARIANTS_IMPORT` | BLOCKER | compatibility | `dshpd_migrate remove-invariants-dep` + 改源码 |
| `INVARIANTS_ROW` | HIGH | compatibility | 删除 patch 行 |
| `SUBPATH_PACKAGE_JSON` | MEDIUM | compatibility | 改用 locale + icon 导出 |
| `TOOL_NO_OUTPUT` | HIGH | tool | 补 `output.schema/render` |
| `GLOBALTHIS_PATCH` / `PROTOTYPE_PATCH` / `DANGEROUS_COMMAND` / `SECRET_LEAK` | BLOCKER | security | 移除 |
| `GLOBAL_MUTABLE_STATE` / `PRIVATE_API` / `COMMAND_INJECTION` | CRITICAL | session/compat/security | 改作用域 / 公开 API / spawn |
| `TIMER_NO_CLEANUP` | MEDIUM | lifecycle | `ctx.effect` 清理 |
| `NO_TESTS` | MEDIUM | testing | 补测试 |

规则集是**启发式**的，不构成 DeepSeek 官方认证。
