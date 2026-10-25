// Compatibility entry for the pre-1.4 profile helpers.
//
// The old module both inspected profiles and appended rows with node:fs. The
// write path is gone: deployment now goes through the official plugin manager
// (see src/deploy/adapter.js). This module only re-exports the read-only
// inspectors so older imports keep working.

import { resolveDshHome } from './runtime/fingerprint.js'
import { deploymentStates, inspectDeployment as inspectDeploymentReadOnly } from './deploy/profiles.js'

export {
  parsePatchRows as parseMountRows,
  findRow,
  resolvePackageFromProfile,
  inspectProfile,
  listProfiles,
  homePatchLayer,
  deploymentStates,
} from './deploy/profiles.js'
export { mountRowYaml } from './change/paths.js'

/** Read-only deployment inspection with a resolved DSH home. */
export function inspectDeployment(packageName, options = {}) {
  const dshHome = options.dshHome || resolveDshHome()
  return inspectDeploymentReadOnly(packageName, { ...options, dshHome })
}

export function inspectDeploymentStates(packageName, options = {}) {
  return deploymentStates(packageName, { ...options, dshHome: options.dshHome || resolveDshHome() })
}

/**
 * Removed: writing a profile row is not a plugin concern. Kept as a hard
 * failure so an old caller cannot silently write with stale assumptions.
 */
export function ensureDesktopMount() {
  return {
    applied: false,
    error: 'DEPRECATED_WRITE_PATH',
    detail: 'ensureDesktopMount was removed; deploy through the official pluginManager '
      + '(dshpd_mount with apply=true and an approvalToken) or run `dsh plugin --profile <name> add <spec>`',
  }
}

export const TARGET_PROFILE = null
export const COMPARE_PROFILES = []
