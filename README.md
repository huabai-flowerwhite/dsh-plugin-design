# dsh plugin design

一个帮你**检查、改造和开发 DSH 插件**的插件。

它会先读你的插件、指出不符合官方规范的地方，生成一份可执行的 `design.md`（施工图）；你确认后，它再按施工图修改插件、迁移清单、做校验，改坏了还能回滚。整个过程都在聊天框里完成，设置页只负责扫描、分析和生成提示词。

> 适用对象：想排查插件兼容问题、把旧插件升级到新规范，或按官方规范从零开发 DSH 插件的用户。
>
> 说明：DH-TP-SDK 的 Bronze/Silver/Gold、P0–P4、S0–S4 是工程化等级，不是 DeepSeek 官方认证。

## 它能帮你做什么

- **检查现有插件**：兼容范围、安装方式、设置页 UI、bundle/client 配置、安全与生命周期风险。
- **生成改造方案**：输出 `design.md`，写清楚要改哪些文件、为什么改、怎么验证。
- **确认后动手**：按 `design.md` 修改 / 规范已有插件，或者继续开发新插件；改完可校验、可回滚。

## 安装 / 升级

### 方式一：官方 bundle 安装（推荐，DSH 0.1.5+）

```bash
# 安装
dsh plugin --profile web add <本目录或 npm 包名>

# 升级：先 remove 再 add（HMR 下不允许覆盖安装）
dsh plugin --profile web remove dsh-plugin-design
dsh plugin --profile web add <本目录或 npm 包名>
```

`--profile` 要写在 `add` / `remove` 等 pnpm 参数之前。安装成功后，本包会进入 profile 的 `dsh.profile.bundles`，工具和设置页由 bundle patch 自动挂载。

### 方式二：仓库脚本（没有 `dsh` CLI 时）

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

> **桌面端**使用 `desktop` profile（由 Electron 托管，`dsh plugin --profile desktop` 会被拒绝）。要在桌面端使用，安装时加 `-Profile desktop`（Windows）或 `--profile desktop`（Linux/macOS），走 link 模式。

安装完重启 dsh（或让 HMR 重载）并刷新页面，就能在聊天框看到 12 个 `dshpd_*` 工具，并在「设置 → dsh plugin design」看到设置页。

> 运行中新增挂载时，Host 半体可能立即生效；Client 半体需要刷新页面（Ctrl+R / Cmd+R）或重启应用，设置页才会出现在导航里。

## 怎么用（聊天框，3 步）

### 第 1 步：让 Agent 分析，产出 `design.md`

在聊天框输入：

```text
使用 dsh plugin design 插件，分析 <插件路径>，输出 design.md。
先只分析，不要修改代码。
```

Agent 会扫描插件、对照官方规范和 DH-TP-SDK，把 `design.md` 写到：

```text
<插件目录>/.dsh-plugin-design/design.md
```

`design.md` 会列出：插件现状、发现的问题、要改哪些文件、每项怎么改、怎么验证。

### 第 2 步：你审核 `design.md`

打开 `design.md` 看一遍。如果方案不合适，直接告诉 Agent 你的意见，让它更新 `design.md`，直到你满意。

### 第 3 步：确认后修改 / 规范 / 开发

确认后输入：

```text
design.md 我已确认。请按它修改 / 规范 / 开发 <插件>，
完成后调用 dshpd_verify 校验；出错时用 dshpd_rollback 回滚。
```

Agent 会按门控流程执行：

```text
approve 审批 → backup 备份 → apply/migrate 修改 → verify 校验 → rollback/report
```

修改前会备份到 `<插件目录>/.dsh-plugin-design/backup/`，校验失败或结果不满意可以回滚。

> **注意：** 产出 `design.md` 只是“施工图”，不是终点。确认后可以继续让 Agent **修改现有代码**、**按规范重构**，或者**从零开发新插件**。如果你只想先看看分析结果，停在第 1 步或第 2 步即可，不会修改任何源码。

## 在设置页使用

「设置 → dsh plugin design」提供三个快捷操作：

- **扫描**：列出一个目录下的第三方插件项目。
- **分析**：只读检查某个插件，显示总体结论和主要问题。
- **规范修改**：生成一段带插件路径的聊天框提示词，复制到聊天框继续第 1 步。

  也可以直接点某个插件行的「规范修改」，提示词会自动带上它的路径。

  ![How‑to Showcase](<How‑to Showcase.png>)

设置页的扫描和分析都是只读的，不会修改文件；真正的修改只发生在聊天框第 3 步。

## 工作流程（原理）

```text
阶段 1（只读分析）
  discover → inspect → analyze → design（生成 design.md）

阶段 2（你确认后）
  approve（门控）→ backup（备份）→ apply / migrate（修改 / 迁移清单）
  → verify（校验）→ rollback / report（回滚 / 报告）
```

安全边界：分析先于修改、设计先于执行；未确认不修改；修改前备份、失败可回滚、改后可校验；不修改 Core、不使用 private API。

## 工具清单（12 个）

