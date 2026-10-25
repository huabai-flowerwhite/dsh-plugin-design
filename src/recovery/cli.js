// dsh-plugin-design — standalone recovery CLI.
//
// This entry point deliberately does not import the Host plugin, the rule
// engine or the audited plugin: it must keep working when DSH cannot boot or
// when the plugin's host entry is broken. It reads the plugin-design state root
// directly, validates snapshot ownership and payload hashes, previews the
// restore, and only then writes.
//
// Exit codes: 0 success, 1 failure, 2 partial/conflict, 64 usage error.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { pathKey } from '../change/paths.js'
import { readJournal, recoveryRequired } from '../change/journal.js'
import {
  isSafeBackupId, loadSnapshot, previewRestore, restoreSnapshot, verifySnapshotPayloads,
} from '../change/snapshot.js'
import { resolveStateRoot } from '../runtime/fingerprint.js'
import { inspectDeployment } from '../deploy/profiles.js'
import { NodeFileSystem } from './node-fs-service.js'

const HELP = `dshpd-recover — offline recovery for dsh-plugin-design operations

Usage:
  dshpd-recover --state-root <dir> --list
  dshpd-recover --state-root <dir> --show <backupId>
  dshpd-recover --state-root <dir> --verify <backupId>
  dshpd-recover --state-root <dir> --preview <backupId>
  dshpd-recover --state-root <dir> --restore <backupId> --yes
  dshpd-recover --state-root <dir> --operations [--limit N]
  dshpd-recover --undo-enable --dsh-home <dir> --profile <name> <packageName>

Options:
  --state-root <dir>   plugin-design state root (default: $DSH_HOME/plugin-design-state)
  --dsh-home <dir>     DSH home for --undo-enable (default: $DSH_HOME)
  --json               machine-readable output (default)
  --yes                confirm a restore
  -h, --help           this text

Notes:
  * --restore refuses to overwrite a file that changed after the last applied
    revision; such files are reported as conflicts and left untouched.
  * --undo-enable only prints the official uninstall plan; it never edits a
    profile itself.
`

function parseArgs(argv) {
  const out = { positional: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      out.positional.push(token)
      continue
    }
    const name = token.slice(2)
    if (name === 'help' || name === 'json' || name === 'yes' || name === 'list' || name === 'operations' || name === 'undo-enable') {
      out[name] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      out[name] = true
      continue
    }
    out[name] = value
    index += 1
  }
  return out
}

async function readdirSafe(path) {
  try {
    return await fs.readdir(path, { withFileTypes: true })
  } catch (error) {
    return []
  }
}

/**
 * The Host keeps one state directory per plugin under `<root>/plugins/<id>`;
 * the CLI accepts either the state root or a plugin state directory.
 */
async function candidateStateDirs(root) {
  const dirs = [root]
  for (const entry of await readdirSafe(join(root, 'plugins'))) {
    if (entry.isDirectory()) dirs.push(join(root, 'plugins', entry.name))
  }
  return dirs
}

/** Locate the state directory that owns a backupId. */
async function resolveStateDirForBackup(root, backupId) {
  for (const dir of await candidateStateDirs(root)) {
    if (!isSafeBackupId(backupId)) continue
    try {
      await fs.stat(join(dir, 'backup', backupId, 'manifest.json'))
      return dir
    } catch (error) {
      // keep looking
    }
  }
  return root
}

async function listBackups(root) {
  const out = []
  for (const stateDir of await candidateStateDirs(root)) {
    const base = join(stateDir, 'backup')
    for (const entry of await readdirSafe(base)) {
      if (!entry.isDirectory()) continue
      const loaded = await loadSnapshot(stateDir, entry.name)
      if (!loaded.ok) {
        out.push({ backupId: entry.name, status: 'INVALID', error: loaded.error, stateDir })
        continue
      }
      out.push({
        backupId: entry.name,
        status: 'OK',
        stateDir,
        pluginRoot: loaded.manifest.pluginRoot,
        createdAt: loaded.manifest.createdAt,
        files: loaded.manifest.files.length,
        design: loaded.manifest.design ? loaded.manifest.design.path : null,
        authorization: loaded.manifest.authorization ? loaded.manifest.authorization.basis : null,
      })
    }
  }
  return out.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
}

