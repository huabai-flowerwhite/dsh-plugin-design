# dsh plugin design

> 给 DSH 插件做体检、改造、**部署**和 **UI 落地**。桌面端优先。

一句话：**它先帮你把插件问题讲清楚，再生成一份可执行的 `design.md`；你确认后，它按施工图修改插件、补 UI、部署并挂载到桌面端，最后做校验。**

它特别适合这几类事：

- **第三方插件部署 / 版本适配**：把只在 web 可用、或只兼容旧版 DSH 的插件，按当前 0.2.x 规范迁移并挂载到 `desktop` profile。
- **桌面端设置页 / 悬浮层 / 面板不出现**：先判断是没挂载到 `desktop` profile，还是 client bundle 过期、slot/路由失效，再给出修复步骤。
- **插件没有 UI**：自动在 `design.md` 里补一份 UI 方案，先用文字线框告诉你大概长什么样，确认后再开发。
- **旧插件要升级 / 规范化**：对照官方 0.2.x 契约检查清单、bundle、client、安装方式、安全与生命周期风险，改完可校验、可回滚。

> 适用对象：使用 **DSH 桌面版**，想排查插件 UI、把 web 插件迁到桌面端、或按官方规范开发插件的用户。
>
> 说明：DH-TP-SDK 的 Bronze/Silver/Gold、P0–P4、S0–S4 是工程化等级，不是 DeepSeek 官方认证。

---

## 30 秒判断：你可能正需要它

| 你遇到的现象 | 它怎么帮你 |
|---|---|
| 插件明明装了，桌面版设置页却没有入口 | 检查 `desktop` profile 是否挂载；没挂载就生成挂载行，`dshpd_mount` 可备份并追加 |
| 第三方插件只在 web 能用 / 只兼容旧版 DSH | 按当前 0.2.x 契约检查并迁移 `engines.dsh`、`manifestVersion`、bundle、client、exports，再部署到 `desktop` profile |
| 插件安装/发布不完整，缺 patch、client、icon | 检查 `package.json.dsh`、`files`、bundle patch、client bundle 与图标，给出要补的文件 |
| 设置页以前有，升级 DSH 后消失 | 检查运行中的 client graph，区分「没挂载」「没重启」「bundle 过期」「slot/路由失效」 |
| 插件只有 Host 能力，没有界面 | 在 `design.md` 生成 UI 方案：入口、文字线框、页面区块、数据/路由、实现清单 |
| 改完 client 源码，页面还是旧 UI | 检查 `src/client` 与 `lib/client.js` 的时间差，提醒重新构建 |
| 不知道从哪里开始改 | 先分析，产出 `design.md`；你审核后再动手，不会一上来就改源码 |

---

## 部署第三方插件 & 适配当前 DSH（核心场景）

它不是只给“分析报告”。从发现插件到在桌面版里真正跑起来，整条链路都可以交给它：

> “规范化”指按当前规则集 `0.2.1` 对齐 `package.json.dsh`、`engines.dsh`、`manifestVersion`、bundle、client、`exports`、npm `files`、图标，以及安全和生命周期要求。

```text
发现/读取 → 契约检查 → 生成 design.md → 你确认
→ 迁移清单 / 修改源码 → 构建 client bundle
→ 挂载到 desktop profile → 重启桌面版
→ dshpd_ui_check → dshpd_verify（失败可 rollback）
```

### 典型应用场景

| 场景 | 它会做什么 |
|---|---|
| **第三方插件只支持旧版 DSH** | 对照当前 0.2.x 契约，迁移 `engines.dsh`、`manifestVersion`、bundle、client、`exports`，清理已移除的 invariants/旧 API |
| **插件只在 web profile 可用** | 检查 desktop profile 的挂载与包解析；生成挂载行，`dshpd_mount` 备份后追加，提示重启桌面版 |
| **插件原来没有 UI** | 在 `design.md` 生成 UI 方案（入口、文字线框、页面区块、数据/路由），确认后按 `M-UI-*` 开发 |
| **插件有 UI，但升级后消失** | 区分“没挂载 / 没重启 / bundle 过期 / slot 或路由失效”，逐项给出修复 |
| **插件发布物不完整** | 检查 npm `files`、bundle patch、client bundle、icon、`type: module`，列出要补的文件 |
| **改造后需要验证/回滚** | `approve → backup → apply/migrate → verify`；失败或结果不满意用 `dshpd_rollback` |

