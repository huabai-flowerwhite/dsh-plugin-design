// dsh-plugin-design — target classification, UI proposal and design.md.
//
// M1-08: a design must first state what the target actually is and which
// Host/Client halves it needs, with a retain/remove/move rationale. It must not
// invent a Client half for a library or a rules package, and it must not assume
// every plugin deploys to the desktop profile.

import { basename } from 'node:path'

import { RULESET } from './rules.js'

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Classify the target and decide whether a Client half is warranted. */
export function classifyTarget(model, result) {
  const official = result.official
  const pkg = model.pkg && typeof model.pkg === 'object' ? model.pkg : {}
  const hasClient = official.client.declared === true
  const hasTools = Array.isArray(model.toolNames) && model.toolNames.length > 0
  const hasBundle = official.bundle.declared === true
  const hasHostEntry = official.host.entryPresent === true || nonEmpty(pkg.main) !== null
  const hasConfig = model.hasConfig === true
  const sourceCount = Array.isArray(model.sourceFiles) ? model.sourceFiles.length : 0
  const hasSettingsUi = official.client.uiSlots.includes('settings.section') || official.client.uiSlots.includes('settings.plugins.tab')

  let type = 'unknown'
  if (hasClient) type = 'client-ui'
  else if (hasTools) type = 'tool'
  else if (hasBundle) type = 'host-integration'
  else if (sourceCount === 0) type = 'rules-docs-assets'
  else if (hasHostEntry) type = 'library-with-host-entry'
  else type = 'library'

  let clientNeed = 'not-needed'
  let clientReason = '没有面向用户的状态、配置或操作，新增 Client 半体只会增加共享 renderer 的代码面。'
  if (hasClient) {
    clientNeed = 'required'
    clientReason = '已经声明 dsh.client：Client 半体是现有功能的一部分，应保留并按需最小化。'
  } else if (hasTools && hasConfig) {
    clientNeed = 'optional'
    clientReason = '有工具和用户配置：设置页有助于发现与配置，但应仅在有明确需求时新增。'
  } else if (hasTools) {
    clientNeed = 'optional'
    clientReason = '只有模型可调用工具：通常不需要 Client 页面；优先通过工具与文档使用。'
  }
  const hostNeed = hasHostEntry || hasTools || hasBundle ? 'required' : (sourceCount === 0 ? 'not-required' : 'entry-only')
  const hostReason = hostNeed === 'required'
    ? 'Loader 按包名导入 Host 入口；工具/服务/路由注册必须发生在 Host 半体。'
    : hostNeed === 'entry-only'
      ? '仅需一个可解析的 Host 入口以满足 Loader 导入，不注册常驻任务。'
      : '纯规则/文档/静态资源包：没有 Host 行为，可只提供静态文件。'

  const halves = [
    {
      half: 'host',
      needed: hostNeed,
      location: official.host.entryTarget || nonEmpty(pkg.main) || 'exports["."]',
      function: hasTools ? '注册 ' + (model.toolNames || []).slice(0, 4).join(', ') : (hasBundle ? '应用 Cordis patch / 提供服务' : '导出插件入口'),
      rationale: hostReason,
      risk: hostNeed === 'not-required' ? 'none' : 'Host 同进程模式：同步阻塞、OOM、process.exit 会影响整个 DSH 进程。',
      action: 'retain',
    },
    {
      half: 'client',
      needed: clientNeed,
      location: official.client.exportTarget || 'exports["./client"]（当前未声明）',
      function: hasClient ? '渲染 UI 并读取 Host 路由' : '（无）',
      rationale: clientReason,
      risk: hasClient ? '运行在共享 renderer：异常会破坏页面；需有界数据、取消与清理。' : 'none',
      action: hasClient ? 'retain-minimal' : 'do-not-add-without-need',
    },
  ]

  return {
    type,
    hostNeed,
    clientNeed,
    settingsUi: hasSettingsUi,
    halves,
    summary: type + '（Host: ' + hostNeed + ', Client: ' + clientNeed + '）',
    distributionGoal: '本机修改与独立分发是两个结果；默认同时准备可分发包材料，但需通过干净环境验收后才可声明“可独立分发”。',
  }
}

/** Whether the UI proposal should be generated under the requested mode. */
export function resolveUiMode(requested, model, classification, result) {
  if (requested === 'off') return { mode: 'off', reason: 'ui=off' }
  if (requested === 'propose') return { mode: 'propose', reason: 'caller requested a UI proposal' }
  if (result.official.client.declared === true) return { mode: 'recovery', reason: 'the target already has a Client half' }
  if (classification.clientNeed === 'optional' && model.hasConfig === true) {
    return { mode: 'propose', reason: 'the target exposes user-facing configuration' }
  }
  return {
    mode: 'not-needed',
    reason: classification.clientNeed === 'not-needed'
      ? 'the target has no user-facing UI need'
      : 'a UI is optional here; add one only after an explicit request',
  }
}

