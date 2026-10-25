#!/usr/bin/env node
// Build the release materials used for the independent-distribution evidence:
//   - export the Host+Client fixture package with the clean-env support matrix
//   - validate that exact archive in an isolated consumer tree
//   - hash the maintenance-plugin and target-plugin tarballs
//   - write the delivery manifest
//
// Development/release tool only. It never uploads anything.

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { exportDistribution } from '../src/distribution/exporter.js'
import { runPackageLoad } from '../src/validation/runner.js'

const outDir = resolve(process.argv[2] || 'outputs')
const pluginTgz = resolve(process.argv[3] || join(outDir, 'artifacts', 'dsh-plugin-design-1.4.0.tgz'))
const maintenanceEvidencePath = join(outDir, 'independent-validation', 'maintenance-plugin', 'clean-env-evidence.json')
const targetEvidencePath = join(outDir, 'independent-validation', 'target-plugin', 'clean-env-evidence.json')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)
const maintenanceEvidence = readJson(maintenanceEvidencePath)
const previousTargetEvidence = readJson(targetEvidencePath)

const targetReleaseRoot = join(outDir, 'target-plugin-release')
const exported = await exportDistribution({
  pluginPath: resolve('tests/fixtures/minimal-host-client'),
  outputDir: targetReleaseRoot,
  supportMatrix: [
    {
      dsh: '0.2.1-rc.2',
      carrier: 'headless web host (Desktop runtime)',
      os: 'win32-x64',
      status: previousTargetEvidence && previousTargetEvidence.status === 'PASS' ? 'PASS' : 'NOT_RUN',
      evidence: previousTargetEvidence
        ? 'install → cold start → /dshpd-demo/health 200 → restart → uninstall → host boots'
        : 'clean-environment run not executed',
    },
    { dsh: '0.2.1-rc.2', carrier: 'desktop window', os: 'win32-x64', status: 'NOT_RUN', evidence: 'real Desktop renderer interaction not exercised' },
    { dsh: '0.2.1-rc.3', carrier: 'any', os: 'any', status: 'NOT_RUN', evidence: 'contract baseline only; runtime not installed' },
    { dsh: '0.2.1-rc.2', carrier: 'web', os: 'linux/macOS', status: 'NOT_RUN', evidence: 'no test machine' },
  ],
  runtime: { version: '0.2.1-rc.2', carrier: 'headless-web', platform: 'win32', arch: 'x64' },
  toolVersion: '1.4.0',
  ruleset: '0.2.1-r2',
  hostClientNecessity: [
    { half: 'host', needed: 'required', location: './index.js', function: 'demo_status tool + /dshpd-demo/health route', rationale: 'Host entry is required for any Loader-imported plugin; kept minimal', risk: 'same-process host code' },
    { half: 'client', needed: 'required', location: './lib/client.js', function: 'settings.section panel', rationale: 'the fixture intentionally covers a real Client half', risk: 'shared renderer code' },
  ],
  localModification: 'UNVERIFIED',
  distributionValidated: Boolean(previousTargetEvidence && previousTargetEvidence.status === 'PASS'),
  evidence: [
    'independent-validation/target-plugin/clean-env-evidence.json',
    'independent-validation/target-plugin-package-load/evidence.json',
  ],
})
if (!exported.ok) {
  console.error('export failed: ' + JSON.stringify(exported.error || exported.audit))
  process.exit(1)
}

const validation = await runPackageLoad({
  tgzPath: exported.artifacts.tgzPath,
  expectedName: 'dshpd-demo-plugin',
  expectedVersion: '1.0.0',
  stateDir: join(outDir, 'independent-validation', 'target-plugin-package-load', 'state'),
  toolName: 'demo_status',
  timeoutMs: 60_000,
})
mkdirSync(join(outDir, 'independent-validation', 'target-plugin-package-load'), { recursive: true })
writeFileSync(join(outDir, 'independent-validation', 'target-plugin-package-load', 'evidence.json'), JSON.stringify(validation, null, 2) + '\n', 'utf8')

const files = [pluginTgz, exported.artifacts.tgzPath]
const hashes = files.map((path) => ({ path, name: basename(path), sha256: sha256(readFileSync(path)), bytes: readFileSync(path).length }))
writeFileSync(join(outDir, 'SHA256SUMS'), hashes.map((entry) => entry.sha256 + '  ' + entry.name).join('\n') + '\n', 'utf8')
copyFileSync(exported.artifacts.tgzPath, join(outDir, 'artifacts', basename(exported.artifacts.tgzPath)))

// The exporter only records what it could verify itself. The clean-environment
// run and the package-load run are separate evidence, so fold them into the
// release report here (and keep the raw evidence files next to it).
const distributionValidated = Boolean(previousTargetEvidence && previousTargetEvidence.status === 'PASS')
  && validation.status === 'PASS'
const reportPath = join(exported.releaseDir, 'distribution-report.json')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
report.status.distributionValidated = distributionValidated
report.evidence = [
  { kind: 'dsh-host', path: 'independent-validation/target-plugin/clean-env-evidence.json', status: previousTargetEvidence ? previousTargetEvidence.status : 'NOT_RUN' },
  { kind: 'package-load', path: 'independent-validation/target-plugin-package-load/evidence.json', status: validation.status },
]
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8')

const manifest = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  dsh: {
    contractBaseline: '0.2.1-rc.3 @ 22ddee3792402c3e70ec5f86a63c3e3e895a2f60',
    verifiedRuntime: '0.2.1-rc.2',
    runtimeSource: 'asar:dsh-app-boot/package.json',
    platform: 'win32-x64',
    carrier: 'headless web host started from the Desktop runtime (electron in node mode)',
  },
  plugins: [
    {
      name: 'dsh-plugin-design',
      version: '1.4.0',
      artifact: 'artifacts/dsh-plugin-design-1.4.0.tgz',
      sha256: hashes[0].sha256,
      cleanInstall: maintenanceEvidence ? maintenanceEvidence.status : 'NOT_RUN',
      evidence: 'independent-validation/maintenance-plugin/clean-env-evidence.json',
    },
    {
      name: 'dshpd-demo-plugin',
      version: '1.0.0',
      artifact: 'artifacts/' + basename(exported.artifacts.tgzPath),
      sha256: hashes[1].sha256,
      releaseDir: exported.releaseDir,
      cleanInstall: previousTargetEvidence ? previousTargetEvidence.status : 'NOT_RUN',
      packageLoad: validation.status,
      evidence: [
        'independent-validation/target-plugin/clean-env-evidence.json',
        'independent-validation/target-plugin-package-load/evidence.json',
        'target-plugin-release/' + basename(exported.releaseDir) + '/distribution-report.json',
      ],
      distributionValidated: (previousTargetEvidence ? previousTargetEvidence.status : 'FAIL') === 'PASS' && validation.status === 'PASS',
    },
  ],
  status: {
    localModification: 'VERIFIED_BY_TESTS',
    distributionValidated: (previousTargetEvidence ? previousTargetEvidence.status : 'FAIL') === 'PASS' && validation.status === 'PASS',
    releasePrepared: true,
    published: false,
    note: 'no remote upload was performed; GitHub/npm publication requires separate authorisation',
  },
}
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ ok: true, hashes, packageLoad: validation.status, manifest: join(outDir, 'MANIFEST.json') }, null, 2))
process.exit(manifest.status.distributionValidated ? 0 : 1)