### 交付标准

- 默认以 **desktop profile 可加载** 为最终目标；
- 清单迁移用 `dshpd_migrate`，源码修改用 `dshpd_apply`，client 产物必须重新构建；
- desktop 挂载用 `dshpd_mount`（默认 dryRun，`apply:true` 才写，写前备份）；
- 最后用 `dshpd_ui_check` 确认 `inGraph=true`，再用 `dshpd_verify` 做整体校验。

> 支持来源是 web 插件、旧版插件，或从零开发的新插件；只对目标插件做备份、修改，并在其目录下写 `.dsh-plugin-design`，不会修改 DSH Core。
>
> 如果 desktop profile 解析不到包，工具会返回 `deployment.desktop.packageResolvable=false`，提示先把包 link/install 到 `$DSH_HOME/profiles/node_modules`，不会假装挂载成功。

---

## 目录结构（先认识它）

```text
dsh-plugin-design/
├── install.ps1 / install.sh    # 官方安装优先，link 回退（互斥、幂等）
├── package.json                # 官方清单：engines.dsh / dsh.bundle / dsh.client / exports / icon
├── dsh.plugin.yaml             # DH-TP-SDK 附加工程化清单（运行时可选）
├── cordis.patch.yml            # bundle patch 层：插入本插件 row
├── assets/icon.svg             # 插件管理器图标
├── README.md / design.md / CHANGELOG.md / LICENSE
├── docs/official-plugin-contract-0.2.md   # 规则集事实依据（含官方链接与规则映射）
├── docs/client-ui-recovery.md             # UI 消失排查、构建契约、当前座位
├── docs/service-catalog-0.2.1.md          # client 服务目录快照（workspaces/uiWorkspace 等）
├── lib/client.js               # 构建产物（factory-form，由 scripts/build-client.mjs 生成）
├── scripts/build-client.mjs    # src/client.js → lib/client.js（含 --check）
├── src/
│   ├── index.js                # Host 入口 → host.js
│   ├── host.js                 # 14 个工具、持久化备份/journal、设置页只读路由
│   ├── profiles.js             # desktop/web profile 挂载、包解析、mount
│   ├── rules.js                # 纯规则引擎（官方契约 + DH-TP-SDK + 源码扫描 + SemVer）
│   └── client.js               # Client 半体源码（factory body）
└── tests/                      # 37 个规则/宿主/客户端/bundle/部署/服务测试 + 3 个插件样本
```

- 你主要接触 `src/`、`lib/client.js`、`docs/` 和测试；
- `profiles.js` 负责桌面端/web 的 profile 差异；
- 构建产物 `lib/client.js` 不要手改，统一走 `npm run build:client`。

---

## 桌面端 UI 助力（本插件最核心的价值）

### 为什么桌面端 UI 容易“消失”

DSH 桌面版启动时加载的是 `desktop` profile（目录 `$DSH_HOME/profiles/desktop/`）。第三方插件通常通过在这个文件里登记 insert row 来挂载：

```text
$DSH_HOME/profiles/desktop/cordis.patch.yml
```

它**不会**因为某个插件装在 `profiles/web` 里就自动加载它。插件没登记在 `desktop` profile：

1. 包不会被桌面版 Loader 挂载；
2. 它的 client 半体不会进入桌面端页面的启动 graph；
3. 设置页 / 悬浮层自然没有入口。

这跟插件代码写得好不好是两件事。**先看挂载，再看 UI 代码。**

### 它具体能帮你做什么

1. **诊断桌面端 UI**
   `dshpd_ui_check` 同时看两件事：
   - 运行中的 client graph：`inGraph`、`rev`、`clientPath`
   - 源码与构建：`buildStale`、`apply` / `inject`、UI 座位、client 路由

2. **判断根因**
   返回 `rootCause`：
   - `DESKTOP_PROFILE_NOT_MOUNTED`：desktop patch 没这个包，web 挂载无效
   - `CLIENT_NOT_DISCOVERED_IN_GRAPH`：已挂载，但需要重启桌面版或修清单

