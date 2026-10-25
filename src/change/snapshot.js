// dsh-plugin-design — byte-accurate snapshots and verified restore.
//
// 1.3.2 stored UTF-8 text copies of files inside the reviewed plugin and
// declared a rollback successful even when half of it failed. This module:
//   - records raw bytes (text, binary assets, build artifacts) plus presence,
//     size, SHA-256 and the fs version observed at capture time,
//   - writes snapshots into the plugin-design state root (outside the plugin),
//   - refuses to commit when any planned file could not be captured,
//   - verifies every payload hash before a restore starts,
//   - classifies each file as restore-safe / user-modified (conflict) /
//     already-restored, and never overwrites a user modification,
//   - reports ROLLED_BACK only when every required file was verified after the
//     write; partial and conflicted restores get their own status.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'

import { canonicalPath, isReparsePoint, pathKey, resolveInside } from './paths.js'

export const SNAPSHOT_SCHEMA = 2
export const DEFAULT_SNAPSHOT_FILE_LIMIT = 8 * 1024 * 1024
const BACKUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  return null
}

function isBinary(bytes) {
  const limit = Math.min(bytes.length, 8192)
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true
  }
  return false
}

export function isSafeBackupId(value) {
  return typeof value === 'string' && BACKUP_ID.test(value)
}

function manifestPath(stateDir, backupId) {
  return join(stateDir, 'backup', backupId, 'manifest.json')
}

function payloadDir(stateDir, backupId) {
  return join(stateDir, 'backup', backupId, 'files')
}

/** Read a file through ctx.fs as raw bytes; returns null when absent. */
async function readTargetBytes(service, target, limit, signal) {
  const info = await service.stat(target, signal)
  if (info === undefined) return { exists: false, bytes: null, version: null, size: 0 }
  if (info.type !== 'file') return { exists: true, bytes: null, version: info.version, size: info.size, error: 'NOT_A_FILE' }
  const size = typeof info.size === 'number' ? info.size : null
  if (size !== null && size > limit) {
    return { exists: true, bytes: null, version: info.version, size, error: 'SNAPSHOT_TOO_LARGE' }
  }
  let raw
  if (typeof service.readBytes === 'function') {
    raw = await service.readBytes(target, signal, limit)
  } else {
    const text = await service.readText(target, signal)
    raw = Buffer.from(text, 'utf8')
  }
  const bytes = toBuffer(raw)
  return { exists: true, bytes, version: info.version, size: bytes === null ? size : bytes.length }
}

/**
 * Capture a snapshot. All planned files are captured before anything is
 * written; a single failure removes the partial snapshot and returns an error.
 */
