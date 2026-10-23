// Profile / desktop-deployment helpers.
//
// The desktop app loads C:\Users\<user>\.dsh\profiles\desktop, while the web
// build loads ...\profiles\web. A package mounted only in one profile is
// invisible to the other, and dsh-client-modules only discovers client halves
// for entries that are actually mounted in the running Loader.

import { appendFileSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const TARGET_PROFILE = 'desktop'
export const COMPARE_PROFILES = ['desktop', 'web']

/** Resolve the DSH home directory without relying on a shell. */
export function resolveDshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : null
  if (configured !== null) return resolve(configured)
  const home = typeof env.USERPROFILE === 'string' && env.USERPROFILE.trim() !== ''
    ? env.USERPROFILE
    : (typeof env.HOME === 'string' && env.HOME.trim() !== '' ? env.HOME : homedir())
  return join(home, '.dsh')
}

/** Parse `- id: ... / name: ...` rows from a Cordis patch file. */
export function parseMountRows(patchText) {
  if (typeof patchText !== 'string') return []
  const rows = []
  let current = null
  const lines = patchText.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const idMatch = /^\s*-\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(lines[index])
    if (idMatch !== null) {
      current = { id: idMatch[1], name: null, line: index + 1 }
      rows.push(current)
      continue
    }
    if (current !== null) {
      const nameMatch = /^\s*name:\s*['"]?([^'"]+)['"]?\s*$/.exec(lines[index])
      if (nameMatch !== null && current.name === null) current.name = nameMatch[1]
    }
  }
  return rows
}

/** Resolve a package from a profile directory the same way the Loader does. */
export function resolvePackageFromProfile(profileDir, packageName) {
  if (typeof profileDir !== 'string' || typeof packageName !== 'string') return null
  try {
    const requireFromProfile = createRequire(join(profileDir, '__dsh_profile_probe__.js'))
    const manifest = requireFromProfile.resolve(packageName + '/package.json')
    return dirname(manifest)
  } catch (error) {
    // Fall back to the conventional node_modules locations.
  }
  const candidates = [
    join(profileDir, 'node_modules', packageName),
    join(profileDir, '..', 'node_modules', packageName),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(join(candidate, 'package.json')) && statSync(candidate).isDirectory()) return resolve(candidate)
    } catch (error) {
      // ignore unreadable candidates
    }
  }
  return null
}

/** Inspect one profile's patch and package resolution for a package. */
export function inspectProfile(dshHome, profile, packageName) {
  const profilePath = join(dshHome, 'profiles', profile)
  const patchPath = join(profilePath, 'cordis.patch.yml')
  let patchRaw = null
  try {
    patchRaw = readFileSync(patchPath, 'utf8')
  } catch (error) {
    patchRaw = null
  }
  const rows = patchRaw === null ? [] : parseMountRows(patchRaw)
  const row = rows.find((candidate) => candidate.id === packageName || candidate.name === packageName) || null
  const packagePath = resolvePackageFromProfile(profilePath, packageName)
  return {
    profile,
    profilePath,
    patchPath,
    patchExists: patchRaw !== null,
    mounted: row !== null,
    row,
    packageResolvable: packagePath !== null,
    packagePath,
  }
}

/** Compare desktop/web mounts for one package. Desktop is the default target. */
export function inspectDeployment(packageName, options = {}) {
  const dshHome = options.dshHome || resolveDshHome()
  const desktop = inspectProfile(dshHome, 'desktop', packageName)
  const web = inspectProfile(dshHome, 'web', packageName)
  return {
    packageName,
    dshHome,
    target: TARGET_PROFILE,
    desktop,
    web,
    needsDesktopMount: desktop.mounted !== true,
    needsPackageResolution: desktop.packageResolvable !== true,
    mountRow: mountRowYaml(packageName, packageName),
  }
}

/** Exact YAML block to append to the desktop profile. */
export function mountRowYaml(packageName, label) {
  const safeLabel = String(label || packageName).replace(/'/g, "''")
  return '# ' + packageName + ' — mounted by dsh-plugin-design\n'
    + '- insert:\n'
    + '    - id: ' + packageName + '\n'
    + "      name: '" + safeLabel + "'\n"
}

/**
 * Append a desktop mount row. `apply` must be explicit; the caller decides
 * whether to write. Returns a backup path and restart/verify instructions.
 */
export function ensureDesktopMount(packageName, options = {}) {
  const dshHome = options.dshHome || resolveDshHome()
  const deployment = inspectDeployment(packageName, { dshHome })
  const dryRun = options.apply !== true
  if (deployment.desktop.mounted) {
    return { applied: false, alreadyMounted: true, deployment, restartRequired: false }
  }
  if (!deployment.desktop.patchExists) {
    return { applied: false, error: 'desktop profile patch not found: ' + deployment.desktop.patchPath, deployment }
  }
  if (dryRun) {
    return {
      applied: false,
      dryRun: true,
      deployment,
      patchPath: deployment.desktop.patchPath,
      append: deployment.mountRow,
      note: 'Pass apply: true to write the row; back up the patch first.',
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = deployment.desktop.patchPath + '.bak-dshpd-' + stamp
  copyFileSync(deployment.desktop.patchPath, backupPath)
  let current = ''
  try { current = readFileSync(deployment.desktop.patchPath, 'utf8') } catch (error) { current = '' }
  const prefix = current.endsWith('\n') || current === '' ? '' : '\n'
  appendFileSync(deployment.desktop.patchPath, prefix + deployment.mountRow, 'utf8')
  return {
    applied: true,
    alreadyMounted: false,
    deployment: inspectDeployment(packageName, { dshHome }),
    backupPath,
    patchPath: deployment.desktop.patchPath,
    restartRequired: true,
    verify: 'Restart the desktop app, then run dshpd_ui_check — runtime.inGraph must be true.',
  }
}