3. **补 UI 方案**
   插件没有 `dsh.client` 时，`dshpd_design` 自动生成「UI 方案建议」：
   - 入口：默认注册到设置导航（`settings.section`，标题为「<插件名> 设置」）
   - 文字线框：先让你看懂大概长什么样
   - 页面区块：状态、配置/能力、最近结果、空/错误状态
   - 数据与路由：Host 怎么提供数据、client 怎么请求
   - 实现清单：`dsh.client`、factory bundle、构建脚本、slot 注册、验证

4. **真正挂载到桌面端**
   `dshpd_mount` 默认只预览要追加的 YAML；`apply: true` 时先备份 desktop patch，再追加挂载行。追加后必须**重启桌面版**。

5. **开发阶段不跑偏**
   `design.md` 固定包含「Desktop Profile Deployment」和 `M-PROFILE-*` 项；`design.meta.json` 记录 `deployment.expected`，`dshpd_verify` 发现没挂载会直接 FAIL。

> **最短路径：** 在聊天框输入：
>
> `使用 dsh plugin design 检查 <插件路径> 的 UI，告诉我为什么没显示、要怎么修。`
>
> 先看 `deployment.desktop.mounted` 和 `rootCause`，再决定是 `dshpd_mount`、重启，还是改 client 代码。

### 一张图看懂 UI 排查顺序

```text
设置页 / 悬浮层没出现
        │
        ├─ desktop profile 没挂载？
        │     → dshpd_mount（先 dryRun，再 apply:true）
        │     → 重启桌面版
        │
        ├─ 已挂载，但 inGraph=false？
        │     → 重启桌面版（client 判定会缓存）
        │     → 仍失败：查 dsh.client / exports["./client"] / lib/client.js
        │
        └─ inGraph=true，但页面空白 / 旧 UI？
              → buildStale：重新构建 lib/client.js
              → CLIENT_ROUTE_MISSING：补 Host 路由
              → CLIENT_NO_UI_SLOT / LEGACY_SLOT：改 slot 名称
              → CLIENT_STYLES_SERVICE：去掉已移除的 styles.insert
              → CLIENT_WORKSPACES_PICKDIRECTORY：取目录用 uiWorkspace.pickDirectory()
```

更完整的排查与构建说明见 [docs/client-ui-recovery.md](docs/client-ui-recovery.md)。

---

## 怎么用（聊天框，3 步）

### 第 1 步：分析，产出 `design.md`

在聊天框输入：

```text
使用 dsh plugin design 插件，分析 <插件路径>，输出 design.md。
先只分析，不要修改代码。
如果插件没有 UI，请给出 UI 方案，并先描述大致样貌。
```

Agent 会扫描插件，把设计写到：

```text
<插件目录>/.dsh-plugin-design/design.md
```

`design.md` 会写清楚：

- 插件现状与官方契约对比
- 发现的问题（按严重度）
- 要改哪些文件、每项怎么改
- **Desktop Profile Deployment**：桌面端是否已挂载、怎么挂载
- **UI 方案建议**（原本没有 UI 时）或 **UI 恢复与验证**（原本有 UI 时）
- 怎么验证、怎么回滚

### 第 2 步：你审核 `design.md`

重点看三件事：

1. **UI 入口和大致样貌**是否符合预期（Agent 应先用文字线框向你描述）；
2. **桌面端挂载方案**是否清楚（追加哪一行、什么时候重启）；
3. 修改范围、风险和验证方式是否可接受。

不满意就直接告诉 Agent，让它更新 `design.md`，直到你确认。

### 第 3 步：确认后修改 / 规范 / 开发

```text
design.md 我已确认（含 UI 方案）。请按它修改 / 规范 / 开发 <插件>，
完成后调用 dshpd_verify 校验；出错时用 dshpd_rollback 回滚。
```

Agent 会按门控流程执行：

```text
approve 审批 → backup 备份 → apply/migrate 修改
→ verify 校验 → rollback/report（回滚 / 报告）
```

修改前会备份到 `<插件目录>/.dsh-plugin-design/backup/`。校验失败或结果不满意，可以回滚。

> `design.md` 是施工图，不是终点。确认后可以继续让 Agent **修改现有代码**、**按规范重构**，或者**从零开发新插件**。只想先看分析结果的话，停在第 1 步或第 2 步即可，不会改任何源码。

