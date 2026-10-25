// dsh-plugin-design — portable distribution export.
//
// Produces, for one target plugin, the M2-07/M2-09 deliverables:
//   source/            complete source tree (build lock included)
//   package/<name>.tgz  prebuilt package with the declared runtime files
//   SHA256SUMS          hash of every delivered file
//   FILELIST.json       per-file hash/size of the package contents
//   INSTALL.md          public install/config/uninstall instructions
//   SUPPORT-MATRIX.*    what was actually verified, what was not
//   distribution-report.json
//
// The export refuses when the package contract audit fails (missing entry,
// missing chunk, undeclared runtime dependency, author-only path, maintenance
// state). "Prepared" is not "published": this module never uploads anything.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { isInside, pathKey } from '../change/paths.js'
import { createTarGz } from './tar.js'
import { auditPackageContents, DISTRIBUTION_SCHEMA } from './audit.js'

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.dsh-plugin-design', '.next', '.turbo', 'coverage'])
const ALWAYS_INCLUDE = ['package.json', 'README.md', 'README', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'cordis.patch.yml', 'dsh.plugin.yaml']
const MAX_FILE_BYTES = 64 * 1024 * 1024

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function toPosix(value) {
  return String(value).split(sep).join('/')
}

function normalizeRelative(value) {
  return toPosix(value).replace(/^\.\//, '').replace(/^\/+/, '')
}

/** Expand package.json.files entries against the actual tree. */
function selectPackageFiles(allFiles, pkg) {
  const normalized = new Map(allFiles.map((path) => [path, path]))
  const filesField = pkg && Array.isArray(pkg.files) ? pkg.files.map(normalizeRelative) : null
  const selected = new Set()
  const missing = []
  if (filesField === null) {
    for (const path of allFiles) selected.add(path)
  } else {
    for (const entry of filesField) {
      const trimmed = entry.replace(/\/+$/, '')
      let matched = false
      for (const path of allFiles) {
        if (path === trimmed || path.startsWith(trimmed + '/')) {
          selected.add(path)
          matched = true
        }
      }
      if (!matched) missing.push(entry)
    }
    for (const path of ALWAYS_INCLUDE) if (normalized.has(path)) selected.add(path)
  }
  // Never ship maintenance state, VCS metadata or node_modules.
  for (const path of [...selected]) {
    if (path.split('/').some((part) => SKIP_DIRS.has(part))) selected.delete(path)
  }
  return { selected: [...selected].sort(), missing, filesField }
}

async function walkFiles(root) {
  const files = []
  async function walk(directory) {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      files.push(toPosix(relative(root, absolute)))
    }
  }
  await walk(root)
  return files
}

async function readBounded(path, limit = MAX_FILE_BYTES) {
  const info = await fs.stat(path)
  if (info.size > limit) throw new Error('FILE_TOO_LARGE_FOR_EXPORT: ' + path)
  return fs.readFile(path)
}

function renderInstallDoc(pkg, report) {
  const name = pkg.name
  const version = pkg.version
  const lines = []
  lines.push('# ' + name + ' ' + version + ' — installation')
  lines.push('')
  lines.push('This package is a DeepSeek Harness (DSH) plugin. It does not require')
  lines.push('`dsh-plugin-design` or any author development environment to run.')
  lines.push('')
  lines.push('## Requirements')
  lines.push('')
  lines.push('- DSH: ' + String(pkg.engines && pkg.engines.dsh ? pkg.engines.dsh : 'see SUPPORT-MATRIX.md'))
  lines.push('- Platform: see `SUPPORT-MATRIX.md` (only the listed carriers/platforms are verified).')
  lines.push('')
  lines.push('## Install the prebuilt package')
  lines.push('')
  lines.push('```sh')
  lines.push('dsh plugin --profile <profile> add ./' + name + '-' + version + '.tgz')
  lines.push('```')
  lines.push('')
  lines.push('Desktop and Web use different profiles: pass the profile your client boots.')
  lines.push('Restart the client after installing so the new Host/Client half is composed.')
  lines.push('')
  lines.push('## Verify')
  lines.push('')
  lines.push('1. Restart the DSH client.')
  lines.push('2. Open the plugin surface listed in the README (tool, page or setting).')
  lines.push('3. If nothing appears, check `dsh plugin --profile <profile> why ' + name + '`.')
  lines.push('')
  lines.push('## Update')
  lines.push('')
  lines.push('Install the new `.tgz` over the old one through the same command, or use the')
  lines.push('official plugin manager update path; keep the previous package for rollback.')
  lines.push('')
  lines.push('## Uninstall')
  lines.push('')
  lines.push('```sh')
  lines.push('dsh plugin --profile <profile> remove ' + name)
  lines.push('```')
  lines.push('')
  lines.push('User data written by the plugin is not deleted automatically; see the README.')
  lines.push('')
  lines.push('## Distribution status')
  lines.push('')
  lines.push('- Package SHA-256: `' + report.artifacts.tgzSha256 + '`')
  lines.push('- Verified carriers: ' + (report.supportMatrix.filter((row) => row.status === 'PASS').map((row) => row.carrier + '/' + row.os).join(', ') || 'none yet (NOT_RUN)'))
  lines.push('- Published: **no** (these are locally prepared release materials)')
  lines.push('')
  return lines.join('\n')
}

