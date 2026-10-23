// dsh-plugin-design — Host half (persistent plugin)
//
// Registers 12 model-facing tools implementing the two-phase workflow:
//   discover -> inspect -> analyze -> design -> approve -> backup -> apply
//   -> verify -> rollback -> status -> report, plus gated manifest migrations.
//
// Design constraints:
//   - Plain ESM module: no bundler and no imports from @deepseek-ai/dsh-*,
//     which are not resolvable from a linked third-party package directory.
//   - Raw ToolDefinition objects (the harness requires output.schema/render);
//     read-only tools opt into parallel dispatch via isConcurrencySafe.
//   - File access goes through ctx.fs + per-call sandbox policy for mutations;
//     read-only discovery/analysis also has a node:fs adapter for the Settings
//     page route, which runs outside any agent workspace.
//   - Approval gates stay process-local (a token cannot be persisted safely);
//     backups and journals are durable on disk under .dsh-plugin-design/.

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename as pathBasename, join as pathJoin, normalize as pathNormalize, relative as pathRelative, resolve as pathResolve } from 'node:path'

import { analyzeModel, countBySeverity, isSourcePath, parseManifestHeuristic, RULESET } from './rules.js'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'out',
  '.dsh-plugin-design', '.next', '.turbo', 'target', 'lib',
])

const STATE_DIR = '.dsh-plugin-design'
const BACKUP_DIR = STATE_DIR + '/backup'
const JOURNAL_FILE = STATE_DIR + '/journal.jsonl'
const MAX_SOURCE_FILES = 400
const MAX_SOURCE_BYTES = 256 * 1024
const MAX_BODY_BYTES = 1024 * 1024
const MAX_SCAN_RESULTS = 500

const TOOL_NAMES = [
  'dshpd_discover', 'dshpd_inspect', 'dshpd_analyze', 'dshpd_ui_check', 'dshpd_design',
  'dshpd_approve', 'dshpd_backup', 'dshpd_apply', 'dshpd_migrate',
  'dshpd_verify', 'dshpd_rollback', 'dshpd_status', 'dshpd_report',
]

const MIGRATION_IDS = [
  'manifest-version', 'engines-dsh', 'bundle-patch', 'client-meta', 'remove-invariants-dep',
]

const PLUGIN = readPluginMeta()

function readPluginMeta() {
  const fallback = { name: 'dsh-plugin-design', version: '0.0.0', engines: null }
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const pkg = JSON.parse(raw)
    return {
      name: typeof pkg.name === 'string' ? pkg.name : fallback.name,
      version: typeof pkg.version === 'string' ? pkg.version : fallback.version,
      engines: pkg.engines && typeof pkg.engines.dsh === 'string' ? pkg.engines.dsh : null,
    }
  } catch (error) {
    return fallback
  }
}