---

## 安装 / 升级（桌面端优先）

### 方式一：官方 bundle 安装（web profile / 有 `dsh` CLI）

```bash
# 安装
dsh plugin --profile web add <本目录或 npm 包名>

# 升级：先 remove 再 add（HMR 下不允许覆盖安装）
dsh plugin --profile web remove dsh-plugin-design
dsh plugin --profile web add <本目录或 npm 包名>
```

`--profile` 要写在 `add` / `remove` 等 pnpm 参数之前。安装成功后，本包会进入 profile 的 `dsh.profile.bundles`，工具和设置页由 bundle patch 自动挂载。

> **桌面版不要用这条命令**：`dsh plugin --profile desktop` 会被拒绝，请用下面的「方式二」指定 `-Profile desktop`。

### 方式二：仓库脚本（没有 `dsh` CLI，或桌面端）

**Windows**

```powershell
git clone <你的仓库> dsh-plugin-design
cd dsh-plugin-design
powershell -ExecutionPolicy Bypass -File install.ps1
# 强制 link 模式： -Mode link    指定 profile： -Profile web
```

**Linux / macOS**

```bash
git clone <你的仓库> dsh-plugin-design
cd dsh-plugin-design
bash install.sh
# 强制 link 模式： --mode link    指定 profile： --profile web
```

脚本检测到 `dsh` 时走官方安装；否则把包链接进 `$DSH_HOME/profiles/node_modules` 与 `profiles/<profile>/node_modules`（如存在），并向 profile `cordis.patch.yml` 追加一行。脚本是幂等的，也会避免「bundle + patch 双挂载」。

### 桌面端怎么装

桌面版使用 `desktop` profile（由 Electron 托管，`dsh plugin --profile desktop` 会被拒绝）。请在安装时显式指定：

```powershell
# Windows：桌面端
powershell -ExecutionPolicy Bypass -File install.ps1 -Profile desktop -Mode link
```

```bash
# Linux / macOS：桌面端
bash install.sh --profile desktop --mode link
```

安装完**重启桌面版**，再刷新页面，就能在聊天框看到 14 个 `dshpd_*` 工具，并在「设置 → dsh plugin design」看到设置页。

> 运行中新增挂载时，Host 半体可能立即生效；Client 半体需要刷新页面（Ctrl+R / Cmd+R）或重启应用，设置页才会出现在导航里。

---

## 在设置页使用

「设置 → dsh plugin design」提供三个快捷操作：

- **扫描**：列出一个目录下的第三方插件项目。
- **分析**：只读检查某个插件，显示总体结论、主要问题，以及 **桌面 profile 是否已挂载**。
- **规范修改**：生成一段带插件路径的聊天框提示词，复制到聊天框继续第 1 步。

也可以直接点某个插件行的「规范修改」，提示词会自动带上它的路径。

![How‑to Showcase](<How‑to Showcase.png>)

设置页的扫描和分析都是只读的，不会修改文件；真正的修改只发生在聊天框第 3 步。

---

# 以下是详细说明（面向开发与排障）

## UI：没有 UI 时自动提案

`dshpd_design` 默认 `ui: "auto"`。目标插件没有 `dsh.client` 时，会生成「UI 方案建议（待用户确认）」：

- `.dsh-plugin-design/design.md` 增加完整章节；
- 工具返回 `ui.summary` / `ui.userMessage` / `ui.wireframe` / `ui.sections` / `ui.dataPlan` / `ui.implementation`；
- `ui.userMessage` 是一段可直接转述给用户的中文说明，含文字线框；
- 用户确认后，按 `M-UI-*` 实施：
  - `M-UI-1`：`package.json` 增加 `dsh.client` / `exports["./client"]` / `files`
  - `M-UI-2`：新增 `src/client.js` 与构建脚本，产出 factory-form `lib/client.js`
  - `M-UI-3`：Host 增加状态/配置路由（`ctx.inject(['webServer'], ...)`）
  - `M-UI-4`：client 注册 `settings.section`（或 design 确定的其它座位）
  - `M-UI-5`：重新构建 → 刷新 → `dshpd_ui_check` → `dshpd_verify`

示例（design.md 里的文字线框，实际视觉会跟随 Harness 主题）：