| 阶段 | 工具 | 作用 |
|---|---|---|
| 分析 | `dshpd_discover` | 递归发现插件项目，报告 bundle / client / engines.dsh 角色 |
| 分析 | `dshpd_inspect` | 读取单个插件的清单、patch、client、目录与源码清单（只读） |
| 分析 | `dshpd_analyze` | 规则集 `0.2.1` 启发式扫描，输出问题、官方契约快照、可执行迁移、评分与结论 |
| 分析 | `dshpd_design` | 生成 `design.md`（含契约快照、问题、迁移项、修改计划骨架） |
| 执行 | `dshpd_approve` | 你确认后开启审批门，签发 approvalToken |
| 执行 | `dshpd_backup` | 快照待改文件（含 hash 与分析摘要，持久化） |
| 执行 | `dshpd_apply` | 单文件字面量替换；三重校验 + 写前 hash 校验 + `dryRun` |
| 执行 | `dshpd_migrate` | 仅改 `package.json` 的受限迁移（`engines.dsh`、`dsh.bundle`、`dsh.client` 等） |
| 执行 | `dshpd_verify` | 校验备份、文件可解析、无冲突标记、client bundle 形态、分析是否退化 |
| 恢复 | `dshpd_rollback` | 从备份恢复（重启后仍可用） |
| 报告 | `dshpd_status` | 查看内存任务，或按插件路径列出磁盘备份与 journal |
| 报告 | `dshpd_report` | 输出修改报告：备份文件、编辑/迁移、校验结果、前后分析、剩余风险 |

## 兼容性

- 本插件 `engines.dsh` 为 `>=0.1.5-rc.1 <0.3.0`：覆盖 `0.1.5-rc.x` 与最新开源 `0.2.1-rc.2`。
- 0.2.1 起安装/启动**先看 `engines.dsh`**，满足即可；不再需要 `@deepseek-ai/dsh*` peer。
- 设置页目前是说明 + 扫描/分析（`settings.section`）。如果以后要暴露**可持久化配置**，应迁移到插件配置卡片档位（`plugins.item` + `ctx.configForms` + Host 设置命名空间）。
- 规则集版本与 Harness 版本解耦：`dshpd_analyze` 输出里会带 `ruleset.version`。

## 1.2.1 更新要点

- 设置页文案重写：先讲“能帮你做什么”，再给 **3 步聊天框用法**；明确 **产出 `design.md` 后可以继续修改 / 规范 / 开发插件**。
- README 重排为「安装 → 使用 → 原理 → 技术信息」，并补充设置页三个按钮的说明。
- 规则增强：新增 Host 入口、`dsh.client` 字段类型/自引用/基线模块、图标格式与 256 KiB 上限、`type: module`、npm `files` 漏发布 patch/client/icon 等检查。
- 版本号 `1.2.0` → `1.2.1`；`design.md`、`dsh.plugin.yaml`、规范文档同步。

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

## 目录结构

```text
dsh-plugin-design/
├── install.ps1 / install.sh    # 官方安装优先，link 回退（互斥、幂等）
├── package.json                # 官方清单：engines.dsh / dsh.bundle / dsh.client / exports / icon
├── dsh.plugin.yaml             # DH-TP-SDK 附加工程化清单（运行时可选）
├── cordis.patch.yml            # bundle patch 层：插入本插件 row
├── assets/icon.svg             # 插件管理器图标
├── README.md / design.md / CHANGELOG.md / LICENSE
├── docs/official-plugin-contract-0.2.md   # 规则集事实依据（含官方链接与规则映射）
├── lib/client.js               # 构建产物（factory-form，由 scripts/build-client.mjs 生成）
├── scripts/build-client.mjs    # src/client.js → lib/client.js（含 --check）
├── src/
│   ├── index.js                # Host 入口 → host.js
│   ├── host.js                 # 12 个工具、持久化备份/journal、设置页只读路由
│   ├── rules.js                # 纯规则引擎（官方契约 + DH-TP-SDK + 源码扫描 + SemVer）
│   └── client.js               # Client 半体源码（factory body）
└── tests/                      # 25 个规则/宿主/客户端/bundle 测试 + 3 个插件样本
```

## 测试

```bash
npm test                # node --test（tests/*.test.mjs）
npm run build:client    # 重新生成 lib/client.js
npm run check:client    # 检查 lib/client.js 是否与 src/client.js 漂移
```

覆盖：包清单/图标/导出、DH-TP-SDK 清单、bundle patch、源码安全、SemVer、三类插件样本、12 工具与 3 条路由、审批→备份→修改→校验→报告→回滚全流程、清单迁移、client 构建防漂移。详见 `tests/README.md`。

## 已知限制

1. `dsh.plugin.yaml` 为「缩进感知」的启发式解析，非完整 YAML。
2. 静态分析是启发式规则，非权威认证；client 共享模块检查是 import 语句级。
3. 审批 token 为进程内状态（重启失效，需重新 `approve`）；备份、journal、报告是磁盘持久化。
4. git 状态 / 真实测试执行依赖 Agent 侧 shell 工具，插件自身不跑 shell。
5. `dshpd_migrate` 只做受限的 `package.json` 迁移，不自动改源码。
6. 设置页的 `/discover`、`/analyze` 使用 node:fs 只读扫描，仅用于用户主动选择的插件目录。
7. 阶段 1 的读取与阶段 2 的写入都走 agent 平面 `fs` 与 `sandboxPolicy`：目标插件在会话 workspace 之外时，需要 danger-full-access，或把会话 cwd 设到插件父目录。
8. npm `files` 覆盖检查是目录前缀启发式；ESM 检测是 `.js/.mjs` 源码的 `import/export` 语法扫描，不做 npm pack 模拟。

## 更多文档

- [官方插件契约（0.2.x）与规则映射](docs/official-plugin-contract-0.2.md)
- [实现设计与落地经验](design.md)
- [变更记录](CHANGELOG.md)
- [DH-TP-SDK 工程化规范](DeepSeek-Harness-Third-Party-Plugin-SDK-Specification.md)
