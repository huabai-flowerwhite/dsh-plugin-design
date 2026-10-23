# dsh plugin design

面向 DeepSeek Harness（dsh）第三方插件生态的 **Plugin Design / Migration / Compliance Agent**：发现第三方插件、检查其源码与配置、对照**官方 0.2.x 插件契约**与 DH-TP-SDK 工程化规范做静态分析、生成 `design.md`，经用户确认后对插件逐项修改，并提供备份、清单迁移、校验与回滚。

> DH-TP-SDK 是工程化规范，Bronze/Silver/Gold、P0–P4、S0–S4 均非 DeepSeek 官方认证。

## 1.2.0 更新要点（对齐 DSH 0.2.1-rc.2）

- **规则集 `0.2.1`**：新增对官方 `package.json.dsh`（`manifestVersion` / `bundle` / `client` / `profile`）、`engines.dsh`、bundle patch、client bundle、`exports`、图标与子路径展示清单的检查。
- **0.2.0 破坏性变更**：`@deepseek-ai/dsh-invariants` 与所有 `<pkg>/invariant` 子路径、子路径 `package.json` 展示清单、`sdk-minimal` 的 invariant 行都会被抓出并给出修复项。
- **12 个工具**：新增 `dshpd_migrate`（受限的清单迁移：`engines.dsh`、`dsh.bundle`、`dsh.client`、`manifestVersion`、移除 invariant 依赖）与 `dshpd_verify`（修改后校验）。
- **持久化状态**：备份清单与 journal 落在 `<插件>/.dsh-plugin-design/`，进程重启后仍可 `status` / `report` / `rollback`；审批 token 仍为进程内（安全考虑）。
- **写前防护**：`dshpd_apply` 校验文件在备份后未被改动（否则拒绝，可用 `allowStale` 覆盖），支持 `dryRun` 计数。
- **Host 服务取用修正**：`fs` / `sandboxPolicy` 改为从 `exec.agent.ctx` 取（0.2.x 的 agent 平面服务），host composition 不再因硬 `inject: ['fs']` 卡住；`webServer` 改为可选注入。
- **Client 半体可维护**：`src/client.js` 是唯一源码，`npm run build:client` 生成 `lib/client.js`，测试阻止两边漂移；设置页修复目录选择（`uiWorkspace` service）并新增「分析」按钮。
- **安装方式**：优先官方 `dsh plugin --profile web add <本目录>`；无 CLI 时回退 `install.ps1` / `install.sh` 的 link 模式，两种方式互斥。

## 解决痛点

- dsh 用户开发/部署第三方插件时，经常遇到兼容问题、引发系统性报错。
- 根因是插件可能未遵循 dsh 的官方插件契约（`package.json.dsh` / `engines.dsh` / client bundle / 服务作用域），也难以做到“随用随丢”的独立插件理念。
- 本插件为此提供两件事：一份可执行的 `design.md`，以及经确认后的逐项规范改造与校验。（本人的 dsh plugin design、dsh plugin manager、dsh ui skin 都经本插件开发验证）

## 使用方法（聊天框入口）

- 使用 dsh plugin design 插件，输出对 `<插件名>` 插件进行规范修改的 design.md 文件，然后询问我意见后进行规范修改。
- 也可在「设置 → dsh plugin design」里扫描插件目录，对单个插件点「分析」查看结论，再点「规范修改」生成提示词。
- 可参考目录中的 How‑to Showcase.png（design.md 未在此处展示）。

  ![How‑to Showcase](<How‑to Showcase.png>)

两阶段工作流：

- **阶段 1（只读分析）**：`discover → inspect → analyze → design`（生成 design.md），此阶段绝不修改源码。
- **阶段 2（用户确认后）**：`approve`（门控）→ `backup`（快照）→ `apply` / `migrate`（逐项原子替换 / 清单迁移）→ `verify`（校验）→ `rollback` / `report`。

安全边界：分析先于修改、设计先于执行；未确认前不修改；修改前备份、失败可回滚、改后可校验；不修改 Core、不使用 private API。

## 工具清单（12 个）