```text
┌──────────────────────────────┐
│ <插件名> 设置          v0.1.0 │
│ 状态：运行中 / 未配置         │
├──────────────────────────────┤
│ 配置区：字段 A [____]        │
│         字段 B [x]           │
├──────────────────────────────┤
│ [保存] [重载] [查看最近结果] │
└──────────────────────────────┘
```

如果明确不需要 UI：告诉 Agent“不做 UI”，或调用 `dshpd_design` 时传 `ui: "off"`。

## UI：原本有 UI，升级后消失

先运行：

```text
使用 dsh plugin design 检查 <插件路径> 的 UI，告诉我为什么没显示、要怎么修。
```

`dshpd_ui_check` 会同时检查源码/产物与运行中的 client graph：

| 检查结果 | 含义 | 处理 |
|---|---|---|
| `runtime.inGraph = false` | 页面没有注册这个 client 半体 | 先看 `rootCause`；`DESKTOP_PROFILE_NOT_MOUNTED` 用 `dshpd_mount`，`CLIENT_NOT_DISCOVERED_IN_GRAPH` 重启桌面版 |
| `deployment.desktop.mounted = false` | desktop patch 没有该包，web 挂载对桌面版无效 | `dshpd_mount({ packageName, apply: true })`，然后重启 |
| `buildStale = true` | `src/client` 比 `lib/client.js` 新，页面加载旧 UI | 重新构建 client bundle 后刷新 |
| `CLIENT_NO_BUILD_SCRIPT` | 有 client 源码但没有 build/prepare 命令 | 先补可重复构建脚本，否则改完源码无法生成新 bundle |
| `CLIENT_ROUTE_MISSING` | client fetch 的本地路由在 Host 源码里找不到，请求落到 SPA HTML | 补 `webServer.register({ path })`，或修正 fetch 路径 |
| `WEBSERVER_NOT_INJECTED` | 用了 `ctx.webServer` 但没有等待 `webServer` 服务 | 加 `inject` 或用 `ctx.inject(['webServer'], ...)` |
| `CLIENT_STYLES_SERVICE` | 使用了已移除的 `styles.insert` | 改为插件自己创建 `<style>` 或内联 style |
| `CLIENT_WORKSPACES_PICKDIRECTORY` | 把 `workspaces` 当成目录选择器 | 改用 `ctx.get('uiWorkspace').pickDirectory()` |
| `CLIENT_UNKNOWN_SERVICE` | `ctx.get('...')` 不在当前 client 服务目录 | 若由其他插件提供可忽略；否则核对 provider |
| `CLIENT_LEGACY_SERVICE` | 使用了已移除的 client 服务 | 按 `docs/service-catalog-0.2.1.md` 替换 |
| `CLIENT_BUNDLE_NO_APPLY` / `NO_INJECT` | factory 模块没有导出 `apply` / `inject` | 修构建出口 |
| `CLIENT_NO_UI_SLOT` | 没有注册任何已知 UI 座位 | 检查是否用了已移除的 slot 名称 |
| `CLIENT_LEGACY_SLOT` | 用了旧版 `settings.plugin.item` 等 slot | 改用 `settings.section` / `settings.plugins.tab` / `plugins.item` |

> 特别注意：`workspaces` 是**合法服务**，所以只查“未知服务”不会报它；但 `pickDirectory` 在 `uiWorkspace` 上。`CLIENT_WORKSPACES_PICKDIRECTORY` 专门检查这种“服务名合法、方法不存在”的调用。

> 修复顺序：改 client 源码 → **重新构建** `lib/client.js` → 刷新页面 → `dshpd_ui_check` 确认 `inGraph=true`、`buildStale=false` → 再跑 `dshpd_verify`。

## 桌面端部署：profile 机制

桌面版加载 `desktop` profile；第三方插件通过 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 的 insert row 挂载。`profiles/web` 的挂载对桌面版无效。

- `dshpd_analyze` / `dshpd_ui_check` / `dshpd_verify` / `/analyze` 都返回：

  ```json
  {
    "deployment": {
      "desktop": {
        "mounted": true,
        "patchPath": ".../profiles/desktop/cordis.patch.yml",
        "packageResolvable": true,
        "packagePath": "..."
      },
      "web": { "mounted": true }
    }
  }
  ```

