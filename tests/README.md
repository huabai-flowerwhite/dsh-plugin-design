# dsh-plugin-design — 测试

## 运行

```bash
npm test          # 等价于 node --test tests/
# 或
node --test tests/
```

## 覆盖范围（DH-TP-SDK 规范冒烟）

`manifest.test.mjs` 校验本插件自身的规范合规性：

| 项 | 校验 |
|---|---|
| `dsh.plugin.yaml` | 必填字段（manifestVersion/plugin.id/runtime.harness/cordis.apiLevel/capabilities/permissions/resources/lifecycle/security/compatibility） |
| 权限最小化 | network.outbound=false、subprocess/shell=false、credentials.access=false、无硬编码密钥 |
| `package.json` | 三处导出（`.`/`./client`/`./package.json`）+ dsh.client.platform + dsh.bundle.patch + compatibility.apiLevel |
| `cordis.patch.yml` | 仅 insert 不替换 Core row |
| 源码安全 | 无 globalThis/window 赋值、prototype patch、`as any`、危险命令、命令注入 |

## 说明

- 这是**静态冒烟测试**（node --test），不启动 dsh，不依赖 Harness 运行时。
- 完整的 DH-TP-SDK 认证矩阵（§26–§34：Agent/Session/Concurrency/Security/Compatibility）需在 dsh 运行时内由 `dshpd_analyze` / 人工验证完成，属启发式 + 手动范畴，不在本测试内。
