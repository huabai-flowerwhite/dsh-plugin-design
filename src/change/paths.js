// dsh-plugin-design — path, identity and containment helpers.
//
// Paths are the main authorization boundary of the change pipeline, so they
// are all handled here rather than with ad-hoc `startsWith` checks:
//   - canonical identity (realpath + Windows case folding),
//   - separator-aware containment (never a raw string prefix),
//   - npm package-name validation before anything is embedded in YAML or
//     resolved from a profile,
//   - reparse-point (junction/symlink) detection for files we are about to
//     back up or write.

import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

/** Fold case on Windows so two spellings of one path compare equal. */
export function pathKey(value) {
  const text = String(value)
  return process.platform === 'win32' ? text.toLowerCase() : text
}

/** Whether `child` is the same as, or below, `parent` (both canonical). */
export function isInside(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false
  if (parent === '' || child === '') return false
  const left = pathKey(normalize(resolve(parent)))
  const right = pathKey(normalize(resolve(child)))
  if (left === right) return true
  const prefix = left.endsWith(sep) ? left : left + sep
  return right.startsWith(prefix)
}

/** Canonical absolute identity of an existing path (best effort). */
export function canonicalPath(target) {
  const absolute = resolve(String(target))
  try {
    return realpathSync.native(absolute)
  } catch (error) {
    // A path that does not exist yet: canonicalize the closest existing
    // ancestor so `..` and junction redirections in the parent still count.
    let ancestor = absolute
    const tail = []
    for (let depth = 0; depth < 64; depth += 1) {
      if (existsSync(ancestor)) {
        try {
          const real = realpathSync.native(ancestor)
          return tail.length === 0 ? real : join(real, ...tail.reverse())
        } catch (inner) {
          return absolute
        }
      }
      const parent = dirname(ancestor)
      if (parent === ancestor) return absolute
      tail.push(basename(ancestor))
      ancestor = parent
    }
    return absolute
  }
}

/** Whether the path itself (not its target) is a reparse point. */
export function isReparsePoint(target) {
  try {
    const info = lstatSync(target)
    return info.isSymbolicLink() || (typeof info.isSymbolicLink === 'function' && info.isSymbolicLink())
  } catch (error) {
    return false
  }
}

/** Real target of a reparse point, or null. */
export function reparseTarget(target) {
  try {
    return realpathSync.native(target)
  } catch (error) {
    return null
  }
}

/**
 * Assert that `target` lives inside `root` after canonicalization and that no
 * component between them is a reparse point escaping the root.
 * @returns {{ok: true, path: string, canonical: string} | {ok: false, error: string, detail: object}}
 */
export function resolveInside(root, target, options = {}) {
  const label = typeof options.label === 'string' ? options.label : 'path'
  if (typeof target !== 'string' || target.trim() === '') {
    return { ok: false, error: 'INVALID_PATH', detail: { label, reason: 'empty path' } }
  }
  if (typeof root !== 'string' || root.trim() === '') {
    return { ok: false, error: 'INVALID_ROOT', detail: { label, reason: 'plugin root is required' } }
  }
  const raw = target.trim()
  if (process.platform === 'win32' && /^\\\\[.?]\\/.test(raw)) {
    return { ok: false, error: 'PATH_OUTSIDE_ROOT', detail: { label, reason: 'device path is not allowed' } }
  }
  if (/^[A-Za-z]:[^\\/]/.test(raw)) {
    return { ok: false, error: 'INVALID_PATH', detail: { label, reason: 'drive-relative path is ambiguous' } }
  }
  const canonicalRoot = canonicalPath(root)
  const absolute = isAbsolute(raw) ? normalize(raw) : resolve(canonicalRoot, raw)
  const canonical = canonicalPath(absolute)
  if (!isInside(canonicalRoot, canonical)) {
    return {
      ok: false,
      error: 'PATH_OUTSIDE_ROOT',
      detail: { label, root: canonicalRoot, path: canonical, reason: 'resolved path escapes the plugin root' },
    }
  }
  if (options.rejectReparse === true) {
    const parts = relative(canonicalRoot, canonical).split(/[\\/]/).filter(Boolean)
    let cursor = canonicalRoot
    for (const part of parts) {
      cursor = join(cursor, part)
      if (isReparsePoint(cursor)) {
        const real = reparseTarget(cursor)
        if (real === null || !isInside(canonicalRoot, real)) {
          return {
            ok: false,
            error: 'PATH_REPARSE_ESCAPE',
            detail: { label, root: canonicalRoot, link: cursor, target: real, reason: 'junction/symlink leaves the plugin root' },
          }
        }
      }
    }
  }
  return { ok: true, path: absolute, canonical }
}

const PLAIN_NAME = /^[a-z0-9][a-z0-9._~-]*$/
const SCOPE_PART = /^[a-z0-9][a-z0-9._~-]*$/

/**
 * Validate an npm package name / Cordis loader source identity.
 * Rejects uppercase, control characters, whitespace, extra path separators,
 * leading `.`/`_`, over-long names and scope-relative injections — all of
 * which previously reached the YAML serializer verbatim.
 */
export function validatePackageName(name) {
  if (typeof name !== 'string') return { ok: false, reason: 'package name must be a string' }
  const value = name.trim()
  if (value === '') return { ok: false, reason: 'package name is empty' }
  if (value !== name) return { ok: false, reason: 'package name has leading or trailing whitespace' }
  if (value.length > 214) return { ok: false, reason: 'package name is longer than 214 characters' }
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, reason: 'package name contains control characters' }
  const scoped = value.startsWith('@')
  if (scoped) {
    const parts = value.slice(1).split('/')
    if (parts.length !== 2) return { ok: false, reason: 'scoped package name must be @scope/name' }
    for (const part of parts) {
      if (!SCOPE_PART.test(part)) return { ok: false, reason: 'scope/name contains an illegal character' }
    }
    return { ok: true, name: value, scoped: true }
  }
  if (value.includes('/') || value.includes('\\')) return { ok: false, reason: 'package name contains a path separator' }
  if (!PLAIN_NAME.test(value)) return { ok: false, reason: 'package name is not a valid lowercase npm name' }
  if (value.startsWith('.') || value.startsWith('_')) return { ok: false, reason: 'package name starts with . or _' }
  return { ok: true, name: value, scoped: false }
}

/** Escape one YAML single-quoted scalar (only `'` needs doubling). */
export function yamlSingleQuoted(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/**
 * One loader row as YAML. Only validated identities may reach this function;
 * `id` and `name` are separate fields, and the display name is quoted.
 */
export function mountRowYaml(packageName, label, options = {}) {
  const validated = validatePackageName(packageName)
  if (!validated.ok) throw new Error('refusing to render a mount row: ' + validated.reason)
  const display = typeof label === 'string' && label.trim() !== '' ? label.trim() : packageName
  const disabled = options.disabled === true
  const lines = [
    '# ' + packageName + ' — mount row written by dsh-plugin-design',
    '- insert:',
    '    - id: ' + packageName,
    '      name: ' + yamlSingleQuoted(display),
  ]
  if (disabled) lines.push('      disabled: true')
  return lines.join('\n') + '\n'
}

/** Stable short identifier for a plugin root, used to name durable state. */
export function stateId(canonicalRoot) {
  let hash = 0
  const text = pathKey(canonicalRoot)
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0') + '-' + basename(canonicalRoot).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
}