- `dshpd_mount({ packageName })` 默认 dryRun，只返回要追加的 YAML；
- `dshpd_mount({ packageName, apply: true })`：
  1. 备份 patch 为 `.bak-dshpd-<时间戳>`；
  2. 追加 `- insert: - id: <包名>`；
  3. 返回 `restartRequired: true` 和验证命令；
- 追加后**必须重启桌面版**，因为 client-modules 对“非 client 包”的判定会缓存到重启；
- 如果 `deployment.desktop.packageResolvable=false`，先把包 link/install 到 `$DSH_HOME/profiles/node_modules`，再挂载。

`design.md` 固定包含「Desktop Profile Deployment」，未挂载时给 `M-PROFILE-*` 和可直接追加的 YAML。

## 工作流程与安全边界

```text
阶段 1（只读分析）
  discover → inspect → analyze → ui_check → design（生成 design.md）

阶段 2（你确认后）
  approve（门控）→ backup（备份）→ apply / migrate（修改 / 迁移）
  → verify（校验）→ rollback / report（回滚 / 报告）
```

- 分析先于修改，设计先于执行；
- 未确认不修改；
- 修改前备份，失败可回滚，改后可校验；
- 不修改 Core，不使用 private API；
- `dshpd_mount` 写 profile patch 前会先备份；默认 dryRun，只有显式 `apply:true` 才写。

## 工具清单（14 个）

| 阶段 | 工具 | 作用 |
|---|---|---|
| 分析 | `dshpd_discover` | 递归发现插件项目，报告 bundle / client / engines.dsh 角色 |
| 分析 | `dshpd_inspect` | 读取单个插件的清单、patch、client、目录与源码清单（只读） |
| 分析 | `dshpd_analyze` | 规则集 `0.2.1` 启发式扫描，输出问题、官方契约快照、可执行迁移、评分、结论与 desktop/web profile 挂载状态 |
| 分析 | `dshpd_ui_check` | 检查 UI 是否真的注册进运行中的 client graph，给出 `rootCause`（桌面 profile 未挂载 / 已挂载未发现），并报告构建过期、apply/inject、UI 座位与缺失路由 |
| 分析 | `dshpd_design` | 生成 `design.md`（含契约快照、问题、迁移项、修改计划、Desktop Deployment；无 UI 时附 UI 方案，有 UI 时附恢复清单） |
| 部署 | `dshpd_mount` | 检查 desktop/web profile 挂载；`apply:true` 时备份并追加 desktop patch 行（桌面版必做） |
| 执行 | `dshpd_approve` | 你确认后开启审批门，签发 approvalToken |
| 执行 | `dshpd_backup` | 快照待改文件（含 hash 与分析摘要，持久化） |
| 执行 | `dshpd_apply` | 单文件字面量替换；三重校验 + 写前 hash 校验 + `dryRun` |
| 执行 | `dshpd_migrate` | 仅改 `package.json` 的受限迁移（`engines.dsh`、`dsh.bundle`、`dsh.client` 等） |
| 执行 | `dshpd_verify` | 校验备份、文件可解析、无冲突标记、client bundle 形态、桌面挂载、分析是否退化 |
| 恢复 | `dshpd_rollback` | 从备份恢复（重启后仍可用） |
| 报告 | `dshpd_status` | 查看内存任务，或按插件路径列出磁盘备份与 journal |
| 报告 | `dshpd_report` | 输出修改报告：备份文件、编辑/迁移、校验结果、前后分析、剩余风险 |

## 专业细节：规则与架构

### 规则集（`src/rules.js`）

纯函数、无 I/O，便于单测和复用。覆盖：

- **官方契约**：`engines.dsh`、`dsh.manifestVersion`、`dsh.bundle.patch`、`dsh.client`、Host 入口、`exports`、图标、`type: module`、npm `files`。
- **0.2.0 移除项**：`@deepseek-ai/dsh-invariants`、`<pkg>/invariant`、旧 patch 行、子路径 `package.json`。
- **UI**：构建过期、无构建脚本、bundle 缺 `apply`/`inject`、旧 slot、React 未引入、已移除的 `styles.insert`、client 路由缺失、webServer 未注入；以及 **client 服务目录**检查（`workspaces` ≠ `uiWorkspace`、未知服务、旧服务）。服务快照见 [docs/service-catalog-0.2.1.md](docs/service-catalog-0.2.1.md)。
- **源码安全**：globalThis/window/prototype patch、类型断言绕过、模块级 session 状态、危险命令、命令注入、硬编码密钥、`eval`/`new Function`、定时器未清理、工具缺 `output`、waterfall 缺 `next()`。