/** Build the UI proposal (or the reasons for not proposing one). */
export function buildUiProposal(model, result, classification, uiMode) {
  const pkg = model.pkg && typeof model.pkg === 'object' ? model.pkg : {}
  const name = nonEmpty(pkg.name) || basename(model.pluginPath)
  if (uiMode.mode === 'off' || uiMode.mode === 'not-needed') {
    return {
      proposed: false,
      disabled: uiMode.mode === 'off',
      reason: uiMode.reason,
      summary: '不新增 Client 半体：' + uiMode.reason + '。',
    }
  }
  if (uiMode.mode === 'recovery') {
    return {
      proposed: false,
      recovery: true,
      reason: uiMode.reason,
      formFactor: result.official.client.uiSlots[0] || 'settings.section',
      title: name,
      entry: result.official.client.uiSlots[0] || 'settings.section',
      summary: '已有 UI：按 CLIENT_BUNDLE / CLIENT_GRAPH / 健康回执检查恢复，不重新设计入口。',
    }
  }
  const description = nonEmpty(pkg.description) || ''
  const tools = Array.isArray(model.toolNames) ? model.toolNames.slice(0, 6) : []
  const hasConfig = model.hasConfig === true
  const title = name + ' 设置'
  const version = nonEmpty(pkg.version) || '0.1.0'
  const wireframe = [
    '┌──────────────────────────────┐',
    '│ ' + title.padEnd(24, ' ') + ' v' + version + ' │',
    '│ 状态：运行中 / 未配置         │',
    '├──────────────────────────────┤',
    hasConfig ? '│ 配置区：字段 A [____]        │' : '│ 能力区：' + (tools[0] || '插件能力').slice(0, 20).padEnd(20, ' ') + ' │',
    hasConfig ? '│         字段 B [x]           │' : '│ 最近结果：...                 │',
    '├──────────────────────────────┤',
    '│ [保存] [重载] [查看最近结果] │',
    '└──────────────────────────────┘',
  ].join('\n')
  return {
    proposed: true,
    reason: uiMode.reason,
    formFactor: 'settings.section',
    title,
    entry: 'settings.section',
    wireframe,
    sections: [
      '顶部状态卡：运行状态、版本、兼容范围（engines.dsh）',
      hasConfig ? '配置区：按 Host Config 字段生成表单，保存后热更新' : '能力区：列出工具/能力与启用状态',
      tools.length > 0 ? '最近结果：展示最近一次工具调用或输出摘要' : '操作区：启动 / 停止 / 重载等按钮',
      '空状态与错误状态：未配置、加载失败、请求超时都要有可读提示',
    ],
    dataPlan: [
      'Host 半体：ctx.inject(["webServer"], ...) 注册只读路由并在 handler 内返回 JSON',
      '配置持久化优先走 Host settings / Config；纯前端状态才放 localStorage',
      'Client 半体：factory 里 fetch 这些路由；失败时显示错误文案，不要留空白页',
      '请求必须带 AbortController/超时，卸载时清理，并丢弃过期代次的响应',
    ],
    implementation: [
      'package.json 增加 dsh.client.platform="web"、exports["./client"]，并把 lib 加入 files',
      '新增 src/client.js 与可重复的构建脚本，产出 factory-form lib/client.js（id=包名，exports.apply/inject）',
      'client apply 中通过 slots.inject("settings.section", ...) 注册，样式使用局部样式',
      '刷新页面后确认 client 健康回执 rendered=true，再运行 dshpd_verify --intent deployment',
    ],
    summary: '建议为 ' + name + ' 增加「设置 → ' + title + '」页面。',
    userMessage: '建议为 ' + name + ' 新增「设置 → ' + title + '」页面：\n\n```text\n' + wireframe
      + '\n```\n\n如果你认可这个 UI 方案，我会按 design.md 的 M-UI-* 项开发；如果不需要 UI，请直接说“不做 UI”。',
  }
}

/**
 * Render design.md. Everything here is a plan, not proof: verification and
 * distribution sections state what must still be measured.
 */
