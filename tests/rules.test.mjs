// Pure rule-engine tests: semver gate, heuristic manifest probe, scoring,
// verdicts, and a couple of model-level rules that need no filesystem.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  analyzeModel,
  countBySeverity,
  parseManifestHeuristic,
  scoreIssues,
  semverSatisfies,
  verdictOf,
} from '../src/rules.js'

test('semverSatisfies understands the ranges used by engines.dsh', () => {
  assert.equal(semverSatisfies('0.1.5-rc.1', '>=0.1.5-rc.1 <0.3.0'), true)
  assert.equal(semverSatisfies('0.2.1-rc.2', '>=0.1.5-rc.1 <0.3.0'), true)
  assert.equal(semverSatisfies('0.2.1', '>=0.1.5-rc.1 <0.3.0'), true)
  assert.equal(semverSatisfies('0.3.0', '>=0.1.5-rc.1 <0.3.0'), false)
  assert.equal(semverSatisfies('0.1.4', '>=0.1.5-rc.1 <0.3.0'), false)
  assert.equal(semverSatisfies('0.2.5', '^0.2.1'), true)
  assert.equal(semverSatisfies('0.3.0', '^0.2.1'), false)
  assert.equal(semverSatisfies('0.2.9', '~0.2.1'), true)
  assert.equal(semverSatisfies('0.3.0', '~0.2.1'), false)
  assert.equal(semverSatisfies('1.0.0', '^0.2.1 || >=1.0.0'), true)
  assert.equal(semverSatisfies('0.2.1', '*'), true)
  assert.equal(semverSatisfies('garbage', '>=0.1.0'), false)
  assert.equal(semverSatisfies('0.2.1', ''), false)
})

test('parseManifestHeuristic builds dotted paths and sees lists', () => {
  const manifest = [
    'manifestVersion: 1',
    'plugin:',
    '  id: com.example.x',
    '  version: 1.0.0',
    'runtime:',
    '  harness:',
    '    min: 0.1.5-rc.1',
    '    max: "<0.3.0"',
    'cordis:',
    '  apiLevel: 1',
    'capabilities:',
    '  provides:',
    '    - a',
    '    - b',
  ].join('\n')
  const parsed = parseManifestHeuristic(manifest)
  assert.equal(parsed['plugin.id'], 'com.example.x')
  assert.equal(parsed['runtime.harness.min'], '0.1.5-rc.1')
  assert.equal(parsed['cordis.apiLevel'], '1')
  assert.equal(parsed['capabilities.provides.length'], 2)
})

test('scores and verdicts follow the documented rule', () => {
  const issues = [
    { severity: 'HIGH', category: 'compat' },
    { severity: 'MEDIUM', category: 'manifest' },
  ]
  const scores = scoreIssues(issues)
  assert.equal(scores.compatibility, 85)
  assert.equal(scores.manifest, 92)
  assert.equal(verdictOf(issues), 'READY_TO_MODIFY')
  assert.equal(verdictOf([{ severity: 'BLOCKER', category: 'security' }]), 'BLOCKED')
  assert.equal(verdictOf([{ severity: 'CRITICAL', category: 'client' }]), 'NEEDS_REVIEW')
  assert.deepEqual(countBySeverity(issues), { BLOCKER: 0, CRITICAL: 0, HIGH: 1, MEDIUM: 1, LOW: 0, INFO: 0 })
})

test('engines.dsh workspace protocol is rejected by the ruleset', () => {
  const result = analyzeModel({
    pluginPath: 'X:/fixture',
    manifestRaw: null,
    pkgRaw: '{}',
    pkg: {
      name: 'p',
      version: '1.0.0',
      engines: { dsh: 'workspace:*' },
      description: 'x',
      icon: 'assets/icon.svg',
    },
    pkgError: null,
    cordisPatchRaw: null,
    bundlePatches: [],
    clientBundleExists: false,
    clientBundleRaw: null,
    defaultClientBundleExists: false,
    clientSourceFiles: [],
    iconExists: true,
    sourceFiles: [],
    hasTests: true,
    hasReadme: true,
    hasLicense: true,
    harnessVersion: '0.2.1-rc.2',
  })
  const ids = result.issues.map((issue) => issue.id)
  assert.ok(ids.includes('ENGINES_DSH_WORKSPACE'))
  assert.equal(result.overall, 'NEEDS_REVIEW')
})

test('client declaration without an export is a blocker', () => {
  const result = analyzeModel({
    pluginPath: 'X:/fixture',
    manifestRaw: null,
    pkgRaw: '{}',
    pkg: {
      name: 'p',
      version: '1.0.0',
      description: 'x',
      icon: 'assets/icon.svg',
      engines: { dsh: '>=0.1.5-rc.1' },
      dsh: { manifestVersion: 1, client: { platform: 'web' } },
      exports: { '.': './src/index.js' },
    },
    pkgError: null,
    cordisPatchRaw: null,
    bundlePatches: [],
    clientBundleExists: false,
    clientBundleRaw: null,
    defaultClientBundleExists: false,
    clientSourceFiles: [],
    iconExists: true,
    sourceFiles: [],
    hasTests: true,
    hasReadme: true,
    hasLicense: true,
    harnessVersion: '0.2.1-rc.2',
  })
  const ids = result.issues.map((issue) => issue.id)
  assert.ok(ids.includes('CLIENT_EXPORT_MISSING'))
  assert.equal(result.overall, 'BLOCKED')
  assert.ok(result.migrations.some((migration) => migration.id === 'client-meta'))
})