### 持久化状态

- `backup/<backupId>/manifest.json`：插件路径、design 路径、文件列表（路径 / 备份名 / 字节数 / sha256）、备份时分析摘要；
- `journal.jsonl`：`backup` / `apply` / `migrate` / `verify` / `rollback` 条目，保留最近 500 条；
- `design.md` / `design.vN.md`：由 `dshpd_design` 生成；
- `design.meta.json`：`ui.expected`、`deployment.expected` 等，供 `dshpd_verify` 校验。

### Host / Client 半体

- **Host**：`src/host.js`，14 个工具 + 3 条只读设置页路由；`fs` / `sandboxPolicy` 从 `exec.agent.ctx` 取；`webServer` 通过 `ctx.inject(['webServer'], ...)` 可选注入。
- **Client**：`src/client.js` → `scripts/build-client.mjs` → `lib/client.js`（factory-form，`window.__ModuleLoader__.load({ id, factory })`）；`id` 必须等于包名。
- **设置页**：注册 `settings.section`；扫描/分析只读，修改只在聊天框执行。

## 兼容性

- 本插件 `engines.dsh` 为 `>=0.1.5-rc.1 <0.3.0`：覆盖 `0.1.5-rc.x` 与最新开源 `0.2.1-rc.2`。
- 0.2.1 起安装/启动**先看 `engines.dsh`**，满足即可；不再需要 `@deepseek-ai/dsh*` peer。
- 设置页目前是说明 + 扫描/分析（`settings.section`）。如果以后要暴露**可持久化配置**，应迁移到插件配置卡片档位（`plugins.item` + `ctx.configForms` + Host 设置命名空间）。
- 规则集版本与 Harness 版本解耦：`dshpd_analyze` 输出里会带 `ruleset.version`。

## 1.3.1 更新要点

- **client 服务目录**：新增 `src/services.js` 与 [docs/service-catalog-0.2.1.md](docs/service-catalog-0.2.1.md)，规则覆盖 `CLIENT_WORKSPACES_PICKDIRECTORY`（`workspaces` 不是目录选择器，`uiWorkspace.pickDirectory()` 才是）、`CLIENT_UNKNOWN_SERVICE`、`CLIENT_LEGACY_SERVICE`。
- 依据 GitHub 当前 `packages/client/ui-workspace/src/client/index.ts` 与本地 0.2.1 bundle：`ctx.get('workspaces')` 本身合法（workspace controller），`pickDirectory` 在 `uiWorkspace` 上。
- 更新 UI 座位快照（`shell.*`、`deliverables.*`、`main.*`、`workspace.*`）。
- 测试增加服务目录/别名调用用例；总计 37。

## 1.3.0 更新要点

- **桌面版优先**：分析/设计/校验都检查 `profiles/desktop` 与 `profiles/web`。桌面版加载 desktop profile；web 挂载对桌面版无效。`design.md` 固定增加「Desktop Profile Deployment」。
- **`dshpd_mount`**：默认 dryRun 返回挂载行；`apply:true` 先备份 `cordis.patch.yml` 再追加 `- insert: - id: <包名>`，提示重启桌面版并用 `dshpd_ui_check` 确认 `inGraph=true`。
- **`dshpd_ui_check` 根因**：`rootCause=DESKTOP_PROFILE_NOT_MOUNTED` 表示 desktop patch 没挂载（web 挂载无效）；`CLIENT_NOT_DISCOVERED_IN_GRAPH` 表示已挂载但需重启/修清单。
- **无 UI 插件的 UI 提案**：`dshpd_design` 默认 `ui: "auto"`，目标插件没有 `dsh.client` 时自动生成 UI 方案，并返回 `ui.userMessage` / `ui.wireframe`；`design.meta.json` 记录 `ui.expected`，`dshpd_verify` 用 `UI_EXPECTED` 检查是否真的实现。
- **UI 恢复能力**：`dshpd_ui_check` 检查 `clientModules.graph()`、构建过期、apply/inject、UI 座位、client 路由。
- 规则增强：Host 入口、`dsh.client` 字段类型/自引用/基线模块、图标格式与 256 KiB 上限、`type: module`、npm `files` 漏发布 patch/client/icon 等检查。
- 版本号 `1.2.3` → `1.3.0`；`design.md`、`dsh.plugin.yaml`、规范文档同步。

