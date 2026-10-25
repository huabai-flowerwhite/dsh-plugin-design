# 交给DSH：桌面版0.2.1-rc.3增量适配

请针对我的Windows/x64 DeepSeek Harness Desktop 0.2.1-rc.3，增量核验并按需适配现有dsh-plugin-design 1.4.0。

## 先读资料

- 工作区：`E:\creat\Codex\dsh设计插件优化建议`
- 本轮判断：`updates/dsh-0.2.1-rc.3/upgrade-assessment.md`
- 本轮状态：`updates/dsh-0.2.1-rc.3/status.json`
- 原插件：`E:\creat\DSH\rule\dsh-plugin-design`
- 现有交付及真实测试范围：工作区`outputs/README.md`、`outputs/SUPPORT-MATRIX.md`、`outputs/reports/test-report.md`
- 完整方案：工作区`dsh-plugin-design-improvement-plan.md`，用于定位原要求与尚未完成项。

已有1.4.0实施交付，请从当前代码及未提交修改出发，不重做已完成的整轮M1/M2，不覆盖用户后来改动。

## 版本身份

目标官方发布标签`dsh-v0.2.1-rc.3`对应`1f81c047fc48fa190a683e469daa699857e9afe8`。原研究master为`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，清单虽同名rc.3，接口和行为并不完全一致。

现有运行PASS只有rc.2桌面配套运行时承载的无窗口Web Host；真实Desktop窗口及renderer尚未验证。本轮已知`E:/运行包/DSHpc`的磁盘清单仍为rc.2，请先确定用户实际新版安装路径与当前Host身份。不要把该旧路径或只传入harnessVersion参数当成rc.3实测。

## 实施步骤

1. 记录当前插件源码/产物hash、DSH Desktop/配套CLI/内嵌app-boot/Node/Electron身份与来源，建立可回退基线。
2. 优先核对升级判断中的实际差异。rc.3发布Manager没有研究master的listVersions/updateBundle；Client metadata含负结果按specifier/baseUrl缓存到重启。不要按最新master虚构已发布能力，也不要通过手写profile绕过缺失方法。
3. 先跑一次相关快速回归和Client产物一致性；只对发现的合同差异修改必要代码、规则和文档。无关的模型provider/fork功能不扩展成本次迁移任务。
4. 准备新数据根与受控执行环境，用实际rc.3桌面配套运行时，对维护插件及Host+Client目标fixture各验证一次安装、冷启动、功能探测、重启和卸载。
5. 单独测试真实Desktop窗口/renderer：设置页、Client激活/渲染、目录选择与手工路径、扫描/分析/取消、错误展示和清理，以及新增“更多”菜单共存。HTTP 200、无窗口Web Host和React stub不能替代此项。
6. 无法安全启动隔离Desktop测试实例时，继续其它独立工作，将真实Desktop/renderer标NOT_RUN并说明必要条件；不改变用户真实desktop profile来试错。
7. 代码或产物变化时重新构建打包、计算hash并验证同一包；未变化时复用同一包，仅新增rc.3证据。实际公开发布前避免同一版本对应不同内容。
8. 按证据更新新的支持矩阵和升级报告，分开Host、真实Desktop/renderer及未测平台。已有rc.2记录保留，不改写成rc.3通过。

## 授权与边界

可直接推进该插件范围内的开发、检查、隔离测试、构建和本地材料准备。DSH应用安装/升级、操作用户真实profile、重启其真实Desktop、兼容豁免、构建脚本授权、远端发布，须遵循实际已有授权及管理策略；开发授权不自动包含这些操作。

不改DSH核心/main/preload，不吞宿主异常，不扩大engines.dsh掩盖不兼容；必要Host/Client代码仍按功能最小化。目标插件继续满足独立分发要求，默认不依赖维护助手。

## 交付与耗时

新材料全部放入工作区`updates/dsh-0.2.1-rc.3/`，包括版本身份、源码差异、必要代码diff、测试起止与耗时、实际日志、包hash、新支持矩阵和剩余项。原outputs作为历史交付保留；若补充旧包声明，用新报告引用，不改写旧证据。

分开记录快速回归、构建、Host集成和真实Desktop测试。对应检查通过后，只有相关输入变化或新失败才重跑；不要把整个开发阶段统称为“安全回归测试”。

只有实际通过的精确构建/载体/平台可标PASS；源码审阅、未运行或能力缺失分别写STATIC_REVIEWED/NOT_RUN/UNSUPPORTED。无须为已授权范围逐文件或逐阶段重复确认，遇到必需信息缺失时明确说明并继续无依赖工作。
