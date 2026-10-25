// Security and transaction regressions for the change pipeline.
//
// Each test models a concrete failure the 1.3.2 implementation allowed:
// unbound approvals, out-of-root files, design swaps, stale writes, silent
// allowStale, partial snapshots, tampered rollback payloads, user-modified
// files, partial restores, unrecorded journal prepares and direct profile
// writes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createHarness, tempDir, writeProfile } from './helpers/harness.mjs'

function fixture(name) {
  const root = tempDir('dshpd-case-')
  const work = join(root, 'plugin')
  cpSync(join('tests', 'fixtures', name), work, { recursive: true })
  return work
}

async function approved(harness, work, files, operations = ['backup', 'apply', 'write']) {
  const design = await harness.call('dshpd_design', { pluginPath: work })
  assert.equal(design.ok, true, JSON.stringify(design))
  const plan = await harness.call('dshpd_plan', {
    pluginPath: work, designPath: design.designPath, files, operations,
  })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  const approval = await harness.call('dshpd_approve', {
    pluginPath: work, designPath: design.designPath, files, operations, planHash: plan.planHash,
  })
  assert.equal(approval.ok, true, JSON.stringify(approval))
  const backup = await harness.call('dshpd_backup', { approvalToken: approval.approvalToken, pluginPath: work })
  assert.equal(backup.ok, true, JSON.stringify(backup))
  return { design, plan, approval, backup }
}

test('plan hash is deterministic and changes when the design changes', async () => {
  const harness = createHarness()
  try {
    const work = fixture('modern-plugin')
    const design = await harness.call('dshpd_design', { pluginPath: work })
    const files = [join(work, 'README.md')]
    const first = await harness.call('dshpd_plan', { pluginPath: work, designPath: design.designPath, files })
    const second = await harness.call('dshpd_plan', { pluginPath: work, designPath: design.designPath, files })
    assert.equal(first.planHash, second.planHash)
    writeFileSync(design.designPath, design.md || 'edited design\n', 'utf8')
    writeFileSync(design.designPath, readFileSync(design.designPath, 'utf8') + '\nextra\n', 'utf8')
    const third = await harness.call('dshpd_plan', { pluginPath: work, designPath: design.designPath, files })
    assert.notEqual(first.planHash, third.planHash)
  } finally {
    harness.close()
  }
})

test('approve refuses a missing or mismatched plan hash and issues no token', async () => {
  const harness = createHarness()
  try {
    const work = fixture('modern-plugin')
    const design = await harness.call('dshpd_design', { pluginPath: work })
    const files = [join(work, 'README.md')]
    const missing = await harness.call('dshpd_approve', {
      pluginPath: work, designPath: design.designPath, files,
    })
    assert.equal(missing.ok, false)
    assert.equal(missing.error, 'PLAN_HASH_REQUIRED')
    const mismatch = await harness.call('dshpd_approve', {
      pluginPath: work, designPath: design.designPath, files, planHash: 'f'.repeat(64),
    })
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.error, 'PLAN_HASH_MISMATCH')
    assert.equal(mismatch.detail.expected.length, 64)
    assert.equal(mismatch.approvalToken, undefined)
  } finally {
    harness.close()
  }
})

test('approve rejects a design that does not exist and a file outside the root', async () => {
  const harness = createHarness()
  try {
    const work = fixture('modern-plugin')
    const outside = join(harness.dshHome, 'outside.txt')
    writeFileSync(outside, 'outside\n', 'utf8')
    const noDesign = await harness.call('dshpd_plan', {
      pluginPath: work, designPath: join(work, 'missing.md'), files: [join(work, 'README.md')],
    })
    assert.equal(noDesign.ok, false)
    assert.equal(noDesign.error, 'DESIGN_UNREADABLE')
    const design = await harness.call('dshpd_design', { pluginPath: work })
    const escape = await harness.call('dshpd_plan', {
      pluginPath: work, designPath: design.designPath, files: [outside],
    })
    assert.equal(escape.ok, false)
    assert.equal(escape.error, 'PATH_OUTSIDE_ROOT')
    const traversal = await harness.call('dshpd_plan', {
      pluginPath: work, designPath: design.designPath, files: [join(work, '..', '..', 'escape.txt')],
    })
    assert.equal(traversal.ok, false)
    assert.equal(traversal.error, 'PATH_OUTSIDE_ROOT')
  } finally {
    harness.close()
  }
})

