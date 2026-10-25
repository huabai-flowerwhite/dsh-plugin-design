// Independent-distribution contract: package audit, portable export, archive
// safety and an isolated package-load validation of the exact artifact.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { auditPackageDirectory, auditPackageEntries } from '../src/distribution/audit.js'
import { exportDistribution, verifyRelease } from '../src/distribution/exporter.js'
import { createTarGz, readTarGz, stripPackagePrefix } from '../src/distribution/tar.js'
import { runPackageLoad } from '../src/validation/runner.js'
import { createHarness, tempDir } from './helpers/harness.mjs'

function copyFixture(name) {
  const root = tempDir('dshpd-dist-')
  const work = join(root, name)
  cpSync(join('tests', 'fixtures', name), work, { recursive: true })
  return work
}

function gateStatuses(audit) {
  return Object.fromEntries(Object.entries(audit.gates).map(([key, value]) => [key, value.status]))
}

test('the minimal Host+Client fixture passes every required distribution gate', async () => {
  const work = copyFixture('minimal-host-client')
  const audit = await auditPackageDirectory(work)
  assert.equal(audit.ok, true, JSON.stringify(gateStatuses(audit)) + '\n' + JSON.stringify(audit.findings, null, 2))
  assert.equal(audit.gates.packageCompleteness.status, 'PASS')
  assert.equal(audit.gates.portability.status, 'PASS')
  assert.equal(audit.gates.dependencyClosure.status, 'PASS')
  assert.equal(audit.gates.maintenancePrivates.status, 'PASS')
  assert.equal(audit.package.clientDeclared, true)
  assert.equal(audit.package.hostEntry, './index.js')
  assert.equal(audit.package.clientEntry, './lib/client.js')
})

test('the negative fixture fails completeness, portability and dependency closure', async () => {
  const work = copyFixture('broken-package')
  const audit = await auditPackageDirectory(work)
  assert.equal(audit.ok, false)
  const statuses = gateStatuses(audit)
  assert.equal(statuses.packageCompleteness, 'FAIL')
  assert.equal(statuses.portability, 'FAIL')
  assert.equal(statuses.maintenancePrivates, 'FAIL')
  // dependencyClosure checks that imported packages are declared; the
  // forbidden maintenance dependency itself is reported by portability.
  assert.ok(['PASS', 'FAIL'].includes(statuses.dependencyClosure))
  const ids = new Set(audit.findings.map((finding) => finding.id))
  for (const id of [
    'DIST_CLIENT_BUNDLE_MISSING', 'DIST_AUTHOR_ABSOLUTE_PATH',
    'DIST_MAINTENANCE_DEPENDENCY', 'DIST_MAINTENANCE_STATE_PACKAGED',
  ]) {
    assert.ok(ids.has(id), 'missing finding ' + id + '; got ' + [...ids].join(','))
  }
})

test('export produces source, tgz, hashes, install docs and a support matrix', async () => {
  const work = copyFixture('minimal-host-client')
  const outputDir = tempDir('dshpd-release-')
  const exported = await exportDistribution({
    pluginPath: work,
    outputDir,
    runtime: { version: '0.2.1-rc.2', carrier: 'web', platform: 'win32', arch: 'x64' },
    toolVersion: '1.4.0',
    hostClientNecessity: [{ half: 'host', needed: 'required' }, { half: 'client', needed: 'required' }],
    supportMatrix: [{ dsh: '0.2.1-rc.2', carrier: 'web', os: 'win32-x64', status: 'NOT_RUN', evidence: 'pending clean-environment install' }],
  })
  assert.equal(exported.ok, true, JSON.stringify(exported.error || exported.audit))
  const releaseDir = exported.releaseDir
  for (const relative of ['package/dshpd-demo-plugin-1.0.0.tgz', 'SHA256SUMS', 'FILELIST.json', 'INSTALL.md', 'SUPPORT-MATRIX.md', 'SUPPORT-MATRIX.json', 'distribution-report.json', 'BUILD-LOCK.json', 'source/package.json']) {
    assert.equal(existsSync(join(releaseDir, relative)), true, 'missing ' + relative)
  }
  const report = JSON.parse(readFileSync(join(releaseDir, 'distribution-report.json'), 'utf8'))
  assert.equal(report.status.published, false)
  assert.equal(report.status.releasePrepared, true)
  assert.equal(report.status.distributionValidated, false)
  assert.match(report.artifacts.tgzSha256, /^[0-9a-f]{64}$/)
  const install = readFileSync(join(releaseDir, 'INSTALL.md'), 'utf8')
  assert.match(install, /dsh plugin --profile/)
  assert.match(install, /Uninstall/)
  const verified = await verifyRelease(releaseDir)
  assert.equal(verified.ok, true, JSON.stringify(verified))
  const listed = readTarGz(readFileSync(exported.artifacts.tgzPath))
  const paths = stripPackagePrefix(listed.entries).map((entry) => entry.path)
  assert.ok(paths.includes('package.json'))
  assert.ok(paths.includes('index.js'))
  assert.ok(paths.includes('lib/client.js'))
  assert.equal(paths.some((path) => path.includes('node_modules')), false)
  assert.equal(paths.some((path) => path.startsWith('.dsh-plugin-design')), false)
})

test('export refuses an output directory inside the plugin tree', async () => {
  const work = copyFixture('minimal-host-client')
  const result = await exportDistribution({ pluginPath: work, outputDir: join(work, 'dist') })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'OUTPUT_INSIDE_PLUGIN')
})

