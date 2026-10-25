// dsh-plugin-design — distribution package audit.
//
// Answers "can another user install this package and run it?" from the package
// contents, not from a README template:
//   packageCompleteness  manifest/entries/chunks/assets/worker/files coverage
//   portability          no author-machine paths, links, local services
//   dependencyClosure    every runtime import is declared or bundled
//   maintenancePrivates  no backups/journal/tokens/profile data
//   releaseDocumentation install/config/uninstall + support matrix presence
//
// It never executes package scripts and never imports the audited package.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { collectPluginModel } from '../scan/collector.js'

export const DISTRIBUTION_SCHEMA = 1

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])

const DOC_PATH = /(^|\/)(readme|changelog|license|licence|docs?|tests?)\b/i
const TEXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|md|txt|css|html|sh|ps1)$/i

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function gate(status, findings, extra = {}) {
  return { status, findings, ...extra }
}

function statusOf(findings, hardStatuses = ['FAIL']) {
  if (findings.some((finding) => hardStatuses.includes(finding.status))) return 'FAIL'
  if (findings.some((finding) => finding.status === 'UNKNOWN')) return 'UNKNOWN'
  return 'PASS'
}

function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
}

/** Static bare-specifier imports of a JS/TS module. */
export function bareImports(text) {
  const out = new Set()
  const source = stripComments(text)
  for (const pattern of [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue
      out.add(specifier)
    }
  }
  return [...out]
}

