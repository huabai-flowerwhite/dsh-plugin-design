// dsh-plugin-design — deployment adapter.
//
// Rule: this plugin never writes a profile file itself. Deployment goes through
// the official `pluginManager` host service when it is composed; when it is
// not, the tool returns a dry-run plan plus the exact supported command and
// refuses to apply. That is the M1-01 fix: there is no code path here that
// appends to `profiles/<name>/cordis.patch.yml`.
//
// The adapter keeps the official result vocabulary intact:
// `applied | overridden | restart-required | failed | cancelled`, plus the
// `restore` result of an update. It never rewrites `restart-required` into a
// success or a failure.
//
// Capability note (DSH 0.2.1-rc.3 release build): the packaged
// plugin-manager exposes listBundles / listPlugins / installBundle /
// removeBundle / setBundleEnabled / setPluginEnabled / inspect / registries /
// waitForInstall / cancelInstall, but NOT `updateBundle` or `listVersions`
// (those exist only in the later research branch). Update is therefore a
// capability probe, never a hard requirement: when `updateBundle` is absent
// the supported path is `installBundle` with an exact spec (the same
// transaction the CLI uses), and the adapter reports the missing method
// instead of pretending an update API exists.

import { inspectDeployment, deploymentStates } from './profiles.js'

/** Methods that must exist for any deployment to be attempted. */
export const REQUIRED_METHODS = [
  'listBundles', 'installBundle', 'removeBundle', 'setBundleEnabled',
]

/** Methods probed but not required; absence is reported, never guessed around. */
export const OPTIONAL_METHODS = [
  'listPlugins', 'setPluginEnabled', 'updateBundle', 'listVersions', 'inspect', 'registries',
  'waitForInstall', 'cancelInstall', 'readBundleDetail', 'listVersionExemptions', 'setVersionExemption',
]

/** Capability name -> the exact service method that provides it. */
const CAPABILITY_METHODS = {
  install: 'installBundle',
  remove: 'removeBundle',
  enable: 'setBundleEnabled',
  update: 'updateBundle',
  versionDiscovery: 'listVersions',
  pluginEnable: 'setPluginEnabled',
  inventory: 'listBundles',
  inspection: 'inspect',
}

const CAPABILITY_SOURCE = {
  updateBundle: 'not exposed by the DSH 0.2.1-rc.3 release plugin-manager; '
    + 'installBundle with an exact spec (or the official CLI) is the supported path',
  listVersions: 'not exposed by the DSH 0.2.1-rc.3 release plugin-manager; '
    + 'the official CLI resolves versions, this Host tool reports UNSUPPORTED instead of inventing one',
}

function capabilityMap(present) {
  const capabilities = {}
  for (const [name, method] of Object.entries(CAPABILITY_METHODS)) {
    capabilities[name] = present.includes(method)
  }
  return capabilities
}

/** Probe the host for a supported management service. */
export function detectDeploymentAdapter(ctx) {
  const get = (name) => {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch (error) {
      return undefined
    }
  }
  const manager = get('pluginManager')
  if (manager !== undefined && manager !== null) {
    const present = [...new Set([...REQUIRED_METHODS, ...OPTIONAL_METHODS])]
      .filter((name) => typeof manager[name] === 'function')
    const missingRequired = REQUIRED_METHODS.filter((name) => !present.includes(name))
    const unsupported = OPTIONAL_METHODS.filter((name) => !present.includes(name)).map((name) => ({
      method: name,
      status: 'UNSUPPORTED',
      reason: CAPABILITY_SOURCE[name] || 'not exposed by this plugin-manager build',
    }))
    const capabilities = capabilityMap(present)
    if (missingRequired.length === 0) {
      return {
        available: true,
        source: 'pluginManager',
        service: 'pluginManager',
        methods: present,
        required: REQUIRED_METHODS,
        missingRequired: [],
        optional: Object.fromEntries(OPTIONAL_METHODS.map((name) => [name, present.includes(name)])),
        capabilities,
        unsupported,
        plane: 'host',
        note: 'official PluginManager service (takes the profile writer lock and returns ChangeResult); '
          + 'deployment uses installBundle/removeBundle/setBundleEnabled, update is capability-probed',
      }
    }
    return {
      available: false,
      source: 'pluginManager',
      service: 'pluginManager',
      methods: present,
      required: REQUIRED_METHODS,
      missingRequired,
      missing: missingRequired,
      optional: Object.fromEntries(OPTIONAL_METHODS.map((name) => [name, present.includes(name)])),
      capabilities,
      unsupported,
      plane: 'host',
      reason: 'the pluginManager service is composed but misses required methods: ' + missingRequired.join(', '),
    }
  }
  const inventory = get('pluginInventory')
  return {
    available: false,
    source: 'none',
    plane: 'host',
    methods: [],
    required: REQUIRED_METHODS,
    missingRequired: REQUIRED_METHODS,
    optional: Object.fromEntries(OPTIONAL_METHODS.map((name) => [name, false])),
    capabilities: capabilityMap([]),
    unsupported: [],
    inventoryAvailable: inventory !== undefined,
    reason: 'no official pluginManager service is visible from this host context; '
      + 'the plugin will not fall back to writing profile files with node:fs',
  }
}

