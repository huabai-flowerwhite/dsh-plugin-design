# dsh-plugin-design — 测试

## 运行

```bash
npm test                 # node --test（tests/*.test.mjs）
npm run build:client     # 重新生成 lib/client.js
npm run check:client     # 仅检查 src/lib 是否漂移
```

## 文件与覆盖

| 文件 | 覆盖 |
|---|---|
| `manifest.test.mjs` | 本插件自身：官方 `package.json.dsh`、`engines.dsh`、三处导出、icon、DH-TP-SDK 清单、bundle patch、源码安全、安装脚本互斥策略 |
| `rules.test.mjs` | SemVer 范围（含预发布、`^`/`~`/`||`）、启发式 manifest、评分与结论、`engines.dsh workspace:`、client 缺导出、client 字段类型/自引用/基线模块、Host 入口、图标格式与大小、`type: module`、npm `files` 完整性、UI 诊断（构建过期 / styles / React / 路由 / apply） |
| `host.test.mjs` | 13 工具与 3 路由注册；legacy / modern / removed-api 三类 fixture；审批→备份→修改→校验→报告→回滚全流程；清单迁移；`dshpd_ui_check` 运行时 client graph；无 UI 插件的 design UI 提案与 `UI_EXPECTED` 校验；`/info`、`/discover`、`/analyze` 路由 |
| `client-build.test.mjs` | `src/client.js` 与 `lib/client.js` 零漂移；factory-form 契约、id/版本/兼容范围注入、占位符替换 |

## Fixtures

- `fixtures/modern-plugin`：0.2.x 形态（`engines.dsh`、bundle、client、icon、测试、README、LICENSE），期望 `READY_TO_MODIFY`。
- `fixtures/legacy-plugin`：pre-0.2 形态（无官方元数据、替换 Core row、globalThis、模块级 session 状态、工具缺 output），期望 `BLOCKED`。
- `fixtures/removed-api-plugin`：仍依赖 0.2.0 已移除的 invariant 与子路径 `package.json`，期望 `BLOCKED`。

fixture 内的 `tests/smoke.mjs` 不命名为 `*.test.*`，避免被根目录 `node --test` 递归执行。

## 说明

- 这是静态与 mock 运行时测试（node --test），不启动 dsh；`host.test.mjs` 用 node:fs 模拟 `ctx.fs` 契约，并通过 `exec.agent.ctx.get(...)` 提供 `fs` / `sandboxPolicy`。
- 完整的 DH-TP-SDK 认证矩阵（§26–§34：Agent/Session/Concurrency/Security/Compatibility）需在 dsh 运行时内由 `dshpd_analyze` + 人工验证完成，属启发式 + 手动范畴。