export function buildDesignTemplate(pluginPath, result, options) {
  const { official, issues, migrations } = result
  const classification = options.classification
  const deployment = options.deployment || null
  const lines = []
  lines.push('# dsh plugin design — design.md')
  lines.push('')
  lines.push('> 依据官方 DSH 0.2.x 插件契约（ruleset ' + RULESET.version + '）生成的可执行修改设计。')
  lines.push('> 这是施工图，不是安全证明；静态预检不执行目标插件代码。')
  lines.push('')
  lines.push('## 1. Target Plugin')
  lines.push('')
  lines.push('- Plugin name: ' + (official.packageName || basename(pluginPath)))
  lines.push('- Package version: ' + (official.packageVersion || 'UNKNOWN'))
  lines.push('- Path: ' + pluginPath)
  lines.push('- Roles: ' + (official.roles.length > 0 ? official.roles.join(', ') : 'UNKNOWN'))
  lines.push('- Compatibility: ' + (official.compatibility.source === 'none'
    ? 'UNKNOWN（无 engines.dsh，也无 @deepseek-ai/dsh* peer）'
    : official.compatibility.source + ' = ' + official.compatibility.range
      + '（运行时 ' + String(official.compatibility.runtime || 'unknown') + '，satisfied=' + String(official.compatibility.satisfied) + '）'))
  lines.push('')
  lines.push('## 2. Executive Summary')
  lines.push('')
  lines.push('（待补充：目标插件做什么、当前架构、最大兼容/安全/生命周期风险，以及是否存在 Core modification / private API / global mutable state。）')
  lines.push('')
  lines.push('## 3. Target Classification 与 Host/Client 必要性（M1-08）')
  lines.push('')
  lines.push('- 类型：**' + classification.type + '**')
  lines.push('- 结论：' + classification.summary)
  lines.push('- 分发目标：' + classification.distributionGoal)
  lines.push('')
  lines.push('| 半体 | 是否必要 | 运行位置 | 功能 | 保留/删除/外移 | 风险 |')
  lines.push('|---|---|---|---|---|---|')
  for (const half of classification.halves) {
    lines.push('| ' + [half.half, half.needed, half.location, half.function, half.action, half.risk]
      .map((cell) => String(cell).replace(/\|/g, '/')).join(' | ') + ' |')
  }
  lines.push('')
  lines.push('保留理由：' + classification.halves.map((half) => half.half + ' — ' + half.rationale).join('；'))
  lines.push('')
  lines.push('> 必要入口保留不等于改造失败；无法在保留功能的同时删除全部半体时，应说明架构限制，而不是机械删除。')
  lines.push('')
  lines.push('## 4. Official Contract Snapshot')
  lines.push('')
  lines.push('- bundle declared: ' + official.bundle.declared + (official.bundle.patch.length > 0 ? '（' + official.bundle.patch.join(', ') + '）' : ''))
  lines.push('- client declared: ' + official.client.declared + (official.client.declared ? '（platform=' + String(official.client.platform) + ', bundle=' + String(official.client.exportTarget) + '）' : ''))
  lines.push('- engines.dsh: ' + String(official.engines.dsh))
  lines.push('- manifestVersion: ' + String(official.manifestVersion))
  lines.push('- Host 入口: ' + String(official.host.entryTarget || 'UNKNOWN') + '（present=' + String(official.host.entryPresent) + '）')
  lines.push('- 实际产物扫描：artifact 文件 ' + official.artifacts.scanned + ' 个；扫描完整=' + String(official.scanCoverage.complete))
  lines.push('')
  lines.push('## 5. Findings')
  lines.push('')
  if (issues.length === 0) {
    lines.push('未发现规则命中（这不等于安全，见第 8 节运行时验证）。')
  } else {
    for (const issue of issues.slice(0, 200)) {
      lines.push('- [' + issue.severity + '] ' + issue.id + ' — ' + issue.title + (issue.file ? '（' + issue.file + '）' : ''))
      if (issue.detail) lines.push('  - ' + issue.detail)
    }
    if (issues.length > 200) lines.push('- … 另有 ' + (issues.length - 200) + ' 条，运行 `dshpd_analyze` 查看完整列表。')
  }
  lines.push('')
  lines.push('## 6. Modification Plan')
  lines.push('')
  lines.push('（逐项 M001/M002/...：ID、Reason、File、Before、After、Risk、Validation、Rollback；只改目标插件源码，不修改 Core。）')
  lines.push('')
  lines.push('计划与授权流程：')
  lines.push('1. `dshpd_plan` — 列出精确文件、目标根、design.md 哈希、操作集合与运行时指纹，得到 `planHash`。')
  lines.push('2. `dshpd_approve` — 回传同一个 `planHash`，经官方 approval 通道（或已授予的 danger-full-access 预设）签发绑定凭证。')
  lines.push('3. `dshpd_backup` — 逐字节快照全部计划文件；任何文件失败则不提交。')
  lines.push('4. `dshpd_apply` / `dshpd_write` / `dshpd_migrate` — 使用 fs 版本守卫提交；冲突即拒绝。')
  lines.push('5. `dshpd_verify` — 分层检查；缺证据不会显示通过。')
  lines.push('')
  if (deployment !== null && Array.isArray(deployment.profiles)) {
    lines.push('## 7. Deployment Target')
    lines.push('')
    lines.push('- 目标 profile 由调用方明确指定；本设计不默认任何 profile。')
    lines.push('- 当前状态：installed=' + String(deployment.installedAnywhere)
      + ' / selected=' + String(deployment.selectedAnywhere)
      + ' / enabled=' + String(deployment.enabledAnywhere))
    for (const profile of deployment.profiles) {
      lines.push('- `' + profile.profile + '`：selected=' + String(profile.selected)
        + '，enabled=' + String(profile.enabled)
        + '，packageResolvable=' + String(profile.packageResolvable)
        + '（' + profile.patchPath + '）')
    }
    if (deployment.homePatch && deployment.homePatch.exists) {
      lines.push('- 注意：`' + deployment.homePatch.path + '` 是高于 profile patch 的覆盖层，需一并检查。')
    }
    lines.push('- 部署只能通过官方 `pluginManager`（installBundle/removeBundle/setBundleEnabled）；没有该服务时只输出 dry-run，不写 profile 文件。')
    lines.push('')
  }
  if (options.uiProposal && (options.uiProposal.proposed === true || options.uiProposal.recovery === true)) {
    lines.push('## 8. UI 方案 / UI 恢复')
    lines.push('')
    if (options.uiProposal.proposed === true) {
      lines.push('- 入口：`' + options.uiProposal.entry + '`；标题：' + options.uiProposal.title)
      lines.push('- 说明：' + options.uiProposal.summary)
      lines.push('- 线框：')
      lines.push('')
      lines.push('```text')
      lines.push(String(options.uiProposal.wireframe || ''))
      lines.push('```')
      lines.push('')
      lines.push('实现清单：')
      for (const item of options.uiProposal.implementation || []) lines.push('- ' + item)
      lines.push('')
      lines.push('> 只有用户明确认可后才新增 Client 半体；不做 UI 时删除本节并保持 Host-only。')
    } else {
      lines.push('- 已有 Client 半体：按 CLIENT_BUNDLE / CLIENT_GRAPH / 健康回执逐层检查，不重新设计入口。')
    }
    lines.push('')
  } else {
    lines.push('## 8. UI 决策')
    lines.push('')
    lines.push('- 不新增 Client 半体：' + String(options.uiProposal ? options.uiProposal.reason : 'no UI need'))
    lines.push('')
  }
  lines.push('## 9. Independent Distribution（独立分发合同）')
  lines.push('')
  lines.push('本设计默认同时准备可分发交付物；只有通过干净环境验收后才能声明“可独立分发”。')
  lines.push('')
  lines.push('- 包内容：manifest、Host 入口、Client 入口/chunks、assets/worker/sidecar、运行依赖与 files 覆盖。')
  lines.push('- 可移植性：不得包含作者绝对路径、临时 link、未声明依赖、私有 registry、开发服务器或维护插件状态。')
  lines.push('- 干净环境：未安装 dsh-plugin-design、作者源码不可依赖时，用公开步骤安装同一个 `.tgz` 并验证冷启动/功能/重启/卸载。')
  lines.push('- 交付物：完整源码、构建锁文件、预构建 `.tgz`、SHA-256、支持矩阵、安装/卸载说明、分发验收报告。')
  lines.push('- 状态分开报告：本机修改结果、独立分发验收、发布准备、实际发布（本工具不上传）。')
  lines.push('')
  lines.push('- 本项目的 Host/Client 保留理由必须写入分发报告（`hostClientNecessity`），不得只写 README 模板。')
  lines.push('')
  lines.push('## 10. Verification')
  lines.push('')
  lines.push('（typecheck / lint / unit / integration / lifecycle / session / concurrency / security / compatibility；无则 NOT_AVAILABLE。）')
  lines.push('- 静态：`dshpd_analyze`（含实际产物与覆盖率）。')
  lines.push('- 修改后：`dshpd_verify --intent local-modification`（快照完整性、CAS、阻断项、产物）。')
  lines.push('- 部署/UI：`dshpd_verify --intent deployment`（Client graph 与健康回执；缺回执为 UNKNOWN）。')
  lines.push('- 运行时风险（同步循环/退出/OOM）：只能在隔离运行器中验证；未运行则保持 NOT_RUN。')
  lines.push('')
  if (migrations.length > 0) {
    lines.push('可由 `dshpd_migrate` 执行的清单迁移（仅清单字段，不改变已测兼容范围）：')
    for (const migration of migrations) lines.push('- `' + migration.id + '` — ' + migration.title)
    lines.push('')
  }
  lines.push('## 11. Approval')
  lines.push('')
  lines.push('（用户确认后才执行修改。批准必须绑定 `planHash`、文件基线、操作集合、目标 profile 与调用身份；设计或文件变化后旧批准自动失效。）')
  lines.push('')
  return lines.join('\n')
}
