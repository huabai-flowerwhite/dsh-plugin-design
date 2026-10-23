// dsh-plugin-design — compliance rule engine (pure, no I/O)
//
// Ruleset 0.2.1 aligns the analysis with the official DeepSeek Harness plugin
// contract documented in the upstream repository:
//   - package.json `dsh` metadata (bundle / client / profile / manifestVersion)
//   - `engines.dsh` compatibility (decides alone when present)
//   - bundle patch files, client module bundles, exports, display icon
//   - the 0.2.0 removals (runtime invariants, subpath package.json manifests)
// plus the DH-TP-SDK engineering manifest (`dsh.plugin.yaml`) kept by this
// project as an additional, optional layer.
//
// The engine never reads files: callers build a plain model (see collectModel
// in host.js) and receive findings, an official-contract summary, actionable
// migrations, per-dimension scores, and a verdict.

/** Ruleset identity surfaced in tool output and documentation. */
export const RULESET = Object.freeze({
  version: '0.2.1',
  updatedAt: '2026-10-23',
  sources: [
    'https://github.com/deepseek-ai/deepseek-harness',
    'docs/user/develop/basic/publish.md',
    'docs/cookbook/adding-a-settings-card.md',
    'docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.md',
    'docs/upgrade-guide/v0.2.0-rc.2/subpath-plugin-display-manifest/guide.md',
    'docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.md',
  ],
})

/** Severity weights used by the per-dimension score. */
export const SEVERITY_WEIGHT = Object.freeze({
  BLOCKER: 50,
  CRITICAL: 25,
  HIGH: 15,
  MEDIUM: 8,
  LOW: 3,
  INFO: 1,
})

const DIMENSION_OF_CATEGORY = Object.freeze({
  manifest: 'manifest',
  install: 'install',
  compat: 'compatibility',
  security: 'security',
  lifecycle: 'lifecycle',
  session: 'session',
  tool: 'tool',
  bundle: 'bundle',
  client: 'client',
  testing: 'testing',
})

const DIMENSIONS = Object.freeze([
  'manifest', 'install', 'compatibility', 'security', 'lifecycle',
  'session', 'tool', 'bundle', 'client', 'testing',
])

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i

const SKIP_SOURCE_DIR = /(^|[\\/])(node_modules|\.git|dist|build|coverage|out)([\\/]|$)/i

/** Official client module table baseline (packages/client/web/src/platform.ts). */
const CLIENT_BASELINE = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const ICON_EXTENSIONS = new Set(['svg', 'png', 'jpg', 'jpeg', 'webp'])
const ICON_MAX_BYTES = 256 * 1024

/** Common UI seats a browser half can register into (used only as a heuristic hint). */
const KNOWN_UI_SLOTS = [
  'settings.section', 'settings.plugins.tab', 'settings.general.item', 'settings.onboarding',
  'plugins.item', 'plugins.detail.', 'plugins.tab', 'plugins.bundle.',
  'shell.overlay', 'tool.call.toolview', 'tool.call.images',
  'conversation.', 'sidebar.', 'main', 'workspace.toast', 'rightbar.',
]

/** Slot names that belonged to older settings-card APIs and no longer exist. */
const LEGACY_UI_SLOTS = [
  'settings.plugin.item', 'settings.plugin.page', 'settings.plugin.card', 'settings.plugins.item',
]

const TEST_FILE = /(^|[\\/])(tests?|__tests__)([\\/]|$)|\.(test|spec)\.[^.]+$/i

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function isTestSource(path) {
  return TEST_FILE.test(String(path || ''))
}

export function isSourcePath(path) {
  return SOURCE_EXT.test(String(path || '')) && !SKIP_SOURCE_DIR.test(String(path || ''))
}

/** Add one finding to an issue list (kept as a tiny helper so rules stay uniform). */
export function addIssue(issues, issue) {
  issues.push({
    id: issue.id,
    severity: issue.severity,
    category: issue.category,
    title: issue.title,
    detail: issue.detail || null,
    file: issue.file || null,
    line: issue.line || null,
    migration: issue.migration || null,
  })
}

/** Per-dimension scores: each dimension starts at 100 and loses severity weight. */
export function scoreIssues(issues) {
  const dims = {}
  for (const dim of DIMENSIONS) dims[dim] = 100
  for (const issue of issues) {
    const dim = DIMENSION_OF_CATEGORY[issue.category] || 'compatibility'
    const weight = SEVERITY_WEIGHT[issue.severity] || 3
    dims[dim] = Math.max(0, dims[dim] - weight)
  }
  return dims
}

/** Overall verdict from the strongest findings. */
export function verdictOf(issues) {
  if (issues.some((issue) => issue.severity === 'BLOCKER')) return 'BLOCKED'
  if (issues.some((issue) => issue.severity === 'CRITICAL')) return 'NEEDS_REVIEW'
  return 'READY_TO_MODIFY'
}

// ---------------------------------------------------------------------------
// Minimal SemVer range check (enough for engines.dsh; no dependency allowed).
// ---------------------------------------------------------------------------

function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value || '').trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function comparePre(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumber = /^\d+$/.test(a)
    const bNumber = /^\d+$/.test(b)
    if (aNumber && bNumber) return Number(a) < Number(b) ? -1 : 1
    if (aNumber) return -1
    if (bNumber) return 1
    return a < b ? -1 : 1
  }
  return 0
}

function compareSemver(left, right) {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePre(left.pre, right.pre)
}

function bump(version, part) {
  const next = { ...version, pre: [] }
  if (part === 'major') return { major: next.major + 1, minor: 0, patch: 0, pre: [] }
  if (part === 'minor') return { major: next.major, minor: next.minor + 1, patch: 0, pre: [] }
  return { major: next.major, minor: next.minor, patch: next.patch + 1, pre: [] }
}

/** Fill missing version parts with zero and return wildcard information. */
function partialVersion(raw) {
  const trimmed = String(raw || '').trim()
  const match = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(trimmed)
  if (match === null) return null
  const wildcard = (part) => part === undefined || /^[xX*]$/.test(part)
  return {
    raw: trimmed,
    major: wildcard(match[1]) ? null : Number(match[1]),
    minor: wildcard(match[2]) ? null : Number(match[2]),
    patch: wildcard(match[3]) ? null : Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
    wildcardMinor: wildcard(match[2]),
    wildcardPatch: wildcard(match[3]),
  }
}

function comparatorFrom(token) {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(String(token || ''))
  if (match === null) return null
  const operator = match[1] === undefined ? '' : match[1]
  const partial = partialVersion(match[2])
  if (partial === null) return null
  return { operator, partial }
}

function testComparator(version, comparator) {
  const { operator, partial } = comparator
  if (partial.major === null) return true
  const floor = {
    major: partial.major,
    minor: partial.minor === null ? 0 : partial.minor,
    patch: partial.patch === null ? 0 : partial.patch,
    pre: partial.pre,
  }
  // A partial version without an operator is a range over the omitted parts.
  if (operator === '' || operator === '=') {
    if (partial.wildcardMinor || partial.wildcardPatch) {
      if (version.major !== floor.major) return false
      if (!partial.wildcardMinor && version.minor !== floor.minor) return false
      if (!partial.wildcardPatch && version.patch !== floor.patch) return false
      return true
    }
    return compareSemver(version, floor) === 0
  }
  if (operator === '^') {
    if (compareSemver(version, floor) < 0) return false
    if (floor.major > 0) return version.major === floor.major
    if (floor.minor > 0) return version.major === 0 && version.minor === floor.minor
    return version.major === 0 && version.minor === 0 && version.patch === floor.patch
  }
  if (operator === '~') {
    if (compareSemver(version, floor) < 0) return false
    return version.major === floor.major && version.minor === floor.minor
  }
  const order = compareSemver(version, floor)
  if (operator === '>=') return order >= 0
  if (operator === '<=') return order <= 0
  if (operator === '>') return order > 0
  if (operator === '<') return order < 0
  return false
}

