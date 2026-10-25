# dsh-plugin-design — 测试

## 运行

```bash
node --test                              # 全部测试（tests/*.test.mjs）
node scripts/build-client.mjs            # 重新生成 lib/client.js
node scripts/build-client.mjs --check    # 只检查 src/lib 是否漂移
node scripts/recovery-drill.mjs <dir>    # 真实快照 + 独立恢复 CLI 演练
node scripts/clean-env-matrix.mjs --cli-json-file <cli.json> --tgz <pkg.tgz> --probe /path
```

测试没有网络依赖；`clean-env-matrix.mjs` 需要显式 DSH CLI argv，未提供时
`dsh-host` 结果保持 `NOT_RUN`。

## 覆盖（1.4.4）

| 文件 | 覆盖 |
|---|---|
| `change.test.mjs` | planHash 稳定性、缺失/错误哈希、越界/junction、跨会话/跨 agent、design 漂移、approval 拒绝/放行、CAS stale、`allowStale` 移除、部分快照、篡改回滚、用户冲突、创建文件回滚需人工删除、journal prepare 恢复、mount 不写 profile、官方 manager 委托与 restart-required |
| `adapter.test.mjs` | rc.3 管理器缺 `updateBundle`/`listVersions` 时仍可用、缺失必需方法时报错、能力矩阵与 `UNSUPPORTED`、install/remove 只走受支持方法、无管理器时不写 profile |
| `scan.test.mjs` | worker 文件/字节预算、lib-only 包、不可读根、取消、队列上限、大扫描期间 Host 心跳、缺失路径 INCOMPLETE |
| `host.test.mjs` | 18 工具/5 路由、analyze 覆盖率与真实产物、运行时未知、分类与 UI 决策、健康回执分层、graph 缺失为 FAIL、设置路由线协议 |
| `semver.test.mjs` | 435 例 semver@7.8.5 差分、合法范围、1.3.2 已知误判、build metadata/prerelease |
| `distribution.test.mjs` | 最小 Host+Client 包审计、负例（缺 chunk/作者路径/维护依赖/私有状态）、导出产物与哈希、输出目录限制、tar 安全、隔离包加载 PASS/FAIL、Host 工具端到端 |
| `recovery.test.mjs` | CLI list/verify/preview/restore、篡改拒绝、冲突保留、operations、undo-enable、依赖闭包 |
| `install.test.mjs` | stdout 与退出码分离、失败不 remove、dry-run、bash 可用时同契约、脚本不含 remove-then-add |
| `profiles.test.mjs` | patch 解析（insert/override/disabled）、installed/selected/enabled 分离、home patch 层、非法包名、旧写路径硬失败 |
| `manifest.test.mjs` / `client-build.test.mjs` | 自身清单、bundle patch、产物漂移、危险模式、无 @deepseek-ai 运行时导入 |
| `runtime.test.mjs` | npm 版本来源守卫：插件自身版本被忽略、仅已知 DSH 包名可采信、显式 DSH_VERSION 优先 |
| `rules.test.mjs` / `services.test.mjs` | 规则集回归、服务目录与取值时机 |

## 断言原则

- 测试的是实际产物与实际行为（worker、tar、文件哈希、子进程），不是源码字符串。
- 负例必须证明“被拒绝”且没有副作用（profile 未改、文件未覆盖、无 token）。
- 真实 DSH / 干净环境证据不属于单元测试，单独记录在 `SUPPORT-MATRIX.md`；
  未运行的环境写 `NOT_RUN`，不伪造 PASS。
- 1.3.2 的旧 `host.test.mjs` 中“不存在的 design 也能 approve”“mount 直接追加
  profile”“verify 只要有备份就 ok”的断言已被删除，替换为上述安全回归。
