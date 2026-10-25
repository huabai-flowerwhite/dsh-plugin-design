#!/usr/bin/env node
// Recovery drill: build a real snapshot, then drive the SHIPPED recovery CLI as
// a child process through list/verify/preview/conflict/restore.
//
// It uses only the snapshot/journal primitives plus the node:fs adapter — the
// same dependency closure the CLI has — so it proves the offline path works
// without loading the Host plugin.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { appendJournal } from '../src/change/journal.js'
import { createSnapshot, verifySnapshotPayloads } from '../src/change/snapshot.js'
import { NodeFileSystem } from '../src/recovery/node-fs-service.js'

const outDir = resolve(process.argv[2] || 'recovery-drill')
const workRoot = join(outDir, 'work')
mkdirSync(workRoot, { recursive: true })
const pluginRoot = join(workRoot, 'plugin')
cpSync(resolve('tests/fixtures/modern-plugin'), pluginRoot, { recursive: true })
const stateRoot = join(workRoot, 'state')
const stateDir = join(stateRoot, 'plugins', 'drill')
mkdirSync(stateDir, { recursive: true })

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const target = join(pluginRoot, 'README.md')
const original = readFileSync(target, 'utf8')
const service = new NodeFileSystem()
const backupId = '11111111-1111-4111-8111-111111111111'
const design = { path: join(pluginRoot, '.dsh-plugin-design', 'design.md'), sha256: sha256('drill design') }

const snapshot = await createSnapshot({
  service,
  pluginRoot,
  files: [target],
  stateDir,
  backupId,
  design,
  authorization: { basis: 'deployment-full-access', approvalOutcome: 'not-requested', channel: 'permission-preset', planHash: sha256('drill plan') },
  analysis: { issueCount: 0, blockers: 0, criticals: 0 },
  toolVersion: '1.4.0',
})
if (!snapshot.ok) {
  console.error('snapshot failed: ' + JSON.stringify(snapshot))
  process.exit(1)
}
await appendJournal(stateDir, {
  operationId: 'drill-backup', phase: 'commit', kind: 'backup', backupId, pluginRoot,
  files: snapshot.manifest.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
})

const edited = original + '\n<!-- applied by the drill -->\n'
writeFileSync(target, edited, 'utf8')
await appendJournal(stateDir, {
  operationId: 'drill-apply', phase: 'commit', kind: 'apply', backupId, pluginRoot,
  filePath: target, beforeHash: sha256(original), afterHash: sha256(edited),
})

const cli = join(process.cwd(), 'bin', 'dshpd-recover.mjs')
const run = (args) => {
  const result = spawnSync(process.execPath, [cli, '--state-root', stateRoot, ...args], { encoding: 'utf8' })
  let body = null
  try {
    body = JSON.parse(result.stdout)
  } catch (error) {
    body = { raw: result.stdout, stderr: result.stderr }
  }
  return { code: result.status, body }
}

const drill = { schema: 1, startedAt: new Date().toISOString(), steps: [] }
const record = (step, result, extra = {}) => {
  drill.steps.push({ step, exitCode: result.code, ...extra, body: result.body })
  return result
}
record('list', run(['--list']))
record('verify', run(['--verify', backupId]))
record('preview', run(['--preview', backupId]))

// 1. The user edits the file after the applied revision: restore must conflict.
writeFileSync(target, edited + '\n<!-- user edit -->\n', 'utf8')
const conflict = record('restore-with-user-edit', run(['--restore', backupId, '--yes']))
const userContentKept = readFileSync(target, 'utf8').includes('user edit')

// 2. Put the file back to the applied revision: restore must succeed.
writeFileSync(target, edited, 'utf8')
const restored = record('restore-clean', run(['--restore', backupId, '--yes']))
const restoredContent = readFileSync(target, 'utf8')

// 3. Tamper with a payload in a second snapshot: verify must fail and restore
//    must refuse to write anything.
const backupId2 = '22222222-2222-4222-8222-222222222222'
const snapshot2 = await createSnapshot({
  service, pluginRoot, files: [target], stateDir, backupId: backupId2,
  design, authorization: { basis: 'deployment-full-access' }, analysis: null, toolVersion: '1.4.0',
})
if (!snapshot2.ok) {
  console.error('second snapshot failed: ' + JSON.stringify(snapshot2))
  process.exit(1)
}
const payloadPath = join(stateDir, 'backup', backupId2, 'files', snapshot2.manifest.files[0].payload)
appendFileSync(payloadPath, '\ntampered\n')
record('verify-tampered', run(['--verify', backupId2]))
record('restore-tampered', run(['--restore', backupId2, '--yes']))
const tamperedRefused = readFileSync(target, 'utf8') === restoredContent

const summary = {
  schema: 1,
  finishedAt: new Date().toISOString(),
  stateRoot,
  pluginRoot,
  backupId,
  backupId2,
  checks: {
    listExit: drill.steps[0].exitCode,
    verifyExit: drill.steps[1].exitCode,
    previewExit: drill.steps[2].exitCode,
    conflictExit: conflict.code,
    conflictState: conflict.body.state,
    userContentKept,
    restoreExit: restored.code,
    restoreState: restored.body.state,
    restoredToOriginal: restoredContent === original,
    tamperedVerifyExit: drill.steps[5].exitCode,
    tamperedRestoreExit: drill.steps[6].exitCode,
    tamperedRefused,
  },
  steps: drill.steps,
}
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'recovery-drill.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
console.log(JSON.stringify(summary.checks, null, 2))
const ok = summary.checks.verifyExit === 0
  && summary.checks.previewExit === 0
  && summary.checks.conflictExit === 2
  && summary.checks.conflictState === 'ROLLBACK_CONFLICT'
  && summary.checks.userContentKept
  && summary.checks.restoreExit === 0
  && summary.checks.restoreState === 'ROLLED_BACK'
  && summary.checks.restoredToOriginal
  && summary.checks.tamperedVerifyExit === 1
  && summary.checks.tamperedRestoreExit === 1
  && summary.checks.tamperedRefused
console.log(ok ? 'DRILL PASS' : 'DRILL FAIL')
process.exit(ok ? 0 : 1)