/**
 * Check a Version against a SemVer range. Deliberately small (no external
 * dependency is resolvable from a linked third-party package): operators
 * ^, ~, >, >=, <, <=, =, wildcards, partial versions, `||`, and space-joined
 * comparator sets. Hyphen ranges and `!=` are unsupported and reported as a
 * ruleset limitation instead of silently passing.
 */
export function semverSatisfies(version, range) {
  const parsedVersion = parseSemver(version)
  if (parsedVersion === null || typeof range !== 'string' || range.trim() === '') return false
  const sets = range.split('||').map((part) => part.trim()).filter((part) => part !== '')
  if (sets.length === 0) return false
  return sets.some((set) => {
    const tokens = set.split(/\s+/).filter(Boolean)
    const comparators = tokens.map(comparatorFrom)
    return comparators.every((comparator) => comparator !== null && testComparator(parsedVersion, comparator))
  })
}

// ---------------------------------------------------------------------------
// Heuristic YAML probe for the optional DH-TP-SDK manifest.
// ---------------------------------------------------------------------------

/**
 * Indentation-aware, line-based probe producing dotted paths for nested keys.
 * Not a YAML parser: no anchors, folded scalars, or flow maps. List items are
 * recorded as `<path>.length` markers so callers can tell a list exists.
 */
