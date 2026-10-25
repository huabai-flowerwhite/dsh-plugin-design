# dsh plugin design — 设计自述（1.4.3）

本目录是 `dsh plugin design` 的持久化插件项目（npm 包 + 官方 bundle 形态），
当前版本 `1.4.3`（DSH Desktop `0.2.1-rc.3` 增量兼容）。

## 定位

DSH 第三方插件维护助手：先取得证据，再做受控修改，最后把目标插件作为可独立
安装的产物交付。它不修改 DSH 核心，不承诺同进程插件绝对安全，也不把静态
预检当成认证。

## 目标分类（对目标插件）

| 类型 | Host | Client | 默认 UI |
|---|---|---|---|
| 纯规则/文档/静态资源 | 不需要 | 不需要 | 不生成 |
| 工具型 | 小型注册入口 | 可选 | 仅在有用户配置时提议 |
| Client UI | 必需 | 必需 | 保留（恢复/最小化） |
| Host 集成/系统管理 | 必需 | 可选 | 不自动生成 |
| 库/依赖 | 入口即可 | 不需要 | 不生成 |

必要入口保留会写明理由、运行位置和风险；不会为了“没有半体”机械删除功能。

## 自身架构

```text
src/index.js                 极小入口
src/host.js                  工具/路由注册、服务与生命周期
src/design.js                分类、UI 决策、design.md
src/rules.js + src/services.js  纯规则引擎
src/semver.js                node-semver 兼容实现（差分测试）
src/runtime/fingerprint.js   运行时身份/能力/realm
src/scan/*                   有界 worker 扫描与调度
src/change/*                 路径、计划、批准、快照、journal、CAS
src/deploy/*                 只读 profile 状态 + 官方 manager 适配
src/distribution/*           包审计、tar、导出、哈希
src/validation/runner.js     隔离包加载 / 真实 dsh-host 矩阵
src/recovery/* + bin/        独立恢复 CLI（不 import Host）
```

### Host 半体（保留理由）

- 注册 18 个模型工具与 5 条只读/回执路由；`fs`/`sandboxPolicy` 是 agent 平面服务，
  在调用时从 agent ctx 解析，不做 host 硬注入。
- 不做大目录同步扫描：扫描在 worker；Host 只做参数校验、授权、状态与投影。
- 风险：Host 同进程；工具自身若被恶意输入拖入同步循环仍会影响宿主。预算与
  worker 只能降低本工具自身风险，不能隔离第三方插件代码。

### Client 半体（保留理由）

- 设置页用于目录扫描、只读分析和生成提示词；数据有界、可取消、卸载清理。
- 没有健康回执时 UI 状态是 UNKNOWN；`inGraph` 只表示模块已提供。
- 风险：共享 renderer；组件异常会影响页面。使用局部样式、AbortController、
  代次丢弃，不修改全局对象。

### 独立进程

- 扫描 worker、验证子进程、恢复 CLI 是三个独立执行位置；临时 `DSH_HOME` 不是
  OS 沙箱，动态不可信代码仍需容器/受限账户/VM。

## 工作流

`IDENTIFIED → COLLECTED → ANALYZED → PLANNED → AUTHORIZED → SNAPSHOT_VERIFIED →
STAGED → VALIDATING → READY_TO_COMMIT → COMMITTING → RESTART_REQUIRED/ACTIVE →
HEALTH_VERIFIED → COMPLETED`；失败分支 `ABORTED / CONFLICT / INCOMPLETE /
VALIDATION_FAILED / RECOVERY_REQUIRED`。

分发分支：`PACKAGED → PORTABILITY_VALIDATING → DISTRIBUTION_VALIDATED →
RELEASE_PREPARED`（`PUBLISHED` 只能由实际发布动作产生）。

## 安全边界

- 目标文件写入：`ctx.fs` + 显式 sandboxPolicy + fs 版本/CAS；拒绝即失败，不回退。
- 维护状态：`$DSH_HOME/plugin-design-state`，逐字节快照 + journal；不是防篡改保险箱。
- 批准：planHash 绑定 + 官方 approval/权限预设；无授权不写。
- profile：只读检查；部署仅调用官方 `pluginManager`。
- 分发：目标包不得依赖本插件、作者路径、本机 link、未声明依赖或私有数据。

## 验证

单元/回归：100 个测试。真实环境（本轮）：Desktop `0.2.1-rc.3` / Electron 44.7.0 /
Node 24.21.0 / win32-x64，配套运行时 + 全新 `DSH_HOME`，维护插件与最小
Host+Client 目标插件各自完成安装→冷启动→探测→重启→卸载→再次启动；证据见
`updates/dsh-0.2.1-rc.3/`。历史 rc.2 证据保留在 `outputs/`。
真实 Desktop 窗口/renderer 若未在隔离实例中实测，保持 `NOT_RUN`，不当作已支持。

## 已知限制

见 README「已知限制」与 `docs/security-model.md`。主要包括：静态预检非认证、
同进程风险、Client 回执依赖目标插件、无删除 API、dsh-host 验证需要显式 CLI。
