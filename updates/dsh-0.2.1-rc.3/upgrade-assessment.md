# Desktop 0.2.1-rc.3 工作区更新判断

核验日期：2026-10-25（Asia/Shanghai）。本轮完成公开源码、发布说明、工作区证据和已知安装路径磁盘清单核对；没有安装新DSH、改动真实profile、重新打包或启动集成测试。

## 1. 结论

**需要增量更新，重点是发布版合同对齐与桌面版验证。无需因为版本名称改变，就重做整轮M1/M2。** 现有架构研究已经写为rc.3，但研究master与正式rc.3标签不是同一提交。已有1.4.0交付的rc.2运行证据继续作为历史证据，不能直接升级为rc.3通过。

本工作区以Windows/x64桌面用户为主要目标。通过桌面配套运行时启动无窗口Web Host，只能证明相应Host载体行为；桌面窗口、preload/carrier、Client激活、目录选择和实际渲染交互必须另测。

## 2. 四种版本身份必须分开

| 对象 | 核验身份 | 说明 |
|---|---|---|
| 官方rc.2标签 | `687f282e8625c6b8d11ff58211a90524be2e4317` | 历史版本参考 |
| 官方rc.3发布标签 | `1f81c047fc48fa190a683e469daa699857e9afe8` | 本轮目标发行合同；标签`dsh-v0.2.1-rc.3` |
| 原架构研究master | `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` | 清单同样写rc.3，但包含发布标签之外的大量变更；保留其固定身份 |
| 已有1.4.0运行证据 | `0.2.1-rc.2`、Windows/x64、桌面运行时的无窗口Web Host | 见旧outputs，实际Desktop renderer仍NOT_RUN |

本轮只读解析 `E:/运行包/DSHpc/resources/app.asar`，顶层Desktop、内嵌runtime及 `dsh-app-boot` 三个清单都为`0.2.1-rc.2`。这仅表示该磁盘路径的内容；若新版位于其它目录或更新尚未完成，要先确定实际安装位置与当前Host版本。一次没有版本输出的CLI调用不能作为版本证明。

发布说明见[官方rc.3 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3)，精确标签由本轮`git ls-remote`核对。

## 3. rc.2 → rc.3的直接变化

官方发布说明列出：左侧栏/会话视图/右侧栏的“更多”菜单，用于浏览和创建插件；切换会话后的未发送草稿修复；API Key适配器模型列表更新方式调整。

本轮直接比较两个发布标签，得到640个路径变化，包含大量package版本、文档、测试和快照，不能把640个文件理解为640项破坏性变更。已审阅的主要实现包括：

| 变化 | 对本工作区的意义 | 验证重点 |
|---|---|---|
| 新增`ui-entry-customization`，进入Web bundle | Desktop复用Web界面，也可能受新插件入口影响 | 菜单、固定/取消固定和维护插件入口共存 |
| 新增`sidebar.panellist.actions`、`conversation.session.header.views.actions`、`sidebar.right.tab.guide.actions` | 可作为新入口扩展；并不要求维护插件自动迁移到这些slot | 现有设置入口仍可达；需要新增入口时才做适配 |
| `pluginNavigation.openList()` | 新的插件列表导航能力 | 使用时先探测，不给旧版本硬调用 |
| 会话草稿/新会话提交与导航变化 | 影响页面使用流程 | 切换会话后维护页面、输入和结果不串会话 |
| 模型列表与配置变化 | 对普通扫描/打包功能关联较低 | 只有触及模型提供方的目标插件需要追加对应场景 |

在本轮选择的boot/core/fs/preset runtime、Client modules、Desktop/desktop-host、CLI runtime、package-manifest、Cordis/Loader路径中，rc.2→rc.3未发现运行源码变化；主要是版本清单、测试及一份组合参考技能文档。此为限定路径的静态比较，不是“所有插件一定兼容”的证明。

## 4. 原研究master与rc.3发布版存在的关键差异

二者全树相差5995个路径。本轮核实以下与维护插件设计有关的差异：

| 合同 | 原研究master | rc.3发布标签 | 应采取的行动 |
|---|---|---|---|
| Plugin Manager更新接口 | 有`listVersions`/`updateBundle` | 相应Manager源码未暴露这两个方法 | 不以`updateBundle`为必需能力；适配实际公开方法，没有就报告不支持该自动更新路径 |
| Client包metadata | 重协调时重新读取 | `pkgMeta`按specifier/baseUrl缓存，包含“非Client”负结果，持续到重启 | 清单或Client导出变化后，按发布版合同要求停机/重启并验证；不能套master的刷新结论 |
| 普通fork独立且不记录父关系 | master含对应guide与实现 | rc.3发布树没有该guide，不能直接应用其新语义 | 涉及Session/fork时重新读取发布版；维护插件无此功能则不增加无关迁移 |
| `dsh.bundle.listedByDefault` | 类型含该字段 | 发布类型不含 | 不生成并宣称它在发布版已受支持 |
| 清单类型`optionalDependencies` | master类型含该字段 | 发布类型未列入该接口 | 不由类型摘录推导npm不支持optionalDependencies；仅标记DSH类型版本差异 |
| 路径/file URL Client发现、preset `serviceFor` | master存在 | 发布实现也存在 | 不把这些一律归为发布版缺失，仍按真实上下文验证 |