/** Latest hash this plugin wrote for each file in one backup. */
export async function lastAppliedHashes(stateDir, backupId) {
  const records = await readJournal(stateDir, 5000)
  const map = new Map()
  for (const record of records) {
    if (!record || record.backupId !== backupId) continue
    if (record.kind !== 'apply' && record.kind !== 'write' && record.kind !== 'migrate') continue
    if (typeof record.filePath !== 'string' || typeof record.afterHash !== 'string') continue
    map.set(pathKey(record.filePath), record.afterHash)
  }
  return map
}

async function commandShow(stateRoot, backupId) {
  const stateDir = await resolveStateDirForBackup(stateRoot, backupId)
  const loaded = await loadSnapshot(stateDir, backupId)
  if (!loaded.ok) return { code: 1, body: { ok: false, error: loaded.error, detail: loaded.detail } }
  const integrity = await verifySnapshotPayloads(stateDir, loaded.manifest)
  return {
    code: integrity.ok ? 0 : 1,
    body: {
      ok: integrity.ok,
      manifest: {
        backupId,
        pluginRoot: loaded.manifest.pluginRoot,
        createdAt: loaded.manifest.createdAt,
        files: loaded.manifest.files.map((file) => ({
          path: file.path, exists: file.exists, bytes: file.bytes, sha256: file.sha256, encoding: file.encoding,
        })),
        design: loaded.manifest.design,
        authorization: loaded.manifest.authorization,
        analysis: loaded.manifest.analysis,
      },
      integrity,
    },
  }
}

async function commandPreview(stateRoot, backupId) {
  const stateDir = await resolveStateDirForBackup(stateRoot, backupId)
  const loaded = await loadSnapshot(stateDir, backupId)
  if (!loaded.ok) return { code: 1, body: { ok: false, error: loaded.error, detail: loaded.detail } }
  const integrity = await verifySnapshotPayloads(stateDir, loaded.manifest)
  if (!integrity.ok) {
    return { code: 1, body: { ok: false, error: 'SNAPSHOT_INTEGRITY_FAILED', integrity } }
  }
  const service = new NodeFileSystem()
  const hashes = await lastAppliedHashes(stateDir, backupId)
  const preview = await previewRestore({
    service,
    manifest: loaded.manifest,
    stateDir,
    lastAppliedHashes: hashes,
  })
  return { code: 0, body: { ok: true, backupId, pluginRoot: loaded.manifest.pluginRoot, preview: preview.checks } }
}

async function commandRestore(stateRoot, backupId, confirmed) {
  if (confirmed !== true) return { code: 64, body: { ok: false, error: 'CONFIRMATION_REQUIRED', detail: 'pass --yes to restore' } }
  const stateDir = await resolveStateDirForBackup(stateRoot, backupId)
  const loaded = await loadSnapshot(stateDir, backupId)
  if (!loaded.ok) return { code: 1, body: { ok: false, error: loaded.error, detail: loaded.detail } }
  const integrity = await verifySnapshotPayloads(stateDir, loaded.manifest)
  if (!integrity.ok) {
    return { code: 1, body: { ok: false, error: 'SNAPSHOT_INTEGRITY_FAILED', detail: 'no file was written', integrity } }
  }
  const service = new NodeFileSystem()
  const hashes = await lastAppliedHashes(stateDir, backupId)
  const preview = await previewRestore({
    service,
    manifest: loaded.manifest,
    stateDir,
    lastAppliedHashes: hashes,
  })
  const result = await restoreSnapshot({
    service,
    manifest: loaded.manifest,
    stateDir,
    preview,
    policy: { mode: 'danger-full-access' },
  })
  return {
    code: result.state === 'ROLLED_BACK' ? 0 : 2,
    body: { ok: result.state === 'ROLLED_BACK', state: result.state, ...result, preview: preview.checks },
  }
}

