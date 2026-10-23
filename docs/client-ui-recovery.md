# Client UI 恢复指南（DSH 0.1.5 → 0.2.1）

> 适用：插件原来有设置页 / 悬浮层 / 背景 / 工具卡片，DSH 升级或修改后 UI 不再出现；也适用于给**原本没有 UI** 的插件新增 UI。
> 工具：`dshpd_ui_check`（静态 + 运行中 client graph）、`dshpd_analyze`、`dshpd_verify`。

## 0. 插件原本没有 UI

`dshpd_design` 默认 `ui: "auto"`。检测到没有 `dsh.client` 时，它会：

- 在 `design.md` 增加「UI 方案建议」：入口（默认 `settings.section`）、文字线框、页面区块、数据/路由、实现清单；
- 在工具结果返回 `ui.wireframe` / `ui.userMessage` / `ui.sections` / `ui.dataPlan` / `ui.summary`，供 Agent 先向用户描述 UI 大致样貌；
- 写入 `design.meta.json`（`ui.expected=true`）；后续 `dshpd_verify` 会检查 `dsh.client` 是否真的实现。

如果不需要 UI，调用时传 `ui: "off"`，或在 design 审核阶段明确告诉 Agent “不做 UI”。

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

`inGraph=false` 优先查：row 是否裸包名、`package.json.dsh.client`、`exports["./client"]`、`lib/client.js` 是否存在，然后重启 dsh / 刷新页面。

## 2. 常见原因与修复

| 症状 | 规则 | 修复 |
|---|---|---|
| 源码改了，页面还是旧 UI | `CLIENT_BUILD_STALE` | 重新构建 `lib/client.js`，确认 mtime 晚于源码 |
| 有源码但没有构建命令 | `CLIENT_NO_BUILD_SCRIPT` | 增加 `build:client` / `prepare`，或把源码改成 factory-body + 包装脚本 |
| 设置页/悬浮层不注册 | `CLIENT_NO_UI_SLOT` / `CLIENT_LEGACY_SLOT` | 改用当前座位名（见第 4 节） |
| apply 时白屏/报错 | `CLIENT_REACT_MISSING` / `CLIENT_STYLES_SERVICE` | `require('react')`；去掉已移除的 `styles.insert` |
| 设置页 fetch 报 `Unexpected token "<"` | `CLIENT_ROUTE_MISSING` / `WEBSERVER_NOT_INJECTED` | 补 `webServer.register({ path })`，或 `ctx.inject(['webServer'], ...)` |
| 模块注册了但页面没有 | `CLIENT_BUNDLE_NO_APPLY` / `NO_INJECT` | 修构建出口 |
| 设置页整个消失 | `runtime.inGraph=false` | 检查 row / `dsh.client` / `exports` / 重启刷新 |

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
