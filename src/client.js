// dsh-plugin-design — Client half source (factory body)
//
// This file is NOT imported by Node. scripts/build-client.mjs wraps it into
// lib/client.js as the lazy-CJS factory required by the harness client module
// system:
//
//   window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => { ... } })
//
// The build replaces the version and harness placeholders below with
// package.json values. Keep the body dependency-free except for the platform
// `react` module: anything else would have to be declared under
// dsh.client.external.

const React = require('react')

const VERSION = '__DSHPD_VERSION__'
const HARNESS_RANGE = '__DSHPD_HARNESS__'
const RULESET = '0.2.1'
const TOOL_NAMES = [
  'dshpd_discover', 'dshpd_inspect', 'dshpd_analyze', 'dshpd_ui_check', 'dshpd_design',
  'dshpd_approve', 'dshpd_backup', 'dshpd_apply', 'dshpd_migrate',
  'dshpd_verify', 'dshpd_rollback', 'dshpd_status', 'dshpd_report',
]

const COLORS = {
  border: 'var(--color-border, #d8d8d8)',
  muted: 'var(--color-text-secondary, #6b7280)',
  bg: 'var(--color-bg-secondary, #f7f7f8)',
  primary: '#2563eb',
  ok: '#15803d',
  warn: '#b45309',
  bad: '#b91c1c',
}

function h(tag, props) {
  const raw = Array.prototype.slice.call(arguments, 2)
  const children = []
  for (let index = 0; index < raw.length; index += 1) {
    const child = raw[index]
    if (Array.isArray(child)) {
      for (let inner = 0; inner < child.length; inner += 1) {
        const item = child[inner]
        children.push(React.isValidElement(item) && item.key === null
          ? React.cloneElement(item, { key: 'k' + index + '-' + inner })
          : item)
      }
    } else {
      children.push(child)
    }
  }
  return React.createElement(tag, props, ...children)
}

function panelStyle() {
  return { fontFamily: 'inherit', padding: '4px 0', lineHeight: 1.6, fontSize: 13 }
}

function h3Style() {
  return { margin: '0 0 6px', fontSize: 15, fontWeight: 600 }
}

function h4Style() {
  return { margin: '16px 0 6px', fontSize: 13, fontWeight: 600 }
}

function leadStyle() {
  return { opacity: 0.8, marginBottom: 4 }
}

function cmdStyle() {
  return {
    margin: '6px 0',
    padding: '10px 12px',
    border: '1px dashed ' + COLORS.border,
    borderRadius: 8,
    background: COLORS.bg,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
  }
}

function noteStyle() {
  return { fontSize: 12, opacity: 0.72, marginTop: 10 }
}

function badgeStyle(tone) {
  const color = tone === 'ok' ? COLORS.ok : tone === 'warn' ? COLORS.warn : tone === 'bad' ? COLORS.bad : COLORS.muted
  return {
    display: 'inline-block',
    padding: '1px 7px',
    marginRight: 6,
    borderRadius: 999,
    border: '1px solid ' + color,
    color: color,
    fontSize: 11,
    lineHeight: '18px',
    whiteSpace: 'nowrap',
  }
}

function buttonStyle(primary) {
  return {
    border: primary ? '1px solid ' + COLORS.primary : '1px solid ' + COLORS.border,
    background: primary ? COLORS.primary : 'transparent',
    color: primary ? '#fff' : 'inherit',
    borderRadius: 6,
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 12,
    whiteSpace: 'nowrap',
  }
}

function inputStyle() {
  return {
    flex: '1 1 auto',
    minWidth: 0,
    border: '1px solid ' + COLORS.border,
    background: 'var(--color-bg-primary, #fff)',
    color: 'inherit',
    borderRadius: 6,
    padding: '6px 9px',
    fontSize: 12,
  }
}

function rowStyle() {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    border: '1px solid ' + COLORS.border,
    borderRadius: 8,
    marginBottom: 8,
    flexWrap: 'wrap',
  }
}

function nameStyle() {
  return { fontWeight: 600, fontSize: 13 }
}

