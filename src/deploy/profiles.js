// dsh-plugin-design — read-only profile/deployment inspection.
//
// 1.3.2 decided "mounted" with `/- id: x/` and then wrote the desktop patch
// itself. Both were wrong: a row can be disabled, overridden later, come from a
// bundle, or sit in a layer above the profile patch, and the writing path
// bypassed every official transaction.
//
// This module only *observes*: it parses the patch layers, resolves the package
// from the profile, reads the profile manifest and reports the distinct states
// "installed / selected / enabled", leaving "Host active / Client active" to
// runtime checks.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { mountRowYaml } from '../change/paths.js'

/** One parsed patch row (insert item or top-level override). */
export function parsePatchRows(patchText) {
  if (typeof patchText !== 'string') return []
  const rows = []
  const lines = patchText.split(/\r?\n/)
  let current = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const item = /^(\s*)-\s+id:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)
    if (item !== null) {
      current = { id: item[2], name: null, disabled: false, line: index + 1, kind: 'row' }
      rows.push(current)
      continue
    }
    if (current === null) continue
    const name = /^\s+name:\s*['"]?(.+?)['"]?\s*$/.exec(line)
    if (name !== null && current.name === null) current.name = name[1]
    if (/^\s+disabled:\s*true\s*$/.test(line)) current.disabled = true
    if (/^\s+-\s+id:/.test(line)) current = null
  }
  return rows
}

/** A patch row for one exact package name (id or loader name). */
export function findRow(rows, packageName) {
  return rows.find((row) => row.id === packageName || row.name === packageName) || null
}

/** Resolve a package from a profile the way the Loader does. */
export function resolvePackageFromProfile(profileDir, packageName) {
  if (typeof profileDir !== 'string' || typeof packageName !== 'string') return null
  try {
    const requireFromProfile = createRequire(join(profileDir, '__dsh_profile_probe__.js'))
    return requireFromProfile.resolve(packageName + '/package.json').replace(/[\\/]package\.json$/, '')
  } catch (error) {
    // fall through to conventional candidates
  }
  const candidates = [
    join(profileDir, 'node_modules', packageName),
    join(profileDir, '..', 'node_modules', packageName),
  ]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory() && existsSync(join(candidate, 'package.json'))) return resolve(candidate)
    } catch (error) {
      // ignore
    }
  }
  return null
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return null
  }
}

/** Inspect one profile without writing anything. */
export function inspectProfile(dshHome, profileName, packageName) {
  const profileDir = join(dshHome, 'profiles', profileName)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  let patchRaw = null
  try {
    patchRaw = readFileSync(patchPath, 'utf8')
  } catch (error) {
    patchRaw = null
  }
  const rows = parsePatchRows(patchRaw || '')
  const row = findRow(rows, packageName)
  const manifest = readJson(join(profileDir, 'package.json'))
  const bundles = manifest && manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles
    : []
  const dependencies = manifest && manifest.dependencies && typeof manifest.dependencies === 'object'
    ? Object.keys(manifest.dependencies)
    : []
  const packagePath = resolvePackageFromProfile(profileDir, packageName)
  return {
    profile: profileName,
    profileDir,
    patchPath,
    patchExists: patchRaw !== null,
    patchSha256: patchRaw === null ? null : createHash('sha256').update(patchRaw).digest('hex'),
    rows,
    row,
    selected: row !== null,
    enabled: row !== null && row.disabled !== true,
    packageResolvable: packagePath !== null,
    packagePath,
    profileBundles: bundles,
    profileDependencies: dependencies,
    patchReload: manifest && manifest.dsh && manifest.dsh.profile ? manifest.dsh.profile.patchReload || null : null,
  }
}

/** All profiles under DSH_HOME that contain a Cordis patch. */
export function listProfiles(dshHome) {
  const base = join(dshHome, 'profiles')
  let entries = []
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch (error) {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, dir: join(base, entry.name), patchPath: join(base, entry.name, 'cordis.patch.yml') }))
    .filter((profile) => existsSync(profile.patchPath))
}

/** Home-level patch layer that overrides every profile patch. */
export function homePatchLayer(dshHome) {
  const path = join(dshHome, 'cordis.patch.yml')
  let raw = null
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    raw = null
  }
  return { path, exists: raw !== null, rows: parsePatchRows(raw || '') }
}

/**
 * Deployment state for one package across profiles.
 * States are reported separately; nothing is collapsed into "installed".
 */
export function inspectDeployment(packageName, options = {}) {
  const dshHome = options.dshHome
  const profiles = listProfiles(dshHome)
  const inspected = profiles.map((profile) => inspectProfile(dshHome, profile.name, packageName))
  const home = homePatchLayer(dshHome)
  return {
    packageName,
    dshHome,
    profiles: inspected,
    homePatch: { path: home.path, exists: home.exists, mounted: findRow(home.rows, packageName) !== null },
    installedAnywhere: inspected.some((profile) => profile.packageResolvable),
    selectedAnywhere: inspected.some((profile) => profile.selected),
    enabledAnywhere: inspected.some((profile) => profile.enabled),
    mountRow: safeMountRow(packageName),
  }
}

function safeMountRow(packageName) {
  try {
    return mountRowYaml(packageName, packageName)
  } catch (error) {
    return null
  }
}

/** Distinct status labels used by reports instead of a single boolean. */
export function deploymentStates(packageName, options = {}) {
  const deployment = inspectDeployment(packageName, options)
  const target = options.profile || null
  const profile = target === null ? null : deployment.profiles.find((item) => item.profile === target) || null
  return {
    installed: deployment.installedAnywhere,
    selected: deployment.selectedAnywhere,
    enabled: deployment.enabledAnywhere,
    configured: profile !== null ? profile.selected : deployment.selectedAnywhere,
    hostActive: 'unknown',
    clientActive: 'unknown',
    profile: profile !== null ? {
      name: profile.profile,
      selected: profile.selected,
      enabled: profile.enabled,
      packageResolvable: profile.packageResolvable,
      row: profile.row,
      patchPath: profile.patchPath,
    } : null,
  }
}