| 工具 | 作用 |
|---|---|
| `dshpd_discover` | 递归发现插件项目，报告官方角色（bundle / client / engines.dsh） |
| `dshpd_inspect` | 读取单个插件的 manifest、package.json、patch、client、目录与源码清单（只读事实） |
| `dshpd_analyze` | 规则集 `0.2.1` 启发式扫描，输出 findings、官方契约快照、可执行迁移、维度评分与结论 |
| `dshpd_design` | 生成 `design.md`（含官方契约快照、findings、迁移项、修改计划骨架） |
| `dshpd_approve` | 用户确认后开启审批门，签发 approvalToken |
| `dshpd_backup` | 快照待改文件到 `.dsh-plugin-design/backup/<id>/`（含 hash 与分析摘要，持久化） |
| `dshpd_apply` | 单文件字面量替换；三重校验 + 写前 hash 校验 + `dryRun` + journal |
| `dshpd_migrate` | 仅改 `package.json` 的受限迁移（`manifest-version` / `engines-dsh` / `bundle-patch` / `client-meta` / `remove-invariants-dep`） |
| `dshpd_verify` | 校验备份完整性、文件可解析、无冲突标记、client bundle 形态、分析是否退化 |
| `dshpd_rollback` | 从备份恢复（内存任务或磁盘清单，重启后可用） |
| `dshpd_status` | 查看内存任务，或按 `pluginPath` 列出磁盘备份与 journal |
| `dshpd_report` | 输出修改报告：备份文件、编辑/迁移、校验结果、前后分析、剩余风险 |

## 安装 / 升级

### 方式一：官方 bundle 安装（推荐，DSH 0.1.5+）

```bash
dsh plugin --profile web add <本目录或 npm 包名>

# 升级（HMR 下不允许覆盖安装）
dsh plugin --profile web remove dsh-plugin-design
dsh plugin --profile web add <本目录或 npm 包名>
```

`--profile` 必须写在转发的 pnpm 参数之前。安装成功后本包进入 profile 的 `dsh.profile.bundles`，bundle patch 自动挂载工具与设置页。

### 方式二：仓库脚本（没有 `dsh` CLI 时）

**Windows**

```powershell
git clone <你的仓库> dsh-plugin-design
cd dsh-plugin-design
powershell -ExecutionPolicy Bypass -File install.ps1
# 强制回退： -Mode link ；指定 profile： -Profile web
```

**Linux / macOS**

```bash
git clone <你的仓库> dsh-plugin-design
cd dsh-plugin-design
bash install.sh
# 强制回退： --mode link ；指定 profile： --profile web
```

脚本检测到 `dsh` 时走官方安装；否则把包链接进 `$DSH_HOME/profiles/node_modules` 与 `profiles/<profile>/node_modules`（如存在），并向 profile `cordis.patch.yml` 追加一行 insert。脚本幂等，且会避免「bundle + patch 双挂载」。

> 桌面端使用 `desktop` profile（由 Electron 托管，`dsh plugin --profile desktop` 会被拒绝）。要在桌面端设置页使用本插件，安装时指定 `-Profile desktop`（Windows）或 `--profile desktop`（Linux/macOS）走 link 模式；web 端仍用默认 `web`。

装完后重启 dsh（或让 HMR 重载）并刷新页面：聊天框出现 12 个 `dshpd_*` 工具，「设置 → dsh plugin design」出现设置页。

> 运行中新增挂载时，Host 半体可能立即生效；Client 半体需要刷新页面（Ctrl+R / Cmd+R）或重启应用，设置页才会出现在导航里。

## 目录结构

```text
dsh-plugin-design/
├── install.ps1 / install.sh    # 官方安装优先，link 回退（互斥、幂等）
├── package.json                # 官方清单：engines.dsh / dsh.bundle / dsh.client / exports / icon
├── dsh.plugin.yaml             # DH-TP-SDK 附加工程化清单（运行时可选）
├── cordis.patch.yml            # bundle patch 层：插入本插件 row
├── assets/icon.svg             # 插件管理器图标（0.2.x package.json.icon）
├── README.md / design.md / CHANGELOG.md / LICENSE
├── docs/official-plugin-contract-0.2.md   # 规则集事实依据（含官方链接与规则映射）
├── DeepSeek-Harness-Third-Party-Plugin-SDK-Specification.md   # DH-TP-SDK 规范
├── deepseek-harness-product-technical-framework.md            # Harness 架构依据
├── lib/client.js               # 构建产物（factory-form，由 scripts/build-client.mjs 生成）
├── scripts/build-client.mjs    # src/client.js → lib/client.js（含 --check）
├── src/
│   ├── index.js                # Host 入口 → host.js
│   ├── host.js                 # 12 个工具、持久化备份/journal、设置页只读路由
│   ├── rules.js                # 纯规则引擎（官方契约 + DH-TP-SDK + 源码扫描 + SemVer）
│   └── client.js               # Client 半体源码（factory body）
└── tests/
    ├── README.md
    ├── manifest.test.mjs       # 自身打包/清单/源码安全冒烟
    ├── rules.test.mjs          # SemVer、manifest 解析、评分/结论、模型规则
    ├── host.test.mjs           # 工具/路由注册、三类 fixture、完整备份-修改-校验-回滚、迁移
    ├── client-build.test.mjs   # src/lib 防漂移与 factory 契约
    └── fixtures/               # legacy / modern / removed-api 三个插件样本
```

