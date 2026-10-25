# dsh-plugin-design

DSH 第三方插件维护助手。它帮助你先取得证据，再修改目标插件：静态预检 → 设计 →
精确计划 → 绑定批准 → 逐字节快照 → CAS 修改 → 分层校验 → 可恢复部署 →
独立分发验证。

> 版本 1.4.3。契约基线：官方发布标签 `dsh-v0.2.1-rc.3`（提交 `1f81c04`）；
> 本机实际验证运行时为 Desktop `0.2.1-rc.3`（Electron 44.7.0 / Node 24.21.0 /
> win32-x64，来源 `asar:dsh-app-boot/package.json` 与安装清单）。历史 rc.2
> 交付保留在 `outputs/`，不升级为 rc.3 证据。
>
> 这是**静态预检 + 受控修改**工具，不是安全认证，也不能保证同进程第三方插件永不
> 崩溃。同步死循环、OOM、`process.exit` 等只能在隔离运行环境中验证。

## 它解决什么

| 阶段 | 工具 | 产出 |
|---|---|---|
| 发现 | `dshpd_discover` | 目录下插件清单 + 扫描覆盖率 |
| 检查 | `dshpd_inspect` / `dshpd_analyze` | 清单、真实入口与构建产物、规则命中、覆盖率 |
| 设计 | `dshpd_design` | design.md：目标分类、Host/Client 必要性、分发义务 |
| 计划 | `dshpd_plan` | 精确文件/哈希/操作/运行时 → `planHash` |
| 批准 | `dshpd_approve` | 绑定 planHash/身份/有效期的批准凭证 |
| 快照 | `dshpd_backup` | 逐字节快照 + schema 2 manifest |
| 修改 | `dshpd_apply` / `dshpd_write` / `dshpd_migrate` | CAS 写入 |
| 校验 | `dshpd_verify` | 分层 PASS/FAIL/UNKNOWN/NOT_RUN |
| 部署 | `dshpd_mount` | 官方 `pluginManager` 调用或 dry-run |
| 恢复 | `dshpd_rollback` / `bin/dshpd-recover.mjs` | 校验后恢复；离线可用 |
| 分发 | `dshpd_distribute` | 包审计、预构建 tgz、SHA-256、支持矩阵 |
| 验证 | `dshpd_validate` | 隔离包加载 / 真实 DSH Host 矩阵 |

## 关键行为（与 1.3.2 不同）

- **不再直接写 profile。** `dshpd_mount` 只调用官方 `pluginManager`
  （`installBundle`/`removeBundle`/`setBundleEnabled`）；服务不可用时返回 dry-run
  计划和官方命令，不会退化为 `node:fs` 追加 `cordis.patch.yml`。
  能力逐项探测：rc.3 发布版没有 `updateBundle`/`listVersions`，适配器把它们标为
  `UNSUPPORTED`，而不是因此判定整个管理器不可用；更新使用带精确 spec 的
  `installBundle` 或官方 CLI。
- **批准绑定具体计划。** `dshpd_approve` 必须收到 `dshpd_plan` 返回的同一个
  `planHash`；receipt 绑定 design 哈希、每个文件的基线哈希、操作集合、目标
  profile、调用身份、过期时间与使用次数。设计/文件/计划变化后旧批准失效。
  授权来自官方 approval 通道（`ctx.get('approval')`，仅 `allowed-once` 放行），
  或在部署已经是 `danger-full-access` 时按权限预设授权并明确记录依据。
  策略为 `never` 且沙箱更窄时不签发 token（仍返回计划与差异）。
- **快照是字节，不是文本。** 任一文件失败则整次快照不提交；`dshpd_rollback`
  先校验全部 payload 哈希，用户已改动的文件保留为冲突，不会覆盖；只有全部必需
  文件恢复并重新哈希通过才报告 `ROLLED_BACK`。
- **扫描移出 Host 主线程。** 目录遍历/读取/规则在 worker 中执行，有单文件
  （2 MiB）、总字节（64 MiB）、文件/目录数、30 秒墙钟、并发队列预算；超时或
  超限返回 `INCOMPLETE`，不会当成“没问题”。`discover`/`inspect`/`analyze` 都报告
  实际扫描覆盖。