function messageOf(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function hashText(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function hashToken(token) {
  return hashText(String(token)).slice(0, 16)
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = pathNormalize(String(value))
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function pathKey(value) {
  const normalized = pathNormalize(String(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Resolve a package-relative path, rejecting absolute paths and `..` escapes. */
function pathInside(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return null
  const raw = relativePath.trim()
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) return null
  const normalized = pathNormalize(raw)
  const segments = normalized.split(/[\\/]/)
  if (segments.includes('..')) return null
  return pathJoin(root, raw)
}

function shortText(value, max) {
  if (typeof value !== 'string') return value
  return value.length <= max ? value : value.slice(0, max) + '\n…（truncated）'
}

function exportTarget(exportsField, key) {
  if (!isPlainObject(exportsField)) return null
  const entry = exportsField[key]
  if (typeof entry === 'string') return entry
  if (isPlainObject(entry)) {
    return nonEmptyString(entry.default) || nonEmptyString(entry.import) || nonEmptyString(entry.require)
  }
  return null
}

// ---------------------------------------------------------------------------
// I/O adapters
// ---------------------------------------------------------------------------

/**
 * ctx.fs adapter. Reads resolve through the agent-scoped filesystem; failures
 * (outside the sandbox, missing file) become null/false so analysis stays
 * total. Mutations never go through this adapter directly — they call
 * writeText()/editText() with the per-call sandbox policy.
 */
function createFsIo(fsApi) {
  return {
    label: 'ctx.fs',
    async resolvePath(target) {
      const resolved = await fsApi.resolve(target)
      return resolved.displayPath
    },
    async readText(target, max) {
      try {
        const resolved = await fsApi.resolve(target)
        const text = await fsApi.readText(resolved)
        return typeof max === 'number' ? shortText(text, max) : text
      } catch (error) {
        return null
      }
    },
    async listDir(target) {
      try {
        const resolved = await fsApi.resolve(target)
        const entries = await fsApi.listDir(resolved)
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.type,
          path: entry.target && typeof entry.target.displayPath === 'string'
            ? entry.target.displayPath
            : entry.displayPath,
        }))
      } catch (error) {
        return null
      }
    },
    async exists(target) {
      try {
        const resolved = await fsApi.resolve(target)
        return (await fsApi.stat(resolved)) !== undefined
      } catch (error) {
        return false
      }
    },
    async stat(target) {
      try {
        const resolved = await fsApi.resolve(target)
        return await fsApi.stat(resolved)
      } catch (error) {
        return undefined
      }
    },
  }
}

/** node:fs adapter for the Settings-page routes (read-only, outside workspaces). */
function createNodeIo() {
  return {
    label: 'node:fs',
    async resolvePath(target) {
      return pathResolve(target)
    },
    async readText(target, max) {
      try {
        const info = statSync(target)
        if (!info.isFile()) return null
        const text = readFileSync(target, 'utf8')
        return typeof max === 'number' ? shortText(text, max) : text
      } catch (error) {
        return null
      }
    },
    async listDir(target) {
      try {
        return readdirSync(target, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          path: pathJoin(target, entry.name),
        }))
      } catch (error) {
        return null
      }
    },
    async exists(target) {
      try {
        statSync(target)
        return true
      } catch (error) {
        return false
      }
    },
    async stat(target) {
      try {
        const info = statSync(target)
        return {
          type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          size: info.size,
          mtimeMs: info.mtimeMs,
        }
      } catch (error) {
        return undefined
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Model collection
// ---------------------------------------------------------------------------

async function collectSources(io, root) {
  const files = []
  const visited = new Set()
  async function walk(directory, depth) {
    if (depth > 5 || files.length >= MAX_SOURCE_FILES) return
    if (visited.has(directory)) return
    visited.add(directory)
    const entries = await io.listDir(directory)
    if (entries === null) return
    for (const entry of entries) {
      if (files.length >= MAX_SOURCE_FILES) return
      if (entry.type === 'directory') {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(entry.path, depth + 1)
        continue
      }
      if (!isSourcePath(entry.name)) continue
      const content = await io.readText(entry.path, MAX_SOURCE_BYTES)
      if (content !== null) files.push({ path: entry.path, relative: pathRelative(root, entry.path), content })
    }
  }
  await walk(root, 0)
  return files
}

async function mtimeOf(io, target) {
  try {
    const info = await io.stat(target)
    if (info && typeof info.mtimeMs === 'number') return info.mtimeMs
  } catch (error) {
    // fall through to the local filesystem probe
  }
  try {
    return statSync(target).mtimeMs
  } catch (error) {
    return undefined
  }
}

async function collectModel(io, pluginPath, harnessVersion) {
  const base = await io.resolvePath(pluginPath)
  const topLevel = (await io.listDir(base)) || []
  const manifestRaw = await io.readText(pathJoin(base, 'dsh.plugin.yaml'))
  const pkgRaw = await io.readText(pathJoin(base, 'package.json'))
  const cordisPatchRaw = await io.readText(pathJoin(base, 'cordis.patch.yml'))
  let pkg = null
  let pkgError = null
  if (pkgRaw !== null) {
    try {
      pkg = JSON.parse(pkgRaw)
    } catch (error) {
      pkgError = messageOf(error)
    }
  }

  const bundlePatches = []
  const declaredPatch = isPlainObject(pkg) && isPlainObject(pkg.dsh) && isPlainObject(pkg.dsh.bundle)
    ? pkg.dsh.bundle.patch
    : null
  const patchList = typeof declaredPatch === 'string'
    ? [declaredPatch]
    : Array.isArray(declaredPatch)
      ? declaredPatch.filter((item) => typeof item === 'string')
      : []
  for (const relativePath of patchList) {
    const target = pathInside(base, relativePath)
    if (target === null) {
      bundlePatches.push({ path: relativePath, unsafe: true, exists: false, raw: null })
      continue
    }
    const raw = await io.readText(target, MAX_SOURCE_BYTES)
    bundlePatches.push({ path: relativePath, unsafe: false, exists: raw !== null, raw })
  }

  const exportsField = isPlainObject(pkg) && isPlainObject(pkg.exports) ? pkg.exports : null
  const clientTarget = exportTarget(exportsField, './client')
  const clientBundlePath = clientTarget === null ? null : pathInside(base, clientTarget)
  const defaultClientBundlePath = pathJoin(base, 'lib', 'client.js')
  const clientBundleRaw = clientBundlePath === null ? null : await io.readText(clientBundlePath, MAX_SOURCE_BYTES)
  const defaultClientBundleRaw = await io.readText(defaultClientBundlePath, MAX_SOURCE_BYTES)

  let iconExists
  let iconBytes
  let iconExt = null
  if (isPlainObject(pkg) && typeof pkg.icon === 'string' && pkg.icon.trim() !== '') {
    const iconPath = pathInside(base, pkg.icon)
    if (iconPath !== null) {
      const info = await io.stat(iconPath)
      iconExists = info !== undefined
      iconBytes = info && typeof info.size === 'number' ? info.size : undefined
      const match = /\.([A-Za-z0-9]+)$/.exec(pkg.icon.trim())
      iconExt = match === null ? null : match[1].toLowerCase()
    } else {
      iconExists = false
    }
  }

  const sourceFiles = await collectSources(io, base)
  const clientSourceFiles = sourceFiles.filter((file) => {
    const normalized = file.path.split('\\').join('/')
    return /(^|\/)src\/client\//.test(normalized)
      || /(^|\/)client\//.test(normalized)
      || /(^|\/)client\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(normalized)
  })
  let clientSourceMtimeMax
  for (const file of clientSourceFiles) {
    const modified = await mtimeOf(io, file.path)
    if (typeof modified === 'number' && (clientSourceMtimeMax === undefined || modified > clientSourceMtimeMax)) {
      clientSourceMtimeMax = modified
    }
  }
  const clientBundleMtime = await mtimeOf(io, clientBundlePath === null ? defaultClientBundlePath : clientBundlePath)
  const hasTests = topLevel.some((entry) => entry.type === 'directory' && /^(?:tests?|__tests__)$/.test(entry.name))
    || (isPlainObject(pkg) && isPlainObject(pkg.scripts) && typeof pkg.scripts.test === 'string')
  const names = new Set(topLevel.map((entry) => entry.name.toLowerCase()))
  const hasReadme = [...names].some((name) => name.startsWith('readme'))
  const hasLicense = [...names].some((name) => name.startsWith('license') || name.startsWith('licence'))

  return {
    pluginPath: base,
    topLevel: topLevel.map((entry) => ({ name: entry.name, type: entry.type })),
    manifestRaw,
    pkgRaw,
    pkg,
    pkgError,
    cordisPatchRaw,
    bundlePatches,
    clientBundleExists: clientBundleRaw !== null,
    clientBundleRaw,
    clientBundlePath,
    defaultClientBundleExists: defaultClientBundleRaw !== null,
    defaultClientBundlePath,
    clientSourceFiles,
    clientSourceMtimeMax,
    clientBundleMtime,
    iconExists,
    iconBytes,
    iconExt,
    sourceFiles,
    hasTests,
    hasReadme,
    hasLicense,
    harnessVersion: nonEmptyString(harnessVersion),
  }
}

async function analyzePath(io, pluginPath, harnessVersion) {
  const model = await collectModel(io, pluginPath, harnessVersion)
  const result = analyzeModel(model)
  return { model, result }
}

function analysisSummary(result) {
  const counts = countBySeverity(result.issues)
  return {
    issueCount: result.issues.length,
    counts,
    blockers: counts.BLOCKER,
    criticals: counts.CRITICAL,
    overall: result.overall,
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function discoverPlugins(io, rootPath, maxDepth) {
  const results = []
  const visited = new Set()
  const root = await io.resolvePath(rootPath)

  async function walk(directory, depth) {
    if (depth > maxDepth || results.length >= MAX_SCAN_RESULTS) return
    if (visited.has(directory)) return
    visited.add(directory)
    const entries = await io.listDir(directory)
    if (entries === null) return

    let hasManifest = false
    let hasPkg = false
    let hasPatch = false
    const subdirs = []
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.type === 'directory') subdirs.push(entry.path)
      else if (entry.name === 'dsh.plugin.yaml') hasManifest = true
      else if (entry.name === 'package.json') hasPkg = true
      else if (entry.name === 'cordis.patch.yml') hasPatch = true
    }

    if (hasPkg) {
      const pkgRaw = await io.readText(pathJoin(directory, 'package.json'), MAX_SOURCE_BYTES)
      if (pkgRaw !== null && isDshSelfManifest(pkgRaw)) return
      const pkg = safeParseJson(pkgRaw)
      if (pkg !== null) {
        results.push({
          path: directory,
          name: pathBasename(directory),
          hasManifest,
          hasPackageJson: true,
          hasCordisPatch: hasPatch,
          depth,
          packageName: nonEmptyString(pkg.name),
          version: nonEmptyString(pkg.version),
          bundle: isPlainObject(pkg.dsh) && isPlainObject(pkg.dsh.bundle),
          client: isPlainObject(pkg.dsh) && isPlainObject(pkg.dsh.client),
          enginesDsh: isPlainObject(pkg.engines) && typeof pkg.engines.dsh === 'string' ? pkg.engines.dsh : null,
        })
      }
    } else if (hasManifest) {
      results.push({
        path: directory,
        name: pathBasename(directory),
        hasManifest: true,
        hasPackageJson: false,
        hasCordisPatch: hasPatch,
        depth,
        packageName: null,
        version: null,
        bundle: false,
        client: false,
        enginesDsh: null,
      })
    }

    for (const subdir of subdirs) await walk(subdir, depth + 1)
  }

  await walk(root, 0)
  return { root, results }
}

function safeParseJson(raw) {
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch (error) {
    return null
  }
}

function isDshSelfManifest(pkgRaw) {
  const pkg = safeParseJson(pkgRaw)
  if (pkg !== null) {
    if (typeof pkg.name === 'string' && (pkg.name === '@deepseek-ai/dsh' || pkg.name.startsWith('@deepseek-ai/dsh-'))) return true
    if (isPlainObject(pkg._npx) && Array.isArray(pkg._npx.packages) && pkg._npx.packages.includes('@deepseek-ai/dsh')) return true
  }
  return /"_npx"\s*:\s*\{[^}]*"packages"\s*:\s*\[[^\]]*@deepseek-ai\/dsh/.test(pkgRaw)
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default {
  name: 'dsh-plugin-design',
  inject: ['tools'],

  apply(ctx) {
    const tasks = new Map()

    // ---- per-agent services --------------------------------------------
    // `fs` and `sandboxPolicy` are agent-plane services: a host-composition
    // plugin cannot hard-inject them (it would wait forever). Resolve them
    // from the calling agent's context at execution time, with the plugin
    // context as a fallback for deployments that do mount them globally.
    function agentContext(exec) {
      return exec && exec.agent && exec.agent.ctx ? exec.agent.ctx : null
    }

    function serviceFor(exec, name) {
      const scoped = agentContext(exec)
      if (scoped && typeof scoped.get === 'function') {
        const value = scoped.get(name)
        if (value !== undefined) return value
      }
      if (typeof ctx.get === 'function') return ctx.get(name)
      return undefined
    }

    function fsFor(exec) {
      const service = serviceFor(exec, 'fs')
      return service && typeof service.resolve === 'function' ? service : null
    }

    function requireFs(exec) {
      const service = fsFor(exec)
      if (service === null) {
        throw new Error('no fs service in this call context: invoke dshpd_* from an agent session (fs is an agent-plane service in 0.2.x)')
      }
      return service
    }

    function ioFor(exec) {
      return createFsIo(requireFs(exec))
    }

    function resolveSandboxPolicy(exec) {
      const policyService = serviceFor(exec, 'sandboxPolicy')
      if (!policyService || typeof policyService.resolve !== 'function') return undefined
      try {
        const session = exec && exec.agent ? exec.agent.session : undefined
        return policyService.resolve(session ? { session } : undefined)
      } catch (error) {
        return undefined
      }
    }

    async function writeText(targetPath, content, exec) {
      const service = requireFs(exec)
      const policy = resolveSandboxPolicy(exec)
      const options = {}
      if (policy && policy.workspaceRoot) options.cwd = policy.workspaceRoot
      if (exec && exec.signal) options.signal = exec.signal
      const target = await service.resolve(targetPath, Object.keys(options).length > 0 ? options : undefined)
      return service.writeText(target, content, undefined, exec && exec.signal, policy)
    }

    async function tryReadText(targetPath, exec) {
      try {
        const service = requireFs(exec)
        const target = await service.resolve(targetPath)
        return await service.readText(target)
      } catch (error) {
        return null
      }
    }

    function renderText(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    }

    // ---- raw tool registration -----------------------------------------
    function reg(name, description, properties, required, execute, options) {
      const parameters = { type: 'object', properties, additionalProperties: false }
      if (required && required.length > 0) parameters.required = required
      const definition = {
        name,
        description,
        parameters,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: renderText,
        },
        async execute(args, exec) {
          try {
            return await execute(args || {}, exec)
          } catch (error) {
            return { error: messageOf(error) }
          }
        },
      }
      if (options && options.concurrencySafe === true) {
        definition.isConcurrencySafe = () => true
      }
      ctx.tools.register(definition)
    }

    // ---- task state + durable journal -----------------------------------
    function taskByToken(token) {
      return token ? tasks.get(token) : undefined
    }

    function backupPath(pluginPath, backupId) {
      return pathJoin(pluginPath, BACKUP_DIR, backupId)
    }

    async function ensureStateDir(pluginPath, exec) {
      await writeText(pathJoin(pluginPath, STATE_DIR, '.keep'), '', exec)
    }

    async function appendJournal(pluginPath, entry, exec) {
      const journalPath = pathJoin(pluginPath, JOURNAL_FILE)
      const existing = (await tryReadText(journalPath, exec)) || ''
      const lines = existing.split('\n').filter((line) => line.trim() !== '')
      lines.push(JSON.stringify(entry))
      const kept = lines.slice(-500).join('\n') + '\n'
      await ensureStateDir(pluginPath, exec)
      await writeText(journalPath, kept, exec)
    }

    async function readJournal(pluginPath, limit, exec) {
      const raw = await tryReadText(pathJoin(pluginPath, JOURNAL_FILE), exec)
      if (raw === null) return []
      return raw.split('\n')
        .filter((line) => line.trim() !== '')
        .slice(-(limit || 200))
        .map((line) => safeParseJson(line))
        .filter((entry) => entry !== null)
    }

    async function readBackupManifest(pluginPath, backupId, exec) {
      const raw = await tryReadText(pathJoin(backupPath(pluginPath, backupId), 'manifest.json'), exec)
      return safeParseJson(raw)
    }

    async function listBackups(pluginPath, exec) {
      const directory = pathJoin(pluginPath, BACKUP_DIR)
      let entries = []
      try {
        const service = requireFs(exec)
        const target = await service.resolve(directory)
        entries = await service.listDir(target)
      } catch (error) {
        return []
      }
      const backups = []
      for (const entry of entries) {
        if (entry.type !== 'directory') continue
        const manifest = await readBackupManifest(pluginPath, entry.name, exec)
        if (manifest === null) continue
        backups.push({
          backupId: entry.name,
          createdAt: manifest.createdAt || null,
          designPath: manifest.designPath || null,
          fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
          analysis: manifest.analysis || null,
        })
      }
      return backups.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    }

    async function requireTask(args) {
      const task = taskByToken(args.approvalToken)
      if (!task) return { error: 'DENIED: invalid or missing approvalToken (approval gates are process-local; call dshpd_approve in this process)' }
      if (task.pluginPath && args.pluginPath && !samePath(task.pluginPath, args.pluginPath)) {
        return { error: 'DENIED: pluginPath does not match the approved task' }
      }
      return { task }
    }

    function backedUpRecord(task, filePath) {
      return (task.files || []).find((record) => samePath(record.path, filePath) || samePath(record.resolved, filePath))
    }

    // ---- runtime client-module status -----------------------------------
    // Answers the question static analysis cannot: is this package's browser
    // half actually in the running client graph, and will the page load it?
    function uiStatus(packageName) {
      if (typeof packageName !== 'string' || packageName.trim() === '') {
        return { available: false, reason: 'package name unknown' }
      }
      const clientModules = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
      if (!clientModules) {
        return { available: false, reason: 'clientModules service is not visible from this context' }
      }
      let graph = null
      try {
        graph = typeof clientModules.graph === 'function' ? clientModules.graph() : null
      } catch (error) {
        return { available: false, reason: messageOf(error) }
      }
      const entry = graph && Array.isArray(graph.entries)
        ? graph.entries.find((item) => item && item.id === packageName) || null
        : null
      let record = null
      try {
        if (clientModules.table && typeof clientModules.table.get === 'function') record = clientModules.table.get(packageName)
      } catch (error) {
        record = null
      }
      let clientPath = null
      try {
        clientPath = typeof clientModules.clientPath === 'function' ? clientModules.clientPath(packageName) : null
      } catch (error) {
        clientPath = null
      }
      if (clientPath === null && record && record.meta) clientPath = record.meta.clientPath || null
      let bundleExists = false
      if (typeof clientPath === 'string') {
        try { bundleExists = statSync(clientPath).isFile() } catch (error) { bundleExists = false }
      }
      return {
        available: true,
        packageName,
        inGraph: entry !== null,
        rev: entry && typeof entry.rev === 'string' ? entry.rev : null,
        clientPath,
        bundleExists,
        inject: record && record.meta && Array.isArray(record.meta.inject) ? record.meta.inject : [],
        external: record && record.meta && Array.isArray(record.meta.external) ? record.meta.external : [],
        immediately: record && record.meta ? record.meta.immediately === true : false,
        graphRev: graph && typeof graph.rev === 'string' ? graph.rev : null,
      }
    }

    // ---- tools ----------------------------------------------------------

    reg('dshpd_discover',
      'Discover third-party DSH plugin projects under a directory. Recursively scans for package.json or dsh.plugin.yaml (skips node_modules/.git/dist/build/lib), excludes DSH\'s own install directory, and reports each candidate\'s official roles (bundle / client / engines.dsh). Read-only. Start here in the dsh-plugin-design workflow.',
      {
        root: { type: 'string', description: 'Scan root. Defaults to the session workspace root.' },
        maxDepth: { type: 'integer', description: 'Max recursion depth (default 5, max 12).' },
      },
      [],
      async (args, exec) => {
        const policy = resolveSandboxPolicy(exec)
        const rootPath = nonEmptyString(args.root)
          || (policy && policy.workspaceRoot ? policy.workspaceRoot : null)
          || process.cwd()
        const depth = args.maxDepth === undefined ? 5 : Math.max(0, Math.min(12, Number(args.maxDepth) || 0))
        const { root, results } = await discoverPlugins(ioFor(exec), rootPath, depth)
        return { root, count: results.length, plugins: results }
      },
      { concurrencySafe: true })

    reg('dshpd_inspect',
      'Inspect one plugin project: official package.json.dsh roles, bundle patch files, client export/bundle facts, package scripts, top-level layout, source file list, and the optional DH-TP-SDK manifest (raw + heuristic parse). Read-only facts; missing values are null/false, never invented.',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory.' },
        maxBytes: { type: 'integer', description: 'Max bytes per raw file in the response (default 20000).' },
      },
      ['pluginPath'],
      async (args, exec) => {
        const maxBytes = args.maxBytes === undefined ? 20000 : Math.max(1000, Number(args.maxBytes) || 20000)
        const model = await collectModel(ioFor(exec), args.pluginPath)
        return {
          pluginPath: model.pluginPath,
          name: pathBasename(model.pluginPath),
          hasManifest: model.manifestRaw !== null,
          manifestRaw: shortText(model.manifestRaw, maxBytes),
          manifestParsed: model.manifestRaw === null ? null : parseManifestHeuristic(model.manifestRaw),
          hasPackageJson: model.pkgRaw !== null,
          packageJson: model.pkg,
          packageJsonError: model.pkgError,
          hasCordisPatch: model.cordisPatchRaw !== null,
          cordisPatchRaw: shortText(model.cordisPatchRaw, maxBytes),
          bundlePatches: model.bundlePatches.map((entry) => ({
            path: entry.path, exists: entry.exists, unsafe: entry.unsafe === true, bytes: entry.raw === null ? 0 : entry.raw.length,
          })),
          client: {
            bundleExists: model.clientBundleExists,
            bundleBytes: model.clientBundleRaw === null ? 0 : model.clientBundleRaw.length,
            sourceFiles: model.clientSourceFiles.map((file) => file.path),
          },
          topLevel: model.topLevel,
          sourceFiles: model.sourceFiles.map((file) => file.path),
          hasTests: model.hasTests,
          note: 'git status/commits require a shell and are NOT_VERIFIED here; manifestParsed is an indentation-aware heuristic probe, not a full YAML parser.',
        }
      },
      { concurrencySafe: true })

    reg('dshpd_analyze',
      'Run the deterministic heuristic compliance scan against the official DSH 0.2.x plugin contract plus the optional DH-TP-SDK manifest. Returns issues (id/severity/category/title/detail/file), an official-contract summary, actionable migrations, per-dimension scores, and a verdict. Heuristic scan, NOT authoritative certification.',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory.' },
        harnessVersion: { type: 'string', description: 'Optional running DSH version (e.g. 0.2.1-rc.2) to check engines.dsh satisfaction.' },
      },
      ['pluginPath'],
      async (args, exec) => {
        const harnessVersion = nonEmptyString(args.harnessVersion) || nonEmptyString(process.env.DSH_VERSION)
        const { model, result } = await analyzePath(ioFor(exec), args.pluginPath, harnessVersion)
        const summary = analysisSummary(result)
        return {
          pluginPath: model.pluginPath,
          pluginName: isPlainObject(model.pkg) ? model.pkg.name || null : null,
          ui: isPlainObject(model.pkg) && typeof model.pkg.name === 'string' ? uiStatus(model.pkg.name) : null,
          ruleset: RULESET,
          runtimeVersion: harnessVersion,
          official: result.official,
          issueCount: result.issues.length,
          counts: summary.counts,
          blockers: summary.blockers,
          criticals: summary.criticals,
          scores: result.scores,
          overall: result.overall,
          issues: result.issues.slice(0, 300),
          issuesTruncated: result.issues.length > 300,
          migrations: result.migrations,
          verdictRule: 'overall = BLOCKED（任意 BLOCKER）｜NEEDS_REVIEW（任意 CRITICAL）｜READY_TO_MODIFY（其余）。HIGH/MEDIUM/LOW/INFO 只扣维度分。',
          knownLimitations: [
            'manifest 字段由「缩进感知」的行级启发式解析，非完整 YAML 解析（无 anchor/多行折叠标量/flow map 处理）',
            'waterfall next() 检查仅针对「确实注册了 waterfall 事件监听」的源码文件，且排除 tests/spec 文件',
            'client 共享模块检查是 import 语句级启发式，type-only import 只能按行排除',
            '静态扫描为启发式规则，非权威认证',
          ],
          note: 'heuristic static scan; not authoritative, not a DeepSeek official certification.',
        }
      },
      { concurrencySafe: true })

    reg('dshpd_ui_check',
      'Check whether a plugin browser half is actually registered in the RUNNING client module graph, and combine that with static UI diagnostics: client bundle presence/freshness, factory apply/inject, known slot registrations, and client fetch routes missing from host source. Read-only; use this when a plugin had UI before a DSH upgrade but the Settings page or overlay no longer appears.',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory (used to read package.json and run static checks).' },
        packageName: { type: 'string', description: 'Optional package name when only the runtime graph entry matters.' },
        harnessVersion: { type: 'string', description: 'Optional running DSH version for engines.dsh evaluation.' },
      },
      [],
      async (args, exec) => {
        let packageName = nonEmptyString(args.packageName)
        let model = null
        let result = null
        if (nonEmptyString(args.pluginPath) !== null) {
          const harnessVersion = nonEmptyString(args.harnessVersion) || nonEmptyString(process.env.DSH_VERSION)
          const scanned = await analyzePath(ioFor(exec), args.pluginPath, harnessVersion)
          model = scanned.model
          result = scanned.result
          if (packageName === null && isPlainObject(model.pkg)) packageName = nonEmptyString(model.pkg.name)
        }
        if (packageName === null) return { error: 'packageName unknown: pass pluginPath or packageName' }
        const runtime = uiStatus(packageName)
        const uiIssues = result === null
          ? []
          : result.issues.filter((issue) => issue.category === 'client' || issue.id === 'WEBSERVER_NOT_INJECTED' || issue.id === 'HOST_FS_HARD_INJECT').slice(0, 50)
        return {
          packageName,
          runtime,
          clientDeclared: result === null ? null : result.official.client.declared,
          buildStale: result === null ? null : result.official.client.buildStale,
          applyPresent: result === null ? null : result.official.client.applyPresent,
          injectPresent: result === null ? null : result.official.client.injectPresent,
          uiSlots: result === null ? [] : result.official.client.uiSlots,
          issues: uiIssues,
          howToUse: [
            'runtime.inGraph=false：检查 row 是否为裸包名、package.json.dsh.client、exports["./client"]、lib/client.js 是否存在，然后重启/刷新页面。',
            'buildStale=true：先重新构建 client bundle（如 npm run build:client），再刷新页面；否则页面加载的仍是旧 UI。',
            'issues 里的 CLIENT_ROUTE_MISSING / WEBSERVER_NOT_INJECTED 会让设置页 fetch 落到 SPA fallback，表现为 JSON 解析错误或页面空白。',
          ],
        }
      },
      { concurrencySafe: true })

    reg('dshpd_design',
      'Generate a design.md draft for adapting a plugin: official-contract summary, findings by severity, actionable migration IDs, and a two-phase modification plan skeleton. Writes to <pluginPath>/.dsh-plugin-design/design.md and never overwrites unless mode=overwrite (mode=version writes design.vN.md). This tool never edits plugin sources.',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory.' },
        mode: { type: 'string', enum: ['create', 'version', 'overwrite'], description: 'create (default, refuse if exists) | version (write next design.vN.md) | overwrite.' },
        harnessVersion: { type: 'string', description: 'Optional running DSH version for engines.dsh evaluation.' },
      },
      ['pluginPath'],
      async (args, exec) => {
        const service = requireFs(exec)
        const directory = pathJoin(args.pluginPath, STATE_DIR)
        const existing = await (async () => {
          try { return await service.stat(await service.resolve(directory)) } catch (error) { return undefined }
        })()
        if (existing === undefined) await writeText(pathJoin(directory, '.keep'), '', exec)

        const mode = args.mode || 'create'
        let designName = 'design.md'
        if (mode === 'version') {
          let index = 2
          while ((await tryReadText(pathJoin(directory, 'design.v' + index + '.md'), exec)) !== null) index += 1
          designName = 'design.v' + index + '.md'
        } else if (mode !== 'overwrite') {
          const current = await tryReadText(pathJoin(directory, 'design.md'), exec)
          if (current !== null) return { wrote: false, designPath: pathJoin(directory, 'design.md'), reason: 'design.md already exists; use mode=version or mode=overwrite' }
        }

        const harnessVersion = nonEmptyString(args.harnessVersion) || nonEmptyString(process.env.DSH_VERSION)
        const { result } = await analyzePath(ioFor(exec), args.pluginPath, harnessVersion)
        const template = buildDesignTemplate(args.pluginPath, result)
        await writeText(pathJoin(directory, designName), template, exec)
        return {
          wrote: true,
          designPath: pathJoin(directory, designName),
          mode,
          issueCount: result.issues.length,
          overall: result.overall,
          migrations: result.migrations.map((migration) => migration.id),
        }
      })

    reg('dshpd_approve',
      'Open the approval gate for a design. Returns an approvalToken bound to (pluginPath, designPath) and records the task as APPROVED. IMPORTANT: obtain the user\'s explicit consent (for example via ask_user_question) BEFORE calling this tool. dshpd_backup/apply/migrate require this token.',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory.' },
        designPath: { type: 'string', description: 'Absolute path to the design.md the user approved.' },
      },
      ['pluginPath', 'designPath'],
      async (args) => {
        const token = randomUUID()
        tasks.set(token, {
          token,
          pluginPath: args.pluginPath,
          designPath: args.designPath,
          state: 'APPROVED',
          backupId: null,
          journal: [],
          fileHashes: new Map(),
          createdAt: new Date().toISOString(),
        })
        return {
          approvalToken: token,
          pluginPath: args.pluginPath,
          designPath: args.designPath,
          state: 'APPROVED',
          note: 'Gate open. Call dshpd_backup with every file the design will touch BEFORE any mutation.',
        }
      })

    reg('dshpd_backup',
      'Snapshot the exact files listed for modification into <pluginPath>/.dsh-plugin-design/backup/<backupId>/ with a manifest (hashes + analysis summary). Requires a valid approvalToken. Returns backupId used by dshpd_apply/migrate/rollback/report/verify. Backups survive process restarts.',
      {
        approvalToken: { type: 'string', description: 'Token from dshpd_approve.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files the design plans to modify.' },
      },
      ['approvalToken', 'files'],
      async (args, exec) => {
        const checked = await requireTask(args)
        if (checked.error) return checked
        const task = checked.task
        if (!Array.isArray(args.files) || args.files.length === 0) return { error: 'files must be a non-empty array of absolute paths' }

        const backupId = randomUUID()
        const records = []
        const failures = []
        for (let index = 0; index < args.files.length; index += 1) {
          const filePath = args.files[index]
          try {
            const content = await tryReadText(filePath, exec)
            if (content === null) throw new Error('file not readable (or outside the allowed workspace)')
            const resolved = (await requireFs(exec).resolve(filePath)).displayPath
            const backupName = String(index) + '-' + pathBasename(filePath)
            await writeText(pathJoin(backupPath(task.pluginPath, backupId), backupName), content, exec)
            records.push({
              index,
              path: filePath,
              resolved,
              backupName,
              bytes: Buffer.byteLength(content, 'utf8'),
              sha256: hashText(content),
            })
          } catch (error) {
            failures.push({ path: filePath, error: messageOf(error) })
          }
        }

        let analysis = null
        try {
          const scanned = await analyzePath(ioFor(exec), task.pluginPath, nonEmptyString(process.env.DSH_VERSION))
          analysis = analysisSummary(scanned.result)
        } catch (error) {
          analysis = { error: messageOf(error) }
        }

        const manifest = {
          version: 1,
          backupId,
          pluginPath: task.pluginPath,
          designPath: task.designPath,
          approvalTokenHash: hashToken(args.approvalToken),
          createdAt: new Date().toISOString(),
          files: records,
          failures,
          analysis,
        }
        await ensureStateDir(task.pluginPath, exec)
        await writeText(pathJoin(backupPath(task.pluginPath, backupId), 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', exec)
        await appendJournal(task.pluginPath, {
          version: 1,
          time: new Date().toISOString(),
          pluginPath: task.pluginPath,
          backupId,
          kind: 'backup',
          files: records.map((record) => ({ path: record.path, sha256: record.sha256, bytes: record.bytes })),
          failures: failures.length,
        }, exec)

        task.backupId = backupId
        task.state = 'BACKED_UP'
        task.files = records
        task.fileHashes = new Map(records.map((record) => [pathKey(record.path), record.sha256]))
        return {
          backupId,
          state: task.state,
          backedUp: records.length,
          failed: failures.length,
          files: records,
          failures,
          analysis,
          note: 'Backup manifest and journal are durable under .dsh-plugin-design/.',
        }
      })

    reg('dshpd_apply',
      'Apply ONE literal text replacement to ONE file (atomic via fs.editText), gated by approvalToken + backupId. The file must be in the backed-up set and must still match the snapshot (stale files are refused unless allowStale=true). Supports dryRun to count matches without writing. Records a durable journal entry.',
      {
        approvalToken: { type: 'string', description: 'Token from dshpd_approve.' },
        backupId: { type: 'string', description: 'backupId from dshpd_backup.' },
        filePath: { type: 'string', description: 'Absolute path of the file to edit (must be in the backed-up set).' },
        oldText: { type: 'string', description: 'Literal text to replace (non-empty, exact match).' },
        newText: { type: 'string', description: 'Literal replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace every match instead of requiring exactly one.' },
        dryRun: { type: 'boolean', description: 'Count matches and report without writing.' },
        allowStale: { type: 'boolean', description: 'Allow editing a file that changed after the backup snapshot.' },
      },
      ['approvalToken', 'backupId', 'filePath', 'oldText', 'newText'],
      async (args, exec) => {
        const checked = await requireTask(args)
        if (checked.error) return checked
        const task = checked.task
        if (task.backupId !== args.backupId) return { error: 'DENIED: backupId mismatch' }
        const record = backedUpRecord(task, args.filePath)
        if (!record) return { error: 'DENIED: filePath not in the backed-up file set' }
        if (typeof args.oldText !== 'string' || args.oldText.length === 0) return { error: 'oldText must be a non-empty string' }
        if (typeof args.newText !== 'string') return { error: 'newText must be a string' }

        const current = await tryReadText(args.filePath, exec)
        if (current === null) return { error: 'file not readable (or outside the allowed workspace)' }
        const expectedHash = task.fileHashes && task.fileHashes.get(pathKey(args.filePath))
          ? task.fileHashes.get(pathKey(args.filePath))
          : record.sha256
        if (expectedHash && hashText(current) !== expectedHash && args.allowStale !== true) {
          return { error: 'DENIED: file changed since the backup snapshot or the last applied edit; re-run dshpd_backup or pass allowStale=true after reviewing the diff' }
        }

        const occurrences = current.split(args.oldText).length - 1
        if (occurrences === 0) return { error: 'oldText not found in ' + args.filePath }
        if (occurrences > 1 && args.replaceAll !== true) {
          return { error: 'oldText matched ' + occurrences + ' times; pass replaceAll=true or use a more specific oldText', matches: occurrences }
        }
        if (args.dryRun === true) {
          return { dryRun: true, filePath: args.filePath, matches: occurrences, wouldReplaceAll: args.replaceAll === true, beforeBytes: Buffer.byteLength(current, 'utf8') }
        }

        const policy = resolveSandboxPolicy(exec)
        const service = requireFs(exec)
        const options = {}
        if (policy && policy.workspaceRoot) options.cwd = policy.workspaceRoot
        if (exec && exec.signal) options.signal = exec.signal
        const target = await service.resolve(args.filePath, Object.keys(options).length > 0 ? options : undefined)
        const outcome = await service.editText(
          target,
          { oldString: args.oldText, newString: args.newText, replaceAll: args.replaceAll === true },
          undefined,
          exec && exec.signal,
          policy,
        )
        const after = await tryReadText(args.filePath, exec)
        const afterHash = after === null ? null : hashText(after)
        if (task.fileHashes && afterHash !== null) task.fileHashes.set(pathKey(args.filePath), afterHash)
        const clientSourceEdited = /client/i.test(args.filePath.replace(/\\/g, '/'))
          && /\.(?:js|ts|tsx|jsx|mjs|cjs)$/i.test(args.filePath)
        const entry = {
          version: 1,
          time: new Date().toISOString(),
          pluginPath: task.pluginPath,
          backupId: args.backupId,
          kind: 'apply',
          filePath: args.filePath,
          beforeHash: hashText(current),
          afterHash,
          bytesBefore: Buffer.byteLength(current, 'utf8'),
          bytesAfter: after === null ? null : Buffer.byteLength(after, 'utf8'),
          matches: occurrences,
          replaceAll: args.replaceAll === true,
          rebuildRequired: clientSourceEdited,
        }
        await appendJournal(task.pluginPath, entry, exec)
        task.journal.push(entry)
        task.state = 'APPLIED'
        return {
          applied: true,
          filePath: args.filePath,
          matches: occurrences,
          before: outcome && outcome.before !== undefined ? shortText(outcome.before, 4000) : undefined,
          after: outcome && outcome.after !== undefined ? shortText(outcome.after, 4000) : undefined,
          rebuildRequired: clientSourceEdited,
          note: clientSourceEdited
            ? '改的是 client 源码：必须重新构建 client bundle（如 npm run build:client），否则页面加载的仍是旧 UI；构建后再运行 dshpd_ui_check / dshpd_verify。'
            : undefined,
          journalCount: task.journal.length,
        }
      })

    reg('dshpd_migrate',
      'Apply one or more manifest-only migrations to package.json (never touches source code), gated by approvalToken + backupId. Migrations: manifest-version, engines-dsh, bundle-patch, client-meta, remove-invariants-dep. Each migration checks its precondition and skips with a reason when not applicable. Records a durable journal entry.',
      {
        approvalToken: { type: 'string', description: 'Token from dshpd_approve.' },
        backupId: { type: 'string', description: 'backupId from dshpd_backup (must include package.json).' },
        migrations: { type: 'array', items: { type: 'string', enum: MIGRATION_IDS }, description: 'Migration IDs to apply.' },
        options: {
          type: 'object',
          description: 'Optional values: dshRange (for engines-dsh).',
          properties: { dshRange: { type: 'string' } },
          additionalProperties: false,
        },
      },
      ['approvalToken', 'backupId', 'migrations'],
      async (args, exec) => {
        const checked = await requireTask(args)
        if (checked.error) return checked
        const task = checked.task
        if (task.backupId !== args.backupId) return { error: 'DENIED: backupId mismatch' }
        const packageJsonPath = pathJoin(task.pluginPath, 'package.json')
        const record = backedUpRecord(task, packageJsonPath)
        if (!record) return { error: 'DENIED: package.json is not in the backed-up file set' }
        if (!Array.isArray(args.migrations) || args.migrations.length === 0) return { error: 'migrations must be a non-empty array' }

        const raw = await tryReadText(packageJsonPath, exec)
        if (raw === null) return { error: 'package.json not readable' }
        const expectedHash = task.fileHashes && task.fileHashes.get(pathKey(packageJsonPath))
          ? task.fileHashes.get(pathKey(packageJsonPath))
          : record.sha256
        if (expectedHash && hashText(raw) !== expectedHash) {
          return { error: 'DENIED: package.json changed since the backup snapshot or the last applied edit; re-run dshpd_backup' }
        }
        let pkg
        try {
          pkg = JSON.parse(raw)
        } catch (error) {
          return { error: 'package.json is not valid JSON: ' + messageOf(error) }
        }

        const options = isPlainObject(args.options) ? args.options : {}
        const applied = []
        const skipped = []
        for (const migrationId of args.migrations) {
          if (!MIGRATION_IDS.includes(migrationId)) {
            skipped.push({ id: migrationId, reason: 'unknown migration id' })
            continue
          }
          const outcome = applyManifestMigration(pkg, migrationId, options, task.pluginPath)
          if (outcome.changed) applied.push({ id: migrationId, detail: outcome.detail })
          else skipped.push({ id: migrationId, reason: outcome.detail })
        }

        if (applied.length === 0) {
          return { changed: false, applied, skipped, filePath: packageJsonPath }
        }

        const next = JSON.stringify(pkg, null, 2) + '\n'
        await writeText(packageJsonPath, next, exec)
        if (task.fileHashes) task.fileHashes.set(pathKey(packageJsonPath), hashText(next))
        const entry = {
          version: 1,
          time: new Date().toISOString(),
          pluginPath: task.pluginPath,
          backupId: args.backupId,
          kind: 'migrate',
          filePath: packageJsonPath,
          beforeHash: hashText(raw),
          afterHash: hashText(next),
          migrations: applied.map((item) => item.id),
        }
        await appendJournal(task.pluginPath, entry, exec)
        task.journal.push(entry)
        task.state = 'APPLIED'
        return { changed: true, applied, skipped, filePath: packageJsonPath, backupId: args.backupId }
      })

    reg('dshpd_verify',
      'Verify a modification run: backup manifest integrity, package.json parsing, modified files (no conflict markers), client bundle factory shape, client build freshness / apply-inject exports / known UI slots / runtime client-graph registration, and whether analysis findings worsened versus the pre-modification snapshot. Read-only checks; appends a verify entry to the durable journal.',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory.' },
        backupId: { type: 'string', description: 'Optional backupId; defaults to the latest backup on disk.' },
        harnessVersion: { type: 'string', description: 'Optional running DSH version for engines.dsh evaluation.' },
      },
      ['pluginPath'],
      async (args, exec) => {
        const io = ioFor(exec)
        const base = await io.resolvePath(args.pluginPath)
        let backupId = nonEmptyString(args.backupId)
        if (backupId === null) {
          const latest = await listBackups(base, exec)
          if (latest.length === 0) return { ok: false, error: 'no backup found under ' + pathJoin(base, BACKUP_DIR) }
          backupId = latest[0].backupId
        }
        const manifest = await readBackupManifest(base, backupId, exec)
        const checks = []
        if (manifest === null) {
          checks.push({ id: 'BACKUP_MANIFEST', status: 'FAIL', detail: 'backup manifest not readable' })
          return { ok: false, pluginPath: base, backupId, checks }
        }
        checks.push({ id: 'BACKUP_MANIFEST', status: 'PASS', detail: 'manifest v' + manifest.version + ', ' + (manifest.files || []).length + ' files' })

        for (const fileRecord of manifest.files || []) {
          const content = await tryReadText(fileRecord.path, exec)
          if (content === null) {
            checks.push({ id: 'FILE_PRESENT:' + fileRecord.path, status: 'WARN', detail: 'file missing or unreadable' })
            continue
          }
          if (/^(<{7}|={7}|>{7})/m.test(content)) {
            checks.push({ id: 'CONFLICT_MARKERS:' + fileRecord.path, status: 'FAIL', detail: 'merge conflict markers found' })
          }
        }

        const harnessVersion = nonEmptyString(args.harnessVersion) || nonEmptyString(process.env.DSH_VERSION)
        const scanned = await analyzePath(io, base, harnessVersion)
        const summary = analysisSummary(scanned.result)
        if (scanned.model.pkgRaw !== null) {
          checks.push({
            id: 'PACKAGE_JSON_PARSE',
            status: scanned.model.pkg === null ? 'FAIL' : 'PASS',
            detail: scanned.model.pkg === null ? 'package.json is not valid JSON: ' + String(scanned.model.pkgError) : 'package.json parses',
          })
        }
        const before = isPlainObject(manifest.analysis) ? manifest.analysis : null
        if (before !== null && typeof before.blockers === 'number') {
          const worsened = summary.blockers > before.blockers || summary.criticals > before.criticals
          checks.push({
            id: 'ANALYSIS_REGRESSION',
            status: worsened ? 'WARN' : 'PASS',
            detail: 'before blockers/criticals ' + before.blockers + '/' + before.criticals + ' -> now ' + summary.blockers + '/' + summary.criticals + ' (issues ' + summary.issueCount + ')',
          })
        } else {
          checks.push({ id: 'ANALYSIS_REGRESSION', status: 'SKIP', detail: 'backup has no analysis summary' })
        }

        const official = scanned.result.official
        const ui = isPlainObject(scanned.model.pkg) && typeof scanned.model.pkg.name === 'string'
          ? uiStatus(scanned.model.pkg.name)
          : null
        if (official.client.declared) {
          checks.push({
            id: 'CLIENT_BUNDLE',
            status: official.client.bundlePresent && official.client.factoryForm ? 'PASS' : 'FAIL',
            detail: 'present=' + official.client.bundlePresent + ' factoryForm=' + official.client.factoryForm,
          })
          checks.push({
            id: 'CLIENT_BUILD_FRESH',
            status: official.client.buildStale ? 'FAIL' : 'PASS',
            detail: official.client.buildStale ? 'client 源码比 bundle 新：必须重新构建' : 'bundle 不早于 client 源码',
          })
          checks.push({
            id: 'CLIENT_BUNDLE_EXPORTS',
            status: official.client.applyPresent ? 'PASS' : 'FAIL',
            detail: 'apply=' + official.client.applyPresent + ' inject=' + official.client.injectPresent,
          })
          checks.push({
            id: 'CLIENT_UI_SLOT',
            status: official.client.uiSlots.length > 0 ? 'PASS' : 'WARN',
            detail: official.client.uiSlots.length > 0 ? official.client.uiSlots.join(', ') : '未找到已知 UI 座位',
          })
          if (ui !== null && ui.available === true) {
            checks.push({
              id: 'CLIENT_GRAPH',
              status: ui.inGraph ? 'PASS' : 'WARN',
              detail: ui.inGraph ? '已注册，rev=' + String(ui.rev) : '运行中的 client graph 没有该包：UI 不会出现（可能未挂载/未重启/包名不一致）',
            })
          }
        }

        const journal = await readJournal(base, 500, exec)
        const applied = journal.filter((entry) => entry && entry.backupId === backupId && entry.kind === 'apply')
        const latestApply = new Map()
        for (const entry of applied) {
          if (entry && typeof entry.filePath === 'string') latestApply.set(pathKey(entry.filePath), entry)
        }
        for (const entry of latestApply.values()) {
          const current = await tryReadText(entry.filePath, exec)
          if (current === null || entry.afterHash === null) {
            checks.push({ id: 'APPLIED_FILE:' + entry.filePath, status: 'WARN', detail: 'applied file unreadable' })
            continue
          }
          const unchanged = hashText(current) === entry.afterHash
          checks.push({
            id: 'APPLIED_FILE:' + entry.filePath,
            status: unchanged ? 'PASS' : 'WARN',
            detail: unchanged ? 'still matches the applied revision' : 'changed after dshpd_apply; re-run analysis or the relevant edit',
          })
        }

        const ok = checks.every((check) => check.status !== 'FAIL')
        const entry = {
          version: 1,
          time: new Date().toISOString(),
          pluginPath: base,
          backupId,
          kind: 'verify',
          ok,
          checks,
        }
        let journalWarning = null
        try {
          await appendJournal(base, entry, exec)
        } catch (error) {
          journalWarning = messageOf(error)
        }
        return { ok, pluginPath: base, backupId, checks, analysis: summary, official: scanned.result.official, ui, journalWarning }
      },
      { concurrencySafe: false })

    reg('dshpd_rollback',
      'Restore every backed-up file from a snapshot. Works from process memory or, with pluginPath, from the durable backup manifest after a restart. Records a rollback entry in the journal.',
      {
        backupId: { type: 'string', description: 'backupId from dshpd_backup.' },
        pluginPath: { type: 'string', description: 'Plugin root (required when the task is no longer in memory).' },
      },
      ['backupId'],
      async (args, exec) => {
        let owner = null
        for (const task of tasks.values()) if (task.backupId === args.backupId) owner = task
        const base = owner !== null ? owner.pluginPath : nonEmptyString(args.pluginPath)
        if (base === null) return { error: 'backupId not found in memory; pass pluginPath to restore from the durable backup manifest' }
        const manifest = await readBackupManifest(base, args.backupId, exec)
        const files = owner !== null && Array.isArray(owner.files) && owner.files.length > 0
          ? owner.files
          : manifest !== null && Array.isArray(manifest.files) ? manifest.files : []
        if (files.length === 0) return { error: 'backup files not found for backupId ' + args.backupId }

        const restored = []
        const failures = []
        for (const record of files) {
          try {
            const content = await tryReadText(pathJoin(backupPath(base, args.backupId), record.backupName), exec)
            if (content === null) throw new Error('backup file missing: ' + record.backupName)
            await writeText(record.path, content, exec)
            restored.push(record.path)
          } catch (error) {
            failures.push({ path: record.path, error: messageOf(error) })
          }
        }
        if (owner !== null) {
          owner.state = 'ROLLED_BACK'
          owner.fileHashes = new Map(files.map((record) => [pathKey(record.path), record.sha256]))
        }
        const entry = {
          version: 1,
          time: new Date().toISOString(),
          pluginPath: base,
          backupId: args.backupId,
          kind: 'rollback',
          restored: restored.length,
          failed: failures.length,
        }
        await appendJournal(base, entry, exec)
        return { state: owner !== null ? owner.state : 'ROLLED_BACK', restored: restored.length, failed: failures.length, restoredFiles: restored, failures }
      })

    reg('dshpd_status',
      'Read task state. With approvalToken: one in-memory task. With pluginPath: durable backups and recent journal entries found on disk. With neither: all in-memory tasks.',
      {
        approvalToken: { type: 'string', description: 'Optional token from dshpd_approve.' },
        pluginPath: { type: 'string', description: 'Optional plugin root for durable state.' },
        journalLimit: { type: 'integer', description: 'Max journal entries to return for pluginPath (default 20).' },
      },
      [],
      async (args, exec) => {
        if (nonEmptyString(args.approvalToken) !== null) {
          const task = taskByToken(args.approvalToken)
          if (!task) return { error: 'token not found (approval tokens are process-local)' }
          return {
            state: task.state,
            pluginPath: task.pluginPath,
            designPath: task.designPath,
            backupId: task.backupId,
            journalCount: (task.journal || []).length,
            createdAt: task.createdAt,
          }
        }
        if (nonEmptyString(args.pluginPath) !== null) {
          const base = await ioFor(exec).resolvePath(args.pluginPath)
          const backups = await listBackups(base, exec)
          const limit = args.journalLimit === undefined ? 20 : Math.max(1, Math.min(200, Number(args.journalLimit) || 20))
          const journal = (await readJournal(base, limit, exec)).slice(-limit)
          return { pluginPath: base, backups, journal, journalCount: journal.length }
        }
        const list = []
        for (const task of tasks.values()) {
          list.push({
            token: task.token,
            state: task.state,
            pluginPath: task.pluginPath,
            backupId: task.backupId,
            journalCount: (task.journal || []).length,
            createdAt: task.createdAt,
          })
        }
        return { activeTasks: list.length, tasks: list, note: 'Pass pluginPath to inspect durable backups/journal from earlier processes.' }
      },
      { concurrencySafe: true })

    reg('dshpd_report',
      'Produce a modification report for a backupId: design, backed-up files, edits/migrations from the journal, verification results, analysis before/after, and remaining risks. Reads durable state when the task is no longer in memory (pass pluginPath).',
      {
        backupId: { type: 'string', description: 'backupId from dshpd_backup.' },
        pluginPath: { type: 'string', description: 'Plugin root (required when the task is no longer in memory).' },
      },
      ['backupId'],
      async (args, exec) => {
        let owner = null
        for (const task of tasks.values()) if (task.backupId === args.backupId) owner = task
        const base = owner !== null ? owner.pluginPath : nonEmptyString(args.pluginPath)
        if (base === null) return { error: 'backupId not found in memory; pass pluginPath to read the durable report' }
        const manifest = await readBackupManifest(base, args.backupId, exec)
        if (manifest === null && owner === null) return { error: 'backup manifest not found for backupId ' + args.backupId }
        const journal = await readJournal(base, 500, exec)
        const entries = journal.filter((entry) => entry && entry.backupId === args.backupId)
        const verification = entries.filter((entry) => entry.kind === 'verify').slice(-1)[0] || null

        let current = null
        try {
          const scanned = await analyzePath(ioFor(exec), base, nonEmptyString(process.env.DSH_VERSION))
          current = analysisSummary(scanned.result)
        } catch (error) {
          current = { error: messageOf(error) }
        }

        return {
          backupId: args.backupId,
          pluginPath: base,
          designPath: owner !== null ? owner.designPath : manifest ? manifest.designPath : null,
          state: owner !== null ? owner.state : 'PERSISTED',
          createdAt: manifest ? manifest.createdAt : owner ? owner.createdAt : null,
          filesBackedUp: manifest ? (manifest.files || []).map((file) => file.path) : (owner.files || []).map((file) => file.path),
          analysisBefore: manifest ? manifest.analysis : null,
          analysisAfter: current,
          edits: entries.filter((entry) => entry.kind === 'apply' || entry.kind === 'migrate'),
          verification: verification === null ? null : { ok: verification.ok, checks: verification.checks, time: verification.time },
          remainingRisks: [
            'validation/tests are not run by this plugin — run them via shell/tooling and mark PASS/FAIL/NOT_AVAILABLE',
            'heuristic analysis is not authoritative certification',
            'approval tokens are process-local; backups/journal are durable',
          ],
          note: 'DH-TP-SDK certification levels (Bronze/Silver/Gold) are engineering spec levels, not DeepSeek official certification.',
        }
      },
      { concurrencySafe: true })

    // ---- Settings-page HTTP routes (read-only) --------------------------
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer
      if (!webServer || typeof webServer.register !== 'function') return

      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-plugin-design/info',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'GET only' })
          sendJson(res, 200, {
            ok: true,
            name: PLUGIN.name,
            version: PLUGIN.version,
            ruleset: RULESET,
            tools: TOOL_NAMES,
            compatibility: PLUGIN.engines,
          })
        },
      }))

      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-plugin-design/discover',
        handler: async (req, res) => {
          try {
            const parsed = await readRequestInput(req)
            const root = nonEmptyString(parsed.root)
            if (root === null) return sendJson(res, 400, { error: 'root path required', plugins: [], count: 0 })
            const depth = parsed.maxDepth === undefined ? 5 : Math.max(0, Math.min(12, Number(parsed.maxDepth) || 0))
            const { root: resolvedRoot, results } = await discoverPlugins(createNodeIo(), root, depth)
            sendJson(res, 200, { ok: true, root: resolvedRoot, count: results.length, plugins: results })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: messageOf(error), plugins: [], count: 0 })
          }
        },
      }))

      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-plugin-design/analyze',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
          try {
            const parsed = await readRequestInput(req)
            const pluginPath = nonEmptyString(parsed.pluginPath)
            if (pluginPath === null) return sendJson(res, 400, { ok: false, error: 'pluginPath required' })
            const harnessVersion = nonEmptyString(parsed.harnessVersion)
            const { model, result } = await analyzePath(createNodeIo(), pluginPath, harnessVersion)
            sendJson(res, 200, {
              ok: true,
              pluginPath: model.pluginPath,
              ui: isPlainObject(model.pkg) && typeof model.pkg.name === 'string' ? uiStatus(model.pkg.name) : null,
              ruleset: RULESET,
              official: result.official,
              issueCount: result.issues.length,
              counts: countBySeverity(result.issues),
              scores: result.scores,
              overall: result.overall,
              issues: result.issues.slice(0, 200),
              issuesTruncated: result.issues.length > 200,
              migrations: result.migrations,
            })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: messageOf(error) })
          }
        },
      }))
    })
  },
}