这是本轮需要纠正的版本适用范围：旧文档把master研究明确固定了SHA，但几处用“当前rc.3”容易让实施者按发行版理解。已为主文档增加范围说明，发布版行为以本节和固定发布源码为准。

## 5. 需要更新哪些内容

| 路径/内容 | 本轮处理或后续动作 |
|---|---|
| 工作区根README | 新增桌面优先目标、版本身份与当前升级入口 |
| 架构文档 | 补充发布标签/master差异、Client缓存和Manager能力限制 |
| 完善方案与完整实施说明 | 标注已有1.4.0交付；当前走增量升级任务，避免整轮重复改造 |
| `updates/dsh-0.2.1-rc.3` | 新建评估、状态、交给DSH的桌面升级提示词；后续证据放这里 |
| `research/upstream` | 保留原HEAD；取得rc.2/rc.3标签作比较，不以pull覆盖研究基线 |
| `research/rc3-release-review` | 保存比较清单、探针和发布源码摘录；探针仅供定位，关键结论经代码核对 |
| `outputs`原日志、manifest、hash与旧包 | 保持历史证据，不改成rc.3结果；如果实施后出新包，在新交付目录生成新manifest/hash |
| 原插件源码及其内置文档/规则目录 | 由DSH以1.4.0为当前基线核对；仅对实际合同差异改代码，不简单全局替换版本字符串 |

原outputs中的M2状态只是当时实施报告，尚有真实renderer等NOT_RUN项；本轮不对整份实现作新的完整安全认证。

## 6. 桌面版增量验收清单

1. 确认用户实际rc.3 Desktop安装路径，记录Desktop、内嵌CLI、`app-boot`版本及可取得的build commit；记录版本来源。不要替用户自动安装/更新应用。
2. 核对当前1.4.0源码和现有`.tgz`身份；先跑一次相关快速回归及Client一致性检查，只有发现问题或输入变化才重跑对应部分。
3. 核对rc.3发布版的Manager、profile锁、settings slot、Client metadata缓存、preset服务来源。对无公开方法的能力明确降级，不通过手改profile补洞。
4. 用新数据根、对应桌面配套运行时和明确隔离边界，对现有相同安装包各跑一次维护插件/目标fixture安装、启动、重启、停用/卸载；输出新的rc.3 Host证据，不能复制旧PASS。
5. 单独验证真实Desktop窗口/renderer：设置页可达、页面激活和渲染、目录选择/手工路径、扫描/分析按钮、取消/卸载清理、错误展示，以及rc.3新“更多”菜单共存。不用HTTP 200或React stub代替真实界面结论。
6. 如无法在不影响真实数据的条件下启动隔离桌面测试实例，先完成其它项，Desktop/renderer结果保持NOT_RUN并说明前提。不得顺手改用户已有desktop profile。
7. 若产物不变，保留原hash并新增精确运行环境的证据；若源码/依赖/构建产物改变，重新构建打包并验证新hash，必要时增加插件版本，避免同一版本公开对应不同内容。
8. 分开计时：快速回归、构建、Host集成、Desktop/renderer。每步记录开始/结束/结果；无相关变更不反复跑整套矩阵。

## 7. 完成判定

源码差异核对通过，只能标`STATIC_REVIEWED`；Host安装验证通过可新增对应载体的PASS；真实Desktop renderer通过后才能将该具体组合列为已验证。缺少某项就保留UNKNOWN/NOT_RUN，不阻止完成其它独立工作，也不宣称“整个rc.3已验证”。

## 8. 固定来源与本地证据

- [rc.2→rc.3官方比较](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.1-rc.2...dsh-v0.2.1-rc.3)
- [rc.3 Client metadata缓存实现](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/modules/src/index.ts)
- [rc.3 Manager实现](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/boot/plugin-manager/src/index.ts)
- [rc.3清单类型](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/util/package-manifest/src/types.ts)
- [rc.3 Desktop说明](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/apps/desktop/README.md)
- [源码差异清单](E:/creat/Codex/dsh设计插件优化建议/research/rc3-release-review/source-comparison.json)、[合同定位探针](E:/creat/Codex/dsh设计插件优化建议/research/rc3-release-review/contract-probes.json)
- [rc.2历史支持矩阵](E:/creat/Codex/dsh设计插件优化建议/outputs/SUPPORT-MATRIX.md)、[旧交付manifest](E:/creat/Codex/dsh设计插件优化建议/outputs/MANIFEST.json)