## 兼容性（Harness 版本）

- 本插件 `engines.dsh` 为 `>=0.1.5-rc.1 <0.3.0`：覆盖当前桌面版 `0.1.5-rc.x` 与最新开源 `0.2.1-rc.2`。
- 0.2.1 起安装/启动**先看 `engines.dsh`**，满足即可；不再需要 `@deepseek-ai/dsh*` peer。
- Settings 入口使用 `settings.section`（整页说明 + 扫描/分析）。若后续要暴露**可持久化配置**，应迁移到插件配置卡片档位（`plugins.item` + `ctx.configForms` + Host 设置命名空间）。
- 规则集版本与 Harness 版本解耦：`dshpd_analyze` 输出里会带 `ruleset.version`。

## 官方契约对齐（摘要）

完整依据见 [`docs/official-plugin-contract-0.2.md`](docs/official-plugin-contract-0.2.md)。

| 对象 | 约定 |
|---|---|
| 包 / row / 设置页 id | 全局唯一，`dsh-<插件名>` |
| Host 入口 | `exports["."]`，插件导出 `apply` / `inject` |
| Client 入口 | `dsh.client.platform="web"` + `exports["./client"]` + factory-form bundle（id = 包名） |
| 组合包 | `dsh.bundle.patch` 指向自己的 patch；只新增 row，不替换 Core row |
| 兼容性 | `engines.dsh` 优先，SemVer 范围；`workspace:` 非法 |
| 工具名 | 前缀化（`dshpd_*`），输出契约 `output.schema/render` 必填 |
| HTTP 路由 | 前缀化（`/dsh-plugin-design/*`） |
| 服务作用域 | `fs` / `sandboxPolicy` 从 `exec.agent.ctx` 取；`webServer` 可选注入 |

## 测试

```bash
npm test                # node --test（tests/*.test.mjs）
npm run build:client    # 重新生成 lib/client.js
npm run check:client    # 检查 lib/client.js 是否与 src/client.js 漂移
```

覆盖：包清单/图标/导出、DH-TP-SDK 清单、bundle patch、源码安全、SemVer、三份插件 fixture 的规则命中、12 工具与 3 条路由注册、审批→备份→修改→校验→报告→回滚全流程、清单迁移、client 构建防漂移。详见 `tests/README.md`。

## 已知限制

1. `dsh.plugin.yaml` 为「缩进感知」的启发式解析（支持嵌套点路径、列表计数、CRLF），非完整 YAML（无 anchor / 折叠标量 / flow map）。
2. 静态分析是启发式规则，非权威认证；client 共享模块检查是 import 语句级，type-only import 仅按行排除。
3. 审批 token 为进程内状态（重启失效，需重新 `approve`）；备份、journal、报告是磁盘持久化，可跨进程读取。
4. git 状态 / 真实测试执行依赖 Agent 侧 shell 工具，插件自身不跑 shell。
5. `dshpd_migrate` 只做受限的 `package.json` 迁移，不自动改源码；invariant 等源码 import 仍需按 design 修改。
6. 设置页的 `/discover`、`/analyze` 走 node:fs 只读扫描（不经过 workspace 沙箱），仅用于用户主动选择的插件目录。
7. 阶段 1 的读取与阶段 2 的写入都走 agent 平面 `fs` 与 `sandboxPolicy`：目标插件在会话 workspace 之外时，需要 danger-full-access，或把会话 cwd 设到插件父目录；设置页的只读扫描不受此限制。
