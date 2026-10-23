# Client 服务目录快照（DSH 0.2.1）

> 用途：`CLIENT_UNKNOWN_SERVICE`、`CLIENT_LEGACY_SERVICE`、`CLIENT_WORKSPACES_PICKDIRECTORY`、`CLIENT_SERVICE_EAGER_LOOKUP` 的事实依据。
> 这不是官方 API 清单；官方源码变化时，先更新本文件，再更新 `src/services.js`。

## 1. 这次为什么需要它

`workspaces` 是**有效的** client 服务，所以只检查“服务名是否未知”不会报错：

```js
const workspaces = ctx.get('workspaces')
workspaces.pickDirectory() // 语法合法，但 workspaces 没有这个方法
```

`pickDirectory()` 在 `uiWorkspace` 上。正确写法：

```js
const uiWorkspace = ctx.get('uiWorkspace')
await uiWorkspace.pickDirectory()
```

因此规则分成两层：

| 层 | 规则 | 作用 |
|---|---|---|
| 服务名 | `CLIENT_UNKNOWN_SERVICE` | `ctx.get('...')` 的字面量不在目录中（MEDIUM，可能是其他插件提供的服务） |
| 服务名 | `CLIENT_LEGACY_SERVICE` / `CLIENT_STYLES_SERVICE` | 已知已移除的服务（HIGH） |
| 方法 | `CLIENT_WORKSPACES_PICKDIRECTORY` | `workspaces.pickDirectory` / 变量别名调用（HIGH） |

## 2. 当前快照

来源：

- 本地桌面版 `0.2.1-rc.2` 的 `@deepseek-ai/dsh-client-*` bundle；
- GitHub `master` 的 [`packages/client/ui-workspace/src/client/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-workspace/src/client/index.ts)（`super(ctx, "uiWorkspace")`、`ctx.get("workspaces")`、`ctx.remote.directoryPicker`）；
- GitHub `master` 的 [`packages/client/web/src/platform.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/web/src/platform.ts)（共享模块基线）。

| 服务 | Provider / 说明 |
|---|---|
| `slots` | `@deepseek-ai/dsh-client-ui-renderer`，客户端座位注册 |
| `workspaces` | workspace controller：`list` / `create` / `rename` / `delete` / `insertBefore`；**没有** `pickDirectory` |
| `uiWorkspace` | `@deepseek-ai/dsh-client-ui-workspace`，界面操作 + `pickDirectory()` |
| `sessions` | session controller |
| `theme` | 主题服务（`ctx.get('theme')` / `ctx.theme`） |
| `settingsSchema` / `configForms` | 设置 schema 与插件配置卡片 |
| `clientModules` | 客户端模块图（`graph()` / `clientPath()` / `table`） |
| `connection` / `remote` / `remoteAccess` | 连接与远端访问 |
| `commandUi` / `inputTriggers` / `modelDirectories` | 命令、输入触发、模型选择 |
| `locale` / `shortcuts` / `layout` | 本地化、快捷键、布局 |
| `fileUpload` / `fileUploads` / `attachments` | 附件与上传 |
| `sidebarRightTabs` / `userQuestionPanels` | 右侧栏 tab、用户问题面板 |
| `workspaceRegistry` | Host 侧 workspace registry |
| `directoryPicker` / `workingDirectory` | 目录选择与工作目录 |
| `productAnalytics` / `pluginRegistryProbe` / `cotTranslation` | 分析、插件注册探针、CoT 翻译 |
| `timer` / `jobs` / `webTerminals` | 定时器、任务、终端 |

已移除：

| 服务 | 替代 |
|---|---|
| `styles` | 无；插件自己创建 `<style>` 或内联 style |

## 3. 取值时机（eager lookup）

服务名正确，不代表 apply 时已经就绪。第三方 client 服务由其他插件激活，`ctx.get('uiWorkspace')` 在 apply 早期可能是 `undefined`：

```js
const uiWorkspace = ctx.get('uiWorkspace')
const pickDirectory = uiWorkspace && typeof uiWorkspace.pickDirectory === 'function'
  ? uiWorkspace.pickDirectory
  : null // 一旦固化为 null，之后点击也不会重试
```

`CLIENT_SERVICE_EAGER_LOOKUP` 检测这种“apply/顶层取值 + `typeof` 缓存”的写法，建议：

```js
const pickDirectory = function () {
  const uiWorkspace = ctx.get('uiWorkspace') // 每次点击时重新取
  if (!uiWorkspace || typeof uiWorkspace.pickDirectory !== 'function') {
    return Promise.reject(new Error('uiWorkspace 不可用，请手动输入路径'))
  }
  return uiWorkspace.pickDirectory()
}
```

或用 `ctx.inject(['uiWorkspace'], (ctx) => { ... })` 等待服务。

作用域是启发式判断：顶层和 `apply(...)` 视为 eager；其他函数体（如 `const pickDirectory = function () { ... }`）视为延迟 helper，不报。框架服务（`slots` / `loader` / `logger` / `effect` / `on` / `inject` 等）在 apply 时保证可用，不报。

## 4. 更新流程

1. 在官方客户端源码中搜索 `ctx.get('...')`、`super(ctx, '...')`、`Service.provide`；
2. 确认 provider 包名与公开方法；
3. 更新 `src/services.js` 的 `CLIENT_SERVICE_CATALOG` / `LEGACY_CLIENT_SERVICES` / `findWorkspacesPickerMisuse`；
4. 在 `tests/services.test.mjs` 增加样本；
5. 跑 `npm test`，并更新本文件的快照日期。

> 静态规则是启发式：第三方插件可以注册自己的服务，`CLIENT_UNKNOWN_SERVICE` 只是提示，不是阻断。