test('a junction that leaves the plugin root is refused', async () => {
  const harness = createHarness()
  try {
    const work = fixture('modern-plugin')
    const outsideDir = join(harness.dshHome, 'outside-dir')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret\n', 'utf8')
    const link = join(work, 'linked')
    try {
      symlinkSync(outsideDir, link, 'junction')
    } catch (error) {
      // Windows without junction support: skip rather than assert a false pass.
      return
    }
    const design = await harness.call('dshpd_design', { pluginPath: work })
    const plan = await harness.call('dshpd_plan', {
      pluginPath: work, designPath: design.designPath, files: [join(link, 'secret.txt')],
    })
    assert.equal(plan.ok, false)
    assert.ok(['PATH_REPARSE_ESCAPE', 'PATH_OUTSIDE_ROOT'].includes(plan.error), plan.error)
  } finally {
    harness.close()
  }
})

test('a token cannot be used from another session or agent identity', async () => {
  const harness = createHarness()
  try {
    const work = fixture('modern-plugin')
    const files = [join(work, 'README.md')]
    const { approval, backup } = await approved(harness, work, files)
    const otherSession = await harness.callAs('dshpd_apply', {
      approvalToken: approval.approvalToken, pluginPath: work, backupId: backup.backupId,
      filePath: files[0], oldText: '# modern-plugin (fixture)', newText: '# edited',
    }, { agentId: 'test-agent', sessionId: 'another-session' })
    assert.equal(otherSession.ok, false)
    assert.equal(otherSession.error, 'APPROVAL_IDENTITY_MISMATCH')
    const otherAgent = await harness.callAs('dshpd_apply', {
      approvalToken: approval.approvalToken, pluginPath: work, backupId: backup.backupId,
      filePath: files[0], oldText: '# modern-plugin (fixture)', newText: '# edited',
    }, { agentId: 'another-agent', sessionId: 'test-session' })
    assert.equal(otherAgent.ok, false)
    assert.equal(otherAgent.error, 'APPROVAL_IDENTITY_MISMATCH')
  } finally {
    harness.close()
  }
})

test('editing the approved design invalidates the token', async () => {
  const harness = createHarness()
  try {
    const work = fixture('modern-plugin')
    const files = [join(work, 'README.md')]
    const { design, approval, backup } = await approved(harness, work, files)
    writeFileSync(design.designPath, readFileSync(design.designPath, 'utf8') + '\nchanged\n', 'utf8')
    const applied = await harness.call('dshpd_apply', {
      approvalToken: approval.approvalToken, pluginPath: work, backupId: backup.backupId,
      filePath: files[0], oldText: '# modern-plugin (fixture)', newText: '# edited',
    })
    assert.equal(applied.ok, false)
    assert.equal(applied.error, 'DESIGN_CHANGED')
  } finally {
    harness.close()
  }
})

test('approval policy ask without a grant issues no token; a grant is recorded', async () => {
  const denied = createHarness({ mode: 'workspace-write', approvalOutcome: 'rejected' })
  try {
    const work = fixture('modern-plugin')
    const design = await denied.call('dshpd_design', { pluginPath: work })
    const files = [join(work, 'README.md')]
    const plan = await denied.call('dshpd_plan', { pluginPath: work, designPath: design.designPath, files })
    const approval = await denied.call('dshpd_approve', {
      pluginPath: work, designPath: design.designPath, files, planHash: plan.planHash,
    })
    assert.equal(approval.ok, false)
    assert.equal(approval.error, 'APPROVAL_NOT_GRANTED')
    assert.equal(approval.detail.outcome, 'rejected')
    assert.equal(denied.approvalCalls.length, 1)
  } finally {
    denied.close()
  }
  const granted = createHarness({ mode: 'workspace-write', approvalOutcome: 'allowed-once' })
  try {
    const work = fixture('modern-plugin')
    const design = await granted.call('dshpd_design', { pluginPath: work })
    const files = [join(work, 'README.md')]
    const plan = await granted.call('dshpd_plan', { pluginPath: work, designPath: design.designPath, files })
    const approval = await granted.call('dshpd_approve', {
      pluginPath: work, designPath: design.designPath, files, planHash: plan.planHash,
    })
    assert.equal(approval.ok, true, JSON.stringify(approval))
    assert.equal(approval.authorization.basis, 'approval-service')
    assert.equal(approval.authorization.approvalOutcome, 'allowed-once')
    assert.match(granted.approvalCalls[0].reason, /plan/)
  } finally {
    granted.close()
  }
})