async function commandOperations(root, limit) {
  const allRecords = []
  const pending = []
  for (const stateDir of await candidateStateDirs(root)) {
    const records = await readJournal(stateDir, limit || 200)
    allRecords.push(...records)
    for (const operation of recoveryRequired(records)) pending.push({ ...operation, stateDir })
  }
  return {
    code: pending.length === 0 ? 0 : 2,
    body: {
      ok: pending.length === 0,
      stateRoot: root,
      journalRecords: allRecords.length,
      recoveryRequired: pending.map((operation) => ({
        operationId: operation.operationId,
        pluginRoot: operation.pluginRoot,
        backupId: operation.backupId,
        kind: operation.kind,
        startedAt: operation.startedAt,
        stateDir: operation.stateDir,
      })),
      recent: allRecords.slice(-20).map((record) => ({
        time: record.time, operationId: record.operationId, phase: record.phase, kind: record.kind, result: record.result || null,
      })),
    },
  }
}

async function commandUndoEnable(dshHome, profile, packageName) {
  const deployment = inspectDeployment(packageName, { dshHome })
  const target = deployment.profiles.find((item) => item.profile === profile) || null
  return {
    code: 0,
    body: {
      ok: true,
      executed: false,
      packageName,
      profile,
      state: target === null ? 'PROFILE_NOT_FOUND' : {
        selected: target.selected,
        enabled: target.enabled,
        packageResolvable: target.packageResolvable,
        patchPath: target.patchPath,
      },
      officialPlan: [
        'dsh plugin --profile ' + profile + ' remove ' + packageName,
        'restart the ' + profile + ' client and confirm the plugin surface is gone',
      ],
      note: 'this command never edits profile files; the official plugin manager owns that transaction',
    },
  }
}

/**
 * Run the CLI.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Promise<{code: number, body: object}>}
 */
export async function main(argv) {
  const args = parseArgs(argv)
  if (args.help === true) return { code: 0, body: { ok: true, help: HELP } }
  const env = process.env
  const stateDir = typeof args['state-root'] === 'string' ? args['state-root'] : resolveStateRoot({ env })
  if (args.list === true) {
    const backups = await listBackups(stateDir)
    return { code: 0, body: { ok: true, stateRoot: stateDir, backups } }
  }
  if (args.operations === true) {
    const limit = typeof args.limit === 'string' ? Number(args.limit) : 200
    return commandOperations(stateDir, Number.isFinite(limit) ? limit : 200)
  }
  if (args['undo-enable'] === true) {
    const dshHome = typeof args['dsh-home'] === 'string' ? args['dsh-home'] : env.DSH_HOME
    const profile = typeof args.profile === 'string' ? args.profile : args.positional[0]
    const packageName = typeof args.profile === 'string' ? args.positional[0] : args.positional[1]
    if (dshHome === undefined || profile === undefined || packageName === undefined) {
      return { code: 64, body: { ok: false, error: 'USAGE', detail: '--undo-enable requires --dsh-home, --profile and <packageName>' } }
    }
    return commandUndoEnable(dshHome, profile, packageName)
  }
  const backupId = typeof args.show === 'string'
    ? args.show
    : typeof args.verify === 'string'
      ? args.verify
      : typeof args.preview === 'string'
        ? args.preview
        : typeof args.restore === 'string'
          ? args.restore
          : null
  if (backupId === null) return { code: 64, body: { ok: false, error: 'USAGE', help: HELP } }
  if (typeof args.show === 'string') return commandShow(stateDir, backupId)
  if (typeof args.verify === 'string') return commandShow(stateDir, backupId)
  if (typeof args.preview === 'string') return commandPreview(stateDir, backupId)
  return commandRestore(stateDir, backupId, args.yes === true)
}