- **检查实际会运行的文件。** Host 入口、Client bundle、`lib/`/`dist/` 构建产物、
  patch、lockfile 都进入扫描；包只有 `lib` 也能被审计。
- **SemVer 对齐官方。** 用 `includePrerelease: true` 的 node-semver 语义（内置实现
  与 semver 7.8.5 差分测试 435 例），`*`、`^0`、`>= 0.2.0`、hyphen/partial 范围
  不再误判；运行时未知时兼容性为 UNKNOWN，不是通过。
- **UI 健康分层。** `inGraph=true` 只表示模块已提供；只有加载后的 Client 半体
  主动上报 `rendered=true` 回执才算 PASS，否则为 UNKNOWN。
- **独立分发是交付的一部分。** `dshpd_distribute` 检查入口/chunk/assets/worker、
  作者绝对路径、本机 link、未声明依赖、维护私有数据，生成确定性 `.tgz`、
  SHA-256、文件清单、安装说明与支持矩阵。`dshpd_validate` 在无法解析作者源码、
  未安装本插件的隔离目录中加载同一个包；`mode=dsh-host` 用真实 CLI 完成
  安装→冷启动→探测→重启→卸载→再次启动。

### DSH 0.2.1-rc.3 已知行为（增量兼容）

- **Manager 能力**：rc.3 发布版公开 `listBundles`/`listPlugins`/`installBundle`/
  `removeBundle`/`setBundleEnabled`/`setPluginEnabled`/`inspect`/`registries`/
  `waitForInstall`/`cancelInstall`，但**没有** `updateBundle`/`listVersions`。
  本插件按实际方法工作，缺失项报告 `UNSUPPORTED`，不伪造更新接口。
- **Client metadata 负缓存**：rc.3 的 `client-modules` 按 loader specifier +
  baseUrl 缓存包元数据，包含“这不是 Client 包”的负结果，直到 Host/Desktop
  重启才失效。修改 `dsh.client`、`exports["./client"]`、入口文件或安装新包后，
  刷新页面/HMR 不够，必须重启整个 Desktop/Host，再运行 `dshpd_ui_check`。
- **真实 renderer 证据**：已在 rc.3 Web Host + 无头 Chromium 中打开真实 UI，验证设置页、扫描、分析、问题渲染、错误提示与 client-health 回执（1.4.3 修复了分析结果渲染崩溃和 HTTP 200 错误文案）。真实 Desktop 窗口/preload/原生目录选择仍未验证。

- **真实 Desktop/renderer**：HTTP 200、无窗口 Web Host、React stub 都不能替代
  真实桌面交互；未在隔离 Desktop 实例中实测时，该组合保持 `NOT_RUN`。

## 安装

优先使用官方插件管理器（不要先 remove 再 add）：

```sh
dsh plugin --profile <profile> add /path/to/dsh-plugin-design-1.4.3.tgz
```

`install.ps1` / `install.sh` 只是同一命令的封装：它们把 stdout 与退出码分开，
失败时不会先删除已安装版本，也不会自动回退到 link。`-Link` 仅供开发，安装后
依赖本机源码目录，不能作为分发方式。安装/升级后需要重启对应客户端。

本插件自身也可独立分发：`updates/dsh-0.2.1-rc.3/` 记录了对
`dsh-plugin-design-1.4.3.tgz` 的 rc.3 干净环境验证（无作者源码、无 link、全新
`DSH_HOME`）；`outputs/` 保留 rc.2 历史证据，不改写为 rc.3 通过。

## 使用流程

```text
1. dshpd_discover / dshpd_analyze        只读，先看证据与覆盖率
2. dshpd_design                          产出 design.md（含 Host/Client 保留理由）
3. dshpd_plan(files, operations)         得到 planHash
4. 用户审核；dshpd_approve(planHash)     取得绑定凭证
5. dshpd_backup                          逐字节快照
6. dshpd_apply / dshpd_write / dshpd_migrate
7. dshpd_verify                          分层校验
8. 需要部署时：dshpd_mount(apply, profile, spec, approvalToken)
9. 出问题：dshpd_rollback 或 bin/dshpd-recover.mjs（可在 DSH 启动不了时使用）
```

`dshpd_migrate` 只改清单字段，`engines-dsh` 必须显式给出合法范围；它不会自动
扩大兼容范围，也不代表该范围已被测试。