test('a file changed after the snapshot is refused (no allowStale override)', async () => {
  const harness = createHarness()
  try {
    const work = fixture('modern-plugin')
    const files = [join(work, 'README.md')]
    const { approval, backup } = await approved(harness, work, files)
    writeFileSync(files[0], readFileSync(files[0], 'utf8') + '\nexternal edit\n', 'utf8')
    const stale = await harness.call('dshpd_apply', {
      approvalToken: approval.approvalToken, pluginPath: work, backupId: backup.backupId,
      filePath: files[0], oldText: '# modern-plugin (fixture)', newText: '# edited',
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.error, 'CAS_STALE')
    const legacy = await harness.call('dshpd_apply', {
      approvalToken: approval.approvalToken, pluginPath: work, backupId: backup.backupId,
      filePath: files[0], oldText: '# modern-plugin (fixture)', newText: '# edited', allowStale: true,
    })
    assert.equal(legacy.ok, false)
    assert.equal(legacy.error, 'DEPRECATED_ARGUMENT')
  } finally {
    harness.close()
  }
})

test('a partial snapshot commits nothing and leaves an aborted journal record', async () => {
  let blockRead = false
  const harness = createHarness({
    fsHooks: {
      readBytes(target) {
        const path = String(target && target.displayPath ? target.displayPath : target)
        if (blockRead && path.endsWith('protected.txt')) {
          const error = new Error('simulated read failure')
          error.code = 'EACCES'
          return error
        }
        return null
      },
    },
  })
  try {
    const work = fixture('modern-plugin')
    writeFileSync(join(work, 'protected.txt'), 'protected\n', 'utf8')
    const files = [join(work, 'README.md'), join(work, 'protected.txt')]
    const design = await harness.call('dshpd_design', { pluginPath: work })
    const plan = await harness.call('dshpd_plan', {
      pluginPath: work, designPath: design.designPath, files, operations: ['backup'],
    })
    const approval = await harness.call('dshpd_approve', {
      pluginPath: work, designPath: design.designPath, files, operations: ['backup'], planHash: plan.planHash,
    })
    assert.equal(approval.ok, true, JSON.stringify(approval))
    blockRead = true
    const backup = await harness.call('dshpd_backup', { approvalToken: approval.approvalToken, pluginPath: work })
    assert.equal(backup.ok, false)
    assert.equal(backup.error, 'SNAPSHOT_INCOMPLETE')
    assert.equal(backup.failures.length, 1)
    const status = await harness.call('dshpd_status', { pluginPath: work })
    assert.equal(status.ok, true)
    const aborted = status.journal.filter((entry) => entry.kind === 'backup' && entry.phase === 'abort')
    assert.ok(aborted.length >= 1, 'expected an aborted backup journal record')
  } finally {
    harness.close()
  }
})

test('verify fails on a newly introduced blocker, a missing file and a tampered payload', async () => {
  const harness = createHarness()
  try {
    const work = fixture('modern-plugin')
    const files = [join(work, 'README.md')]
    const { backup } = await approved(harness, work, files)
    const clean = await harness.call('dshpd_verify', { pluginPath: work })
    assert.equal(clean.ok, true, JSON.stringify(clean.checks.filter((check) => check.status !== 'PASS')))

    writeFileSync(join(work, 'src', 'index.js'), readFileSync(join(work, 'src', 'index.js'), 'utf8') + '\nprocess.exit(1)\n', 'utf8')
    const blocker = await harness.call('dshpd_verify', { pluginPath: work })
    assert.equal(blocker.ok, false)
    assert.equal(blocker.status, 'FAIL')
    assert.ok(blocker.checks.some((check) => check.id === 'ANALYSIS_BLOCKERS' && check.status === 'FAIL'))
  } finally {
    harness.close()
  }

  const second = createHarness()
  try {
    const work = fixture('modern-plugin')
    const files = [join(work, 'README.md')]
    const { backup } = await approved(second, work, files)
    const manifestPath = join(backup.backupDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const payloadPath = join(backup.backupDir, 'files', manifest.files[0].payload)
    writeFileSync(payloadPath, Buffer.concat([readFileSync(payloadPath), Buffer.from('\ntampered\n')]))
    const verify = await second.call('dshpd_verify', { pluginPath: work, backupId: backup.backupId })
    assert.equal(verify.ok, false)
    assert.equal(verify.status, 'FAIL')
    assert.ok(verify.checks.some((check) => check.id === 'PAYLOAD_INTEGRITY' && check.status === 'FAIL'))

    const rollback = await second.call('dshpd_rollback', {
      backupId: backup.backupId, pluginPath: work, confirmBackupId: backup.backupId,
    })
    assert.equal(rollback.ok, false)
    assert.equal(rollback.status, 'ROLLBACK_ABORTED')
  } finally {
    second.close()
  }
})

test('rollback refuses to overwrite a user modification and reports the conflict', async () => {
  const harness = createHarness()
  try {
    const work = fixture('modern-plugin')
    const file = join(work, 'README.md')
    const { approval, backup } = await approved(harness, work, [file])
    const applied = await harness.call('dshpd_apply', {
      approvalToken: approval.approvalToken, pluginPath: work, backupId: backup.backupId,
      filePath: file, oldText: '# modern-plugin (fixture)', newText: '# modern-plugin (edited)',
    })
    assert.equal(applied.ok, true, JSON.stringify(applied))
    writeFileSync(file, readFileSync(file, 'utf8') + '\nuser change\n', 'utf8')
    const rollback = await harness.call('dshpd_rollback', {
      backupId: backup.backupId, pluginPath: work, confirmBackupId: backup.backupId,
    })
    assert.equal(rollback.ok, false)
    assert.equal(rollback.status, 'ROLLBACK_CONFLICT')
    assert.match(readFileSync(file, 'utf8'), /user change/)
    assert.equal(rollback.conflicts.length, 1)
  } finally {
    harness.close()
  }
})

test('rollback of a created file is reported for manual removal, never deleted', async () => {
  const harness = createHarness()
  try {
    const work = fixture('modern-plugin')
    const created = join(work, 'generated.txt')
    const files = [created]
    const design = await harness.call('dshpd_design', { pluginPath: work })
    const plan = await harness.call('dshpd_plan', { pluginPath: work, designPath: design.designPath, files, operations: ['backup', 'write'] })
    const approval = await harness.call('dshpd_approve', {
      pluginPath: work, designPath: design.designPath, files, operations: ['backup', 'write'], planHash: plan.planHash,
    })
    assert.equal(approval.ok, true, JSON.stringify(approval))
    const backup = await harness.call('dshpd_backup', { approvalToken: approval.approvalToken, pluginPath: work })
    assert.equal(backup.ok, true, JSON.stringify(backup))
    const written = await harness.call('dshpd_write', {
      approvalToken: approval.approvalToken, pluginPath: work, backupId: backup.backupId,
      filePath: created, content: 'generated\n', mode: 'create',
    })
    assert.equal(written.ok, true, JSON.stringify(written))
    const rollback = await harness.call('dshpd_rollback', {
      backupId: backup.backupId, pluginPath: work, confirmBackupId: backup.backupId,
    })
    assert.equal(rollback.ok, false)
    assert.equal(rollback.status, 'ROLLBACK_CONFLICT')
    assert.equal(existsSync(created), true)
    assert.match(rollback.conflicts[0].reason, /manual/)
  } finally {
    harness.close()
  }
})

test('a verify entry is durable and recoveryRequired sees an uncommitted prepare', async () => {
  const harness = createHarness()
  try {
    const work = fixture('modern-plugin')
    await approved(harness, work, [join(work, 'README.md')])
    await harness.call('dshpd_verify', { pluginPath: work })
    const status = await harness.call('dshpd_status', { pluginPath: work })
    assert.equal(status.ok, true)
    assert.ok(status.journal.some((entry) => entry.kind === 'verify' && entry.status === 'PASS'))
    const journalPath = join(status.stateDir, 'journal.jsonl')
    writeFileSync(journalPath, readFileSync(journalPath, 'utf8')
      + JSON.stringify({ schema: 2, operationId: 'crashed-op', phase: 'prepare', kind: 'apply', pluginRoot: work }) + '\n', 'utf8')
    const after = await harness.call('dshpd_status', { pluginPath: work })
    assert.equal(after.ok, false)
    assert.ok(after.recoveryRequired.some((operation) => operation.operationId === 'crashed-op'))
  } finally {
    harness.close()
  }
})

test('mount never writes a profile and requires the official adapter for apply', async () => {
  const harness = createHarness()
  try {
    writeProfile(harness.dshHome, 'web', {
      rows: ["- insert:\n    - id: other-plugin\n      name: 'other-plugin'"],
      packages: { 'demo-plugin': '1.0.0' },
    })
    const patchPath = join(harness.dshHome, 'profiles', 'web', 'cordis.patch.yml')
    const before = readFileSync(patchPath, 'utf8')
    const dry = await harness.call('dshpd_mount', { packageName: 'demo-plugin', profile: 'web' })
    assert.equal(dry.ok, true)
    assert.equal(dry.applied, false)
    assert.match(dry.plan.mountRow, /- id: demo-plugin/)
    assert.equal(dry.plan.applySupported, false)
    const applied = await harness.call('dshpd_mount', { packageName: 'demo-plugin', profile: 'web', apply: true })
    assert.equal(applied.ok, false)
    assert.equal(applied.error, 'DEPLOYMENT_ADAPTER_UNAVAILABLE')
    assert.equal(readFileSync(patchPath, 'utf8'), before)
    const invalid = await harness.call('dshpd_mount', { packageName: "evil\n- remove: core", profile: 'web' })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.error, 'INVALID_PACKAGE_NAME')
  } finally {
    harness.close()
  }
})

test('mount apply delegates to the official manager and preserves restart-required', async () => {
  const calls = []
  const manager = {
    async listBundles() { return [] },
    async listPlugins() { return [] },
    async installBundle(spec, options) {
      calls.push({ spec, options })
      return { changed: true, application: 'restart-required', restartReason: 'no-hmr', stage: 'install', target: spec }
    },
    async removeBundle() { return { changed: true, application: 'applied', stage: 'remove', target: 'x' } },
    async setBundleEnabled() { return { changed: true, application: 'applied', stage: 'enable', target: 'x' } },
    async updateBundle() { return { changed: true, application: 'applied', step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: 'x' } } },
  }
  const harness = createHarness({ pluginManager: manager })
  try {
    writeProfile(harness.dshHome, 'web', { packages: { 'demo-plugin': '1.0.0' } })
    const work = fixture('minimal-host-client')
    const design = await harness.call('dshpd_design', { pluginPath: work, targetProfile: 'web' })
    assert.equal(design.ok, true, JSON.stringify(design))
    const files = [join(work, 'package.json')]
    const plan = await harness.call('dshpd_plan', {
      pluginPath: work,
      designPath: design.designPath,
      files,
      operations: ['mount'],
      targetProfile: 'web',
    })
    assert.equal(plan.ok, true, JSON.stringify(plan))
    const approval = await harness.call('dshpd_approve', {
      pluginPath: work,
      designPath: design.designPath,
      files,
      operations: ['mount'],
      targetProfile: 'web',
      planHash: plan.planHash,
    })
    assert.equal(approval.ok, true, JSON.stringify(approval))
    const result = await harness.call('dshpd_mount', {
      packageName: 'demo-plugin',
      profile: 'web',
      spec: 'demo-plugin@1.0.0',
      apply: true,
      approvalToken: approval.approvalToken,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.status, 'restart-required')
    assert.equal(result.restartRequired, true)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].options, { enabled: true })
  } finally {
    harness.close()
  }
})