/** Dry-run deployment plan for one package. */
export function planMount(options) {
  const packageName = options.packageName
  const dshHome = options.dshHome
  const profile = options.profile || null
  const adapter = options.adapter || detectDeploymentAdapter(options.ctx)
  const deployment = inspectDeployment(packageName, { dshHome })
  const states = deploymentStates(packageName, { dshHome, profile })
  const targetProfile = profile !== null ? deployment.profiles.find((item) => item.profile === profile) || null : null
  const blocked = []
  if (targetProfile === null && profile !== null) blocked.push('PROFILE_NOT_INITIALIZED:' + profile)
  if (targetProfile !== null && targetProfile.packageResolvable !== true) blocked.push('PACKAGE_NOT_RESOLVABLE')
  if (!adapter.available) blocked.push('DEPLOYMENT_ADAPTER_UNAVAILABLE')
  return {
    packageName,
    dshHome,
    profile,
    adapter: {
      available: adapter.available === true,
      source: adapter.source,
      reason: adapter.reason || null,
      methods: adapter.methods || [],
      required: adapter.required || REQUIRED_METHODS,
      missingRequired: adapter.missingRequired || [],
      optional: adapter.optional || {},
      capabilities: adapter.capabilities || {},
      unsupported: adapter.unsupported || [],
    },
    states,
    targetProfile: targetProfile === null ? null : {
      name: targetProfile.profile,
      dir: targetProfile.profileDir,
      patchPath: targetProfile.patchPath,
      patchSha256: targetProfile.patchSha256,
      selected: targetProfile.selected,
      enabled: targetProfile.enabled,
      packageResolvable: targetProfile.packageResolvable,
      row: targetProfile.row,
      profileBundles: targetProfile.profileBundles,
    },
    alreadySelected: targetProfile !== null && targetProfile.selected === true,
    mountRow: deployment.mountRow,
    blocked,
    applySupported: blocked.length === 0,
    officialCommand: profile === null || options.spec === undefined
      ? null
      : 'dsh plugin --profile ' + profile + ' add ' + String(options.spec),
    note: adapter.available
      ? 'apply=true delegates to the official pluginManager installBundle transaction'
        + (adapter.capabilities && adapter.capabilities.update === false
          ? '; this plugin-manager build exposes no updateBundle, so an exact installBundle spec is the supported update path'
          : '')
      : 'apply is refused without the official management service; use the official command in a terminal',
  }
}

function mapChangeResult(result, context) {
  if (result === null || typeof result !== 'object') {
    return { applied: false, status: 'failed', error: 'EMPTY_MANAGER_RESULT', context }
  }
  const application = typeof result.application === 'string' ? result.application : 'failed'
  return {
    applied: application === 'applied' || application === 'overridden' || application === 'restart-required',
    status: application,
    restartRequired: application === 'restart-required',
    restartReason: result.restartReason || null,
    changed: result.changed === true,
    stage: result.stage || null,
    target: result.target || null,
    version: result.version || null,
    error: result.error || null,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    pendingBuilds: Array.isArray(result.pendingBuilds) ? result.pendingBuilds : [],
    approvedBuilds: Array.isArray(result.approvedBuilds) ? result.approvedBuilds : [],
    restore: result.restore === undefined ? undefined : mapChangeResult(result.restore, 'restore'),
    context,
  }
}

/**
 * Apply a deployment through the official service only.
 * `spec` is a pnpm-installable spec (path, link:, tarball, registry name).
 */
export async function applyMount(options) {
  const plan = planMount(options)
  if (!plan.applySupported) {
    return {
      applied: false,
      status: 'refused',
      plan,
      error: 'DEPLOYMENT_NOT_APPLIED',
      detail: plan.blocked,
      note: plan.note,
    }
  }
  const manager = options.ctx.get('pluginManager')
  const spec = options.spec
  if (typeof spec !== 'string' || spec.trim() === '') {
    return { applied: false, status: 'refused', plan, error: 'DEPLOYMENT_SPEC_REQUIRED' }
  }
  try {
    const result = await manager.installBundle(spec.trim(), { enabled: true })
    const mapped = mapChangeResult(result, 'installBundle')
    return { ...mapped, plan }
  } catch (error) {
    return {
      applied: false,
      status: 'failed',
      plan,
      error: 'DEPLOYMENT_FAILED',
      detail: String(error && error.message ? error.message : error),
    }
  }
}

/** Remove one bundle through the official service. */
export async function removeDeployment(options) {
  const adapter = detectDeploymentAdapter(options.ctx)
  if (!adapter.available) {
    return { applied: false, status: 'refused', error: 'DEPLOYMENT_ADAPTER_UNAVAILABLE', adapter }
  }
  try {
    const result = await options.ctx.get('pluginManager').removeBundle(options.packageName)
    return mapChangeResult(result, 'removeBundle')
  } catch (error) {
    return {
      applied: false,
      status: 'failed',
      error: 'REMOVE_FAILED',
      detail: String(error && error.message ? error.message : error),
    }
  }
}

/** Official inventory, when available (used by verify/report). */
export async function inventory(ctx, profile) {
  const adapter = detectDeploymentAdapter(ctx)
  if (!adapter.available) return { available: false, reason: adapter.reason }
  try {
    const [plugins, bundles] = await Promise.all([
      ctx.get('pluginManager').listPlugins(),
      ctx.get('pluginManager').listBundles(),
    ])
    return {
      available: true,
      source: adapter.source,
      plugins: Array.isArray(plugins) ? plugins : [],
      bundles: Array.isArray(bundles) ? bundles : [],
      profile: profile || null,
    }
  } catch (error) {
    return { available: false, reason: String(error && error.message ? error.message : error) }
  }
}