// ---------------------------------------------------------------------------
// Pure helpers used by the plugin entry
// ---------------------------------------------------------------------------

function buildDesignTemplate(pluginPath, result) {
  const { official, issues, migrations } = result
  const lines = []
  lines.push('# dsh plugin design — design.md')
  lines.push('')
  lines.push('> 依据官方 DSH 0.2.x 插件契约（ruleset ' + RULESET.version + '）与 DH-TP-SDK 工程化规范生成的可执行修改设计。')
  lines.push('> 注意：Bronze/Silver/Gold、P0-P4、S0-S4 为本工程化规范等级，不是 DeepSeek 官方认证。')
  lines.push('')
  lines.push('## 1. Target Plugin')
  lines.push('')
  lines.push('- Plugin name: ' + (official.packageName || pathBasename(pluginPath)))
  lines.push('- Package version: ' + (official.packageVersion || 'UNKNOWN'))
  lines.push('- Path: ' + pluginPath)
  lines.push('- Roles: ' + (official.roles.length > 0 ? official.roles.join(', ') : 'UNKNOWN'))
  lines.push('- Compatibility: ' + (official.compatibility.source === 'none'
    ? 'UNKNOWN（无 engines.dsh，也无 @deepseek-ai/dsh* peer）'
    : official.compatibility.source + ' = ' + official.compatibility.range))
  lines.push('')
  lines.push('## 2. Executive Summary')
  lines.push('')
  lines.push('（待补充：当前插件做什么、当前架构、是否已适配 dsh、最大兼容/安全/生命周期风险，以及是否存在 Core modification / private API / global mutable state。）')
  lines.push('')
  lines.push('## 3. Official Contract Snapshot')
  lines.push('')
  lines.push('- bundle declared: ' + official.bundle.declared + (official.bundle.patch.length > 0 ? '（' + official.bundle.patch.join(', ') + '）' : ''))
  lines.push('- client declared: ' + official.client.declared + (official.client.declared ? '（platform=' + String(official.client.platform) + ', bundle=' + official.client.exportTarget + '）' : ''))
  lines.push('- engines.dsh: ' + String(official.engines.dsh))
  lines.push('- manifestVersion: ' + String(official.manifestVersion))
  lines.push('')
  lines.push('## 4. Findings')
  lines.push('')
  if (issues.length === 0) {
    lines.push('未发现规则命中。')
  } else {
    for (const issue of issues.slice(0, 200)) {
      lines.push('- [' + issue.severity + '] ' + issue.id + ' — ' + issue.title + (issue.file ? '（' + issue.file + '）' : ''))
      if (issue.detail) lines.push('  - ' + issue.detail)
    }
    if (issues.length > 200) lines.push('- … 另有 ' + (issues.length - 200) + ' 条，运行 `dshpd_analyze` 查看完整列表。')
  }
  lines.push('')
  lines.push('## 5. Modification Plan')
  lines.push('')
  lines.push('（逐项 M001/M002/...：ID、Reason、File、Before、After、Risk、Validation、Rollback；只改目标插件源码，不修改 Core。）')
  if (migrations.length > 0) {
    lines.push('')
    lines.push('可直接由 `dshpd_migrate` 执行的清单迁移：')
    for (const migration of migrations) lines.push('- `' + migration.id + '` — ' + migration.title)
  }
  lines.push('')
  let sectionNumber = 6
  if (official.client.declared) {
    lines.push('## ' + sectionNumber + '. UI 恢复与验证（client 插件必做）')
    sectionNumber += 1
    lines.push('')
    lines.push('- Client 入口：`' + String(official.client.exportTarget) + '`；检测到的 UI 座位：' + (official.client.uiSlots.length > 0 ? official.client.uiSlots.join(', ') : '（未检测到已知座位）'))
    lines.push('- 如果 `dshpd_analyze` 报了 `CLIENT_BUILD_STALE`：先重新构建 client bundle，再刷新页面；否则源码改了、页面仍是旧 UI。')
    lines.push('- 步骤：修改 client 源码 → 确认仍导出 `apply` / `inject` → 运行项目构建命令（如 `npm run build:client`）→ 确认 `lib/client.js` 是 factory-form 且 mtime 晚于源码 → 备份源码与 bundle → 刷新页面。')
    lines.push('- 验证：调用 `dshpd_ui_check`（或 `dshpd_verify`），要求 `runtime.inGraph = true`、`buildStale = false`、`applyPresent = true`；再打开设置页确认入口出现。')
    lines.push('- 若 `runtime.inGraph = false`：检查 Loader row 是否为裸包名、`package.json.dsh.client`、`exports["./client"]`、`lib/client.js` 是否存在，然后重启 dsh / 刷新页面。')
    lines.push('- 若设置页请求报 `Unexpected token "<"`：检查 client 的 fetch 路径与 Host `webServer.register({ path })` 是否一致（`CLIENT_ROUTE_MISSING`），以及是否用 `ctx.inject(["webServer"], ...)` 等待服务。')
    lines.push('')
  }
  lines.push('## ' + sectionNumber + '. Verification')
  lines.push('')
  lines.push('（typecheck / lint / unit / integration / lifecycle / session / concurrency / security / compatibility；无则 NOT_AVAILABLE。修改完成后调用 `dshpd_verify`，client 插件再调用 `dshpd_ui_check`，并人工运行测试记录 PASS/FAIL/NOT_AVAILABLE。）')
  lines.push('')
  sectionNumber += 1
  lines.push('## ' + sectionNumber + '. Approval')
  lines.push('')
  lines.push('（用户确认后才执行修改；未确认前严禁修改目标插件源码。审批通过后依次调用 dshpd_approve → dshpd_backup → dshpd_apply/dshpd_migrate → dshpd_verify。）')
  lines.push('')
  return lines.join('\n')
}