function renderSupportMatrix(rows) {
  const lines = ['# Support matrix', '', '| DSH version | Carrier | OS/arch | Result | Evidence |', '|---|---|---|---|---|']
  for (const row of rows) {
    lines.push('| ' + row.dsh + ' | ' + row.carrier + ' | ' + row.os + ' | ' + row.status + ' | ' + String(row.evidence || '').replace(/\|/g, '/') + ' |')
  }
  lines.push('')
  lines.push('`NOT_RUN` means there is no evidence for that combination; it must not be')
  lines.push('read as supported. Static package-load results are labelled separately from')
  lines.push('a real DSH Host run.')
  lines.push('')
  return lines.join('\n')
}

/**
 * Export a distribution directory.
 * @param {object} options
 * @param {string} options.pluginPath
 * @param {string} options.outputDir
 * @param {object} [options.supportMatrix]
 * @param {object} [options.runtime]
 * @param {string} [options.buildCommand]
 */
export async function exportDistribution(options) {
  const pluginRoot = resolve(options.pluginPath)
  const outputRoot = resolve(options.outputDir)
  if (isInside(pluginRoot, outputRoot)) {
    return { ok: false, error: 'OUTPUT_INSIDE_PLUGIN', detail: 'the export directory must be outside the target plugin tree' }
  }
  const out = await fs.stat(outputRoot).catch(() => null)
  if (out !== null && !out.isDirectory()) {
    return { ok: false, error: 'OUTPUT_NOT_A_DIRECTORY' }
  }
  const realRoot = await fs.realpath(pluginRoot)
  const realOut = await fs.realpath(outputRoot).catch(() => outputRoot)
  if (isInside(realOut, realRoot)) {
    return { ok: false, error: 'OUTPUT_WOULD_CONTAIN_PLUGIN' }
  }

  const pkg = JSON.parse(await fs.readFile(join(pluginRoot, 'package.json'), 'utf8'))
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
    return { ok: false, error: 'PACKAGE_IDENTITY_MISSING' }
  }
  const allFiles = await walkFiles(pluginRoot)
  const selection = selectPackageFiles(allFiles, pkg)
  if (selection.missing.length > 0) {
    return { ok: false, error: 'PACKAGE_ENTRY_MISSING', detail: selection.missing }
  }
  const archiveEntries = []
  for (const path of selection.selected) {
    archiveEntries.push({ path, bytes: await readBounded(join(pluginRoot, path)) })
  }

  // Audit exactly the archive contents, not the wider source tree.
  const audit = auditPackageContents({
    pkg,
    files: archiveEntries.map((entry) => ({
      path: entry.path,
      text: /\.(?:js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|md|txt|css|html)$/i.test(entry.path) ? entry.bytes.toString('utf8') : null,
      bytes: entry.bytes.length,
    })),
    coverage: { incomplete: false, source: 'package-selection' },
  })
  if (!audit.ok) {
    return {
      ok: false,
      error: 'PACKAGE_AUDIT_FAILED',
      audit,
      detail: Object.entries(audit.gates).filter(([, value]) => value.status === 'FAIL').map(([key]) => key),
    }
  }

  const base = pkg.name.startsWith('@') ? basename(pkg.name) : pkg.name
  const releaseName = base + '-' + pkg.version
  const releaseDir = join(outputRoot, releaseName)
  const packageDir = join(releaseDir, 'package')
  const sourceDir = join(releaseDir, 'source')
  await fs.mkdir(packageDir, { recursive: true })
  await fs.mkdir(sourceDir, { recursive: true })

  const tgz = createTarGz(archiveEntries, { prefix: 'package' })
  const tgzName = releaseName + '.tgz'
  const tgzPath = join(packageDir, tgzName)
  await fs.writeFile(tgzPath, tgz)
  const tgzSha256 = sha256(tgz)

  // Complete source tree (no node_modules / state / VCS metadata).
  for (const path of allFiles) {
    const target = join(sourceDir, path)
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.copyFile(join(pluginRoot, path), target)
  }

  const fileList = archiveEntries.map((entry) => ({
    path: entry.path,
    bytes: entry.bytes.length,
    sha256: sha256(entry.bytes),
  }))
  const hashes = [tgzSha256 + '  package/' + tgzName]
  for (const entry of fileList) hashes.push(entry.sha256 + '  source/' + entry.path)
  await fs.writeFile(join(releaseDir, 'SHA256SUMS'), hashes.sort().join('\n') + '\n', 'utf8')
  await fs.writeFile(join(releaseDir, 'FILELIST.json'), JSON.stringify({
    schema: DISTRIBUTION_SCHEMA,
    package: { name: pkg.name, version: pkg.version, tgz: 'package/' + tgzName, sha256: tgzSha256 },
    files: fileList,
  }, null, 2) + '\n', 'utf8')

  const supportMatrix = Array.isArray(options.supportMatrix) && options.supportMatrix.length > 0
    ? options.supportMatrix
    : [{
        dsh: options.runtime && options.runtime.version ? options.runtime.version : 'unknown',
        carrier: 'web',
        os: process.platform + '-' + process.arch,
        status: 'NOT_RUN',
        evidence: 'no clean-environment installation was run for this export',
      }]
  await fs.writeFile(join(releaseDir, 'SUPPORT-MATRIX.json'), JSON.stringify({
    schema: DISTRIBUTION_SCHEMA,
    rows: supportMatrix,
  }, null, 2) + '\n', 'utf8')
  await fs.writeFile(join(releaseDir, 'SUPPORT-MATRIX.md'), renderSupportMatrix(supportMatrix), 'utf8')

  const buildLock = {
    schema: 1,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    packageManager: 'not used by the exporter',
    buildCommand: options.buildCommand || null,
    note: 'the exporter does not run package scripts; the committed build artifacts are packaged as-is',
    exportedAt: new Date().toISOString(),
  }
  await fs.writeFile(join(releaseDir, 'BUILD-LOCK.json'), JSON.stringify(buildLock, null, 2) + '\n', 'utf8')

  const report = {
    schema: DISTRIBUTION_SCHEMA,
    generatedAt: new Date().toISOString(),
    tool: { name: 'dsh-plugin-design', version: options.toolVersion || null, ruleset: options.ruleset || null },
    target: {
      name: pkg.name,
      version: pkg.version,
      sourceRoot: realRoot,
      sourceDigest: sha256(Buffer.from(fileList.map((file) => file.path + ':' + file.sha256).join('\n'), 'utf8')),
      workingTreeDirty: null,
    },
    artifacts: {
      releaseDir,
      tgzPath,
      tgzSha256,
      tgzBytes: tgz.length,
      fileList: 'FILELIST.json',
      sha256sums: 'SHA256SUMS',
      sourceDir,
    },
    runtime: options.runtime || null,
    gates: audit.gates,
    package: audit.package,
    supportMatrix,
    evidence: options.evidence || [],
    status: {
      localModification: options.localModification || 'UNKNOWN',
      distributionValidated: false,
      releasePrepared: true,
      published: false,
      publishedWhere: null,
      note: 'prepared materials only; no remote upload was performed by this tool',
    },
    hostClientNecessity: options.hostClientNecessity || null,
    installCommand: 'dsh plugin --profile <profile> add ./' + tgzName,
  }
  await fs.writeFile(join(releaseDir, 'INSTALL.md'), renderInstallDoc(pkg, report), 'utf8')
  await fs.writeFile(join(releaseDir, 'distribution-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')

  return { ok: true, releaseDir, artifacts: report.artifacts, report, audit, fileList, supportMatrix }
}

/** Hash a delivered file (used by release verification). */
export async function hashFile(path) {
  return sha256(await fs.readFile(path))
}

/** Verify a prepared release directory against its SHA256SUMS. */
export async function verifyRelease(releaseDir) {
  let sums
  try {
    sums = await fs.readFile(join(releaseDir, 'SHA256SUMS'), 'utf8')
  } catch (error) {
    return { ok: false, error: 'SHA256SUMS_MISSING' }
  }
  const checks = []
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line.trim())
    if (match === null) continue
    const [hash, relativePath] = [match[1], match[2]]
    const target = join(releaseDir, relativePath)
    try {
      const actual = hashFile(target)
      const digest = await actual
      checks.push({ path: relativePath, status: digest === hash ? 'PASS' : 'FAIL' })
    } catch (error) {
      checks.push({ path: relativePath, status: 'FAIL', detail: 'missing' })
    }
  }
  return { ok: checks.length > 0 && checks.every((check) => check.status === 'PASS'), checks }
}
