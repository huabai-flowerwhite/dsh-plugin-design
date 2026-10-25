# Client UI 恢复指南（基线 0.2.1-rc.3）

> 适用：插件原来有设置页 / 悬浮层 / 背景 / 工具卡片，DSH 升级或修改后 UI 不再出现；也适用于给**原本没有 UI** 的插件新增 UI。
> 工具：`dshpd_ui_check`（分层：bundle → graph → 激活/渲染回执）、`dshpd_analyze`、`dshpd_verify`。

## 0.0 rc.3 的 metadata 负缓存（先读）

DSH `0.2.1-rc.3` 的 `client-modules` 在 `resolveMeta(loaderName, baseUrl)` 中按
`loader specifier + baseUrl` 缓存包元数据，并把 `null`（“不是 Client 包”）也写入
缓存。该缓存要到 **Host/Desktop 重启**才失效：

- 新安装带 Client 的包、给已有包补 `dsh.client` / `exports["./client"]`，或修改
  入口文件后，只刷新页面、只做 HMR、只重装 Client bundle 都**不会**让旧负结果
  消失。
- 正确步骤：完成清单/文件修改 → 重启整个 Desktop（或对应 Host）→ 再运行
  `dshpd_ui_check`，确认 `inGraph=true`，并等待 Client 半体的 `rendered` 回执。
- `dshpd_ui_check` 会在 `metadataCache` 字段说明缓存范围、键与失效方式；
  `inGraph=false` 的 `reason` 与 `dshpd_verify` 的 `CLIENT_GRAPH` 失败详情也会
  提示整机重启。这是 rc.3 发布版行为，不套用后续研究分支“重协调时重新读取”的结论。

## 0.1 1.4.0 的分层证据（先读）

`dshpd_ui_check` 不再把 `inGraph=true` 当成“UI 正常”。它分别报告：

| 阶段 | 证据 | 说明 |
|---|---|---|
| served | `clientPath` 存在 | 只是文件在 |
| registered | 运行中 client module graph 有该包 | Loader 愿意提供模块 |
| activated | Client 半体上报 `activated=true` | 模块体已执行、apply 完成 |
| rendered | Client 半体上报 `rendered=true` | 面板已渲染（插件自己上报，非官方通道） |

没有新鲜回执时状态是 `UNKNOWN`，不是 PASS。回执通过
`POST /dsh-plugin-design/client-health` 发送，保留 10 分钟。
`buildStale` 只是 mtime 提示，不能证明产物新旧。

## 0. 插件原本没有 UI

`dshpd_design` 默认 `ui: "auto"`：只有目标确实有用户可见配置/状态时才会提议新增
UI；纯工具、库、规则包默认给出 `uiMode=not-needed`，**不会自动创建 Client 半体**。
需要强制提议时传 `ui: "propose"`；不需要时传 `ui: "off"`。

## 1. 先确认“运行中的页面到底有没有它”

```text
使用 dsh plugin design 检查 <插件路径> 的 UI
```

`dshpd_ui_check` 返回：

| 字段 | 含义 |
|---|---|
| `runtime.available` | 当前上下文能否访问 `clientModules` 服务 |
| `runtime.inGraph` | 运行中的 client graph 是否包含该包；false 时 UI 必然不出现 |
| `runtime.rev` / `clientPath` | 当前加载的 bundle 版本与绝对路径 |
| `runtime.bundleExists` | `clientPath` 指向的文件是否存在 |
| `buildStale` | `src/client` 是否比 `lib/client.js` 新 |
| `applyPresent` / `injectPresent` | bundle 是否导出 `apply` / `inject` |
| `uiSlots` | 检测到的 UI 座位 |
| `deployment.desktop.mounted` | desktop profile 的 patch 是否有该包 |
| `deployment.desktop.packageResolvable` | 从 desktop profile 能否解析到该包 |
| `rootCause` | `DESKTOP_PROFILE_NOT_MOUNTED` / `CLIENT_NOT_DISCOVERED_IN_GRAPH` |

### 桌面版先看 profile

桌面版加载 `desktop` profile，第三方插件通过 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 的 insert row 挂载。如果插件只挂在 `profiles/web`：

- `runtime.inGraph=false`，`deployment.desktop.mounted=false`，`rootCause=DESKTOP_PROFILE_NOT_MOUNTED`；
- 这不是代码/清单问题，改代码不会让 UI 出现；
- 用 `dshpd_mount({ packageName, apply: true })` 追加行（会先备份 patch），然后**重启桌面版**；
- `web` 挂载对桌面版无效；client-modules 只扫描当前 Loader 中已挂载的 entries。

