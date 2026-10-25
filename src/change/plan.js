// dsh-plugin-design — exact change plan.
//
// A plan is the unit an approval is bound to. It records the canonical plugin
// root, the design document hash, the exact file set with the version/hash each
// file had when the plan was built, the permitted operations, the target
// profile and the runtime it was built against. `planHash` is deterministic
// over that content, so editing the design, swapping a file, moving the root or
// changing the operation set produces a different hash and the old approval no
// longer matches.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'

import { canonicalPath, pathKey, resolveInside } from './paths.js'

export const PLAN_SCHEMA = 1
export const DEFAULT_OPERATIONS = Object.freeze(['backup', 'apply', 'migrate', 'write'])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Stable JSON: object keys sorted recursively. */
export function canonicalJson(value) {
  const walk = (input) => {
    if (Array.isArray(input)) return input.map(walk)
    if (input !== null && typeof input === 'object') {
      const out = {}
      for (const key of Object.keys(input).sort()) out[key] = walk(input[key])
      return out
    }
    return input
  }
  return JSON.stringify(walk(value))
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  return null
}

/** Read design.md / design.meta.json through the agent fs service. */
export async function readDesignEvidence(service, pluginRoot, designPath, signal) {
  const containment = resolveInside(pluginRoot, designPath, { label: 'designPath', rejectReparse: true })
  if (!containment.ok) return { ok: false, error: containment.error, detail: containment.detail }
  const target = await service.resolve(containment.path)
  let text = null
  try {
    text = await service.readText(target, signal)
  } catch (error) {
    return { ok: false, error: 'DESIGN_UNREADABLE', detail: String(error && error.message ? error.message : error) }
  }
  const metaPath = containment.path.replace(/design(?:\.v\d+)?\.md$/i, 'design.meta.json')
  let meta = null
  let metaRaw = null
  if (metaPath !== containment.path) {
    try {
      const metaTarget = await service.resolve(metaPath)
      metaRaw = await service.readText(metaTarget, signal)
      meta = JSON.parse(metaRaw)
    } catch (error) {
      meta = null
    }
  }
  return {
    ok: true,
    path: containment.canonical,
    sha256: sha256(Buffer.from(text, 'utf8')),
    bytes: Buffer.byteLength(text, 'utf8'),
    metaPath: meta === null ? null : canonicalPath(metaPath),
    metaHash: metaRaw === null ? null : sha256(Buffer.from(metaRaw, 'utf8')),
    meta,
  }
}

/**
 * Build a deterministic plan.
 * @returns {{ok: true, plan: object, planHash: string} | {ok: false, error: string, detail?: object}}
 */
export async function buildPlan(options) {
  const {
    service,
    pluginRoot,
    designPath,
    files,
    operations,
    targetProfile,
    runtime,
    tool,
    signal,
  } = options
  const rootResult = resolveInside(pluginRoot, pluginRoot)
  if (!rootResult.ok) return { ok: false, error: rootResult.error, detail: rootResult.detail }
  const canonicalRoot = canonicalPath(pluginRoot)
  const design = await readDesignEvidence(service, canonicalRoot, designPath, signal)
  if (!design.ok) return { ok: false, ...design }
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: 'PLAN_FILES_REQUIRED', detail: 'an approval must list the exact files it covers' }
  }
  const unique = new Map()
  for (const filePath of files) {
    const containment = resolveInside(canonicalRoot, filePath, { label: 'file', rejectReparse: true })
    if (!containment.ok) return { ok: false, error: containment.error, detail: containment.detail }
    if (unique.has(pathKey(containment.canonical))) continue
    const target = await service.resolve(containment.path)
    const info = await service.stat(target, signal)
    let exists = info !== undefined
    let digest = null
    let bytes = 0
    let version = info && info.version ? String(info.version) : null
    if (exists) {
      if (info.type !== 'file') {
        return { ok: false, error: 'PLAN_FILE_NOT_REGULAR', detail: { path: containment.canonical } }
      }
      const raw = typeof service.readBytes === 'function'
        ? await service.readBytes(target, signal, options.fileLimit || 8 * 1024 * 1024)
        : await service.readText(target, signal)
      const buffer = toBuffer(raw)
      digest = sha256(buffer)
      bytes = buffer.length
    }
    unique.set(pathKey(containment.canonical), {
      path: containment.canonical,
      relative: containment.canonical.slice(canonicalRoot.length).replace(/^[\\/]+/, '').split('\\').join('/'),
      exists,
      sha256: digest,
      bytes,
      version,
    })
  }
  const operationList = [...new Set((Array.isArray(operations) && operations.length > 0 ? operations : DEFAULT_OPERATIONS)
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim()))].sort()
  const plan = {
    schema: PLAN_SCHEMA,
    pluginRoot: canonicalRoot,
    packageName: options.packageName || null,
    packageVersion: options.packageVersion || null,
    design: {
      path: design.path,
      sha256: design.sha256,
      bytes: design.bytes,
      metaPath: design.metaPath,
      metaHash: design.metaHash,
    },
    operations: operationList,
    targetProfile: typeof targetProfile === 'string' && targetProfile.trim() !== '' ? targetProfile.trim() : null,
    files: [...unique.values()].sort((left, right) => left.relative.localeCompare(right.relative)),
    runtime: runtime || null,
    tool: tool || null,
  }
  return { ok: true, plan, planHash: computePlanHash(plan) }
}

/** Deterministic hash of the plan content (no wall-clock fields). */
export function computePlanHash(plan) {
  return sha256(canonicalJson(plan))
}

/** Re-read the design document to prove the approved revision is unchanged. */
export async function designStillMatches(service, plan, signal) {
  const current = await readDesignEvidence(service, plan.pluginRoot, plan.design.path, signal)
  if (!current.ok) return { ok: false, error: current.error }
  if (current.sha256 !== plan.design.sha256) {
    return { ok: false, error: 'DESIGN_CHANGED', detail: 'design.md changed after approval; re-plan and approve again' }
  }
  return { ok: true }
}
