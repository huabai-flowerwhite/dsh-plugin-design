// dsh-plugin-design — conditional file mutations.
//
// The public FileSystem surface provides two compare-and-swap guards:
//   writeText(target, text, {kind:'createIfAbsent'} | {kind:'replaceIfVersion', version})
//   editText(target, edit, {version})
// A version is obtained from `stat()`, never manufactured. Every mutation in
// this plugin goes through these helpers so a change is either applied to the
// exact revision the plan approved or rejected with FS_STALE_VERSION.

import { createHash } from 'node:crypto'

export function sha256Text(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function resolvePolicy(ctx, exec) {
  try {
    const service = ctx && typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined
    if (!service || typeof service.resolve !== 'function') return undefined
    const session = exec && exec.agent ? exec.agent.session : undefined
    return service.resolve(session ? { session } : undefined)
  } catch (error) {
    return undefined
  }
}

export async function resolveTarget(service, filePath, signal) {
  return service.resolve(filePath, signal ? { signal } : undefined)
}

export async function statTarget(service, target, signal) {
  try {
    return await service.stat(target, signal)
  } catch (error) {
    return undefined
  }
}

export async function readTargetText(service, filePath, signal) {
  const target = await resolveTarget(service, filePath, signal)
  const info = await statTarget(service, target, signal)
  if (info === undefined) return { exists: false, text: null, version: null, target }
  if (info.type !== 'file') return { exists: true, text: null, version: info.version || null, target, type: info.type }
  const text = await service.readText(target, signal)
  return { exists: true, text, version: info.version || null, target, type: 'file', size: info.size }
}

function classify(error) {
  const code = error && typeof error.code === 'string' ? error.code : null
  if (code === 'FS_STALE_VERSION') return { code: 'CAS_STALE', detail: 'the file changed after it was read; re-plan before writing' }
  if (code === 'FS_NOT_OBSERVED') return { code: 'CAS_TARGET_EXISTS', detail: 'createIfAbsent refused: the target already exists' }
  if (code === 'FS_SANDBOX_DENIED') return { code: 'POLICY_DENIED', detail: 'the session sandbox policy denied this write; the plugin never falls back to a wider transport' }
  if (code === 'ENOENT') return { code: 'TARGET_MISSING', detail: 'the target no longer exists' }
  return { code: 'WRITE_FAILED', detail: String(error && error.message ? error.message : error) }
}

/**
 * Edit text with a compare-and-swap guard.
 * @returns {{ok: true, before: string, after: string, version: string|null, cas: string} | {ok: false, code: string, detail: string}}
 */
export async function editTextCas(service, filePath, edit, options = {}) {
  const signal = options.signal
  const target = await resolveTarget(service, filePath, signal)
  const info = await statTarget(service, target, signal)
  if (info === undefined) return { ok: false, code: 'TARGET_MISSING', detail: 'file does not exist' }
  const version = info.version || null
  const expected = version === null ? undefined : { version }
  try {
    const outcome = await service.editText(target, edit, expected, signal, options.policy)
    return {
      ok: true,
      before: typeof outcome?.before === 'string' ? outcome.before : null,
      after: typeof outcome?.after === 'string' ? outcome.after : null,
      version: outcome && outcome.version ? String(outcome.version) : null,
      cas: version === null ? 'post-verify' : 'fs-version',
    }
  } catch (error) {
    const mapped = classify(error)
    return { ok: false, ...mapped }
  }
}

/**
 * Write full text with an explicit create/replace guard.
 * @returns {{ok: true, version: string|null, cas: string} | {ok: false, code: string, detail: string}}
 */
export async function writeTextCas(service, filePath, content, options = {}) {
  const signal = options.signal
  const target = await resolveTarget(service, filePath, signal)
  const info = await statTarget(service, target, signal)
  const exists = info !== undefined
  if (options.create === true && exists) {
    return { ok: false, code: 'CAS_TARGET_EXISTS', detail: 'create refused: the target already exists' }
  }
  if (options.create !== true && !exists) {
    return { ok: false, code: 'TARGET_MISSING', detail: 'replace refused: the target does not exist (use create)' }
  }
  if (options.expectedHash !== undefined && options.expectedHash !== null && exists) {
    const current = await readTargetText(service, filePath, signal)
    if (current.text === null || sha256Text(current.text) !== options.expectedHash) {
      return { ok: false, code: 'CAS_STALE', detail: 'content hash differs from the approved revision' }
    }
  }
  const expected = options.create === true
    ? { kind: 'createIfAbsent' }
    : (info.version ? { kind: 'replaceIfVersion', version: info.version } : undefined)
  try {
    const outcome = await service.writeText(target, content, expected, signal, options.policy)
    return {
      ok: true,
      version: outcome && outcome.version ? String(outcome.version) : null,
      cas: expected === undefined ? 'post-verify' : 'fs-version',
    }
  } catch (error) {
    const mapped = classify(error)
    return { ok: false, ...mapped }
  }
}