<details>
<summary>1.2.0 主要更新（规则集 0.2.1、12 工具、持久化等）</summary>

- 规则集 `0.2.1`：检查官方 `package.json.dsh`、`engines.dsh`、bundle patch、client bundle、`exports`、图标、子路径展示清单。
- 0.2.0 破坏性变更：`@deepseek-ai/dsh-invariants`、`<pkg>/invariant`、子路径 `package.json`、invariant patch 行。
- 12 个工具：新增 `dshpd_migrate`（受限清单迁移）与 `dshpd_verify`（修改后校验）。
- 备份清单与 journal 持久化到 `.dsh-plugin-design/`；`status` / `report` / `rollback` 重启后可用。
- `dshpd_apply` 写前 hash 校验、`dryRun`、多步编辑跟踪。
- `fs` / `sandboxPolicy` 改为从 `exec.agent.ctx` 取；`webServer` 可选注入。
- client 构建管线（`src/client.js` → `lib/client.js`）与防漂移测试；修复 `uiWorkspace` 目录选择。
- 安装优先 `dsh plugin add`，link 模式回退，两种方式互斥。

</details>

## 测试

```bash
npm test                # node --test（tests/*.test.mjs）
npm run build:client    # 重新生成 lib/client.js
npm run check:client    # 检查 lib/client.js 是否与 src/client.js 漂移
```

覆盖：包清单/图标/导出、DH-TP-SDK 清单、bundle patch、源码安全、SemVer、三类插件样本、14 工具与 3 条路由、desktop/web profile 挂载、审批→备份→修改→校验→报告→回滚全流程、清单迁移、client 构建防漂移。详见 `tests/README.md`。

## 已知限制

1. `dsh.plugin.yaml` 为“缩进感知”的启发式解析，非完整 YAML。
2. 静态分析是启发式规则，非权威认证；client 共享模块检查是 import 语句级。
3. 审批 token 为进程内状态（重启失效，需重新 `approve`）；备份、journal、报告是磁盘持久化。
4. git 状态 / 真实测试执行依赖 Agent 侧 shell 工具，插件自身不跑 shell。
5. `dshpd_migrate` 只做受限的 `package.json` 迁移，不自动改源码。
6. 设置页的 `/discover`、`/analyze` 使用 node:fs 只读扫描，仅用于用户主动选择的插件目录。
7. 阶段 1 的读取与阶段 2 的写入都走 agent 平面 `fs` 与 `sandboxPolicy`：目标插件在会话 workspace 之外时，需要 danger-full-access，或把会话 cwd 设到插件父目录。
8. npm `files` 覆盖检查是目录前缀启发式；ESM 检测是 `.js/.mjs` 源码的 `import/export` 语法扫描，不做 npm pack 模拟。
9. UI 构建过期基于文件 mtime；从 npm/git 重新检出可能重置 mtime，需以 `dshpd_ui_check` 的运行时结果为准。`CLIENT_ROUTE_MISSING` 是字符串级启发式（只识别字面量 `fetch('/x')` 与 `path: '/x'`）。
10. `dshpd_mount` 只追加 desktop patch 行，不自动 link/install 包；`deployment.desktop.packageResolvable=false` 时需要先手动 link/install。

## 更多文档

- [官方插件契约（0.2.x）与规则映射](docs/official-plugin-contract-0.2.md)
- [UI 恢复与构建指南](docs/client-ui-recovery.md)
- [client 服务目录快照（workspaces / uiWorkspace）](docs/service-catalog-0.2.1.md)
- [实现设计与落地经验](design.md)
- [变更记录](CHANGELOG.md)
- [DH-TP-SDK 工程化规范](DeepSeek-Harness-Third-Party-Plugin-SDK-Specification.md)