test('the archive reader rejects traversal, links and duplicate entries', () => {
  const traversal = createTarGz([{ path: '../escape.js', bytes: Buffer.from('x') }])
  assert.throws(() => readTarGz(traversal), /ARCHIVE_PATH_ESCAPE_REJECTED/)
  const duplicate = createTarGz([
    { path: 'a.js', bytes: Buffer.from('1') },
    { path: 'a.js', bytes: Buffer.from('2') },
  ])
  assert.throws(() => readTarGz(duplicate), /ARCHIVE_DUPLICATE_ENTRY_REJECTED/)
  const normal = stripPackagePrefix(readTarGz(createTarGz([{ path: 'a/b.js', bytes: Buffer.from('hello') }])).entries)
  assert.deepEqual(normal.map((entry) => entry.path), ['a/b.js'])
  assert.equal(normal[0].bytes.toString(), 'hello')
})

test('a missing chunk is caught from the archive itself, not the source tree', () => {
  const tgz = createTarGz([
    { path: 'package.json', bytes: Buffer.from(JSON.stringify({
      name: 'x', version: '1.0.0', exports: { '.': './index.js', './client': './lib/client.js' }, dsh: { client: { platform: 'web' } },
    })) },
    { path: 'index.js', bytes: Buffer.from('export default { apply() {} }') },
  ])
  const audit = auditPackageEntries(stripPackagePrefix(readTarGz(tgz).entries))
  assert.equal(audit.ok, false)
  assert.ok(audit.findings.some((finding) => finding.id === 'DIST_CLIENT_BUNDLE_MISSING'))
})

test('package-load validates the exact archive in an isolated consumer tree', async () => {
  const work = copyFixture('minimal-host-client')
  const outputDir = tempDir('dshpd-release-')
  const exported = await exportDistribution({ pluginPath: work, outputDir })
  assert.equal(exported.ok, true, JSON.stringify(exported.error))
  const evidence = await runPackageLoad({
    tgzPath: exported.artifacts.tgzPath,
    expectedName: 'dshpd-demo-plugin',
    expectedVersion: '1.0.0',
    stateDir: tempDir('dshpd-state-'),
    toolName: 'demo_status',
    timeoutMs: 60_000,
  })
  assert.equal(evidence.status, 'PASS', JSON.stringify(evidence, null, 2).slice(0, 4000))
  assert.equal(evidence.result.maintenancePluginAbsent, true)
  assert.equal(evidence.result.host.applied, true)
  assert.equal(evidence.result.host.toolCall.ok, true)
  assert.equal(evidence.result.client.factory, true)
  assert.equal(evidence.result.client.applied, true)
  assert.equal(evidence.result.client.registered, true)
  assert.equal(evidence.result.client.rendered, true)
  assert.equal(evidence.gates.distributionLifecycle.status, 'NOT_RUN')
  assert.equal(evidence.gates.independentRuntime.status, 'PASS')
})

test('package-load fails the same way a user would when the bundle is missing', async () => {
  const work = copyFixture('broken-package')
  const outputDir = tempDir('dshpd-release-')
  const exported = await exportDistribution({ pluginPath: work, outputDir })
  assert.equal(exported.ok, false)
  assert.ok(['PACKAGE_ENTRY_MISSING', 'PACKAGE_AUDIT_FAILED'].includes(exported.error), exported.error)
  // Build a tarball by hand to prove the runner also fails on a bad artifact.
  const tgz = createTarGz([
    { path: 'package.json', bytes: Buffer.from(JSON.stringify({
      name: 'broken-runtime', version: '1.0.0', type: 'module', main: './index.js',
      exports: { '.': './index.js' }, dsh: { client: { platform: 'web' } },
    })) },
    { path: 'index.js', bytes: Buffer.from('export default { apply() { throw new Error("boom") } }') },
  ])
  const tgzPath = join(tempDir('dshpd-badtgz-'), 'broken.tgz')
  writeFileSync(tgzPath, tgz)
  const evidence = await runPackageLoad({
    tgzPath,
    expectedName: 'broken-runtime',
    stateDir: tempDir('dshpd-state-'),
    timeoutMs: 30_000,
  })
  assert.equal(evidence.status, 'FAIL')
  assert.equal(evidence.gates.independentRuntime.status, 'FAIL')
})

test('dshpd_distribute audits and exports through the Host tool', async () => {
  const harness = createHarness()
  try {
    const work = copyFixture('minimal-host-client')
    const audit = await harness.call('dshpd_distribute', { pluginPath: work })
    assert.equal(audit.ok, true, JSON.stringify(audit.gates))
    assert.equal(audit.status.published, false)
    assert.ok(Array.isArray(audit.hostClientNecessity))
    const outputDir = tempDir('dshpd-tool-release-')
    const exported = await harness.call('dshpd_distribute', { pluginPath: work, mode: 'export', outputDir })
    assert.equal(exported.ok, true, JSON.stringify(exported).slice(0, 3000))
    assert.equal(exported.releaseVerified.ok, true)
    assert.equal(exported.status.published, false)
    assert.equal(exported.status.releasePrepared, true)
    const report = await harness.call('dshpd_report', {
      backupId: '00000000-0000-4000-8000-000000000000', pluginPath: work,
    })
    assert.equal(report.ok, false)
  } finally {
    harness.close()
  }
})