`inGraph=false` 其余情况再查：row 是否裸包名、`package.json.dsh.client`、`exports["./client"]`、`lib/client.js` 是否存在，然后重启 dsh / 刷新页面。

## 2. 常见原因与修复

| 症状 | 规则 | 修复 |
|---|---|---|
| 源码改了，页面还是旧 UI | `CLIENT_BUILD_STALE` | 重新构建 `lib/client.js`，确认 mtime 晚于源码 |
| 有源码但没有构建命令 | `CLIENT_NO_BUILD_SCRIPT` | 增加 `build:client` / `prepare`，或把源码改成 factory-body + 包装脚本 |
| 设置页/悬浮层不注册 | `CLIENT_NO_UI_SLOT` / `CLIENT_LEGACY_SLOT` | 改用当前座位名（见第 4 节） |
| apply 时白屏/报错 | `CLIENT_REACT_MISSING` / `CLIENT_STYLES_SERVICE` | `require('react')`；去掉已移除的 `styles.insert` |
| 目录选择器点了没反应 | `CLIENT_WORKSPACES_PICKDIRECTORY` | `workspaces` 没有 `pickDirectory`；改用 `ctx.get('uiWorkspace').pickDirectory()` |
| 服务名对但功能一直为空 | `CLIENT_SERVICE_EAGER_LOOKUP` | 不要在 apply 时缓存 `ctx.get(...)`；点击时重新取或 `ctx.inject` |
| 设置页 fetch 报 `Unexpected token "<"` | `CLIENT_ROUTE_MISSING` / `WEBSERVER_NOT_INJECTED` | 补 `webServer.register({ path })`，或 `ctx.inject(['webServer'], ...)` |
| 模块注册了但页面没有 | `CLIENT_BUNDLE_NO_APPLY` / `NO_INJECT` | 修构建出口 |
| 设置页整个消失 | `runtime.inGraph=false` | 先看 `rootCause` / `deployment.desktop.mounted`，再查 row / `dsh.client` / `exports` / 重启 |

## 3. 构建产物契约

`lib/client.js` 必须是 lazy-CJS factory：

```js
window.__ModuleLoader__.load({
  id: '<package name>',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    function apply(ctx) { /* slots / host 路由等 */ }
    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
```

- `id` 必须等于包名。
- 必须导出 `apply`；依赖座位时导出 `inject: ['slots']`。
- 只允许平台基线模块与 `dsh.client.external` 中的精确 specifier；其余模块要么打进 bundle，要么改成 service 协作。
- 构建后 `lib/client.js` 的 mtime 必须晚于 `src/client`，否则页面加载旧版本。

### 没有构建脚本时

两条可行路线：

1. **factory-body 源码**（本插件采用）：`src/client.js` 直接写 factory 内部代码，`scripts/build-client.mjs` 加壳生成 `lib/client.js`，`package.json` 加 `build:client`。适合无 JSX、无外部依赖的 UI。
2. **ESM/TS + 打包器**：用 esbuild/tsdown/rollup 把 `src/client/**` 打成 CJS，再用 banner/footer 包成 `__ModuleLoader__.load`；`prepare` 里执行构建，`files` 带上 `lib/`。

> 修改 client 源码后，`dshpd_apply` 会返回 `rebuildRequired: true`；`dshpd_verify` 的 `CLIENT_BUILD_FRESH` 会在 bundle 仍过期时 FAIL。

## 4. 当前可用的设置/UI 座位

| 目的 | 座位 |
|---|---|
| 设置整页 | `settings.section` |
| 插件区标签页 | `settings.plugins.tab` |
| 通用设置行 | `settings.general.item` |
| 插件配置卡片 | `plugins.item`（`ctx.configForms`） |
| 插件详情扩展 | `plugins.detail.actions` / `badge` / `section` |
| 全局悬浮层 | `shell.overlay`（按当前 Harness 版本为准） |
| 工具卡片 | `tool.call.toolview` |
| 侧栏/会话/聊天 | `sidebar.*` / `conversation.*` 等 |

旧版 `settings.plugin.item` / `settings.plugin.page` 等不再渲染。

## 5. 修复顺序

```text
1. dshpd_ui_check            # 确认 inGraph / buildStale / 路由 / slot
2. 改 src/client 或 host
3. 重新构建 lib/client.js
4. 刷新页面（必要时重启 dsh）
5. dshpd_ui_check            # inGraph=true, buildStale=false, applyPresent=true
6. 打开设置页/悬浮层确认
7. dshpd_verify              # 备份/构建/分析回归
```

如果 UI 仍然不出现，把 `dshpd_ui_check` 的 `runtime`、`issues` 和浏览器 Console 的报错一起提供给 Agent。