function packageNameOfSpecifier(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

function isBuiltin(specifier) {
  return specifier.startsWith('node:') || NODE_BUILTINS.has(specifier)
}

function entriesFromModel(model) {
  return (model.files || []).map((file) => ({
    path: file.relative,
    text: model.sourceFiles.find((source) => source.relative === file.relative)?.content ?? null,
    bytes: file.bytes || 0,
  }))
}

/**
 * Core audit over a collected model (directory) or extracted archive entries.
 * @param {{pkg: object, files: {path: string, text: string|null}[], root?: string, coverage?: object}} input
 */
export function auditPackageContents(input) {
  const pkg = input.pkg || null
  const files = Array.isArray(input.files) ? input.files : []
  const paths = new Set(files.map((file) => file.path.split('\\').join('/')))
  const textFile = (path) => files.find((file) => file.path.split('\\').join('/') === path)
  const findings = []
  const push = (finding) => findings.push({ ruleVersion: 'distribution-1', ...finding })

  const name = pkg && typeof pkg.name === 'string' ? pkg.name : null
  const version = pkg && typeof pkg.version === 'string' ? pkg.version : null

  // ---- manifest and entries -------------------------------------------
  if (pkg === null) {
    push({ id: 'DIST_NO_PACKAGE_JSON', status: 'FAIL', detail: 'package.json missing or unparsable' })
  }
  const exportsField = pkg && pkg.exports && typeof pkg.exports === 'object' ? pkg.exports : null
  const hostTarget = exportsField && typeof exportsField['.'] === 'string'
    ? exportsField['.']
    : (typeof exportsField?.['.'] === 'object' && exportsField?.['.'] !== null
      ? exportsField['.'].default || exportsField['.'].import || exportsField['.'].require || null
      : null)
  const mainTarget = hostTarget || (pkg && typeof pkg.main === 'string' ? pkg.main : null)
  const clientTarget = exportsField && typeof exportsField['./client'] === 'string'
    ? exportsField['./client']
    : (typeof exportsField?.['./client'] === 'object' && exportsField?.['./client'] !== null
      ? exportsField['./client'].default || exportsField['./client'].import || null
      : null)
  const normalize = (value) => String(value).replace(/^\.\//, '').split('\\').join('/')
  if (mainTarget !== null && !paths.has(normalize(mainTarget))) {
    push({ id: 'DIST_HOST_ENTRY_MISSING', status: 'FAIL', detail: 'host entry not present in the package: ' + mainTarget })
  }
  const dsh = pkg && pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : null
  const clientDeclared = Boolean(dsh && dsh.client)
  if (clientDeclared && clientTarget === null) {
    push({ id: 'DIST_CLIENT_EXPORT_MISSING', status: 'FAIL', detail: 'dsh.client is declared without exports["./client"]' })
  }
  if (clientTarget !== null) {
    const target = normalize(clientTarget)
    const record = textFile(target)
    if (record === undefined || typeof record.text !== 'string') {
      push({ id: 'DIST_CLIENT_BUNDLE_MISSING', status: 'FAIL', detail: 'client bundle not present: ' + clientTarget })
    } else {
      if (!/__ModuleLoader__\s*\.\s*load\s*\(/.test(record.text)) {
        push({ id: 'DIST_CLIENT_NOT_FACTORY', status: 'FAIL', detail: 'client bundle is not factory-form (__ModuleLoader__.load)' })
      }
      const idMatch = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]{0,200}?id\s*:\s*['"]([^'"]+)['"]/.exec(record.text)
      if (idMatch !== null && name !== null && idMatch[1] !== name) {
        push({ id: 'DIST_CLIENT_ID_MISMATCH', status: 'FAIL', detail: 'bundle id ' + idMatch[1] + ' != package name ' + name })
      }
      const requires = [...record.text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
        .map((match) => match[1])
        .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('/'))
      const declared = new Set(Array.isArray(dsh?.client?.external) ? dsh.client.external : [])
      const baseline = new Set(['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', '@deepseek-ai/cordis', 'zod'])
      for (const specifier of new Set(requires)) {
        if (baseline.has(specifier) || declared.has(specifier)) continue
        if (name !== null && (specifier === name || specifier.startsWith(name + '/'))) continue
        push({
          id: 'DIST_CLIENT_UNDECLARED_REQUIRE',
          status: 'FAIL',
          detail: 'client bundle requires "' + specifier + '" but dsh.client.external does not declare it',
          file: target,
        })
      }
    }
  }
  const filesField = pkg && Array.isArray(pkg.files) ? pkg.files.map(normalize) : null
  const covered = (target) => {
    if (filesField === null) return true
    return filesField.some((entry) => entry === target || target.startsWith(entry.replace(/\/+$/, '') + '/'))
  }
  for (const [label, target] of [['host entry', mainTarget], ['client bundle', clientTarget]]) {
    if (target !== null && !covered(normalize(target))) {
      push({ id: 'DIST_FILES_FIELD_MISSING_' + label.toUpperCase().replace(/\s+/g, '_'), status: 'FAIL', detail: 'package.json.files does not publish the ' + label + ': ' + target })
    }
  }
  if (pkg && typeof pkg.icon === 'string' && !paths.has(normalize(pkg.icon))) {
    push({ id: 'DIST_ICON_MISSING', status: 'FAIL', detail: 'declared icon not present: ' + pkg.icon })
  }

  // assets/worker/sidecar references must resolve inside the package
  const assetRefs = new Set()
  for (const file of files) {
    if (typeof file.text !== 'string') continue
    const base = new URL('file:///' + file.path.split('\\').join('/'))
    for (const match of file.text.matchAll(/new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
      assetRefs.add(decodeURIComponent(new URL(match[1], base).pathname).replace(/^\/+/, ''))
    }
    for (const match of file.text.matchAll(/(?:require|readFileSync|readFile)\s*\(\s*(?:join\s*\(\s*__dirname\s*,\s*)?['"]([^'"]+\.(?:json|wasm|node|bin|html|svg|png))['"]/g)) {
      assetRefs.add(normalize(match[1]))
    }
  }
  for (const ref of assetRefs) {
    if (ref.startsWith('..')) continue
    if (!paths.has(ref) && !paths.has('package/' + ref)) {
      push({ id: 'DIST_ASSET_MISSING', status: 'FAIL', detail: 'referenced asset/worker is not in the package: ' + ref })
    }
  }

  // ---- portability ------------------------------------------------------
  const portability = []
  const pushPort = (finding) => {
    portability.push({ ruleVersion: 'distribution-1', ...finding })
    findings.push({ ruleVersion: 'distribution-1', ...finding })
  }
  const authorPath = /(?:[A-Za-z]:\\[^'"\r\n]{3,}|[A-Za-z]:\/[^'"\r\n]{3,}|\/Users\/[^/\s'"]+\/|\/home\/[^/\s'"]+\/)/
  for (const file of files) {
    const normalized = file.path.split('\\').join('/')
    if (typeof file.text !== 'string') continue
    if (!TEXT.test(normalized)) continue
    const isDoc = DOC_PATH.test(normalized)
    const text = file.text
    if (authorPath.test(text)) {
      pushPort({
        id: 'DIST_AUTHOR_ABSOLUTE_PATH',
        status: isDoc ? 'WARN' : 'FAIL',
        detail: 'absolute author-machine path found' + (isDoc ? ' in documentation/source map (review before publishing)' : ' in runtime code'),
        file: normalized,
      })
    }
    if (!isDoc && /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\b/.test(text)) {
      pushPort({ id: 'DIST_LOCAL_SERVICE', status: 'FAIL', detail: 'hard-coded local service address in runtime code', file: normalized })
    }
    if (/\bhttps?:\/\/[^\s'"]*\b(?:localhost|127\.0\.0\.1)\b/.test(text) && !isDoc) {
      pushPort({ id: 'DIST_LOCAL_SERVICE', status: 'FAIL', detail: 'hard-coded local URL in runtime code', file: normalized })
    }
    if (/(?:^|\n)\s*registry\s*=/.test(text) && /_authToken|npmAuthToken/.test(text)) {
      pushPort({ id: 'DIST_PRIVATE_REGISTRY_CREDENTIAL', status: 'FAIL', detail: 'registry credential material found', file: normalized })
    }
    if (/\b(?:ghp_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})\b/.test(text)) {
      pushPort({ id: 'DIST_SECRET_MATERIAL', status: 'FAIL', detail: 'token-like secret found', file: normalized })
    }
    if (/dsh-plugin-design/.test(text) && !isDoc && !normalized.startsWith('package.json')) {
      pushPort({
        id: 'DIST_MAINTENANCE_DEPENDENCY',
        status: 'FAIL',
        detail: 'runtime code references dsh-plugin-design; the distributed plugin must not depend on the maintenance plugin',
        file: normalized,
      })
    }
  }
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const values = pkg && pkg[section] && typeof pkg[section] === 'object' ? pkg[section] : {}
    for (const [dep, spec] of Object.entries(values)) {
      if (dep === 'dsh-plugin-design') {
        pushPort({ id: 'DIST_MAINTENANCE_DEPENDENCY', status: 'FAIL', detail: 'package depends on dsh-plugin-design in ' + section })
      }
      if (typeof spec === 'string' && /^(?:file:|link:|workspace:)/.test(spec)) {
        pushPort({ id: 'DIST_LOCAL_DEPENDENCY_SPEC', status: 'FAIL', detail: dep + ' uses a local spec (' + spec + ') that another machine cannot resolve' })
      }
    }
  }
  for (const path of paths) {
    if (path === '.dsh-plugin-design' || path.startsWith('.dsh-plugin-design/')) {
      pushPort({ id: 'DIST_MAINTENANCE_STATE_PACKAGED', status: 'FAIL', detail: 'maintenance state directory is inside the package', file: path })
    }
    if (/(^|\/)(?:\.env(?:\.local)?|\.npmrc|\.git-credentials|id_rsa|id_ed25519)$/.test(path)) {
      pushPort({ id: 'DIST_PRIVATE_FILE_PACKAGED', status: 'FAIL', detail: 'private credential/config file is inside the package', file: path })
    }
    if (path.startsWith('node_modules/')) {
      pushPort({ id: 'DIST_NODE_MODULES_PACKAGED', status: 'FAIL', detail: 'node_modules must not be shipped in the package', file: path })
    }
  }

  // ---- dependency closure ----------------------------------------------
  const closure = []
  const pushDep = (finding) => {
    closure.push({ ruleVersion: 'distribution-1', ...finding })
    findings.push({ ruleVersion: 'distribution-1', ...finding })
  }
  const declaredRuntime = new Set([
    ...Object.keys(pkg?.dependencies || {}),
    ...Object.keys(pkg?.peerDependencies || {}),
    ...Object.keys(pkg?.optionalDependencies || {}),
  ])
  const devOnly = new Set(Object.keys(pkg?.devDependencies || {}))
  for (const file of files) {
    const normalized = file.path.split('\\').join('/')
    if (typeof file.text !== 'string') continue
    if (!/\.(?:js|mjs|cjs|ts|tsx|jsx)$/i.test(normalized)) continue
    if (DOC_PATH.test(normalized)) continue
    // Client sources are bundled for the browser (their imports become the
    // bundle's externals, checked above) and build scripts are dev-time tools.
    if (/(^|\/)(src\/client|client)(\/|\.)|^scripts\//.test(normalized)) continue
    const isClient = normalized === normalize(clientTarget || '')
    if (isClient) continue
    for (const specifier of bareImports(file.text)) {
      if (isBuiltin(specifier)) continue
      const dependency = packageNameOfSpecifier(specifier)
      if (name !== null && dependency === name) continue
      if (declaredRuntime.has(dependency)) continue
      if (devOnly.has(dependency)) {
        pushDep({
          id: 'DIST_DEV_ONLY_RUNTIME_DEPENDENCY',
          status: 'FAIL',
          detail: dependency + ' is imported at runtime but only declared in devDependencies',
          file: normalized,
        })
        continue
      }
      pushDep({
        id: 'DIST_UNDECLARED_RUNTIME_DEPENDENCY',
        status: 'FAIL',
        detail: dependency + ' is imported at runtime but not declared in dependencies/peerDependencies',
        file: normalized,
      })
    }
  }

  // ---- documentation ----------------------------------------------------
  const docs = []
  const readme = files.find((file) => /^readme\.md$/i.test(file.path))
  if (readme === undefined || typeof readme.text !== 'string') {
    docs.push({ id: 'DIST_README_MISSING', status: 'FAIL', detail: 'README.md is required for public installation' })
  } else {
    for (const [needle, id, label] of [
      [/install|安装/i, 'DIST_README_NO_INSTALL', 'installation'],
      [/uninstall|remove|卸载/i, 'DIST_README_NO_UNINSTALL', 'uninstall'],
      [/DSH|DeepSeek Harness/i, 'DIST_README_NO_DSH', 'supported DSH version'],
      [/desktop|web|命令行|CLI/i, 'DIST_README_NO_CARRIER', 'Web/Desktop carrier'],
    ]) {
      if (!needle.test(readme.text)) docs.push({ id, status: 'WARN', detail: 'README does not describe ' + label })
    }
  }
  if (!paths.has('LICENSE') && !paths.has('LICENSE.md') && !paths.has('LICENSE.txt')) {
    docs.push({ id: 'DIST_LICENSE_MISSING', status: 'WARN', detail: 'LICENSE file is missing' })
  }
  findings.push(...docs.map((finding) => ({ ruleVersion: 'distribution-1', ...finding })))

  const packageCompleteness = [
    ...findings.filter((finding) => finding.id.startsWith('DIST_HOST')
      || finding.id.startsWith('DIST_CLIENT')
      || finding.id.startsWith('DIST_FILES')
      || finding.id.startsWith('DIST_ICON')
      || finding.id.startsWith('DIST_ASSET')
      || finding.id === 'DIST_NO_PACKAGE_JSON'),
  ]
  const gates = {
    packageCompleteness: gate(statusOf(packageCompleteness), packageCompleteness, {
      hostEntry: mainTarget, clientEntry: clientTarget, clientDeclared, fileCount: files.length,
    }),
    portability: gate(statusOf(portability.filter((finding) => finding.status === 'FAIL')), portability),
    dependencyClosure: gate(statusOf(closure), closure),
    maintenancePrivates: gate(
      statusOf(portability.filter((finding) => /MAINTENANCE|PRIVATE|SECRET|REGISTRY/.test(finding.id))),
      portability.filter((finding) => /MAINTENANCE|PRIVATE|SECRET|REGISTRY/.test(finding.id)),
    ),
    releaseDocumentation: gate(statusOf(docs, ['FAIL']), docs),
  }
  const required = ['packageCompleteness', 'portability', 'dependencyClosure', 'maintenancePrivates']
  const ok = required.every((key) => gates[key].status === 'PASS')
  return {
    schema: DISTRIBUTION_SCHEMA,
    ok,
    package: {
      name,
      version,
      fileCount: files.length,
      bytes: files.reduce((sum, file) => sum + (file.bytes || 0), 0),
      hostEntry: mainTarget,
      clientEntry: clientTarget,
      clientDeclared,
    },
    gates,
    findings,
    coverage: input.coverage || null,
  }
}

/** Audit a directory tree. */
export async function auditPackageDirectory(pluginPath, options = {}) {
  const { model, coverage } = await collectPluginModel(pluginPath, { harnessVersion: options.harnessVersion })
  const files = entriesFromModel(model)
  const audit = auditPackageContents({ pkg: model.pkg, files, coverage })
  // The collector deliberately skips `.dsh-plugin-design`; if the package would
  // publish it anyway, that is a distribution failure, so probe it explicitly.
  const stateDirPath = join(pluginPath, '.dsh-plugin-design')
  const statePresent = existsSync(stateDirPath)
  if (statePresent) {
    const filesField = model.pkg && Array.isArray(model.pkg.files) ? model.pkg.files : null
    const published = filesField === null || filesField.some((entry) => String(entry).replace(/^\.\//, '').startsWith('.dsh-plugin-design'))
    if (published) {
      const finding = {
        ruleVersion: 'distribution-1',
        id: 'DIST_MAINTENANCE_STATE_PACKAGED',
        status: 'FAIL',
        detail: 'maintenance state (.dsh-plugin-design) would be published with this package',
        file: '.dsh-plugin-design',
      }
      audit.findings.push(finding)
      audit.gates.maintenancePrivates = {
        status: 'FAIL',
        findings: [...audit.gates.maintenancePrivates.findings, finding],
      }
      audit.gates.portability = {
        status: 'FAIL',
        findings: [...audit.gates.portability.findings, finding],
      }
      audit.ok = false
    }
  }
  return {
    ...audit,
    source: { kind: 'directory', path: model.pluginPath },
    packageJsonRaw: model.pkgRaw,
    model,
  }
}

/** Audit an extracted/streamed archive (entries from readTarGz, prefix stripped). */
export function auditPackageEntries(entries, options = {}) {
  let pkg = null
  const pkgEntry = entries.find((entry) => entry.path === 'package.json')
  if (pkgEntry !== undefined) {
    try {
      pkg = JSON.parse(pkgEntry.bytes.toString('utf8'))
    } catch (error) {
      pkg = null
    }
  }
  const files = entries.map((entry) => ({
    path: entry.path,
    text: TEXT.test(entry.path) ? entry.bytes.toString('utf8') : null,
    bytes: entry.bytes.length,
  }))
  const audit = auditPackageContents({ pkg, files, coverage: options.coverage || null })
  return { ...audit, source: { kind: 'archive', path: options.archivePath || null } }
}

/** Manifest hash used to pin the exact artifact a report refers to. */
export function fileListHash(files) {
  const normalized = [...files]
    .map((file) => ({ path: file.path, sha256: file.sha256 || (Buffer.isBuffer(file.bytes) ? sha256(file.bytes) : null) }))
    .sort((left, right) => left.path.localeCompare(right.path))
  return sha256(Buffer.from(JSON.stringify(normalized), 'utf8'))
}
