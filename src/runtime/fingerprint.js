// dsh-plugin-design — runtime fingerprint and service-realm resolution.
//
// The 1.3.2 code trusted the caller-supplied `harnessVersion` and silently
// fell back from the agent context to the host context when resolving `fs`.
// Both are wrong in 0.2.x:
//   - the running build identity must come from the host, and a caller value
//     is only a "simulated target version";
//   - `fs` / `sandboxPolicy` are agent-plane services; an isolated preset group
//     keeps them out of plain host lookup (`agentPresets.serviceFor()` is the
//     documented retained-composition accessor).
//
// Everything here is evidence-collecting: unknown values are reported as
// `unknown` with the source that was probed, never guessed.

import { resolve as resolvePath } from 'node:path'
import { readFileSync } from 'node:fs'

export const AGENT_PLANE_SERVICES = new Set(['fs', 'sandboxPolicy', 'sessions', 'agentPresets'])

/** Resolve DSH home exactly like the rest of the plugin (explicit env wins). */
export function resolveDshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : null
  if (configured !== null) return resolvePath(configured)
  const home = typeof env.USERPROFILE === 'string' && env.USERPROFILE.trim() !== ''
    ? env.USERPROFILE
    : (typeof env.HOME === 'string' && env.HOME.trim() !== '' ? env.HOME : null)
  return home === null ? null : resolvePath(home, '.dsh')
}

/**
 * The plugin's durable state root. It deliberately lives outside the reviewed
 * plugin tree so a target plugin can never ship, delete or self-authorize its
 * own backups/approvals.
 */
export function resolveStateRoot(options = {}) {
  const env = options.env || process.env
  const override = typeof options.stateRoot === 'string' && options.stateRoot.trim() !== ''
    ? options.stateRoot.trim()
    : (typeof env.DSHPD_STATE_ROOT === 'string' && env.DSHPD_STATE_ROOT.trim() !== '' ? env.DSHPD_STATE_ROOT.trim() : null)
  if (override !== null) return resolvePath(override)
  const home = resolveDshHome(env)
  if (home !== null) return resolvePath(home, 'plugin-design-state')
  const base = env.LOCALAPPDATA || env.APPDATA || env.TMPDIR || env.TEMP || '.'
  return resolvePath(base, 'dsh-plugin-design', 'state')
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

// `npm_package_version` is only meaningful when the npm script belongs to a
// DSH runtime package. Under `npm test` in any other project it is that
// project's own version (e.g. this plugin's 1.4.x), which must never be
// reported as the running DSH build.
const DSH_NPM_PACKAGES = new Set([
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-desktop',
  '@deepseek-ai/dsh-desktop-runtime',
  '@deepseek-ai/dsh-app-boot',
  'deepseek-harness',
])

function npmRuntimeCandidate(env) {
  const name = nonEmpty(env.npm_package_name)
  const version = nonEmpty(env.npm_package_version)
  if (name === null || version === null || !DSH_NPM_PACKAGES.has(name)) return null
  return { version, source: 'env:npm_package_version' }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return null
  }
}

/**
 * Discover the running DSH build identity.
 *
 * Sources, in order:
 *   1. an explicit host service (`runtimeInfo` / `appInfo`) exposing
 *      `version`/`commit`,
 *   2. environment markers set by the launcher (`DSH_VERSION`, `DSH_COMMIT`,
 *      `DSH_RUNTIME_VERSION`),
 *   3. the packaged app manifest reachable from `process.resourcesPath`,
 *   4. `npm_package_version` only when `npm_package_name` is a known DSH
 *      package (never this plugin's own npm version).
 *
 * A caller-supplied `requested` value is reported separately as `simulated`:
 * it can describe a target build for offline checks, never the running one.
 */