function pathStyle() {
  return {
    fontSize: 11,
    opacity: 0.7,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
  }
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(function (response) {
    return response.text().then(function (text) {
      var data
      try {
        data = JSON.parse(text)
      } catch (error) {
        throw new Error('Host 返回了非 JSON 响应（路由可能未注册）：' + text.slice(0, 120))
      }
      if (!response.ok || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + response.status))
      return data
    })
  })
}

function verdictTone(overall) {
  if (overall === 'BLOCKED') return 'bad'
  if (overall === 'NEEDS_REVIEW') return 'warn'
  if (overall === 'READY_TO_MODIFY') return 'ok'
  return 'muted'
}

function FindingList(props) {
  var issues = props.issues || []
  if (issues.length === 0) return h('div', { style: { fontSize: 12, opacity: 0.7 } }, '未命中规则。')
  var top = issues.slice(0, props.limit || 6)
  return h('div', { style: { marginTop: 4 } }, top.map(function (issue) {
    var tone = issue.severity === 'BLOCKER' || issue.severity === 'CRITICAL' ? 'bad' : issue.severity === 'HIGH' ? 'warn' : 'muted'
    return h('div', { key: issue.id + ':' + (issue.file || ''), style: { fontSize: 12, margin: '2px 0' } }, [
      h('span', { style: badgeStyle(tone) }, issue.severity),
      h('span', null, issue.title + (issue.file ? '  ·  ' + issue.file : '')),
    ])
  })).concat(issues.length > top.length
    ? [h('div', { key: 'more', style: { fontSize: 11, opacity: 0.65 } }, '… 另有 ' + (issues.length - top.length) + ' 条')]
    : []).concat(props.truncated
    ? [h('div', { key: 'truncated', style: { fontSize: 11, opacity: 0.65 } }, '（结果已截断，完整列表请让 Agent 调用 dshpd_analyze）')]
    : [])
}

function PluginRow(props) {
  var plugin = props.plugin
  var analysis = props.analysis
  var analyzing = props.analyzing
  var tone = analysis ? verdictTone(analysis.overall) : 'muted'
  var tags = [
    plugin.bundle ? h('span', { style: badgeStyle('ok'), key: 'bundle' }, 'bundle') : null,
    plugin.client ? h('span', { style: badgeStyle('ok'), key: 'client' }, 'client') : null,
    plugin.enginesDsh ? h('span', { style: badgeStyle('muted'), key: 'engines' }, 'engines.dsh') : null,
    plugin.hasManifest ? h('span', { style: badgeStyle('muted'), key: 'manifest' }, 'DH-TP-SDK') : null,
  ].filter(Boolean)

  return h('div', { style: { border: '1px solid ' + COLORS.border, borderRadius: 8, marginBottom: 8, padding: '8px 10px' } }, [
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
      h('div', { style: { flex: '1 1 240px', minWidth: 0 } }, [
        h('div', { style: nameStyle() }, plugin.packageName || plugin.name),
        h('div', { style: pathStyle(), title: plugin.path }, plugin.path),
      ]),
      h('button', { style: buttonStyle(false), onClick: props.onAnalyze, disabled: analyzing }, analyzing ? '分析中…' : '分析'),
      h('button', { style: buttonStyle(true), onClick: props.onPrompt }, '规范修改'),
    ]),
    tags.length > 0 ? h('div', { style: { marginTop: 4 } }, tags) : null,
    analysis
      ? h('div', { style: { marginTop: 6, borderTop: '1px dashed ' + COLORS.border, paddingTop: 6 } }, [
          h('div', null, [
            h('span', { style: badgeStyle(tone) }, analysis.overall),
            h('span', { style: { fontSize: 12, opacity: 0.8 } },
              'issues ' + analysis.issueCount + ' · B' + analysis.counts.BLOCKER + ' / C' + analysis.counts.CRITICAL + ' / H' + analysis.counts.HIGH + ' / M' + analysis.counts.MEDIUM +
              (analysis.migrations && analysis.migrations.length > 0 ? ' · 可自动迁移 ' + analysis.migrations.length + ' 项' : '')),
          ]),
          analysis.ui && analysis.ui.available
            ? h('div', { style: { fontSize: 11, marginTop: 2 } }, [
                h('span', { style: badgeStyle(analysis.ui.inGraph ? 'ok' : 'warn') }, '运行时 UI'),
                h('span', { style: { opacity: 0.8 } }, analysis.ui.inGraph
                  ? '已注册 ' + (analysis.ui.rev || '')
                  : '未注册（页面不会出现该 UI）'),
                analysis.official && analysis.official.client && analysis.official.client.buildStale
                  ? h('span', { style: { marginLeft: 6, color: COLORS.warn } }, '· client bundle 已过期，需要重新构建')
                  : null,
              ])
            : null,
          h(FindingList, { issues: analysis.issues, truncated: analysis.issuesTruncated === true }),
        ])
      : null,
  ])
}