## 部署与 profile

- `web` 与 `desktop` 是不同 profile，挂载互不相通。目标 profile 是显式参数，
  不再默认 desktop，也不给所有插件强制生成 UI。
- `installed` / `selected` / `enabled` / `Host active` / `Client active` 分别报告；
  离线只能判断前三个。
- 无官方 `pluginManager` 时不写 profile；请用
  `dsh plugin --profile <name> add <spec>`。

## 恢复

```sh
node bin/dshpd-recover.mjs --state-root <state-root> --list
node bin/dshpd-recover.mjs --state-root <state-root> --verify <backupId>
node bin/dshpd-recover.mjs --state-root <state-root> --preview <backupId>
node bin/dshpd-recover.mjs --state-root <state-root> --restore <backupId> --yes
node bin/dshpd-recover.mjs --state-root <state-root> --operations
node bin/dshpd-recover.mjs --undo-enable --dsh-home <dir> --profile web <package>
```

状态目录默认是 `$DSH_HOME/plugin-design-state`，独立于被审插件，可用
`DSHPD_STATE_ROOT` 覆盖。旧版放在插件目录里的 `.dsh-plugin-design` 只作为
**不可信导入材料**：`dshpd_status` 会显示它，但不会自动恢复。

退出码：`0` 成功，`1` 失败/完整性不通过，`2` 部分恢复或冲突，`64` 用法错误。
`--undo-enable` 只打印官方卸载计划，不修改 profile。

## 分发（给目标插件）

```text
dshpd_distribute(mode=audit)                       只读审计
dshpd_distribute(mode=export, outputDir=<dir>)     生成发布材料
dshpd_validate(mode=package-load)                  隔离消费目录加载同一个 tgz
dshpd_validate(mode=dsh-host, cliCommand=[...])    真实 DSH 安装/启动/重启/卸载
```

导出目录包含：`source/`、`package/<name>-<version>.tgz`、`SHA256SUMS`、
`FILELIST.json`、`INSTALL.md`、`SUPPORT-MATRIX.md/json`、`BUILD-LOCK.json`、
`distribution-report.json`。报告明确区分本机修改、分发验证、发布准备与
实际发布；本工具**不会上传**任何内容。

## 已知限制

- 静态规则是启发式预检；命中不等于必然崩溃，未命中也不等于安全。
- 同进程 Host/Client 插件仍可能阻塞或终止宿主；隔离运行需要外部监督进程、
  独立账户或 VM/容器，临时 `DSH_HOME` 不是 OS 沙箱。
- Client 渲染回执依赖插件自己的 Client 半体发送；没有回执就是 UNKNOWN。
- 文件创建可回滚记录为“需人工删除”（公开 `ctx.fs` 没有删除操作）。
- `dshpd_validate(mode=dsh-host)` 需要显式 CLI argv，不能从插件内部安全猜测。
- 已测试矩阵见 `SUPPORT-MATRIX.md`；未列出的组合不是已支持。

## 测试

```sh
node --test
node scripts/build-client.mjs --check
node scripts/recovery-drill.mjs <output-dir>
node scripts/clean-env-matrix.mjs --cli-json-file <cli.json> --tgz <pkg.tgz> --probe /path
```

测试包含 100 个用例/子测试：修改事务安全（计划绑定、身份、design 漂移、越界、
junction、CAS、部分快照、篡改回滚、冲突、journal 恢复）、worker 扫描预算与
取消、SemVer 差分、部署适配（含 rc.3 缺 `updateBundle`/`listVersions` 的能力
协商）、分发审计与负例、隔离包加载、离线恢复、安装器退出码。真实 DSH 与干净
环境证据单独记录，不用单元测试代替。

## 文档

- `docs/official-plugin-contract-0.2.md` — 固定基线合同索引
- `docs/service-catalog-0.2.1.md` — 客户端服务快照（含 realm/来源说明）
- `docs/client-ui-recovery.md` — UI 分层诊断与恢复
- `docs/distribution-contract.md` — 独立分发合同与验收清单
- `docs/security-model.md` — 信任边界、批准与快照语义
- `DeepSeek-Harness-Third-Party-Plugin-SDK-Specification.md` — 工程规范（历史章节已标注）
