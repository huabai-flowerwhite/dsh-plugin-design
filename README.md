# dsh plugin design

面向 DeepSeek Harness（dsh）第三方插件生态的 **Plugin Design / Migration / Compliance Agent**：发现第三方插件、检查其源码与配置、对照 DH-TP-SDK 工程化规范做静态分析、生成 `design.md`，经用户确认后对插件逐项修改并支持备份与回滚。

> DH-TP-SDK 是工程化规范，Bronze/Silver/Gold、P0–P4、S0–S4 均非 DeepSeek 官方认证。

## 解决痛点

- dsh用户开发/部署各类插件时，经常遇到兼容问题、引发系统性报错。
- 问题根源于各类插件可能未遵循dsh的开发规范、以及各类插件并不能完全做到“随用随丢”的独立插件理念。
- 本插件针对开发/部署插件提供设计规范.md（design.md），并进行技术规范改造。（本人的dsh plugin design、dsh plugin manager、dsh ui skin都经过本插件开发验证）

## 使用方法（聊天框入口）

- 使用dsh plugin design插件，输出对 <插件名> 插件进行规范修改的design.md文件，然后询问我意见后进行规范修改
- 可参考目录中的How‑to Showcase.png。(design.md未在此处展示)

   ![How‑to Showcase](<How‑to Showcase.png>)

两阶段工作流：

- **阶段 1（只读分析）**：`discover → inspect → analyze → design`（生成 design.md），此阶段绝不修改源码。
- **阶段 2（你确认后才修改）**：`approve`（门控）→ `backup`（备份）→ `apply`（逐项原子替换）→ `rollback` / `report`。

安全边界：分析先于修改、设计先于执行；未确认前不修改；修改前备份、失败可回滚；不修改 Core、不用 private API。

## 目录结构

```text
dsh-plugin-design/
├── install.ps1 / install.sh   # 一键安装（node_modules 链接 + cordis.patch.yml insert）
├── package.json               # npm 包：exports + dsh.client + dsh.bundle + scripts.test
├── dsh.plugin.yaml            # DH-TP-SDK manifest
├── cordis.patch.yml           # 挂载参考：host composition insert row
├── README.md / design.md / LICENSE / .gitignore
├── lib/client.js              # Client 半体：factory-form bundle（Settings 设置页）
├── src/
│   ├── index.js               # 入口 → host.js
│   ├── host.js                # Host 半体：10 个 dshpd_* 工具
│   └── client.js              # Client 源码（构建产物见 lib/client.js）
└── tests/
    ├── README.md              # 测试矩阵
    └── manifest.test.mjs      # DH-TP-SDK 规范冒烟测试（node --test）
```

## 能力

- **Host 半体**：10 个模型工具 —— `dshpd_discover` / `dshpd_inspect` / `dshpd_analyze` / `dshpd_design` / `dshpd_approve` / `dshpd_backup` / `dshpd_apply` / `dshpd_rollback` / `dshpd_status` / `dshpd_report`。
- **Client 半体**：Settings 设置页（「设置 → dsh plugin design」），展示使用方法、两阶段工作流、工具清单与安全边界。


## 安装（一条命令）

本插件是 **npm 包 + host composition row** 形态：工具全局注册 + Settings UI 全局加载，重启后自动加载。

下载后，在插件目录内运行对应脚本，即可自动完成「链接进 node_modules + 写入 cordis.patch.yml」两步：

**Windows（PowerShell）**

```powershell
git clone <你的仓库> dsh-plugin-design
cd dsh-plugin-design
powershell -ExecutionPolicy Bypass -File install.ps1
```

**Linux / macOS（bash）**

```bash
git clone <你的仓库> dsh-plugin-design
cd dsh-plugin-design
bash install.sh
```

脚本是幂等的（重复运行无害）。装完后**重启 dsh**（Ctrl+C 后重新 `npx dsh web` / `dsh web`），即完整可用：

- 聊天框拥有 10 个 `dshpd_*` 工具；
- 「设置 → dsh plugin design」出现设置页（选文件夹扫描第三方插件）。

### 脚本做了什么（手动安装等价步骤）

1. 把本目录链接进 node_modules：
   ```text
   $DSH_HOME/profiles/node_modules/dsh-plugin-design  ->  本目录
   ```
   （`$DSH_HOME` 默认 `~/.dsh`；Windows 用 junction，Linux/macOS 用 symlink。或发布到 npm 后 `npm install dsh-plugin-design` 亦可。）
2. 在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 追加：
   ```yaml
   - insert:
       - id: dsh-plugin-design
         name: 'dsh-plugin-design'
   ```
   （profile 默认 `web`，可用环境变量 `DSH_PROFILE` 覆盖。）

> 提示：Host 半体（工具）改 `cordis.patch.yml` 后热生效；Client 半体（Settings UI）在 boot 时由 `dsh-client-modules` 扫描加载，需重启后刷新页面。

## 为什么 Host 与 Client 挂载位置不同

- Host 半体（工具）既可在 agent preset（per-session）也可在 host composition（全局）。
- Client 半体（Settings UI）**必须** host composition：`dsh-client-modules` 只扫描 host Loader entries，且 client UI 是 boot 时加载的全局 UI，agent preset 的 client 不会被加载。因此本包统一挂到 host composition（工具全局 + UI 全局）。

## 给插件作者的命名约定（避免冲突）

每个第三方插件都挂到同一份 `cordis.patch.yml` / `node_modules`，必须保证以下**全局唯一**，否则会相互覆盖或注册报错：

| 命名对象 | 约定（本插件取值） | 冲突后果 |
|---|---|---|
| 包名 / row id / 设置页 slot id | `dsh-<插件名>`（`dsh-plugin-design`） | 同名 → node_modules 链接与 patch row 互相覆盖 |
| 模型工具名 | `<缩写>_*`（`dshpd_*`） | 同名工具同层注册会 throw |
| HTTP 路由前缀 | `/<包名>/<动作>`（`/dsh-plugin-design/discover`） | 同名路由注册会 throw |

`install.ps1` / `install.sh` 是**各自仓库根目录的普通文件**，用户在各自的 clone 目录里执行，不会互相冲突；只要坚持「一个插件一个唯一前缀」，多插件共存安全。

## 安全边界

- Security Level **S2** / Permission Level **P2**：需读写目标插件的 workspace 文件（发现/检查/备份/修改/回滚）。
- 网络/子进程/shell/密钥默认**全部关闭**（`network.outbound: false`、`subprocess.enabled: false`、`shell.enabled: false`、`credentials.access: false`）。
- 不修改 Core、不用 private API、不改 `globalThis`/原型；两阶段门控 + 备份回滚保证「分析先于修改、确认后才改、失败可回滚」。
- Host 半体仅在「用户确认后」才经 `dshpd_backup`/`dshpd_apply` 写文件；静态分析为启发式，非权威认证。

## 规范合规测试

本插件自身遵循 DH-TP-SDK 规范，并提供静态冒烟测试：

```bash
npm test            # 等价于 node --test tests/
```

覆盖：manifest 必填字段、最小权限（网络/子进程/shell/密钥关闭）、package.json 三处导出、cordis.patch.yml 仅 insert 不替换 Core row、源码无高危模式。详见 `tests/README.md`。

## 已知限制

1. manifest 解析为行级启发式，非完整 YAML 解析。
2. 静态分析为启发式规则，非权威认证。
3. 任务状态（approval/backup/journal）为进程内内存态，进程重启即失。
4. git 状态/测试运行依赖 Agent 侧 shell 工具，插件自身不直接跑 shell。