export async function createSnapshot(options) {
  const {
    service,
    pluginRoot,
    files,
    stateDir,
    backupId,
    design,
    authorization,
    toolVersion,
  } = options
  const signal = options.signal
  const limit = options.fileLimit || DEFAULT_SNAPSHOT_FILE_LIMIT
  if (!isSafeBackupId(backupId)) return { ok: false, error: 'INVALID_BACKUP_ID' }
  const canonicalRoot = canonicalPath(pluginRoot)
  const records = []
  const failures = []
  const unique = new Set()
  const directory = join(stateDir, 'backup', backupId)
  await fs.mkdir(payloadDir(stateDir, backupId), { recursive: true })

  for (let index = 0; index < files.length; index += 1) {
    const filePath = files[index]
    const containment = resolveInside(canonicalRoot, filePath, { label: 'file', rejectReparse: true })
    if (!containment.ok) {
      failures.push({ path: filePath, error: containment.error, detail: containment.detail })
      continue
    }
    const key = pathKey(containment.canonical)
    if (unique.has(key)) continue
    unique.add(key)
    if (isReparsePoint(containment.path)) {
      failures.push({ path: filePath, error: 'PATH_IS_REPARSE_POINT' })
      continue
    }
    let target
    try {
      target = await service.resolve(containment.path)
    } catch (error) {
      failures.push({ path: filePath, error: 'RESOLVE_FAILED', detail: String(error && error.message ? error.message : error) })
      continue
    }
    let captured
    try {
      captured = await readTargetBytes(service, target, limit, signal)
    } catch (error) {
      failures.push({ path: filePath, error: 'READ_FAILED', detail: String(error && error.message ? error.message : error) })
      continue
    }
    if (captured.error === 'SNAPSHOT_TOO_LARGE') {
      failures.push({ path: filePath, error: 'SNAPSHOT_TOO_LARGE', detail: { bytes: captured.size, limit } })
      continue
    }
    if (captured.error === 'NOT_A_FILE') {
      failures.push({ path: filePath, error: 'NOT_A_FILE' })
      continue
    }
    const record = {
      index,
      path: containment.canonical,
      relative: containment.canonical.slice(canonicalRoot.length).replace(/^[\\/]+/, '').split('\\').join('/'),
      exists: captured.exists,
      bytes: captured.exists && captured.bytes !== null ? captured.bytes.length : 0,
      sha256: captured.exists && captured.bytes !== null ? sha256(captured.bytes) : null,
      encoding: captured.exists && captured.bytes !== null ? (isBinary(captured.bytes) ? 'binary' : 'utf8') : 'absent',
      capturedVersion: captured.version || null,
      payload: null,
    }
    if (captured.exists && captured.bytes !== null) {
      const payloadName = String(index).padStart(3, '0') + '-' + basename(containment.canonical).replace(/[^A-Za-z0-9._-]/g, '_')
      await fs.writeFile(join(payloadDir(stateDir, backupId), payloadName), captured.bytes)
      record.payload = payloadName
    }
    records.push(record)
  }

  if (failures.length > 0) {
    await fs.rm(directory, { recursive: true, force: true })
    return {
      ok: false,
      error: 'SNAPSHOT_INCOMPLETE',
      detail: 'a snapshot must capture every planned file; nothing was committed',
      failures,
    }
  }

  const manifest = {
    schema: SNAPSHOT_SCHEMA,
    backupId,
    pluginRoot: canonicalRoot,
    createdAt: new Date().toISOString(),
    toolVersion: typeof toolVersion === 'string' ? toolVersion : null,
    design: design || null,
    authorization: authorization || null,
    files: records,
    analysis: options.analysis || null,
    note: 'payload files are raw bytes; sha256 is over the original bytes',
  }
  await fs.writeFile(manifestPath(stateDir, backupId), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { ok: true, manifest, stateDir, backupDir: directory }
}

/** Load and structurally validate a manifest. */
export async function loadSnapshot(stateDir, backupId) {
  if (!isSafeBackupId(backupId)) return { ok: false, error: 'INVALID_BACKUP_ID' }
  let raw
  try {
    raw = await fs.readFile(manifestPath(stateDir, backupId), 'utf8')
  } catch (error) {
    return { ok: false, error: 'MANIFEST_MISSING' }
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: 'MANIFEST_UNREADABLE', detail: String(error && error.message ? error.message : error) }
  }
  const structure = validateManifestStructure(manifest, backupId)
  if (!structure.ok) return structure
  return { ok: true, manifest, stateDir }
}

/** Validate schema, ownership fields and payload names. */
export function validateManifestStructure(manifest, backupId) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: 'MANIFEST_INVALID', detail: 'manifest is not an object' }
  }
  if (manifest.schema !== SNAPSHOT_SCHEMA) {
    return { ok: false, error: 'MANIFEST_SCHEMA_UNSUPPORTED', detail: 'schema=' + String(manifest.schema) }
  }
  if (manifest.backupId !== backupId) return { ok: false, error: 'MANIFEST_OWNERSHIP_MISMATCH', detail: 'backupId differs' }
  if (typeof manifest.pluginRoot !== 'string' || manifest.pluginRoot === '') {
    return { ok: false, error: 'MANIFEST_OWNERSHIP_MISMATCH', detail: 'pluginRoot missing' }
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { ok: false, error: 'MANIFEST_INVALID', detail: 'files missing' }
  }
  for (const record of manifest.files) {
    if (record === null || typeof record !== 'object') return { ok: false, error: 'MANIFEST_INVALID', detail: 'file record is not an object' }
    if (typeof record.path !== 'string' || !resolveInside(manifest.pluginRoot, record.path).ok) {
      return { ok: false, error: 'MANIFEST_PATH_OUTSIDE_ROOT', detail: String(record.path) }
    }
    if (record.exists === true) {
      if (typeof record.payload !== 'string' || record.payload.includes('..') || record.payload.includes('/') || record.payload.includes('\\')) {
        return { ok: false, error: 'MANIFEST_PAYLOAD_INVALID', detail: String(record.payload) }
      }
      if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) {
        return { ok: false, error: 'MANIFEST_HASH_INVALID', detail: String(record.path) }
      }
    }
  }
  return { ok: true }
}

