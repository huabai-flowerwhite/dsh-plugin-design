# DSH Desktop 0.2.1-rc.3 增量兼容报告

日期：2026-10-25。基线：dsh-plugin-design **1.4.0**（rc.2 交付，历史证据保留于
`E:/creat/Codex/dsh设计插件优化建议/outputs/`）→ 本轮 **1.4.4**。
工作区：`E:/creat/DSH/rule/dsh-plugin-design`（交付物在 `updates/dsh-0.2.1-rc.3/`）。

## 1. 实际运行时身份（先确认，再验证）

| 对象 | 身份 | 来源 |
|---|---|---|
| 实际安装 | `E:/运行包/DSHpc`（就地升级后的 rc.3） | 运行进程 `E:\运行包\DSHpc\DeepSeek Harness.exe --updated` |
| Desktop 应用 | `@deepseek-ai/dsh-desktop` **0.2.1-rc.3** | `app.asar/package.json` |
| 内嵌运行时 | `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.3** | `app.asar/dsh/package.json` |
| app-boot | `@deepseek-ai/dsh-app-boot` **0.2.1-rc.3** | 同上；Host 内 `/info` 也报告此版本 |
| 配套 CLI | `@deepseek-ai/dsh` **0.2.1-rc.3**（`dsh-desktop-host/lib/cli.js`） | `app.asar/dsh/node_modules/.../package.json` |
| plugin-manager / client-modules | 均 **0.2.1-rc.3** | 同上 |
| Electron / Chrome / Node | **44.7.0** / **152.0.7977.130** / **24.21.0** | 用安装的 Electron 二进制 `ELECTRON_RUN_AS_NODE=1` 读取 `process.versions` |
| 平台 | win32 / x64 | `process.platform` / `process.arch` |
| `app.asar` | 182434783 bytes，SHA-256 `04b32e3a872826ba15cfb2081c6a929a8d4ecaa65e09a2543e5a6b30e2eff1f0` | 直接读取（`process.noAsar` 仅用于哈希归档文件） |
| 旧目录 | `E:/运行包/DSHpc.new-{GUID}` = **0.2.1-rc.2** | 同法读取其清单 |

> 这纠正了升级评估中“`E:/运行包/DSHpc` 磁盘清单仍为 rc.2”的判断：rc.2 实际在
> `.new-{GUID}` 暂存目录；主安装已就地升级为 rc.3（应用启动带 `--updated`）。
> 没有把传入的 `harnessVersion` 当作证据；以上均来自实际安装与运行进程。
> 完整证据：`evidence/runtime-identity.json`、`evidence/running-processes.json`。

## 2. 源码/合同差异核验（rc.3 发布版 vs 研究 master）

在实际安装的 rc.3 `app.asar` 内核对：

| 合同 | rc.3 发布版实际 | 研究 master（`22ddee3`） | 处理 |
|---|---|---|---|
| Manager 方法 | 有 `listBundles`/`listPlugins`/`installBundle`/`removeBundle`/`setBundleEnabled`/`setPluginEnabled`/`inspect`/`registries`/`waitForInstall`/`cancelInstall`；**无 `updateBundle`、无 `listVersions`** | 有后两者 | 能力逐项探测；缺失项 `UNSUPPORTED`；更新用精确 spec 的 `installBundle` 或官方 CLI |
| Client metadata | `dsh-client-modules` 的 `resolveMeta()` 先查 `pkgMeta`（键 = loader specifier + baseUrl），缺失/非 Client 时写入 `null`；重建不清除，直到 Host 重启 | 重协调时重新读取 | 文档/工具提示“必须整机重启”，不套用 master 结论 |
| 新“更多”菜单 | `ui-entry-customization` 等新增 slot（`sidebar.panellist.actions`、`conversation.session.header.views.actions`、`sidebar.right.tab.guide.actions`） | — | 现有 `settings.section` 仍存在；不新增入口，不迁移 |
| `dsh.bundle.listedByDefault` | 发布类型不含 | 类型含 | 不生成、不宣称 |
| `optionalDependencies` 清单类型 | 发布类型未列 | 类型含 | 仅记录类型差异，不推断 npm 行为 |

关键代码证据（rc.3 `dsh-client-modules/lib/index.js`）：

```js
resolveMeta(loaderName, baseUrl) {
  const sourceKey = this.sourceKey(loaderName, baseUrl);
  const cached = this.pkgMeta.get(sourceKey);
  if (cached !== void 0) return cached;      // includes cached null
  const located = this.locatePkgJson(loaderName, baseUrl);
  if (located === void 0) { this.pkgMeta.set(sourceKey, null); return null; }
  ...
  if (decl === void 0 || decl.platform !== "web") {
    this.pkgMeta.set(sourceKey, null);       // negative result cached
    return null;
  }
```

`settings.section` 在 rc.3 的 5 个 settings 客户端包中仍被使用；新增菜单 slot 在
`ui-entry-customization` / `ui-sidebar` 等 2 个包中出现，属于**新增入口**，不是替换。
证据：`evidence/rc3-slot-probe.json`。

## 3. 必要修改（三个真实 bug）

### 3.1 部署适配器（1.4.1）

`src/deploy/adapter.js` 把 `updateBundle` 列为必需方法，而 rc.3 发布版没有它，
导致整个官方管理器被误判为不可用。修复：

- 必需能力改为 `listBundles` + `installBundle` + `removeBundle` +
  `setBundleEnabled`；其余逐项探测。
- 输出 `required` / `missingRequired` / `optional` / `capabilities` /
  `unsupported[]`；`dshpd_mount`、`/info` 原样展示。
- `dshpd_ui_check` 增加 `metadataCache`；`inGraph=false` 与 verify 的
  `CLIENT_GRAPH` 提示 rc.3 负缓存需整机重启。

### 3.2 `FindingList` 真实渲染崩溃（1.4.2）

真实 Chromium 中点击“分析”后设置页整体空白，控制台报：

```
TypeError: h(...).concat is not a function
    at FindingList (.../dsh-plugin-design/client.js...)
```

`h()` 返回 React element，不能 `.concat`。只要有分析结果（issues > 0）就触发；
扫描-only 视图正常，所以源码/产物/React stub 测试都没发现。修复为“先构造
children 数组，再交给 `h()`”，并新增回归测试禁止对 `h()` 结果调用 `.concat`。

### 3.3 扫描错误文案（1.4.3）

不存在/不可读目录时 `/discover` 返回 `ok:false` 但没有 `error`，客户端回退成
`HTTP 200`。现在优先 `error`，其次 `scan.reasons`，最后 `scan.status`；真实
渲染器实测显示 `扫描状态：INCOMPLETE`。

### 3.4 npm 测试误取插件自身版本（1.4.4）

GitHub/npm 验证时发现：`npm test` 下 `tests/host.test.mjs:86` 失败，`node --test`
正常。根因在运行时指纹：

```js
if (nonEmpty(env.npm_package_version) !== null && nonEmpty(env.DSH_VERSION) === null) {
  candidates.push({ version: env.npm_package_version.trim(), source: 'env:npm_package_version' })
}
```

`npm test` 会设置 `npm_package_name=dsh-plugin-design` 和
`npm_package_version=1.4.3`。旧逻辑把插件自身版本当作运行中 DSH 版本，
`semverSatisfies('1.4.3', '>=0.2.5 <0.3.0')` 得 false，兼容性结论从 `null`
（UNKNOWN）变成 `false`（不兼容），与该用例意图相反。

修复：

- 仅当 `npm_package_name` 属于已知 DSH 包（`@deepseek-ai/dsh`、
  `@deepseek-ai/dsh-desktop`、`@deepseek-ai/dsh-desktop-runtime`、
  `@deepseek-ai/dsh-app-boot`、`deepseek-harness`）时才采信
  `npm_package_version`；插件自身包名被忽略。
- 降为**最后兜底**：`DSH_VERSION`、`DSH_RUNTIME_VERSION`、asar manifest 优先。
- 新增 `tests/runtime.test.mjs`（3 项）：插件版本被忽略、DSH 包名被采信、
  `DSH_VERSION` 优先。
- 验证：`node --test` 与 `npm test` 均 **103/103** 通过。

### 3.5 版本与边界

- 版本 **1.4.4**；测试 **103** 个。
- 未扩大 `engines.dsh`，未改 DSH 核心/main/preload，未新增构建脚本授权，
  未削弱计划绑定/路径/CAS/快照/回滚/扫描预算约束。

## 4. 测试与验证

| 项 | 结果 |
|---|---|
| `node --test` | **103 / 103 通过**，3.6 s（08:03:01.578–08:03:05.213Z） |
| `npm test` | **103 / 103 通过**，4.8 s（08:03:05.263–08:03:10.016Z） |
| Client 产物一致性 | `lib/client.js is up to date`，0.1 s |
| rc.3 Host：维护插件 1.4.4 | 安装→冷启动→`/info` 200→重启→卸载→再启动：**PASS**，12.6 s |
| rc.3 Host：目标插件 1.0.0（Host+Client，包未变） | 同一流程 + `/dshpd-demo/health` 200：**PASS**，17.6 s |
| rc.3 Host 运行时/能力探针 | runtime `0.2.1-rc.3`；adapter install/remove/enable=true，update/versionDiscovery=false；unsupported `updateBundle`,`listVersions`,`readBundleDetail`：**PASS**，6.2 s |
| **真实 Chromium renderer（rc.3 Web Host）** | 设置页 “dsh plugin design” v1.4.4 渲染；扫描 5 个 fixture；分析 `BLOCKED issues 9` + 问题行；非法路径 `扫描状态：INCOMPLETE`；`/health` 回执 `activated=true, rendered=true`；**0 console 异常**：**PASS**，30.9 s |
| 真实 Desktop 窗口/renderer | **NOT_RUN**：第二实例被单实例锁拒绝（exit 9，无 profile、无 CDP）；真实实例使用用户 live desktop profile，未重启、未修改，0.7 s 探测 |

时间、命令与日志：`SUPPORT-MATRIX.md`、`validation/*/clean-env-evidence.json`、
`evidence/rc3-host-info.json`、`evidence/browser-renderer/probe.json`、
`evidence/desktop-isolated-probe.json`、`evidence/quick-regression.log`、
`evidence/npm-test.log`、`increment.diff`（1.4.0 → 1.4.4 实际产物差异：
18 文件，+584/−91）。

### 渲染器与测试证据说明

`evidence/browser-renderer/probe.mjs` 用 CDP 驱动无头 Chrome：打开 rc.3 Web Host
的带 token URL → 欢迎页“继续” → 默认工作区 → 设置 → “dsh plugin design” →
输入 `tests/fixtures` → 扫描 → 分析 `broken-package` → 输入不存在目录 → 关闭。
产物：`probe.json`（含测试包 SHA-256、文本、按钮、健康回执、console 事件）与
`01…12` 截图。这是**真实浏览器渲染**，但仍**不是** Desktop 窗口/preload/原生目录选择。
`evidence/quick-regression.log` 与 `evidence/npm-test.log` 分别记录
`node --test` 和 `npm test` 的 103/103 结果。

## 5. 产物

| 产物 | SHA-256 | 字节 |
|---|---|---|
| `artifacts/dsh-plugin-design-1.4.4.tgz` | `5355cf0a0f5a179c8c2fbdcc5858b90f487e162b12d3458d04df00531639881c` | 221131 |
| `artifacts/dshpd-demo-plugin-1.0.0.tgz`（复用未变包） | `7bff8c3bd441cec9510d8c88cb010c90c6052570e306e692a22044fefd372972` | 3633 |

旧 `outputs/` 的 rc.2 安装包、manifest、hash、日志保持原样，未改写成 rc.3。
旧 1.4.1/1.4.2/1.4.3 中间包已删除，交付目录只保留最终 1.4.4 与复用的目标包。

## 6. 对四个问题的回答

1. **是否需要代码修改？** 需要：1.4.1 修适配器必需能力；真实渲染器暴露并修复
   了 1.4.2 的分析渲染崩溃和 1.4.3 的错误文案；`npm test` 又暴露并修复了
   1.4.4 的运行时指纹来源。均已包含在 1.4.4。
2. **rc.3 Host 是否验证通过？** 通过（限定无窗口 `web` Host 载体）：维护插件与
   最小 Host+Client 目标包均完成安装、冷启动、功能探测、重启、卸载、再次启动；
   `/info` 实测 runtime `0.2.1-rc.3`。
3. **真实 Desktop 窗口/renderer 是否验证通过？** Desktop 窗口 **NOT_RUN**（单实例
   锁；未触碰 live profile）。真实 Chromium 的 **Web Host renderer PASS**，覆盖
   设置页、扫描、分析渲染、错误提示、健康回执；不覆盖 Desktop preload、原生目录
   选择和显式取消按钮。
4. **旧结论哪些保留、哪些更新？** 保留 1.4.0 的修改事务/安全/分发结论与 rc.2
   历史证据。更新：`DSHpc` 已是 rc.3（rc.2 在 `.new-{GUID}`）；Manager 的
   `updateBundle/listVersions` 仅属研究分支；Client 元数据负缓存到重启；
   “无 renderer 证据”升级为“真实 Chromium Web renderer PASS、Desktop 仍 NOT_RUN”；
   `npm test` 与 `node --test` 现在是同一结论（103/103）。

## 7. 剩余限制与恢复

- 真实 Desktop 窗口/preload、原生目录选择、显式取消按钮、Linux/macOS、
  npm/GitHub 渠道安装、真实 profile 升级、动态故障注入均 `NOT_RUN`。
- 恢复：本次未改真实 profile；如需回退，把
  `C:\Users\YYZ\.dsh\profiles\node_modules\dsh-plugin-design` 的 junction 指向恢复为
  旧版本源码或用旧包重装，并重启 Desktop。临时 `DSH_HOME`、浏览器 user-data
  与探测目录已删除；证据中的 host token 已脱敏，未包含 `.credentials.yaml`。
- 发布：本任务未上传 GitHub/Release/npm；`artifacts/` 只是本地准备材料。