function Panel(props) {
  var getWorkspace = props && typeof props.getWorkspace === 'function' ? props.getWorkspace : function () { return null }
  var rootState = React.useState('')
  var root = rootState[0]
  var setRoot = rootState[1]
  var pluginsState = React.useState([])
  var plugins = pluginsState[0]
  var setPlugins = pluginsState[1]
  var loadingState = React.useState(false)
  var loading = loadingState[0]
  var setLoading = loadingState[1]
  var errorState = React.useState(null)
  var error = errorState[0]
  var setError = errorState[1]
  var promptState = React.useState(null)
  var prompt = promptState[0]
  var setPrompt = promptState[1]
  var analysesState = React.useState({})
  var analyses = analysesState[0]
  var setAnalyses = analysesState[1]
  var analyzingState = React.useState({})
  var analyzing = analyzingState[0]
  var setAnalyzing = analyzingState[1]
  var techState = React.useState(false)
  var showTech = techState[0]
  var setShowTech = techState[1]

  function pickDirectory() {
    var workspace = null
    try {
      workspace = getWorkspace()
    } catch (error) {
      workspace = null
    }
    if (!workspace || typeof workspace.pickDirectory !== 'function') {
      setError('当前环境未提供目录选择器（uiWorkspace service 不可用），请在输入框手动粘贴路径。')
      return
    }
    setError(null)
    Promise.resolve(workspace.pickDirectory()).then(function (picked) {
      if (typeof picked === 'string' && picked !== '') setRoot(picked)
    }).catch(function (failure) {
      setError('目录选择失败：' + String(failure && failure.message ? failure.message : failure) + '（可手动粘贴路径）')
    })
  }

  function scan() {
    var target = String(root || '').trim()
    if (target === '') {
      setError('请先选择或输入第三方插件库文件夹路径。')
      return
    }
    setLoading(true)
    setError(null)
    setAnalyses({})
    postJson('/dsh-plugin-design/discover', { root: target, maxDepth: 6 }).then(function (data) {
      setPlugins((data && data.plugins) || [])
      setLoading(false)
    }).catch(function (failure) {
      setError(String(failure && failure.message ? failure.message : failure))
      setLoading(false)
    })
  }

  function analyze(plugin) {
    setAnalyzing(function (previous) {
      var next = Object.assign({}, previous)
      next[plugin.path] = true
      return next
    })
    postJson('/dsh-plugin-design/analyze', { pluginPath: plugin.path }).then(function (data) {
      setAnalyses(function (previous) {
        var next = Object.assign({}, previous)
        next[plugin.path] = data
        return next
      })
    }).catch(function (failure) {
      setError('分析失败：' + String(failure && failure.message ? failure.message : failure))
    }).then(function () {
      setAnalyzing(function (previous) {
        var next = Object.assign({}, previous)
        delete next[plugin.path]
        return next
      })
    })
  }

  function requestPrompt(plugin) {
    setPrompt('使用 dsh plugin design 插件，分析 ' + plugin.path + ' 并输出 design.md；先只分析，不要修改代码。\n如果插件没有 UI，请在 design.md 里给出 UI 方案，并先向我描述大致样貌；确认后再按它修改 / 规范 / 开发该插件。')
  }

  return h('div', { style: panelStyle() }, [
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } }, [
      h('h3', { style: h3Style() }, 'dsh plugin design'),
      h('span', { style: badgeStyle('ok') }, 'v' + VERSION),
    ]),
    h('div', { style: leadStyle() }, '帮你检查 DSH 插件是否符合官方规范、指出问题并给出改造方案；你确认后，它会按方案修改插件、迁移清单并做校验，出问题还能回滚。'),

    h('h4', { style: h4Style() }, '能帮你做什么'),
    h('ul', { style: { margin: '4px 0 0 18px', padding: 0 } }, [
      h('li', { key: 'check', style: { margin: '2px 0' } }, [h('b', null, '检查现有插件'), '：兼容性、安装方式、设置页 UI、安全与生命周期风险。']),
      h('li', { key: 'design', style: { margin: '2px 0' } }, [h('b', null, '生成改造方案'), '：产出 design.md，写清要改哪些文件、为什么改、怎么验证。']),
      h('li', { key: 'do', style: { margin: '2px 0' } }, [h('b', null, '确认后动手'), '：按 design.md 修改 / 规范已有插件，或继续开发新插件。']),
    ]),

    h('h4', { style: h4Style() }, '在聊天框怎么用（3 步）'),
    h('div', { style: { fontWeight: 600, fontSize: 12, marginTop: 8 } }, '第 1 步 · 让 Agent 分析并产出 design.md'),
    h('div', { style: cmdStyle() }, '使用 dsh plugin design 插件，分析 <插件路径>，输出 design.md。先只分析，不要修改代码。'),
    h('div', { style: { fontSize: 12, opacity: 0.75, marginTop: 2 } }, '如果插件没有 UI，design.md 会自动附「UI 方案建议」；Agent 应先描述入口与大致样貌，确认后再开发。'),
    h('div', { style: { fontWeight: 600, fontSize: 12, marginTop: 10 } }, '第 2 步 · 你审核 design.md'),
    h('div', null, '打开 design.md，看它准备改哪些文件、为什么改、怎么验证；有不同意见直接告诉 Agent，让它更新方案。'),
    h('div', { style: { fontWeight: 600, fontSize: 12, marginTop: 10 } }, '第 3 步 · 确认后修改 / 规范 / 开发'),
    h('div', { style: cmdStyle() }, 'design.md 我已确认（含 UI 方案）。请按它修改 / 规范 / 开发 <插件>，完成后调用 dshpd_verify 校验；出错时用 dshpd_rollback 回滚。'),
    h('div', { style: { margin: '8px 0', padding: '8px 10px', borderLeft: '3px solid ' + COLORS.primary, background: COLORS.bg, borderRadius: 4 } }, [
      h('b', null, '注意：'),
      '产出 design.md 只是“施工图”，不是终点。确认后可以继续让 Agent 修改现有代码、按规范重构，或从零开发新插件。',
    ]),

    h('h4', { style: h4Style() }, '设置页能做什么'),
    h('ul', { style: { margin: '4px 0 0 18px', padding: 0 } }, [
      h('li', { key: 'scan', style: { margin: '2px 0' } }, [h('b', null, '扫描'), '：列出某个目录下的第三方插件项目。']),
      h('li', { key: 'analyze', style: { margin: '2px 0' } }, [h('b', null, '分析'), '：只读检查，显示总体结论和主要问题。']),
      h('li', { key: 'prompt', style: { margin: '2px 0' } }, [h('b', null, '规范修改'), '：生成一段带路径的聊天框提示词，交给 Agent 继续。']),
    ]),

    h('h4', { style: h4Style() }, '发现并分析第三方插件'),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } }, [
      h('input', {
        style: inputStyle(),
        placeholder: '插件库文件夹，例如 E:\\creat\\DSH\\open',
        value: root,
        onChange: function (event) { setRoot(event.target.value) },
        onKeyDown: function (event) { if (event.key === 'Enter') scan() },
      }),
      h('button', { style: buttonStyle(false), onClick: pickDirectory }, '选择文件夹'),
      h('button', { style: buttonStyle(true), onClick: scan, disabled: loading }, loading ? '扫描中…' : '扫描'),
    ]),
    h('div', { style: { fontSize: 11, opacity: 0.65, marginTop: 4 } }, '扫描和分析都是只读的；“规范修改”只生成提示词，不会直接改文件。'),
    plugins.length === 0
      ? h('div', { style: { opacity: 0.7, padding: '8px 0' } }, loading ? '正在扫描…' : '尚未扫描，或该目录下没有含 package.json / dsh.plugin.yaml 的插件项目。')
      : h('div', { style: { marginTop: 8 } }, plugins.map(function (plugin) {
          return h(PluginRow, {
            key: plugin.path,
            plugin: plugin,
            analysis: analyses[plugin.path] || null,
            analyzing: analyzing[plugin.path] === true,
            onAnalyze: function () { analyze(plugin) },
            onPrompt: function () { requestPrompt(plugin) },
          })
        })),
    prompt !== null
      ? h('div', { style: { marginTop: 8, padding: 10, border: '1px dashed ' + COLORS.border, borderRadius: 8 } }, [
          h('div', { style: nameStyle() }, '复制到聊天框执行：'),
          h('div', { style: cmdStyle() }, prompt),
        ])
      : null,
    error !== null ? h('div', { style: { color: COLORS.bad, marginTop: 8, fontSize: 12 } }, error) : null,

    h('div', { style: { marginTop: 14 } }, [
      h('button', { style: buttonStyle(false), onClick: function () { setShowTech(!showTech) } },
        showTech ? '收起技术信息' : '查看技术信息（工具 / 安装 / 安全）'),
    ]),

    showTech ? h('div', null, [
      h('h4', { style: h4Style() }, '技术信息'),
      h('div', { style: { fontSize: 12, opacity: 0.8 } }, '规则集 ' + RULESET + ' · 兼容 Harness ' + HARNESS_RANGE),
      h('div', { style: { fontSize: 12, lineHeight: 1.9, marginTop: 6 } }, [
        h('div', { key: 'a' }, [h('b', null, '分析：'), 'dshpd_discover · dshpd_inspect · dshpd_analyze · dshpd_ui_check · dshpd_design']),
        h('div', { key: 'e' }, [h('b', null, '执行：'), 'dshpd_approve · dshpd_backup · dshpd_apply · dshpd_migrate · dshpd_verify']),
        h('div', { key: 'r' }, [h('b', null, '恢复与报告：'), 'dshpd_rollback · dshpd_status · dshpd_report']),
      ]),
      h('h4', { style: h4Style() }, '安装 / 升级（官方 bundle 方式）'),
      h('div', { style: cmdStyle() }, 'dsh plugin --profile web add <本目录或 npm 包名>\n# 升级：先 remove 再 add（HMR 下不允许覆盖安装）\ndsh plugin --profile web remove dsh-plugin-design\ndsh plugin --profile web add <本目录或 npm 包名>'),
      h('div', { style: { fontSize: 12, opacity: 0.75 } }, '旧版没有 dsh CLI 时，可用仓库内 install.ps1 / install.sh 的 link 模式作为回退；桌面端请用 -Profile desktop。'),
      h('h4', { style: h4Style() }, '安全边界'),
      h('div', null, '分析先于修改、设计先于执行；未确认不修改；修改前备份、失败可回滚；不修改 Core、不使用 private API。'),
      h('div', { style: noteStyle() }, '说明：DH-TP-SDK 的 Bronze/Silver/Gold、P0–P4、S0–S4 为工程化规范等级，非 DeepSeek 官方认证。'),
    ]) : null,
  ])
}

function apply(ctx) {
  var slots = ctx && ctx.slots ? ctx.slots : (ctx && typeof ctx.get === 'function' ? ctx.get('slots') : null)
  if (!slots || typeof slots.inject !== 'function') return
  var getWorkspace = function () {
    return ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
  }
  slots.inject('settings.section', function () {
    return slots.register(
      { name: 'settings.section', id: 'dsh-plugin-design', order: 100, label: 'dsh plugin design' },
      function () { return h(Panel, { getWorkspace: getWorkspace }) },
    )
  })
}

exports.apply = apply
exports.inject = ['slots']
