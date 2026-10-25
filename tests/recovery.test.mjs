// Standalone recovery CLI: it must work from the durable state alone, verify
// snapshots before writing, report partial/conflict results accurately and
// never import the Host plugin or the audited plugin.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { main } from '../src/recovery/cli.js'
import { createHarness, tempDir, writeProfile } from './helpers/harness.mjs'

function copyFixture(name) {
  const root = tempDir('dshpd-recovery-')
  const work = join(root, 'plugin')
  cpSync(join('tests', 'fixtures', name), work, { recursive: true })
  return work
}

async function makeBackup(harness, work, file) {
  const files = [file]
  const design = await harness.call('dshpd_design', { pluginPath: work })
  const plan = await harness.call('dshpd_plan', { pluginPath: work, designPath: design.designPath, files, operations: ['backup', 'apply'] })
  const approval = await harness.call('dshpd_approve', {
    pluginPath: work, designPath: design.designPath, files, operations: ['backup', 'apply'], planHash: plan.planHash,
  })
  assert.equal(approval.ok, true, JSON.stringify(approval))
  const backup = await harness.call('dshpd_backup', { approvalToken: approval.approvalToken, pluginPath: work })
  assert.equal(backup.ok, true, JSON.stringify(backup))
  return { backup, approval, design }
}

test('recovery lists, verifies and previews a snapshot without the Host plugin', async () => {
  const harness = createHarness()
  const work = copyFixture('modern-plugin')
  const file = join(work, 'README.md')
  const { backup, approval } = await makeBackup(harness, work, file)
  const { stateRoot } = harness
  try {
    const list = await main(['--state-root', stateRoot, '--list'])
    assert.equal(list.code, 0)
    assert.equal(list.body.backups.length, 1)
    assert.equal(list.body.backups[0].backupId, backup.backupId)
    assert.equal(list.body.backups[0].pluginRoot, backup.pluginRoot)
    const verify = await main(['--state-root', stateRoot, '--verify', backup.backupId])
    assert.equal(verify.code, 0, JSON.stringify(verify.body))
    assert.equal(verify.body.integrity.ok, true)
    const applied = await harness.call('dshpd_apply', {
      approvalToken: approval.approvalToken, pluginPath: work, backupId: backup.backupId,
      filePath: file, oldText: '# modern-plugin (fixture)', newText: '# modern-plugin (recovered)',
    })
    assert.equal(applied.ok, true, JSON.stringify(applied))
    const preview = await main(['--state-root', stateRoot, '--preview', backup.backupId])
    assert.equal(preview.code, 0, JSON.stringify(preview.body))
    assert.equal(preview.body.preview[0].action, 'restore')
    const restore = await main(['--state-root', stateRoot, '--restore', backup.backupId, '--yes'])
    assert.equal(restore.code, 0, JSON.stringify(restore.body))
    assert.equal(restore.body.state, 'ROLLED_BACK')
    assert.match(readFileSync(file, 'utf8'), /modern-plugin \(fixture\)/)
  } finally {
    harness.close()
  }
})

test('recovery refuses to restore when a payload hash no longer matches', async () => {
  const harness = createHarness()
  const work = copyFixture('modern-plugin')
  const file = join(work, 'README.md')
  const { backup, approval } = await makeBackup(harness, work, file)
  try {
    await harness.call('dshpd_apply', {
      approvalToken: approval.approvalToken, pluginPath: work, backupId: backup.backupId,
      filePath: file, oldText: '# modern-plugin (fixture)', newText: '# edited',
    })
    const manifest = JSON.parse(readFileSync(join(backup.backupDir, 'manifest.json'), 'utf8'))
    const payload = join(backup.backupDir, 'files', manifest.files[0].payload)
    writeFileSync(payload, 'tampered')
    const verify = await main(['--state-root', harness.stateRoot, '--verify', backup.backupId])
    assert.equal(verify.code, 1)
    assert.equal(verify.body.ok, false)
    const restore = await main(['--state-root', harness.stateRoot, '--restore', backup.backupId, '--yes'])
    assert.equal(restore.code, 1)
    assert.equal(restore.body.error, 'SNAPSHOT_INTEGRITY_FAILED')
    assert.match(readFileSync(file, 'utf8'), /# edited/)
  } finally {
    harness.close()
  }
})

test('recovery leaves a user-modified file untouched and exits with a conflict', async () => {
  const harness = createHarness()
  const work = copyFixture('modern-plugin')
  const file = join(work, 'README.md')
  const { backup, approval } = await makeBackup(harness, work, file)
  try {
    await harness.call('dshpd_apply', {
      approvalToken: approval.approvalToken, pluginPath: work, backupId: backup.backupId,
      filePath: file, oldText: '# modern-plugin (fixture)', newText: '# edited',
    })
    writeFileSync(file, readFileSync(file, 'utf8') + '\nuser edit\n', 'utf8')
    const restore = await main(['--state-root', harness.stateRoot, '--restore', backup.backupId, '--yes'])
    assert.equal(restore.code, 2)
    assert.equal(restore.body.state, 'ROLLBACK_CONFLICT')
    assert.match(readFileSync(file, 'utf8'), /user edit/)
  } finally {
    harness.close()
  }
})

test('recovery reports operations whose journal has a prepare but no terminal record', async () => {
  const harness = createHarness()
  const work = copyFixture('modern-plugin')
  const file = join(work, 'README.md')
  const { backup } = await makeBackup(harness, work, file)
  try {
    const status = await harness.call('dshpd_status', { pluginPath: work })
    const journal = join(status.stateDir, 'journal.jsonl')
    writeFileSync(journal, readFileSync(journal, 'utf8')
      + JSON.stringify({ schema: 2, operationId: 'crashed-write', phase: 'prepare', kind: 'write', pluginRoot: work }) + '\n', 'utf8')
    const operations = await main(['--state-root', harness.stateRoot, '--operations'])
    assert.equal(operations.code, 2)
    assert.equal(operations.body.ok, false)
    assert.ok(operations.body.recoveryRequired.some((operation) => operation.operationId === 'crashed-write'))
  } finally {
    harness.close()
  }
})

test('undo-enable only prints the official plan and never edits the profile', async () => {
  const dshHome = tempDir('dshpd-undo-')
  const profileDir = writeProfile(dshHome, 'web', { rows: ["- insert:\n    - id: demo\n      name: 'demo'"], packages: { demo: '1.0.0' } })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const before = readFileSync(patchPath, 'utf8')
  const result = await main(['--undo-enable', '--dsh-home', dshHome, '--profile', 'web', 'demo'])
  assert.equal(result.code, 0, JSON.stringify(result.body))
  assert.equal(result.body.executed, false)
  assert.equal(result.body.state.selected, true)
  assert.match(result.body.officialPlan[0], /dsh plugin --profile web remove demo/)
  assert.equal(readFileSync(patchPath, 'utf8'), before)
})

test('the recovery entry does not import the Host plugin, rules or the audited package', () => {
  const source = readFileSync(new URL('../bin/dshpd-recover.mjs', import.meta.url), 'utf8')
  const cli = readFileSync(new URL('../src/recovery/cli.js', import.meta.url), 'utf8')
  for (const forbidden of ['./src/host.js', '../host.js', './rules.js', '../rules.js', 'node:child_process']) {
    assert.equal(source.includes(forbidden), false, 'entry imports ' + forbidden)
    assert.equal(cli.includes(forbidden), false, 'cli imports ' + forbidden)
  }
  assert.equal(cli.includes('dsh-plugin-design/state'), false)
  assert.equal(existsSync(new URL('../bin/dshpd-recover.mjs', import.meta.url)), true)
})