/** Verify every payload byte against the manifest before any write. */
export async function verifySnapshotPayloads(stateDir, manifest) {
  const checks = []
  for (const record of manifest.files) {
    if (record.exists !== true) {
      checks.push({ path: record.path, status: 'PASS', detail: 'recorded as absent (create rollback)' })
      continue
    }
    let bytes
    try {
      bytes = await fs.readFile(join(payloadDir(stateDir, manifest.backupId), record.payload))
    } catch (error) {
      checks.push({ path: record.path, status: 'FAIL', detail: 'payload missing' })
      continue
    }
    const digest = sha256(bytes)
    if (digest !== record.sha256) {
      checks.push({ path: record.path, status: 'FAIL', detail: 'payload hash mismatch' })
      continue
    }
    checks.push({ path: record.path, status: 'PASS', detail: bytes.length + ' bytes' })
  }
  return { ok: checks.every((check) => check.status === 'PASS'), checks }
}

async function currentBytes(service, target, signal, limit) {
  const info = await service.stat(target, signal)
  if (info === undefined) return { exists: false, bytes: null, version: null }
  if (typeof service.readBytes === 'function') {
    const raw = await service.readBytes(target, signal, limit)
    return { exists: true, bytes: toBuffer(raw), version: info.version }
  }
  const text = await service.readText(target, signal)
  return { exists: true, bytes: Buffer.from(text, 'utf8'), version: info.version }
}

/**
 * Work out what a restore would do without writing anything.
 * `lastAppliedHash` supplies the hash this plugin last wrote for a file.
 */
export async function previewRestore(options) {
  const { service, manifest, stateDir, lastAppliedHashes, signal } = options
  const limit = options.fileLimit || DEFAULT_SNAPSHOT_FILE_LIMIT
  const checks = []
  for (const record of manifest.files) {
    const containment = resolveInside(manifest.pluginRoot, record.path, { label: 'file', rejectReparse: true })
    if (!containment.ok) {
      checks.push({ path: record.path, action: 'blocked', reason: containment.error })
      continue
    }
    let target
    try {
      target = await service.resolve(containment.path)
    } catch (error) {
      checks.push({ path: record.path, action: 'blocked', reason: 'RESOLVE_FAILED' })
      continue
    }
    const current = await currentBytes(service, target, signal, limit)
    const currentHash = current.exists && current.bytes !== null ? sha256(current.bytes) : null
    const expectedAfter = lastAppliedHashes && lastAppliedHashes.get(pathKey(record.path))
    let action
    let reason = null
    if (record.exists !== true) {
      // The file was created by this change set. The public FileSystem surface
      // has no delete operation, so removal is reported for manual action and
      // is never performed with an unrelated transport.
      if (!current.exists) action = 'noop'
      else if (expectedAfter !== undefined && currentHash === expectedAfter) action = 'manual-remove'
      else if (currentHash === null) action = 'manual-remove'
      else {
        action = 'conflict'
        reason = 'file was created by this change set but has since been edited by someone else'
      }
    } else if (!current.exists) {
      action = 'recreate'
    } else if (currentHash === record.sha256) {
      action = 'noop'
    } else if (expectedAfter !== undefined && currentHash === expectedAfter) {
      action = 'restore'
    } else if (expectedAfter === undefined) {
      action = 'conflict'
      reason = 'file differs from the snapshot and no applied revision is recorded'
    } else {
      action = 'conflict'
      reason = 'file changed after the last applied revision'
    }
    checks.push({
      path: record.path,
      action,
      reason,
      currentHash,
      snapshotHash: record.sha256,
      expectedAfterHash: expectedAfter || null,
      version: current.version || null,
      existsNow: current.exists,
    })
  }
  return { checks, stateDir }
}

