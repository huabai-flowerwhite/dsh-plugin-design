# Changelog

## 1.2.0 — 2026-10-23

对齐 DeepSeek Harness 0.2.1-rc.2（`dsh-v0.2.1-rc.2`，commit `687f282`），同时保持 0.1.5-rc.x 可加载。

### Added

- 规则集 `0.2.1`：官方 `package.json.dsh`（manifestVersion / bundle / client / profile）、`engines.dsh`、bundle patch、client bundle、`exports`、图标、子路径展示清单。
- `dshpd_migrate`：受限清单迁移（`manifest-version` / `engines-dsh` / `bundle-patch` / `client-meta` / `remove-invariants-dep`），只改 `package.json`。
- `dshpd_verify`：备份完整性、文件可解析、冲突标记、client bundle 形态、分析退化检查。
- 持久化备份清单与 `journal.jsonl`；`status` / `report` / `rollback` 支持跨进程读取。
- `dshpd_apply` 增加写前 hash 校验、`dryRun`、`allowStale`。
- 设置页增加 `/info` 与 `/analyze` 路由、插件行「分析」按钮、版本/规则集/兼容范围徽标。
- `src/client.js` → `lib/client.js` 构建脚本与防漂移测试；`assets/icon.svg`。

### Changed

- `engines.dsh` 改为 `>=0.1.5-rc.1 <0.3.0`（原对齐 0.1.1-rc.2）。
- Host 半体不再硬注入 `fs`，改为从 `exec.agent.ctx.get('fs')` 取；`webServer` 改为可选注入。
- `dshpd_discover` 报告官方角色；`dshpd_analyze` 输出 `official` 快照与 `migrations`。
- `dshpd_inspect` / `dshpd_design` / `dshpd_status` / `dshpd_report` 输出与备注更新。
- 安装脚本优先 `dsh plugin add`，link 模式回退；两种方式互斥，避免双挂载。
- 客户端目录选择修正为 `uiWorkspace` service；修复原 `styles.insert` 遗留源码。

### Fixed

- 0.2.0 移除项检测：`@deepseek-ai/dsh-invariants`、`<pkg>/invariant`、子路径 `package.json`。
- `isTestSource` 使用相对插件根路径，避免 `tests/fixtures/**` 整树被跳过。
- `INVARIANTS_IMPORT` 只匹配 import/require 语句，避免迁移代码字符串自指误报。
- 工具定义 `parameters.additionalProperties`、只读工具 `isConcurrencySafe`。

### Compatibility

- Harness：`>=0.1.5-rc.1 <0.3.0`（0.1.5-rc.x 与 0.2.1-rc.2）。
- Node：`>=22 <25`。
- 安装：官方 `dsh plugin --profile web add` 或 `install.ps1` / `install.sh` link 回退。

## 1.1.0 — 2026-08-29

- 对齐 `@deepseek-ai/dsh` 0.1.1-rc.2；新增 manifest 测试、SDK 规范与产品技术框架文档。

## 1.0.0 — 2026-08-21

- 初始版本：10 个 `dshpd_*` 工具、两阶段门控、Settings 说明页。