/** Run one manifest migration in place; returns {changed, detail}. */
function applyManifestMigration(pkg, migrationId, options, pluginPath) {
  if (!isPlainObject(pkg.dsh)) pkg.dsh = {}
  const dsh = pkg.dsh
  if (migrationId === 'manifest-version') {
    if (dsh.manifestVersion === 1) return { changed: false, detail: 'already 1' }
    dsh.manifestVersion = 1
    return { changed: true, detail: 'dsh.manifestVersion = 1' }
  }
  if (migrationId === 'engines-dsh') {
    const compatibility = isPlainObject(dsh.compatibility) && typeof dsh.compatibility.harness === 'string'
      ? dsh.compatibility.harness
      : null
    const candidate = nonEmptyString(options.dshRange) || compatibility || '>=0.1.5-rc.1 <0.3.0'
    if (/^workspace:/.test(candidate) || !/[\d]/.test(candidate)) {
      return { changed: false, detail: 'refusing invalid range: ' + candidate }
    }
    if (!isPlainObject(pkg.engines)) pkg.engines = {}
    if (pkg.engines.dsh === candidate) return { changed: false, detail: 'already ' + candidate }
    pkg.engines.dsh = candidate
    return { changed: true, detail: 'engines.dsh = ' + candidate }
  }
  if (migrationId === 'bundle-patch') {
    if (isPlainObject(dsh.bundle) && (typeof dsh.bundle.patch === 'string' || Array.isArray(dsh.bundle.patch))) {
      return { changed: false, detail: 'dsh.bundle.patch already declared' }
    }
    const hasPatch = readFileSafe(pathJoin(pluginPath, 'cordis.patch.yml')) !== null
    if (!hasPatch) return { changed: false, detail: 'no cordis.patch.yml at the package root' }
    dsh.bundle = { ...(isPlainObject(dsh.bundle) ? dsh.bundle : {}), patch: './cordis.patch.yml' }
    return { changed: true, detail: 'dsh.bundle.patch = ./cordis.patch.yml' }
  }
  if (migrationId === 'client-meta') {
    const clientBundle = pathJoin(pluginPath, 'lib/client.js')
    const hasBundle = readFileSafe(clientBundle) !== null
    if (!hasBundle) return { changed: false, detail: 'no lib/client.js build artifact' }
    dsh.client = { ...(isPlainObject(dsh.client) ? dsh.client : {}), platform: 'web' }
    if (!isPlainObject(pkg.exports)) pkg.exports = {}
    if (pkg.exports['./client'] === undefined) pkg.exports['./client'] = './lib/client.js'
    if (pkg.exports['./package.json'] === undefined) pkg.exports['./package.json'] = './package.json'
    return { changed: true, detail: 'dsh.client.platform = web; exports["./client"] and ["./package.json"] ensured' }
  }
  if (migrationId === 'remove-invariants-dep') {
    let changed = false
    const detail = []
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (isPlainObject(pkg[section]) && Object.hasOwn(pkg[section], '@deepseek-ai/dsh-invariants')) {
        delete pkg[section]['@deepseek-ai/dsh-invariants']
        changed = true
        detail.push(section)
      }
    }
    return { changed, detail: changed ? 'removed from ' + detail.join(', ') : 'dependency not present' }
  }
  return { changed: false, detail: 'unknown migration' }
}

function readFileSafe(target) {
  try {
    return readFileSync(target, 'utf8')
  } catch (error) {
    return null
  }
}

async function readRequestInput(req) {
  if (req.method === 'GET') {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    return Object.fromEntries(url.searchParams.entries())
  }
  let body = ''
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new Error('request body too large')
    body += chunk
  }
  if (body.trim() === '') return {}
  const parsed = JSON.parse(body)
  return isPlainObject(parsed) ? parsed : {}
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}