async function writeTextWithCas(service, target, text, version, policy, signal) {
  const expected = version
    ? { kind: 'replaceIfVersion', version }
    : { kind: 'createIfAbsent' }
  return service.writeText(target, text, expected, signal, policy)
}

async function writeBytesAtomic(path, bytes) {
  const temporary = path + '.dshpd-' + process.pid + '-' + Date.now() + '.tmp'
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, path)
}

/**
 * Execute a restore from the preview. Never overwrites a conflicted file;
 * copies the current content to the conflict directory instead.
 * @returns {{state: string, files: object[], conflicts: object[], failures: object[]}}
 */
export async function restoreSnapshot(options) {
  const { service, manifest, stateDir, preview, policy, signal } = options
  const results = []
  const conflicts = []
  const failures = []
  const conflictDir = join(stateDir, 'conflict', manifest.backupId)
  for (const check of preview.checks) {
    if (check.action === 'blocked') {
      failures.push({ path: check.path, error: check.reason })
      continue
    }
    if (check.action === 'noop') {
      results.push({ path: check.path, status: 'UNCHANGED' })
      continue
    }
    if (check.action === 'conflict') {
      conflicts.push({ path: check.path, reason: check.reason, kept: check.path })
      continue
    }
    if (check.action === 'manual-remove') {
      conflicts.push({
        path: check.path,
        reason: 'this change set created the file; the FileSystem service has no delete operation, remove it manually after reviewing it',
        kept: check.path,
      })
      continue
    }
    const record = manifest.files.find((item) => pathKey(item.path) === pathKey(check.path))
    if (record === undefined) {
      failures.push({ path: check.path, error: 'RECORD_MISSING' })
      continue
    }
    let target
    try {
      target = await service.resolve(check.path)
    } catch (error) {
      failures.push({ path: check.path, error: 'RESOLVE_FAILED' })
      continue
    }
    if (check.action === 'delete') {
      failures.push({ path: check.path, error: 'DELETE_NOT_SUPPORTED' })
      continue
    }
    let payload
    try {
      payload = await fs.readFile(join(payloadDir(stateDir, manifest.backupId), record.payload))
    } catch (error) {
      failures.push({ path: check.path, error: 'PAYLOAD_MISSING' })
      continue
    }
    try {
      if (record.encoding === 'utf8') {
        await writeTextWithCas(service, target, payload.toString('utf8'), check.version, policy, signal)
      } else {
        // The public FileSystem surface has no binary write; binary restore is
        // an explicitly reported node:fs atomic write after the CAS precheck.
        await writeBytesAtomic(check.path, payload)
      }
      const after = await currentBytes(service, target, signal, options.fileLimit || DEFAULT_SNAPSHOT_FILE_LIMIT)
      const afterHash = after.exists && after.bytes !== null ? sha256(after.bytes) : null
      if (afterHash !== record.sha256) {
        failures.push({ path: check.path, error: 'POST_WRITE_HASH_MISMATCH' })
      } else {
        results.push({ path: check.path, status: record.encoding === 'utf8' ? 'RESTORED' : 'RESTORED_BINARY' })
      }
    } catch (error) {
      failures.push({ path: check.path, error: String(error && error.message ? error.message : error) })
      // Preserve whatever the failed write left behind for manual recovery.
      try {
        const current = await currentBytes(service, target, signal, options.fileLimit || DEFAULT_SNAPSHOT_FILE_LIMIT)
        if (current.exists && current.bytes !== null) {
          await fs.mkdir(conflictDir, { recursive: true })
          await fs.writeFile(join(conflictDir, basename(check.path)), current.bytes)
        }
      } catch (inner) {
        // best effort
      }
    }
  }
  const state = failures.length === 0 && conflicts.length === 0
    ? 'ROLLED_BACK'
    : conflicts.length > 0
      ? 'ROLLBACK_CONFLICT'
      : 'ROLLBACK_PARTIAL'
  return { state, files: results, conflicts, failures }
}