export function parseManifestHeuristic(raw) {
  if (raw === null || raw === undefined) return null
  const out = {}
  const stack = []
  for (const line of String(raw).split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue
    const indent = (line.match(/^\s*/) || [''])[0].length
    const item = /^(\s*)-\s+(.*)$/.exec(line)
    if (item !== null) {
      const parent = stack.filter((entry) => entry.indent < indent).map((entry) => entry.key).join('.')
      if (parent !== '') out[parent + '.length'] = (out[parent + '.length'] || 0) + 1
      continue
    }
    const match = /^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[2]
    const value = match[3].trim()
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    const path = stack.map((entry) => entry.key).concat([key]).join('.')
    if (value === '' || value === '{}' || value === '[]') {
      out[path] = {}
      stack.push({ indent, key })
    } else {
      out[path] = value.replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Model analysis.
// ---------------------------------------------------------------------------

function resolveExportTarget(exportsField, key) {
  const entry = isPlainObject(exportsField) ? exportsField[key] : undefined
  if (typeof entry === 'string') return { target: entry, key }
  if (isPlainObject(entry)) {
    const target = nonEmptyString(entry.default) || nonEmptyString(entry.import) || nonEmptyString(entry.require)
    if (target !== null) return { target, key }
  }
  return null
}

function packageSections(pkg) {
  if (!isPlainObject(pkg)) return []
  return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .filter((section) => isPlainObject(pkg[section]))
    .map((section) => [section, pkg[section]])
}

function normalizePackagePath(value) {
  return String(value || '').trim().replace(/^\.\//, '').replace(/\\/g, '/')
}

/** Whether npm's `files` list publishes a package-relative path. */
function packageFilesCover(files, target) {
  if (!Array.isArray(files)) return true
  const normalizedTarget = normalizePackagePath(target)
  if (normalizedTarget === '') return true
  return files.some((entry) => {
    if (typeof entry !== 'string') return false
    const normalizedEntry = normalizePackagePath(entry).replace(/\/+$/, '')
    return normalizedTarget === normalizedEntry || normalizedTarget.startsWith(normalizedEntry + '/')
  })
}

/** Whether a `.js`/`.mjs` source file uses ESM syntax (needs package.json type=module). */
function sourceUsesEsm(sourceFiles) {
  for (const file of sourceFiles) {
    if (!isPlainObject(file) || typeof file.content !== 'string') continue
    const path = String(file.path || '')
    if (!/\.(?:js|mjs)$/i.test(path)) continue
    if (/^\s*(?:import\s|export\s)/m.test(file.content)) return true
  }
  return false
}

/** Quoted tokens from an `inject: [...]` / `export const inject = [...]` declaration. */
function injectTokens(sourceFiles) {
  const tokens = new Set()
  for (const file of sourceFiles) {
    if (!isPlainObject(file) || typeof file.content !== 'string') continue
    for (const pattern of [/inject\s*:\s*\[([^\]]*)\]/g, /inject\s*=\s*\[([^\]]*)\]/g]) {
      for (const match of file.content.matchAll(pattern)) {
        for (const token of match[1].matchAll(/['"]([^'"]+)['"]/g)) tokens.add(token[1])
      }
    }
  }
  return tokens
}

/** Absolute fetch paths used by client source (query/hash removed). */
function clientFetchPaths(clientFiles) {
  const paths = new Set()
  for (const file of clientFiles) {
    if (!isPlainObject(file) || typeof file.content !== 'string') continue
    for (const match of file.content.matchAll(/fetch\s*\(\s*['"`](\/[^'"`?\s#]+)/g)) paths.add(match[1])
  }
  return [...paths]
}

/** Route paths declared by host source (`path: '/x'`). */
function hostRoutePaths(sourceFiles) {
  const paths = new Set()
  for (const file of sourceFiles) {
    if (!isPlainObject(file) || typeof file.content !== 'string') continue
    if (isTestSource(file.relative || file.path)) continue
    for (const match of file.content.matchAll(/path\s*:\s*['"]([^'"]+)['"]/g)) paths.add(match[1])
  }
  return paths
}

function collectClientImports(sourceFiles) {
  const specifiers = new Set()
  for (const file of sourceFiles) {
    if (!isPlainObject(file) || typeof file.content !== 'string') continue
    const lines = file.content.split('\n')
    for (const line of lines) {
      if (/\bimport\s+type\b/.test(line)) continue
      const from = /(?:import|export)[^'"]*?from\s*['"](@deepseek-ai\/[^'"]+)['"]/g
      const dynamic = /import\s*\(\s*['"](@deepseek-ai\/[^'"]+)['"]\s*\)/g
      for (const match of line.matchAll(from)) specifiers.add(match[1])
      for (const match of line.matchAll(dynamic)) specifiers.add(match[1])
    }
  }
  return [...specifiers].sort()
}

function issueMigration(migration) {
  return isPlainObject(migration) ? migration : null
}

/**
 * Analyze one plugin model.
 * @param {object} model - collected facts (see collectModel in host.js).
 * @returns {{issues: object[], official: object, migrations: object[], scores: object, overall: string}}
 */
export function analyzeModel(model) {
  const issues = []
  const migrations = new Map()
  const addMigration = (migration) => {
    if (isPlainObject(migration) && typeof migration.id === 'string' && !migrations.has(migration.id)) {
      migrations.set(migration.id, migration)
    }
  }
  const push = (issue) => {
    addIssue(issues, issue)
    addMigration(issueMigration(issue.migration))
  }

  const pkg = isPlainObject(model.pkg) ? model.pkg : null
  const pkgError = nonEmptyString(model.pkgError)
  const sourceFiles = Array.isArray(model.sourceFiles) ? model.sourceFiles : []
  const manifestRaw = typeof model.manifestRaw === 'string' ? model.manifestRaw : null
  const manifest = parseManifestHeuristic(manifestRaw)
  const harnessVersion = nonEmptyString(model.harnessVersion)
  const dshField = pkg !== null && isPlainObject(pkg.dsh) ? pkg.dsh : null
  const bundle = dshField !== null && isPlainObject(dshField.bundle) ? dshField.bundle : null
  const client = dshField !== null && isPlainObject(dshField.client) ? dshField.client : null
  const profile = dshField !== null && isPlainObject(dshField.profile) ? dshField.profile : null
  const engines = pkg !== null && isPlainObject(pkg.engines) ? pkg.engines : null
  const peerDependencies = pkg !== null && isPlainObject(pkg.peerDependencies) ? pkg.peerDependencies : null
  const dshPeers = peerDependencies === null
    ? []
    : Object.keys(peerDependencies).filter((name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))

  const official = {
    packageName: pkg !== null ? nonEmptyString(pkg.name) : null,
    packageVersion: pkg !== null ? nonEmptyString(pkg.version) : null,
    private: pkg !== null && pkg.private === true,
    manifestVersion: dshField !== null && typeof dshField.manifestVersion === 'number' ? dshField.manifestVersion : null,
    engines: {
      dsh: engines !== null ? (typeof engines.dsh === 'string' ? engines.dsh : null) : null,
      node: engines !== null ? (typeof engines.node === 'string' ? engines.node : null) : null,
      dshPeers,
    },
    compatibility: {
      source: 'none',
      range: null,
      runtime: harnessVersion,
      satisfied: null,
    },
    bundle: {
      declared: bundle !== null,
      patch: [],
      filesPresent: null,
    },
    client: {
      declared: client !== null,
      platform: client !== null ? nonEmptyString(client.platform) : null,
      exportKey: null,
      exportTarget: null,
      bundlePresent: false,
      factoryForm: false,
      buildStale: false,
      applyPresent: false,
      injectPresent: false,
      uiSlots: [],
      externals: client !== null ? stringArray(client.external) : [],
    },
    profile: profile !== null,
    roles: [],
  }
  if (official.bundle.declared || official.client.declared || official.profile) official.roles.push('package')
  if (official.bundle.declared) official.roles.push('bundle')
  if (official.client.declared) official.roles.push('client')

  // ---- package identity -------------------------------------------------
  if (pkg === null) {
    push({
      id: 'PKG_MISSING', severity: 'BLOCKER', category: 'manifest',
      title: '缺少 package.json', detail: '官方插件契约以 package.json 为唯一清单：name/version 必填，dsh 字段声明 bundle/client 角色。',
      file: 'package.json',
    })
  } else if (pkgError !== null) {
    push({
      id: 'PKG_INVALID_JSON', severity: 'BLOCKER', category: 'manifest',
      title: 'package.json 无法解析', detail: pkgError, file: 'package.json',
    })
  } else {
    if (official.packageName === null) {
      push({ id: 'PKG_NO_NAME', severity: 'BLOCKER', category: 'manifest', title: 'package.json 缺少 name', detail: '包名同时是 Loader 行标识、客户端模块 id 与工具命名前缀的来源。', file: 'package.json' })
    }
    if (official.packageVersion === null) {
      push({ id: 'PKG_NO_VERSION', severity: 'HIGH', category: 'manifest', title: 'package.json 缺少 version', detail: '安装兼容检查与插件管理器都要求非空版本号。', file: 'package.json' })
    }
    if (!nonEmptyString(pkg.description)) {
      push({ id: 'PKG_NO_DESCRIPTION', severity: 'LOW', category: 'install', title: 'package.json 缺少 description', detail: '插件管理器用 description 作为卡片摘要；缺失时只显示技术名。', file: 'package.json' })
    }
    if (official.private) {
      push({ id: 'PKG_PRIVATE', severity: 'INFO', category: 'install', title: 'package.json 标记 private', detail: 'private 包不能发布到 npm；仅本地 link 安装时无影响。', file: 'package.json' })
    }
    if (typeof pkg.icon !== 'string' || pkg.icon.trim() === '') {
      push({ id: 'PKG_NO_ICON', severity: 'INFO', category: 'install', title: '未声明插件图标', detail: '0.2.x 插件管理器读取 package.json.icon（SVG/PNG/JPEG/WebP，≤256 KiB，须位于包目录内）；缺失时显示通用图标。', file: 'package.json' })
    } else if (model.iconExists === false) {
      push({ id: 'PKG_ICON_MISSING', severity: 'MEDIUM', category: 'install', title: '声明的图标文件不存在', detail: 'package.json.icon 指向的文件在包目录内不存在。', file: String(pkg.icon) })
    } else {
      const iconExt = typeof model.iconExt === 'string' ? model.iconExt : String(pkg.icon).split('.').pop().toLowerCase()
      if (!ICON_EXTENSIONS.has(iconExt)) {
        push({
          id: 'PKG_ICON_FORMAT', severity: 'MEDIUM', category: 'install',
          title: '图标格式不受支持', detail: '官方插件管理器支持 SVG / PNG / JPEG / WebP，当前为 .' + iconExt + '。', file: String(pkg.icon),
        })
      }
      if (typeof model.iconBytes === 'number' && model.iconBytes > ICON_MAX_BYTES) {
        push({
          id: 'PKG_ICON_TOO_LARGE', severity: 'MEDIUM', category: 'install',
          title: '图标超过 256 KiB', detail: '图标当前 ' + model.iconBytes + ' 字节；官方上限为 262144 字节。', file: String(pkg.icon),
        })
      }
      if (!packageFilesCover(pkg.files, pkg.icon)) {
        push({
          id: 'PKG_FILES_ICON', severity: 'LOW', category: 'install',
          title: 'npm files 列表漏掉图标', detail: '发布后插件管理器将拿不到图标；把该文件加入 package.json.files。', file: 'package.json',
        })
      }
    }
  }

  if (pkg !== null && pkg.type !== 'module' && sourceUsesEsm(sourceFiles)) {
    push({
      id: 'PKG_NO_TYPE_MODULE', severity: 'HIGH', category: 'manifest',
      title: 'ESM 源码但缺少 "type": "module"',
      detail: '源码使用 import/export，而 package.json 没有声明 type=module；Node 会按 CommonJS 解析 .js 并直接报错。',
      file: 'package.json',
    })
  }

  // ---- engines.dsh / peer compatibility ---------------------------------
  if (pkg !== null && pkg.engines !== undefined && !isPlainObject(pkg.engines)) {
    push({
      id: 'ENGINES_INVALID', severity: 'HIGH', category: 'compat',
      title: 'engines 不是对象', detail: '0.2.1 起，非对象的 engines 会让清单的兼容性不可读，安装被拒绝。', file: 'package.json',
    })
  } else if (engines !== null && engines.dsh !== undefined) {
    const range = engines.dsh
    official.compatibility.source = 'engines.dsh'
    if (typeof range !== 'string') {
      push({
        id: 'ENGINES_DSH_INVALID', severity: 'HIGH', category: 'compat',
        title: 'engines.dsh 不是字符串', detail: 'engines.dsh 必须是 SemVer 范围字符串；同类写法在 0.2.1 起直接拒绝安装。', file: 'package.json',
        migration: { id: 'engines-dsh', title: '把 engines.dsh 改写为 SemVer 范围', tool: 'dshpd_migrate' },
      })
    } else {
      official.compatibility.range = range.trim()
      if (/^workspace:/.test(range.trim())) {
        push({
          id: 'ENGINES_DSH_WORKSPACE', severity: 'CRITICAL', category: 'compat',
          title: 'engines.dsh 使用了 workspace: 协议', detail: 'workspace: 只在 peerDependencies 中有效；engines.dsh 中出现会被判定为不兼容并拒绝安装。', file: 'package.json',
          migration: { id: 'engines-dsh', title: '把 workspace: 改成真实 SemVer 范围', tool: 'dshpd_migrate' },
        })
      } else if (!/[\d]/.test(range)) {
        push({
          id: 'ENGINES_DSH_INVALID_RANGE', severity: 'HIGH', category: 'compat',
          title: 'engines.dsh 不是可读的 SemVer 范围', detail: '示例：">=0.2.0 <0.3.0"、"^0.2.1"、"*"。', file: 'package.json',
          migration: { id: 'engines-dsh', title: '写入可读的 SemVer 范围', tool: 'dshpd_migrate' },
        })
      } else if (harnessVersion !== null) {
        const satisfied = semverSatisfies(harnessVersion, range)
        official.compatibility.satisfied = satisfied
        if (!satisfied) {
          push({
            id: 'ENGINES_DSH_UNSATISFIED', severity: 'CRITICAL', category: 'compat',
            title: '当前 Harness 版本不满足 engines.dsh',
            detail: '运行时 ' + harnessVersion + ' 不满足 ' + range + '；安装与启动都会被拒绝（可用 version exemption 逐版本放行）。',
            file: 'package.json',
          })
        }
      }
    }
  } else if (pkg !== null && dshPeers.length === 0) {
    push({
      id: 'ENGINES_DSH_MISSING', severity: 'HIGH', category: 'compat',
      title: '没有 engines.dsh，也没有 @deepseek-ai/dsh* peer',
      detail: '0.2.1 起安装/启动先看 engines.dsh；缺省时才回退 peerDependencies。两者都没有时兼容性不可验证。',
      file: 'package.json',
      migration: {
        id: 'engines-dsh', title: '声明 engines.dsh 兼容范围', tool: 'dshpd_migrate',
        options: { dshRange: '>=0.2.0 <0.3.0' },
      },
    })
  } else if (pkg !== null && dshPeers.length > 0) {
    official.compatibility.source = 'peerDependencies'
    official.compatibility.range = dshPeers.map((name) => name + '@' + String(peerDependencies[name])).join(', ')
  }

  // ---- dsh manifest roles ----------------------------------------------
  if (pkg !== null && pkg.dsh !== undefined && !isPlainObject(pkg.dsh)) {
    push({ id: 'DSH_FIELD_INVALID', severity: 'HIGH', category: 'manifest', title: 'package.json.dsh 不是对象', detail: 'dsh 字段承载 bundle / profile / client 角色声明，必须是对象。', file: 'package.json' })
  }
  if (dshField !== null) {
    if (dshField.bundle !== undefined && !isPlainObject(dshField.bundle)) {
      push({ id: 'BUNDLE_DECL_INVALID', severity: 'HIGH', category: 'bundle', title: 'dsh.bundle 不是对象', detail: 'bundle 声明必须形如 { "patch": "./cordis.patch.yml" }。', file: 'package.json' })
    }
    if (dshField.client !== undefined && !isPlainObject(dshField.client)) {
      push({ id: 'CLIENT_DECL_INVALID', severity: 'HIGH', category: 'client', title: 'dsh.client 不是对象', detail: 'client 声明必须形如 { "platform": "web", "external": [...] }。', file: 'package.json' })
    }
    if (dshField.profile !== undefined && !isPlainObject(dshField.profile)) {
      push({ id: 'PROFILE_DECL_INVALID', severity: 'MEDIUM', category: 'manifest', title: 'dsh.profile 不是对象', detail: 'profile 声明必须形如 { "bundles": [...] }。', file: 'package.json' })
    }
    if (official.manifestVersion === null) {
      push({
        id: 'MANIFEST_VERSION_MISSING', severity: 'LOW', category: 'manifest',
        title: 'package.json.dsh 未声明 manifestVersion', detail: '0.2.x 读取该字段；当前可省略，但显式写 1 可避免未来默认值变化。', file: 'package.json',
        migration: { id: 'manifest-version', title: '写入 dsh.manifestVersion = 1', tool: 'dshpd_migrate' },
      })
    } else if (official.manifestVersion !== 1) {
      push({ id: 'MANIFEST_VERSION_UNKNOWN', severity: 'MEDIUM', category: 'manifest', title: '未知的 dsh.manifestVersion', detail: '当前官方版本为 1。', file: 'package.json' })
    }
  }

  // ---- bundle ----------------------------------------------------------
  if (bundle !== null) {
    const patch = bundle.patch
    const declared = typeof patch === 'string' ? [patch] : stringArray(patch)
    official.bundle.patch = declared
    if (declared.length === 0) {
      push({
        id: 'BUNDLE_PATCH_UNSPECIFIED', severity: 'BLOCKER', category: 'bundle',
        title: 'dsh.bundle 未声明 patch', detail: '声明了 bundle 角色却没有可应用的 patch 文件，安装后不会挂载任何插件行。', file: 'package.json',
      })
    } else {
      const collected = Array.isArray(model.bundlePatches) ? model.bundlePatches : []
      let allPresent = true
      for (const entry of collected) {
        if (!isPlainObject(entry)) continue
        if (entry.unsafe === true) {
          push({
            id: 'BUNDLE_PATCH_UNSAFE', severity: 'BLOCKER', category: 'bundle',
            title: 'bundle patch 路径越出包目录', detail: 'patch 必须是相对包目录的路径，不能是绝对路径或包含 ..。', file: String(entry.path || 'package.json'),
          })
          allPresent = false
          continue
        }
        if (entry.exists !== true) {
          allPresent = false
          push({
            id: 'BUNDLE_PATCH_MISSING', severity: 'CRITICAL', category: 'bundle',
            title: 'bundle patch 文件不存在', detail: '声明的 patch 文件在包目录内不存在：' + String(entry.path), file: String(entry.path),
          })
        } else if (typeof entry.raw === 'string' && !/^\s*-\s+(insert:|id:|override:|remove:)/m.test(entry.raw)) {
          push({
            id: 'PATCH_UNRECOGNIZED', severity: 'MEDIUM', category: 'bundle',
            title: 'patch 文件不是标准的 Loader patch 数组', detail: '应以顶层数组的 `- insert:` / `- id:` 条目开始。', file: String(entry.path),
          })
        }
      }
      official.bundle.filesPresent = allPresent
      if (pkg !== null) {
        for (const patchPath of declared) {
          if (!packageFilesCover(pkg.files, patchPath)) {
            push({
              id: 'PKG_FILES_BUNDLE_PATCH', severity: 'MEDIUM', category: 'install',
              title: 'npm files 列表漏掉 bundle patch', detail: '发布后的包将缺少 ' + patchPath + '，安装后无法挂载；把该文件（或所在目录）加入 package.json.files。',
              file: 'package.json',
            })
          }
        }
      }
    }
    const base = Array.isArray(model.bundlePatches) ? model.bundlePatches : []
    if (base.length > 0 && base.every((entry) => isPlainObject(entry) && entry.exists === true)) {
      const joined = base.map((entry) => String(entry.raw || '')).join('\n')
      if (/replace|replacement/i.test(joined)) {
        push({
          id: 'CORE_ROW_REPLACE', severity: 'CRITICAL', category: 'bundle',
          title: 'patch 疑似替换 Core row', detail: '第三方 bundle 应新增自己的 row；如必须覆盖，需声明目标 row、版本范围、冲突检测与回滚方案。', file: String(base[0].path),
        })
      }
    }
  } else if (typeof model.cordisPatchRaw === 'string' && profile === null) {
    push({
      id: 'BUNDLE_NOT_DECLARED', severity: 'HIGH', category: 'bundle',
      title: '有 cordis.patch.yml 但未声明 dsh.bundle',
      detail: '只有声明 dsh.bundle.patch 的包才会被 dsh plugin 当作组合包（bundle）选择与挂载；否则只能手工改 profile patch。',
      file: 'package.json',
      migration: { id: 'bundle-patch', title: '声明 dsh.bundle.patch', tool: 'dshpd_migrate' },
    })
    if (/replace|replacement/i.test(model.cordisPatchRaw)) {
      push({
        id: 'CORE_ROW_REPLACE', severity: 'CRITICAL', category: 'bundle',
        title: 'patch 疑似替换 Core row', detail: '第三方 bundle 应新增自己的 row；如必须覆盖，需声明目标 row、版本范围、冲突检测与回滚方案。', file: 'cordis.patch.yml',
      })
    }
  }

  // ---- client ----------------------------------------------------------
  const exportsField = pkg !== null && isPlainObject(pkg.exports) ? pkg.exports : null
  const clientExport = exportsField === null ? null : resolveExportTarget(exportsField, './client')
  if (clientExport !== null) {
    official.client.exportKey = clientExport.key
    official.client.exportTarget = clientExport.target
  }
  official.client.bundlePresent = model.clientBundleExists === true
  official.client.factoryForm = typeof model.clientBundleRaw === 'string'
    && /__ModuleLoader__\s*\.\s*load\s*\(/.test(model.clientBundleRaw)
    && /factory\s*:/.test(model.clientBundleRaw)

  if (client !== null) {
    if (client.inject !== undefined && !isStringArray(client.inject)) {
      push({
        id: 'CLIENT_INJECT_INVALID', severity: 'HIGH', category: 'client',
        title: 'dsh.client.inject 不是字符串数组', detail: 'inject 是客户端模块的包名依赖列表；必须是字符串数组。', file: 'package.json',
      })
    }
    if (client.external !== undefined && !isStringArray(client.external)) {
      push({
        id: 'CLIENT_EXTERNAL_INVALID', severity: 'HIGH', category: 'client',
        title: 'dsh.client.external 不是字符串数组', detail: 'external 是精确的模块表 specifier 列表；必须是字符串数组。', file: 'package.json',
      })
    }
    if (client.immediately !== undefined && typeof client.immediately !== 'boolean') {
      push({
        id: 'CLIENT_IMMEDIATELY_INVALID', severity: 'MEDIUM', category: 'client',
        title: 'dsh.client.immediately 不是布尔值', detail: 'immediately 控制 boot 第一阶段注册屏障，只能是 true/false。', file: 'package.json',
      })
    }
    const declaredExternal = stringArray(client.external)
    if (official.packageName !== null && declaredExternal.some((specifier) => specifier === official.packageName || specifier.startsWith(official.packageName + '/'))) {
      push({
        id: 'CLIENT_EXTERNAL_SELF', severity: 'HIGH', category: 'client',
        title: 'dsh.client.external 引用了自身包', detail: 'client-modules 禁止一个 row 在 external 中声明自己的包；会直接拒绝组合。', file: 'package.json',
      })
    }
    for (const specifier of declaredExternal) {
      if (CLIENT_BASELINE.has(specifier)) {
        push({
          id: 'CLIENT_EXTERNAL_BASELINE', severity: 'INFO', category: 'client',
          title: 'dsh.client.external 重复声明平台基线模块', detail: specifier + ' 已在平台基线中，无需再写；保留无害但冗余。', file: 'package.json',
        })
      }
    }
    const hostExport = exportsField === null ? null : resolveExportTarget(exportsField, '.')
    if (hostExport === null && !nonEmptyString(pkg.main)) {
      push({
        id: 'HOST_EXPORT_MISSING', severity: 'HIGH', category: 'manifest',
        title: '缺少 Host 入口（exports["."] 或 main）',
        detail: 'client 包也必须有 Host 半体入口：行按包名导入它，空实现也要有 exports["."]。',
        file: 'package.json',
      })
    }
    if (official.client.platform !== 'web') {
      push({
        id: 'CLIENT_PLATFORM', severity: 'MEDIUM', category: 'client',
        title: 'dsh.client.platform 不是 web', detail: '浏览器半体当前只支持 platform: "web"。', file: 'package.json',
      })
    }
    if (clientExport === null) {
      push({
        id: 'CLIENT_EXPORT_MISSING', severity: 'BLOCKER', category: 'client',
        title: '声明了 dsh.client 但缺少 exports["./client"]', detail: '客户端模块系统只加载 exports["./client"] 导出的构建产物；缺失时设置页等 UI 永不挂载。',
        file: 'package.json',
        migration: { id: 'client-meta', title: '补齐 dsh.client 与 ./client 导出', tool: 'dshpd_migrate' },
      })
    } else if (model.clientBundleExists !== true) {
      push({
        id: 'CLIENT_BUNDLE_MISSING', severity: 'BLOCKER', category: 'client',
        title: 'client bundle 文件不存在', detail: 'exports["./client"] 指向 ' + clientExport.target + '，但文件不存在；构建产物必须先 build。',
        file: String(clientExport.target),
      })
    } else if (!official.client.factoryForm) {
      push({
        id: 'CLIENT_BUNDLE_FORMAT', severity: 'BLOCKER', category: 'client',
        title: 'client bundle 不是 factory-form', detail: '浏览器 bundle 必须是 window.__ModuleLoader__.load({ id, factory }) 形式（tsdown clientBundle 的输出）；否则页面加载即抛错。',
        file: String(clientExport.target),
      })
    } else {
      const idMatch = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[^}]*id\s*:\s*['"]([^'"]+)['"]/.exec(String(model.clientBundleRaw))
      if (idMatch !== null && official.packageName !== null && idMatch[1] !== official.packageName) {
        push({
          id: 'CLIENT_BUNDLE_ID', severity: 'HIGH', category: 'client',
          title: 'client bundle 注册 id 与包名不一致', detail: '注册 id 为 ' + idMatch[1] + '，包名为 ' + official.packageName + '；客户端模块系统按包名装配，id 不一致会 MISS。',
          file: String(clientExport.target),
        })
      }
    }

    // ---- UI restoration diagnostics --------------------------------------
    const clientSourceText = (Array.isArray(model.clientSourceFiles) ? model.clientSourceFiles : [])
      .map((file) => (isPlainObject(file) && typeof file.content === 'string' ? file.content : ''))
      .join('\n')
    const bundleText = typeof model.clientBundleRaw === 'string' ? model.clientBundleRaw : ''
    const clientText = clientSourceText + '\n' + bundleText

    official.client.applyPresent = /exports\s*\.\s*apply|module\.exports\s*=\s*\{[\s\S]*?\bapply\b/.test(bundleText)
    official.client.injectPresent = /exports\s*\.\s*inject|(?:^|[^\w.])inject\s*[:=]/.test(bundleText)
    official.client.uiSlots = KNOWN_UI_SLOTS.filter((slot) => clientText.includes(slot))

    if (typeof model.clientSourceMtimeMax === 'number' && typeof model.clientBundleMtime === 'number'
      && model.clientSourceMtimeMax > model.clientBundleMtime + 1500) {
      official.client.buildStale = true
      push({
        id: 'CLIENT_BUILD_STALE', severity: 'HIGH', category: 'client',
        title: 'client 源码比构建产物新（UI 可能还是旧版本）',
        detail: 'src/client 的最后修改时间晚于 ' + String(clientExport === null ? model.defaultClientBundlePath : clientExport.target)
          + '；修改源码后必须重新构建 lib/client.js，否则页面加载的仍是旧 UI。',
        file: String(clientExport === null ? model.defaultClientBundlePath : clientExport.target),
      })
    }
    if (model.clientBundleExists === true && !official.client.applyPresent) {
      push({
        id: 'CLIENT_BUNDLE_NO_APPLY', severity: 'HIGH', category: 'client',
        title: 'client bundle 没有导出 apply',
        detail: 'factory 返回的模块必须包含 exports.apply，否则客户端模块系统会注册一个没有插件的空模块，设置页/UI 不会出现。',
        file: String(clientExport === null ? model.defaultClientBundlePath : clientExport.target),
      })
    }
    if (model.clientBundleExists === true && !official.client.injectPresent) {
      push({
        id: 'CLIENT_BUNDLE_NO_INJECT', severity: 'MEDIUM', category: 'client',
        title: 'client bundle 没有导出 inject',
        detail: '依赖 slots 等客户端服务时应导出 exports.inject = ["slots"]，否则 apply 可能早于座位/服务就绪。',
        file: String(clientExport === null ? model.defaultClientBundlePath : clientExport.target),
      })
    }
    if (clientText.length > 0 && official.client.uiSlots.length === 0) {
      push({
        id: 'CLIENT_NO_UI_SLOT', severity: 'INFO', category: 'client',
        title: 'client 半体没有注册已知 UI 座位',
        detail: '源码/bundle 中没有 settings.section、settings.plugins.tab、shell.overlay、tool.call.toolview 等已知座位；如果它本应有设置页，请检查是否使用了已移除的 slot 名称。',
        file: null,
      })
    }
    for (const legacySlot of LEGACY_UI_SLOTS) {
      if (clientText.includes(legacySlot)) {
        push({
          id: 'CLIENT_LEGACY_SLOT', severity: 'MEDIUM', category: 'client',
          title: 'client 使用了旧版/不存在的 UI 座位：' + legacySlot,
          detail: '当前设置页座位是 settings.section / settings.plugins.tab / settings.general.item；插件配置卡片是 plugins.item + ctx.configForms。旧座位名不会渲染。',
          file: null,
        })
      }
    }
    if (/React\s*\.\s*(?:createElement|useState|useEffect|useRef|useMemo|useCallback)/.test(clientSourceText)
      && !/require\s*\(\s*['"]react['"]\s*\)|from\s+['"]react['"]/.test(clientSourceText)) {
      push({
        id: 'CLIENT_REACT_MISSING', severity: 'HIGH', category: 'client',
        title: 'client 源码使用 React 但没有 require/import',
        detail: 'factory 里必须 require("react") 或 import；否则 apply/render 时 React 未定义，UI 直接白屏。',
        file: null,
      })
    }
    if (/styles\s*\.\s*insert|ctx\s*\.\s*get\s*\(\s*['"]styles['"]\s*\)/.test(clientText)) {
      push({
        id: 'CLIENT_STYLES_SERVICE', severity: 'HIGH', category: 'client',
        title: '使用了已移除的 styles 服务',
        detail: '当前 client 半体没有 styles.insert；样式应由插件自己创建 <style> 标签或用内联 style，否则 apply 会抛错、UI 不出现。',
        file: null,
      })
    }
    const routePaths = hostRoutePaths(sourceFiles)
    for (const fetchPath of clientFetchPaths(Array.isArray(model.clientSourceFiles) ? model.clientSourceFiles : [])) {
      if (/^\/(?:plugins|api|assets|static|favicon|login|health|manifest|socket)(?:\/|$)/.test(fetchPath)) continue
      const covered = [...routePaths].some((route) => {
        const normalizedRoute = route.replace(/\/+$/, '')
        return fetchPath === normalizedRoute || fetchPath.startsWith(normalizedRoute + '/')
      })
      if (!covered) {
        push({
          id: 'CLIENT_ROUTE_MISSING', severity: 'HIGH', category: 'client',
          title: 'client 请求的本地路由在 Host 源码中未找到',
          detail: 'client fetch("' + fetchPath + '")，但 host 源码没有对应的 webServer.register({ path: ... })；请求会落到 SPA fallback（HTML），设置页读取 JSON 时报 Unexpected token "<"。',
          file: null,
        })
      }
    }
    if (exportsField !== null && exportsField['./package.json'] === undefined) {
      push({
        id: 'EXPORT_PACKAGE_JSON', severity: 'LOW', category: 'client',
        title: '未导出 ./package.json', detail: '旧版 client-modules 曾用 require.resolve("<pkg>/package.json") 定位包；0.2.x 已不强制，但保留该导出兼容更广。',
        file: 'package.json',
      })
    }
    if (clientExport !== null && !packageFilesCover(pkg.files, clientExport.target)) {
      push({
        id: 'PKG_FILES_CLIENT_BUNDLE', severity: 'MEDIUM', category: 'install',
        title: 'npm files 列表漏掉 client bundle', detail: '发布后的包将缺少 ' + clientExport.target + '，设置页等 UI 不会加载；把该文件（或 lib 目录）加入 package.json.files。',
        file: 'package.json',
      })
    }
    const requested = new Set(stringArray(client.external))
    for (const specifier of collectClientImports(Array.isArray(model.clientSourceFiles) ? model.clientSourceFiles : [])) {
      if (CLIENT_BASELINE.has(specifier) || requested.has(specifier)) continue
      if (specifier === official.packageName || (official.packageName !== null && specifier.startsWith(official.packageName + '/'))) continue
      push({
        id: 'CLIENT_EXTERNAL_UNLISTED', severity: 'MEDIUM', category: 'client',
        title: 'client 源码引用了未声明的共享模块', detail: specifier + ' 不在平台基线或 dsh.client.external 中；动态 bundle 解析不到会导致运行时报错（type-only import 会被擦除，可忽略）。',
        file: null,
      })
    }
  } else if (model.clientBundleExists === true || model.defaultClientBundleExists === true) {
    push({
      id: 'CLIENT_NOT_DECLARED', severity: 'HIGH', category: 'client',
      title: '存在 client bundle 但未声明 dsh.client',
      detail: 'lib/client.js 看起来是浏览器半体，但 package.json 没有 dsh.client；客户端模块系统只扫描声明过的包。',
      file: 'package.json',
      migration: { id: 'client-meta', title: '声明 dsh.client 与 ./client 导出', tool: 'dshpd_migrate' },
    })
  }

  // ---- host-plane service wiring (UI routes / fs scope) ----------------
  const tokens = injectTokens(sourceFiles)
  const nonTestSources = sourceFiles.filter((file) => isPlainObject(file) && !isTestSource(file.relative || file.path))
  const usesWebServer = nonTestSources.some((file) => typeof file.content === 'string' && /ctx\s*\.\s*webServer\b/.test(file.content))
  const injectsWebServer = tokens.has('webServer')
    || nonTestSources.some((file) => typeof file.content === 'string' && /ctx\s*\.\s*inject\s*\(\s*\[[^\]]*webServer/.test(file.content))
  if (usesWebServer && !injectsWebServer) {
    push({
      id: 'WEBSERVER_NOT_INJECTED', severity: 'HIGH', category: 'lifecycle',
      title: '使用 ctx.webServer 但没有声明/等待 webServer',
      detail: 'Host 半体要么在 inject 里声明 webServer，要么用 ctx.inject(["webServer"], ...) 等待服务；否则 apply 时 ctx.webServer 为 undefined，路由不注册，设置页请求会落到 SPA fallback。',
      file: null,
    })
  }
  const usesFs = nonTestSources.some((file) => typeof file.content === 'string' && /ctx\s*\.\s*fs\b/.test(file.content))
  const usesAgentCtx = nonTestSources.some((file) => typeof file.content === 'string' && /exec\s*\.\s*agent|agent\s*\.\s*ctx/.test(file.content))
  if (tokens.has('fs') && usesFs && !usesAgentCtx) {
    push({
      id: 'HOST_FS_HARD_INJECT', severity: 'MEDIUM', category: 'lifecycle',
      title: 'host composition 硬注入 fs',
      detail: 'fs 是 agent 平面服务；host composition 中 inject: ["fs"] 可能永远等不到依赖。改为在工具执行时从 exec.agent.ctx.get("fs") 取。',
      file: null,
    })
  }

  // ---- removed runtime invariants (0.2.0) ------------------------------
  for (const [section, values] of packageSections(pkg)) {
    if (Object.hasOwn(values, '@deepseek-ai/dsh-invariants')) {
      push({
        id: 'INVARIANTS_DEP', severity: 'BLOCKER', category: 'compat',
        title: '依赖了已移除的 dsh-invariants', detail: '0.2.0 删除 @deepseek-ai/dsh-invariants 与所有 <pkg>/invariant 子路径；' + section + ' 中的依赖必须删除。',
        file: 'package.json',
        migration: { id: 'remove-invariants-dep', title: '移除 @deepseek-ai/dsh-invariants 依赖', tool: 'dshpd_migrate' },
      })
    }
  }
  for (const file of sourceFiles) {
    if (!isPlainObject(file) || typeof file.content !== 'string') continue
    if (isTestSource(file.relative || file.path)) continue
    const importPattern = /(?:\bimport|\bexport)[^'"\n]*?from\s*['"](?:@deepseek-ai\/dsh-invariants|@deepseek-ai\/dsh-[a-z0-9-]+\/invariant)['"]|\brequire\s*\(\s*['"](?:@deepseek-ai\/dsh-invariants|@deepseek-ai\/dsh-[a-z0-9-]+\/invariant)['"]|\bimport\s*\(\s*['"](?:@deepseek-ai\/dsh-invariants|@deepseek-ai\/dsh-[a-z0-9-]+\/invariant)['"]/g
    const match = importPattern.exec(file.content)
    if (match !== null) {
      push({
        id: 'INVARIANTS_IMPORT', severity: 'BLOCKER', category: 'compat',
        title: '引用了已移除的 invariant 模块', detail: '0.2.0 起这些模块不再发布，import 会直接失败：' + match[0],
        file: String(file.path),
      })
    }
  }
  for (const patchEntry of Array.isArray(model.bundlePatches) ? model.bundlePatches : []) {
    const raw = isPlainObject(patchEntry) ? patchEntry.raw : null
    if (typeof raw !== 'string') continue
    if (/dsh-invariants|\/invariant['"]?/.test(raw)) {
      push({
        id: 'INVARIANTS_ROW', severity: 'HIGH', category: 'compat',
        title: 'patch 仍引用已移除的 invariant 行', detail: '0.2.0 的 sdk-minimal 不再包含 invariant 行；保留这些行会报 missing package。',
        file: isPlainObject(patchEntry) ? String(patchEntry.path) : null,
      })
    }
  }

  // ---- subpath display manifest (0.2.0) --------------------------------
  if (exportsField !== null) {
    for (const key of Object.keys(exportsField)) {
      if (/^\.\/.+\/package\.json$/.test(key)) {
        push({
          id: 'SUBPATH_PACKAGE_JSON', severity: 'MEDIUM', category: 'compat',
          title: '导出了子路径 package.json', detail: '0.2.0 起子路径插件不再读取 <subpath>/package.json；标题/描述改由 locale 文件提供，图标改由 ./<subpath>/icon 导出。',
          file: 'package.json',
        })
      }
    }
  }

  // ---- optional DH-TP-SDK manifest -------------------------------------
  if (manifestRaw === null) {
    const officialComplete = official.bundle.declared || official.client.declared || official.compatibility.source !== 'none'
    push({
      id: 'MANIFEST_YAML_MISSING',
      severity: officialComplete ? 'INFO' : 'MEDIUM',
      category: 'manifest',
      title: '未提供 dsh.plugin.yaml',
      detail: officialComplete
        ? '官方运行时以 package.json.dsh 为准，dsh.plugin.yaml 是 DH-TP-SDK 的附加工程化清单；缺失不影响加载。'
        : '包内既没有官方 dsh 元数据，也没有 DH-TP-SDK manifest，无法判断插件角色与权限。',
      file: 'dsh.plugin.yaml',
    })
  } else {
    if (manifest === null || manifest['plugin.id'] === undefined) {
      push({ id: 'MANIFEST_NO_ID', severity: 'HIGH', category: 'manifest', title: 'Manifest 缺少 plugin.id', detail: '缺少全局唯一插件 ID。', file: 'dsh.plugin.yaml' })
    }
    if (manifest === null || manifest['runtime.harness'] === undefined) {
      push({ id: 'MANIFEST_NO_HARNESS', severity: 'HIGH', category: 'manifest', title: 'Manifest 缺少 runtime.harness 兼容范围', detail: '必须显式声明 Harness min/max（与 package.json engines.dsh 保持一致）。', file: 'dsh.plugin.yaml' })
    }
    if (manifest === null || manifest['cordis.apiLevel'] === undefined) {
      push({ id: 'MANIFEST_NO_API_LEVEL', severity: 'MEDIUM', category: 'manifest', title: 'Manifest 缺少 cordis.apiLevel', detail: '建议声明 Cordis API level。', file: 'dsh.plugin.yaml' })
    }
    if (manifest === null || manifest['permissions'] === undefined) {
      push({ id: 'MANIFEST_NO_PERMISSIONS', severity: 'MEDIUM', category: 'manifest', title: 'Manifest 缺少 permissions', detail: '权限必须 Manifest 化。', file: 'dsh.plugin.yaml' })
    }
    if (manifest === null || manifest['resources'] === undefined) {
      push({ id: 'MANIFEST_NO_RESOURCES', severity: 'MEDIUM', category: 'manifest', title: 'Manifest 缺少 resources 资源上限', detail: '建议声明 maxRuntimeMs/maxMemoryMb 等。', file: 'dsh.plugin.yaml' })
    }
    if (manifest === null || manifest['lifecycle'] === undefined) {
      push({ id: 'MANIFEST_NO_LIFECYCLE', severity: 'MEDIUM', category: 'manifest', title: 'Manifest 缺少 lifecycle', detail: '应声明 unloadable/reversible。', file: 'dsh.plugin.yaml' })
    }
    if (manifest === null || manifest['security'] === undefined) {
      push({ id: 'MANIFEST_NO_SECURITY', severity: 'MEDIUM', category: 'manifest', title: 'Manifest 缺少 security', detail: '应声明 security.level 与 sandboxRequired。', file: 'dsh.plugin.yaml' })
    }
  }
  if (pkg !== null && !nonEmptyString(pkg.engines ? pkg.engines.node : null)) {
    push({ id: 'PKG_NO_NODE_RANGE', severity: 'MEDIUM', category: 'compat', title: 'package.json 缺少 engines.node', detail: '应声明兼容的 Node 版本范围。', file: 'package.json' })
  }

  // ---- source-level rules ---------------------------------------------
  let hasWaterfallListener = false
  let hasNextCall = false
  const toolRegisterPattern = /ctx\s*\.\s*tools\s*\.\s*register\s*\(\s*\{/g
  for (const file of sourceFiles) {
    if (!isPlainObject(file) || typeof file.content !== 'string') continue
    const path = String(file.path || '')
    if (isTestSource(file.relative || path)) continue
    const lines = file.content.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const loc = path + ':' + (index + 1)
      if (/globalThis\s*\.\s*[A-Za-z_$][\w$]*\s*=/.test(line)) {
        push({ id: 'GLOBALTHIS_PATCH', severity: 'BLOCKER', category: 'security', title: '修改 globalThis', detail: '禁止修改全局对象，注册必须通过 ctx 或服务。', file: loc })
      }
      if (/window\s*\.\s*[A-Za-z_$][\w$]*\s*=/.test(line)) {
        push({ id: 'GLOBALTHIS_PATCH', severity: 'BLOCKER', category: 'security', title: '修改 window 全局', detail: '禁止修改全局对象。', file: loc })
      }
      if (/\b[A-Za-z_$][\w$]*\.prototype\.[A-Za-z_$][\w$]*\s*=/.test(line)) {
        push({ id: 'PROTOTYPE_PATCH', severity: 'BLOCKER', category: 'security', title: 'Monkey/Prototype Patch', detail: '禁止修改原型链。', file: loc })
      }
      if (/\bas\s+(?:any|unknown)\b/.test(line)) {
        push({ id: 'PRIVATE_API', severity: 'CRITICAL', category: 'compat', title: '类型断言绕过类型检查', detail: '要求使用公开类型；不可把任意值断言成任意类型来访问未文档化 API。', file: loc })
      }
      if (/^\s*(?:let|var)\s+(?:currentSession|currentAgent|currentRequest|globalState)\b/.test(line)) {
        push({ id: 'GLOBAL_MUTABLE_STATE', severity: 'CRITICAL', category: 'session', title: '模块级可变全局状态', detail: '禁止 global session/agent/request state，应绑定 agent/session/request scope。', file: loc })
      }
      if (/(rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-fd|git\s+push\s+--force|rmdir\s+\/s)/i.test(line)) {
        push({ id: 'DANGEROUS_COMMAND', severity: 'BLOCKER', category: 'security', title: '危险破坏性命令', detail: '默认禁止不可逆破坏性操作。', file: loc })
      }
      if (/exec\s*\(\s*["'][^"']*\+/.test(line) || /exec\s*\(\s*`[^`]*\$\{/.test(line)) {
        push({ id: 'COMMAND_INJECTION', severity: 'CRITICAL', category: 'security', title: '疑似命令注入', detail: '禁止 exec 拼接用户输入，优先 spawn(command, args)。', file: loc })
      }
      if (/(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][A-Za-z0-9_\-]{12,}["']/i.test(line)) {
        push({ id: 'SECRET_LEAK', severity: 'BLOCKER', category: 'security', title: '疑似硬编码密钥', detail: '禁止将 secret 写入源码/Session/日志，必须 redaction。', file: loc })
      }
      if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(line)) {
        push({ id: 'DYNAMIC_CODE', severity: 'HIGH', category: 'security', title: '动态代码执行', detail: '避免 eval / new Function；它们破坏静态分析与沙箱边界。', file: loc })
      }
      if (/(?:^|[^.\w])fetch\s*\(\s*['"`]https?:|https?\.request\s*\(/.test(line)) {
        push({ id: 'NETWORK_CALL', severity: 'LOW', category: 'security', title: '源码直接发起网络请求', detail: '插件应通过说明的能力/服务访问网络；直接跨域 fetch 会绕过部署策略。', file: loc })
      }
      if (/\.on\s*\(\s*["'][^"']*?(?:agent\/pre-step|agent\/request|llm\/stream|tools\/pre-execute|tools\/execute|tools\/post-execute|fs\/write-intent|fs\/edit-intent)/i.test(line)
        || /waterfall\s*\(\s*["'][^"']*?(?:agent\/pre-step|agent\/request|llm\/stream|tools\/pre-execute|tools\/execute|tools\/post-execute|fs\/write-intent|fs\/edit-intent)/i.test(line)) {
        hasWaterfallListener = true
      }
      if (/\bnext\s*\(/.test(line)) hasNextCall = true
    }
    if (/(?:setInterval|setTimeout)\s*\(/.test(file.content) && !/ctx\s*\.\s*effect/.test(file.content) && !/clearInterval|clearTimeout/.test(file.content)) {
      push({ id: 'TIMER_NO_CLEANUP', severity: 'MEDIUM', category: 'lifecycle', title: '定时器未见清理', detail: '用 ctx.effect() 返回清理函数，或显式 clearInterval/clearTimeout，避免卸载后仍持有资源。', file: path })
    }
    toolRegisterPattern.lastIndex = 0
    let match = toolRegisterPattern.exec(file.content)
    while (match !== null) {
      const snippet = file.content.slice(match.index, match.index + 2000)
      if (!/\boutput\s*:/.test(snippet)) {
        push({ id: 'TOOL_NO_OUTPUT', severity: 'HIGH', category: 'tool', title: '工具定义缺少 output', detail: '0.1.x/0.2.x 的 ToolDefinition 强制 output.schema 与 output.render；缺失会注册失败。', file: path })
        break
      }
      match = toolRegisterPattern.exec(file.content)
    }
  }
  if (hasWaterfallListener && !hasNextCall) {
    push({ id: 'WATERFALL_NEXT', severity: 'CRITICAL', category: 'compat', title: 'waterfall listener 疑似未调用 next()', detail: 'waterfall listener 必须调用并返回 next()，除非是终止型 interceptor。', file: null })
  }

  // ---- tests / docs ----------------------------------------------------
  if (model.hasTests !== true) {
    push({ id: 'NO_TESTS', severity: 'MEDIUM', category: 'testing', title: '未检测到 tests 目录或 test 脚本', detail: '建议提供 unit/integration/lifecycle/security/compatibility 测试。', file: null })
  }
  if (model.hasReadme !== true) {
    push({ id: 'NO_README', severity: 'LOW', category: 'install', title: '未检测到 README', detail: '插件管理器与插件市场用 README/description 呈现插件；建议补充安装与使用说明。', file: 'README.md' })
  }
  if (model.hasLicense !== true) {
    push({ id: 'NO_LICENSE', severity: 'LOW', category: 'install', title: '未检测到 LICENSE', detail: '发布 npm 或公开仓库前应补充许可证。', file: 'LICENSE' })
  }

  return {
    issues,
    official,
    migrations: [...migrations.values()],
    scores: scoreIssues(issues),
    overall: verdictOf(issues),
  }
}

/** Count findings by severity (stable order). */
export function countBySeverity(issues) {
  const counts = { BLOCKER: 0, CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 }
  for (const issue of issues) {
    if (Object.hasOwn(counts, issue.severity)) counts[issue.severity] += 1
  }
  return counts
}
