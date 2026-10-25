// dsh-plugin-design — bounded artifact collector.
//
// Runs inside the scan worker (never on the Host event loop). It reads what
// the loader will actually execute, not only `src/`:
//   - package.json / dsh.plugin.yaml / Cordis patch files,
//   - the Host entry from `exports["."]` / `main`,
//   - the Client entry from `exports["./client"]`,
//   - built artifacts under lib/, dist/, build/ (a lib-only npm package must
//     still be audited),
//   - lockfiles and declared dependency sections (metadata only).
//
// Every budget overrun becomes an explicit coverage record. Truncation is
// never silent: `coverage.incomplete` is true and the caller must not turn the
// result into a clean verdict.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

export const DEFAULT_BUDGET = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 10000,
  maxDirectories: 5000,
  maxDepth: 24,
  maxArtifactFiles: 4000,
  deadlineMs: 30000,
})

const ARTIFACT_DIRS = new Set(['lib', 'dist', 'build', 'out', 'bundle'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.dsh-plugin-design', '.next', '.turbo', '.cache', '.pnpm-store'])
const TEXT_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|md|txt|css|html)$/i
const SOURCE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx)$/i
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'npm-shrinkwrap.json']

function toPosix(value) {
  return String(value).split(sep).join('/')
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function classify(path) {
  const normalized = toPosix(path)
  if (/(^|\/)(tests?|__tests__)\//.test(normalized) || /\.(?:test|spec)\.[^.]+$/i.test(normalized)) return 'test'
  if (/(^|\/)(src|source)\//.test(normalized)) return 'source'
  if (/(^|\/)(lib|dist|build|out|bundle)\//.test(normalized)) return 'artifact'
  return 'file'
}

function isSkippableDirectory(name) {
  return SKIP_DIRS.has(name)
}

/**
 * Collect one plugin model with hard budgets.
 * @param {string} pluginPath - absolute plugin root.
 * @param {object} [options] - budget overrides + harness version.
 * @returns {Promise<{model: object, coverage: object}>}
 */
export async function collectPluginModel(pluginPath, options = {}) {
  const budget = { ...DEFAULT_BUDGET, ...(options.budget || {}) }
  const started = Date.now()
  const deadline = started + budget.deadlineMs
  const root = resolve(pluginPath)
  const coverage = {
    root,
    startedAt: new Date(started).toISOString(),
    budget,
    directories: 0,
    filesVisited: 0,
    bytesRead: 0,
    parsed: 0,
    skippedOversize: [],
    unreadable: [],
    truncated: false,
    incompleteReasons: [],
    artifactFiles: 0,
    dependencyCoverage: 'declared-only',
  }
  const files = []
  const relativeFiles = []
  const contents = new Map()
  let cancelled = false

  function fail(reason) {
    coverage.truncated = true
    if (!coverage.incompleteReasons.includes(reason)) coverage.incompleteReasons.push(reason)
  }

  function checkBudget() {
    if (Date.now() > deadline) {
      cancelled = true
      fail('DEADLINE_EXCEEDED')
      return false
    }
    if (options.signal && options.signal.aborted) {
      cancelled = true
      fail('CANCELLED')
      return false
    }
    return true
  }

  async function readTextFile(absolute, relativePath, limit) {
    if (coverage.bytesRead >= budget.maxTotalBytes) {
      fail('TOTAL_BYTES_EXCEEDED')
      return null
    }
    let info
    try {
      info = await fs.stat(absolute)
    } catch (error) {
      coverage.unreadable.push({ path: relativePath, error: String(error && error.code ? error.code : error) })
      return null
    }
    if (!info.isFile()) return null
    if (info.size > limit) {
      coverage.skippedOversize.push({ path: relativePath, bytes: info.size, limit })
      fail('FILE_OVERSIZE:' + relativePath)
      return null
    }
    const remaining = budget.maxTotalBytes - coverage.bytesRead
    if (info.size > remaining) {
      fail('TOTAL_BYTES_EXCEEDED')
      return null
    }
    try {
      const bytes = await fs.readFile(absolute)
      coverage.bytesRead += bytes.length
      coverage.parsed += 1
      return { text: bytes.toString('utf8'), bytes: bytes.length, hash: hashBytes(bytes) }
    } catch (error) {
      coverage.unreadable.push({ path: relativePath, error: String(error && error.code ? error.code : error) })
      return null
    }
  }

  async function walk(directory, depth) {
    if (cancelled) return
    if (!checkBudget()) return
    if (depth > budget.maxDepth) {
      fail('DEPTH_EXCEEDED')
      return
    }
    if (coverage.directories >= budget.maxDirectories) {
      fail('DIRECTORIES_EXCEEDED')
      return
    }
    coverage.directories += 1
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      coverage.unreadable.push({ path: toPosix(relative(root, directory)) || '.', error: String(error && error.code ? error.code : error) })
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (cancelled) return
      if (!checkBudget()) return
      if (coverage.filesVisited >= budget.maxFiles) {
        fail('FILES_EXCEEDED')
        return
      }
      const absolute = join(directory, entry.name)
      const relativePath = toPosix(relative(root, absolute))
      if (entry.isDirectory()) {
        if (isSkippableDirectory(entry.name)) continue
        await walk(absolute, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      coverage.filesVisited += 1
      relativeFiles.push(relativePath)
      const kind = classify(relativePath)
      if (kind === 'artifact') {
        coverage.artifactFiles += 1
        if (coverage.artifactFiles > budget.maxArtifactFiles) {
          fail('ARTIFACTS_EXCEEDED')
          continue
        }
      }
      if (!TEXT_EXT.test(entry.name)) {
        files.push({ relative: relativePath, kind, text: false })
        continue
      }
      const read = await readTextFile(absolute, relativePath, budget.maxFileBytes)
      if (read === null) {
        files.push({ relative: relativePath, kind, text: false, unreadable: true })
        continue
      }
      contents.set(relativePath, read.text)
      files.push({ relative: relativePath, kind, bytes: read.bytes, hash: read.hash, text: true })
    }
  }

  await walk(root, 0)

  if (coverage.filesVisited === 0 && coverage.unreadable.length > 0) {
    fail('ROOT_UNREADABLE')
  }

  const pkgRaw = contents.get('package.json') || null
  let pkg = null
  let pkgError = null
  if (pkgRaw !== null) {
    try {
      pkg = JSON.parse(pkgRaw)
    } catch (error) {
      pkgError = error instanceof Error ? error.message : String(error)
    }
  }

  const sourceFiles = []
  for (const file of files) {
    if (!file.text) continue
    if (!SOURCE_EXT.test(file.relative) && !/\.(?:json|yml|yaml|md)$/i.test(file.relative)) continue
    if (/(^|\/)node_modules\//.test(file.relative)) continue
    sourceFiles.push({
      path: join(root, file.relative),
      relative: file.relative,
      content: contents.get(file.relative) || '',
      kind: file.kind,
      bytes: file.bytes,
    })
  }

  const exportTarget = (key) => {
    if (pkg === null || typeof pkg.exports !== 'object' || pkg.exports === null) return null
    const entry = pkg.exports[key]
    if (typeof entry === 'string') return entry
    if (entry !== null && typeof entry === 'object') return entry.default || entry.import || entry.require || null
    return null
  }
  const hostEntryRelative = exportTarget('.') || (typeof pkg?.main === 'string' ? pkg.main : null)
  const clientEntryRelative = exportTarget('./client')
  const readEntry = async (relativePath, limit) => {
    if (typeof relativePath !== 'string') return null
    const normalized = toPosix(relativePath).replace(/^\.\//, '')
    const cached = contents.get(normalized)
    if (cached !== undefined) return { text: cached, path: normalized, cached: true }
    if (!relativeFiles.includes(normalized)) return { text: null, path: normalized, missing: true }
    const read = await readTextFile(join(root, normalized), normalized, limit)
    if (read === null) return { text: null, path: normalized, unreadable: true }
    contents.set(normalized, read.text)
    return { text: read.text, bytes: read.bytes, hash: read.hash, path: normalized }
  }
  const hostEntry = await readEntry(hostEntryRelative, budget.maxEntryBytes)
  const clientEntry = await readEntry(clientEntryRelative, budget.maxEntryBytes)

  const bundlePatches = []
  const declaredPatch = pkg && pkg.dsh && pkg.dsh.bundle ? pkg.dsh.bundle.patch : null
  const patchList = typeof declaredPatch === 'string' ? [declaredPatch] : Array.isArray(declaredPatch) ? declaredPatch.filter((item) => typeof item === 'string') : []
  for (const relativePath of patchList) {
    const normalized = toPosix(relativePath).replace(/^\.\//, '')
    const unsafe = normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')
    if (unsafe) {
      bundlePatches.push({ path: relativePath, unsafe: true, exists: false, raw: null })
      continue
    }
    const raw = contents.get(normalized) ?? null
    bundlePatches.push({ path: relativePath, unsafe: false, exists: raw !== null, raw })
  }
  const cordisPatchRaw = contents.get('cordis.patch.yml') ?? null

  // Client bundle text: declared entry, else the conventional lib/client.js.
  let clientBundlePath = null
  let clientBundleRaw = null
  if (clientEntry && typeof clientEntry.text === 'string') {
    clientBundlePath = join(root, clientEntry.path)
    clientBundleRaw = clientEntry.text
  } else if (contents.has('lib/client.js')) {
    clientBundlePath = join(root, 'lib', 'client.js')
    clientBundleRaw = contents.get('lib/client.js')
  }
  const defaultClientBundlePath = join(root, 'lib', 'client.js')
  const defaultClientBundleRaw = contents.get('lib/client.js') ?? null

  const clientSourceFiles = sourceFiles.filter((file) => {
    const normalized = toPosix(file.relative)
    return /(^|\/)(src\/client|client)\//.test(normalized) || /(^|\/)client\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(normalized)
  })

  const topLevelNames = new Set(relativeFiles.filter((name) => !name.includes('/')).map((name) => name.toLowerCase()))
  const iconRelative = pkg && typeof pkg.icon === 'string' ? toPosix(pkg.icon).replace(/^\.\//, '') : null
  let iconExists = undefined
  let iconBytes
  let iconExt = null
  if (iconRelative !== null) {
    const record = files.find((file) => file.relative === iconRelative)
    iconExists = record !== undefined
    iconBytes = record && typeof record.bytes === 'number' ? record.bytes : undefined
    const match = /\.([A-Za-z0-9]+)$/.exec(iconRelative)
    iconExt = match === null ? null : match[1].toLowerCase()
  }

  const sourceText = sourceFiles.map((file) => file.content).join('\n')
  const toolNames = []
  for (const match of sourceText.matchAll(/ctx\s*\.\s*tools\s*\.\s*register\s*\(\s*\{[\s\S]{0,500}?name\s*:\s*['"]([^'"]+)['"]/g)) {
    if (!toolNames.includes(match[1])) toolNames.push(match[1])
  }
  const lockfiles = LOCKFILES.filter((name) => topLevelNames.has(name))
  const hasTests = relativeFiles.some((name) => /(^|\/)(tests?|__tests__)\//.test(name))
    || Boolean(pkg && pkg.scripts && typeof pkg.scripts.test === 'string')
  const hasReadme = [...topLevelNames].some((name) => name.startsWith('readme'))
  const hasLicense = [...topLevelNames].some((name) => name.startsWith('license') || name.startsWith('licence'))

  const model = {
    pluginPath: root,
    topLevel: [...new Set(relativeFiles.filter((name) => !name.includes('/')))].map((name) => ({ name, type: 'file' })),
    files,
    relativeFiles,
    manifestRaw: contents.get('dsh.plugin.yaml') ?? null,
    pkgRaw,
    pkg,
    pkgError,
    cordisPatchRaw,
    bundlePatches,
    hostEntry: hostEntry || null,
    clientEntry: clientEntry || null,
    clientBundlePath,
    clientBundleRaw,
    clientBundleExists: typeof clientBundleRaw === 'string',
    defaultClientBundlePath,
    defaultClientBundleRaw,
    defaultClientBundleExists: typeof defaultClientBundleRaw === 'string',
    clientSourceFiles,
    clientSourceMtimeMax: undefined,
    clientBundleMtime: undefined,
    toolNames,
    hasConfig: /export\s+const\s+Config\b|\bctx\s*\.\s*settings\b/.test(sourceText),
    iconExists,
    iconBytes,
    iconExt,
    iconRelative,
    sourceFiles,
    hasTests,
    hasReadme,
    hasLicense,
    lockfiles,
    nodeModulesPresent: coverage.directories > 0 && relativeFiles.some((name) => name.startsWith('node_modules/')),
    harnessVersion: typeof options.harnessVersion === 'string' && options.harnessVersion.trim() !== '' ? options.harnessVersion.trim() : null,
    coverage,
  }
  coverage.finishedAt = new Date().toISOString()
  coverage.elapsedMs = Date.now() - started
  coverage.incomplete = coverage.incompleteReasons.length > 0
  coverage.scannedSourceFiles = sourceFiles.length
  coverage.entryFiles = {
    host: hostEntry === null ? null : { path: hostEntry.path || null, present: typeof hostEntry.text === 'string' },
    client: clientEntry === null ? null : { path: clientEntry.path || null, present: typeof clientEntry.text === 'string' },
  }
  if (budget.includeContents !== true) {
    // Keep worker responses small: the analyzer runs in the worker, so the
    // caller only needs the coverage summary and hashes.
  }
  return { model, coverage }
}

/**
 * Bounded recursive discovery of plugin projects.
 * Skips node_modules/.git and VCS metadata, records incomplete coverage.
 */
export async function discoverPluginProjects(rootPath, options = {}) {
  const budget = { ...DEFAULT_BUDGET, maxDepth: 5, ...(options.budget || {}) }
  const started = Date.now()
  const root = resolve(rootPath)
  const coverage = {
    root, directories: 0, filesVisited: 0, matches: 0, truncated: false,
    incompleteReasons: [], unreadable: [], startedAt: new Date(started).toISOString(), budget,
  }
  const results = []
  const fail = (reason) => {
    coverage.truncated = true
    if (!coverage.incompleteReasons.includes(reason)) coverage.incompleteReasons.push(reason)
  }
  async function walk(directory, depth) {
    if (Date.now() - started > budget.deadlineMs) return fail('DEADLINE_EXCEEDED')
    if (options.signal && options.signal.aborted) return fail('CANCELLED')
    if (depth > budget.maxDepth) return fail('DEPTH_EXCEEDED')
    if (coverage.directories >= budget.maxDirectories) return fail('DIRECTORIES_EXCEEDED')
    coverage.directories += 1
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      coverage.unreadable.push({ path: directory, error: String(error && error.code ? error.code : error) })
      if (depth === 0) fail('ROOT_UNREADABLE')
      return undefined
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    const names = new Set(entries.map((entry) => entry.name))
    let pkg = null
    if (names.has('package.json')) {
      try {
        const raw = await fs.readFile(join(directory, 'package.json'), 'utf8')
        pkg = JSON.parse(raw)
      } catch (error) {
        pkg = null
      }
      if (pkg !== null && typeof pkg.name === 'string'
        && (pkg.name === '@deepseek-ai/dsh' || pkg.name.startsWith('@deepseek-ai/dsh-'))) return undefined
    }
    if (pkg !== null || names.has('dsh.plugin.yaml')) {
      coverage.matches += 1
      if (results.length < (options.maxResults || 500)) {
        results.push({
          path: directory,
          name: basename(directory),
          hasManifest: names.has('dsh.plugin.yaml'),
          hasPackageJson: pkg !== null,
          hasCordisPatch: names.has('cordis.patch.yml'),
          depth,
          packageName: pkg && typeof pkg.name === 'string' ? pkg.name : null,
          version: pkg && typeof pkg.version === 'string' ? pkg.version : null,
          bundle: Boolean(pkg && pkg.dsh && pkg.dsh.bundle),
          client: Boolean(pkg && pkg.dsh && pkg.dsh.client),
          enginesDsh: pkg && pkg.engines && typeof pkg.engines.dsh === 'string' ? pkg.engines.dsh : null,
        })
      } else {
        fail('RESULTS_EXCEEDED')
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (isSkippableDirectory(entry.name)) continue
      coverage.filesVisited += 1
      if (coverage.filesVisited > budget.maxFiles * 4) return fail('FILES_EXCEEDED')
      const outcome = await walk(join(directory, entry.name), depth + 1)
      if (outcome === false) return undefined
    }
    return undefined
  }
  await walk(root, 0)
  coverage.finishedAt = new Date().toISOString()
  coverage.elapsedMs = Date.now() - started
  coverage.incomplete = coverage.incompleteReasons.length > 0
  return { root, results, coverage }
}