export function runtimeFingerprint(options = {}) {
  const ctx = options.ctx || null
  const env = options.env || process.env
  const candidates = []
  const service = (name) => {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch (error) {
      return undefined
    }
  }
  const runtimeInfo = service('runtimeInfo') || service('appInfo') || null
  if (runtimeInfo && typeof runtimeInfo.version === 'string') {
    candidates.push({ version: runtimeInfo.version, source: 'service:runtimeInfo' })
  }
  if (nonEmpty(env.DSH_VERSION) !== null) candidates.push({ version: env.DSH_VERSION.trim(), source: 'env:DSH_VERSION' })
  if (nonEmpty(env.DSH_RUNTIME_VERSION) !== null) candidates.push({ version: env.DSH_RUNTIME_VERSION.trim(), source: 'env:DSH_RUNTIME_VERSION' })
  const resourcesPath = nonEmpty(process.resourcesPath)
  if (resourcesPath !== null) {
    // Inside Electron, fs can read paths inside app.asar; plain Node cannot.
    // The app-boot package version is the authority the official compatibility
    // check uses, so it is preferred over the outer app manifest.
    const packaged = [
      { path: ['app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'], source: 'asar:dsh-app-boot/package.json' },
      { path: ['app.asar', 'dsh', 'package.json'], source: 'asar:dsh/package.json' },
      { path: ['app.asar', 'package.json'], source: 'asar:app/package.json' },
      { path: ['app.asar.unpacked', 'package.json'], source: 'app.asar.unpacked/package.json' },
      { path: ['app', 'package.json'], source: 'app/package.json' },
    ]
    for (const candidate of packaged) {
      const manifest = readJson(resolvePath(resourcesPath, ...candidate.path))
      if (manifest !== null && typeof manifest.version === 'string' && nonEmpty(manifest.version) !== null) {
        candidates.push({ version: manifest.version.trim(), source: candidate.source })
        break
      }
    }
  }
  if (nonEmpty(env.DSH_CLIENT_VERSION) !== null) {
    candidates.push({ version: env.DSH_CLIENT_VERSION.trim(), source: 'env:DSH_CLIENT_VERSION' })
  }
  if (candidates.length === 0) {
    const npmCandidate = npmRuntimeCandidate(env)
    if (npmCandidate !== null) candidates.push(npmCandidate)
  }
  const commit = nonEmpty(env.DSH_COMMIT) || nonEmpty(env.DSH_BUILD_COMMIT) || (runtimeInfo && nonEmpty(runtimeInfo.commit)) || null
  const version = candidates.length > 0 ? candidates[0].version : null
  const requested = nonEmpty(options.requestedVersion)
  const electron = typeof process.versions.electron === 'string' ? process.versions.electron : null
  const isDesktop = electron !== null && process.resourcesPath !== undefined && env.ELECTRON_RUN_AS_NODE !== '1'
  const isEmbeddedCli = electron !== null && env.ELECTRON_RUN_AS_NODE === '1'
  async function capabilities() {
    const names = ['pluginManager', 'approval', 'clientModules', 'webServer', 'agentPresets', 'loader', 'pluginInventory', 'profileContext']
    const out = {}
    for (const name of names) {
      const value = service(name)
      out[name] = {
        present: value !== undefined && value !== null,
        methodCount: value !== null && typeof value === 'object'
          ? Object.keys(value).filter((key) => typeof value[key] === 'function').length
          : 0,
      }
    }
    return out
  }
  return {
    running: {
      version,
      versionSource: candidates.length > 0 ? candidates[0].source : 'unknown',
      candidates,
      commit,
      commitSource: commit === null ? 'unknown' : (nonEmpty(env.DSH_COMMIT) ? 'env:DSH_COMMIT' : 'service/env build marker'),
      node: process.version,
      electron,
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
      resourcesPath,
      carrier: isDesktop ? 'desktop' : isEmbeddedCli ? 'embedded-cli' : 'node',
      dshHome: resolveDshHome(env),
      stateRoot: resolveStateRoot({ env }),
      profile: nonEmpty(env.DSH_PROFILE) || null,
      cwd: process.cwd(),
      collectedAt: new Date().toISOString(),
    },
    simulated: requested === null ? null : { version: requested, source: 'caller' },
    /** Version used for compatibility checks: running build wins, else simulated. */
    effectiveVersion: version || requested,
    effectiveSource: version !== null ? 'running' : requested !== null ? 'simulated' : 'unknown',
    capabilities,
  }
}

/**
 * Resolve one service with an explicit realm record.
 *
 * Agent-plane services are resolved from the agent context first (optionally
 * through `agentPresets.serviceFor()`), and a host-realm value is *reported*
 * rather than silently substituted. Host-plane services use the plugin ctx.
 */
export function serviceWithRealm(ctx, exec, name) {
  const agent = exec && exec.agent ? exec.agent : null
  const get = (target) => {
    try {
      if (target && typeof target.get === 'function') return target.get(name)
      if (target && typeof target === 'object' && name in target) return target[name]
      return undefined
    } catch (error) {
      return undefined
    }
  }
  const hostValue = get(ctx)
  if (!AGENT_PLANE_SERVICES.has(name)) {
    return { value: hostValue, realm: 'host', verified: false, degraded: false }
  }
  const presets = get(ctx) && name === 'agentPresets' ? undefined : (() => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
    } catch (error) {
      return undefined
    }
  })()
  if (presets && agent && typeof presets.serviceFor === 'function') {
    try {
      const value = presets.serviceFor(agent, name)
      if (value !== undefined) return { value, realm: 'agent-preset', verified: true, degraded: false }
    } catch (error) {
      // fall through to the agent context
    }
  }
  if (agent) {
    const scoped = get(agent.ctx)
    if (scoped !== undefined) {
      return { value: scoped, realm: 'agent-ctx', verified: false, degraded: false }
    }
  }
  if (hostValue !== undefined) {
    return {
      value: hostValue,
      realm: 'host',
      verified: false,
      degraded: true,
      warning: name + ' resolved from the host realm; it may not belong to this agent session',
    }
  }
  return { value: undefined, realm: 'missing', verified: false, degraded: false }
}
