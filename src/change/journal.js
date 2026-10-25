// dsh-plugin-design — durable operation journal.
//
// The journal is the recovery source of truth. It lives in the plugin-design
// state root (outside the reviewed plugin tree), is append-only, and serializes
// writers with a PID lock file shared by every process using the same state
// directory. Every mutating operation writes `prepare` before touching a file
// and a terminal record (`commit`/`abort`) after; an operation whose prepare
// has no terminal record is reported as RECOVERY_REQUIRED instead of being
// silently treated as done.

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

export const JOURNAL_SCHEMA = 2
const MAX_LINES = 512
const LOCK_STALE_MS = 60_000
const LOCK_WAIT_MS = 10_000

function nowIso() {
  return new Date().toISOString()
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

/**
 * Serialize writers of one state directory. The lock is a `<dir>/.journal.lock`
 * file created exclusively and containing `pid\nISO-timestamp`. A lock whose
 * process is gone (or that is older than LOCK_STALE_MS) is taken over, so a
 * crash cannot wedge the journal forever.
 */
export async function withStateLock(stateDir, fn, options = {}) {
  await fs.mkdir(stateDir, { recursive: true })
  const lockPath = join(stateDir, '.journal.lock')
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : LOCK_WAIT_MS
  const started = Date.now()
  let handle = null
  while (handle === null) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600)
      await handle.writeFile(process.pid + '\n' + nowIso() + '\n', 'utf8')
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        let stale = false
        try {
          const raw = await fs.readFile(lockPath, 'utf8')
          const [pidLine, timeLine] = raw.split('\n')
          const pid = Number(pidLine)
          const age = Date.now() - Date.parse(timeLine || '')
          stale = !alive(pid) || (Number.isFinite(age) && age > LOCK_STALE_MS)
        } catch (inner) {
          stale = true
        }
        if (stale) {
          try {
            await fs.rm(lockPath, { force: true })
          } catch (inner) {
            // someone else won the takeover; retry
          }
          continue
        }
        if (Date.now() - started > waitMs) {
          const error = new Error('JOURNAL_LOCK_TIMEOUT: ' + lockPath)
          error.code = 'JOURNAL_LOCK_TIMEOUT'
          throw error
        }
        await sleep(25 + Math.floor(Math.random() * 50))
        continue
      }
      throw error
    }
  }
  try {
    return await fn()
  } finally {
    try {
      await handle.close()
    } catch (error) {
      // ignore
    }
    try {
      await fs.rm(lockPath, { force: true })
    } catch (error) {
      // ignore
    }
  }
}

/** Ensure the state layout exists. */
export async function ensureStateLayout(stateDir) {
  await fs.mkdir(join(stateDir, 'backup'), { recursive: true })
  await fs.mkdir(join(stateDir, 'conflict'), { recursive: true })
  await fs.mkdir(join(stateDir, 'forwards'), { recursive: true })
}

async function rotateIfNeeded(journalPath) {
  let raw = null
  try {
    raw = await fs.readFile(journalPath, 'utf8')
  } catch (error) {
    return
  }
  const lines = raw.split('\n').filter((line) => line.trim() !== '')
  if (lines.length < MAX_LINES) return
  const archive = join(dirname(journalPath), 'journal.' + Date.now() + '.jsonl')
  await fs.writeFile(archive, lines.join('\n') + '\n', 'utf8')
  await fs.writeFile(journalPath, lines.slice(-64).join('\n') + '\n', 'utf8')
}

/** Append one record under the state lock. Returns the record with `seq`. */
export async function appendJournal(stateDir, entry) {
  await ensureStateLayout(stateDir)
  const journalPath = join(stateDir, 'journal.jsonl')
  return withStateLock(stateDir, async () => {
    await rotateIfNeeded(journalPath)
    const record = {
      schema: JOURNAL_SCHEMA,
      time: nowIso(),
      pid: process.pid,
      ...entry,
    }
    await fs.appendFile(journalPath, JSON.stringify(record) + '\n', 'utf8')
    return record
  })
}

/** Read up to `limit` recent records (oldest first). */
export async function readJournal(stateDir, limit = 500) {
  const journalPath = join(stateDir, 'journal.jsonl')
  let raw = ''
  try {
    raw = await fs.readFile(journalPath, 'utf8')
  } catch (error) {
    return []
  }
  const records = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch (error) {
      records.push({ schema: JOURNAL_SCHEMA, corrupt: true, raw: line.slice(0, 400) })
    }
  }
  return records.slice(-Math.max(1, Math.min(5000, limit)))
}

/** Collapse journal records into operation state. */
export function operationStates(records) {
  const operations = new Map()
  for (const record of records) {
    if (!record || typeof record.operationId !== 'string') continue
    const current = operations.get(record.operationId) || {
      operationId: record.operationId,
      pluginRoot: record.pluginRoot || null,
      backupId: record.backupId || null,
      kind: record.kind || null,
      startedAt: record.time || null,
      state: 'PREPARED',
      records: [],
      files: [],
      errors: [],
    }
    current.records.push(record)
    if (record.pluginRoot) current.pluginRoot = record.pluginRoot
    if (record.backupId) current.backupId = record.backupId
    if (record.kind) current.kind = record.kind
    if (record.phase === 'commit') current.state = 'COMMITTED'
    else if (record.phase === 'abort') current.state = 'ABORTED'
    else if (record.phase === 'rollback') current.state = record.result || 'ROLLED_BACK'
    if (Array.isArray(record.files)) current.files.push(...record.files)
    if (Array.isArray(record.errors)) current.errors.push(...record.errors)
    operations.set(record.operationId, current)
  }
  return operations
}

/** Operations that wrote a prepare without a terminal record. */
export function recoveryRequired(records) {
  return [...operationStates(records).values()].filter((operation) => operation.state === 'PREPARED')
}

/** Allocate an operation id for one mutating call. */
export function newOperationId(prefix = 'op') {
  return prefix + '-' + randomUUID()
}

/** Convenience wrapper: emit a terminal record for an operation. */
export async function finishOperation(stateDir, operationId, phase, extra = {}) {
  return appendJournal(stateDir, {
    operationId,
    phase,
    ...extra,
  })
}
