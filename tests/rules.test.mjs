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

test('client declaration validates inject/external/immediately and self-reference', () => {
  const result = analyzeModel({
    pluginPath: 'X:/fixture',
    manifestRaw: null,
    pkgRaw: '{}',
    pkg: {
      name: 'p',
      version: '1.0.0',
      description: 'x',
      icon: 'assets/icon.svg',
      type: 'module',
      engines: { dsh: '>=0.1.5-rc.1' },
      exports: { '.': './src/index.js', './client': './lib/client.js' },
      dsh: {
        manifestVersion: 1,
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web', inject: 'slots', external: ['p', 'react'], immediately: 'yes' },
      },
    },
    pkgError: null,
    cordisPatchRaw: null,
    bundlePatches: [{ path: './cordis.patch.yml', exists: true, raw: '- insert:\n    - id: p\n      name: p\n' }],
    clientBundleExists: true,
    clientBundleRaw: 'window.__ModuleLoader__.load({ id: "p", factory: (require) => { return {}; } });',
    defaultClientBundleExists: true,
    clientSourceFiles: [],
    iconExists: true,
    iconBytes: 100,
    iconExt: 'svg',
    sourceFiles: [],
    hasTests: true,
    hasReadme: true,
    hasLicense: true,
    harnessVersion: '0.2.1-rc.2',
  })
  const ids = result.issues.map((issue) => issue.id)
  assert.ok(ids.includes('CLIENT_INJECT_INVALID'))
  assert.ok(ids.includes('CLIENT_IMMEDIATELY_INVALID'))
  assert.ok(ids.includes('CLIENT_EXTERNAL_SELF'))
  assert.ok(ids.includes('CLIENT_EXTERNAL_BASELINE'))
})

test('package metadata checks ESM type, icon limits and npm files coverage', () => {
  const result = analyzeModel({
    pluginPath: 'X:/fixture',
    manifestRaw: null,
    pkgRaw: '{}',
    pkg: {
      name: 'q',
      version: '1.0.0',
      description: 'x',
      main: './index.js',
      icon: 'assets/big.gif',
      files: ['package.json'],
      engines: { dsh: '>=0.1.5-rc.1' },
      exports: { '.': './index.js', './client': './lib/client.js' },
      dsh: {
        manifestVersion: 1,
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
      },
    },
    pkgError: null,
    cordisPatchRaw: null,
    bundlePatches: [{ path: './cordis.patch.yml', exists: true, raw: '- insert:\n    - id: q\n      name: q\n' }],
    clientBundleExists: true,
    clientBundleRaw: 'window.__ModuleLoader__.load({ id: "q", factory: (require) => { return {}; } });',
    defaultClientBundleExists: true,
    clientSourceFiles: [],
    iconExists: true,
    iconBytes: 300000,
    iconExt: 'gif',
    sourceFiles: [{ path: 'X:/fixture/src/index.js', relative: 'src/index.js', content: 'export const value = 1\n' }],
    hasTests: true,
    hasReadme: true,
    hasLicense: true,
    harnessVersion: '0.2.1-rc.2',
  })
  const ids = result.issues.map((issue) => issue.id)
  assert.ok(ids.includes('PKG_NO_TYPE_MODULE'))
  assert.ok(ids.includes('PKG_ICON_FORMAT'))
  assert.ok(ids.includes('PKG_ICON_TOO_LARGE'))
  assert.ok(ids.includes('PKG_FILES_ICON'))
  assert.ok(ids.includes('PKG_FILES_BUNDLE_PATCH'))
  assert.ok(ids.includes('PKG_FILES_CLIENT_BUNDLE'))
})

test('UI diagnostics flag stale bundles, removed styles API, missing routes and missing apply', () => {
  const clientSource = [
    'const slots = ctx.slots',
    "slots.register({ name: 'settings.section' })",
    "styles.insert('.x{}')",
    "const ws = ctx.get('workspaces')",
    'ws.pickDirectory()',
    "ctx.get('notARealService')",
    "fetch('/demo/missing')",
    "const node = React.createElement('div')",
  ].join('\n')
  const hostSource = "ctx.webServer.register({ path: '/demo/ok', handler: () => {} })\n"
  const result = analyzeModel({
    pluginPath: 'X:/ui-fixture',
    manifestRaw: null,
    pkgRaw: '{}',
    pkg: {
      name: 'ui-fixture',
      version: '1.0.0',
      description: 'x',
      icon: 'assets/icon.svg',
      type: 'module',
      engines: { dsh: '>=0.1.5-rc.1' },
      exports: { '.': './src/index.js', './client': './lib/client.js' },
      dsh: {
        manifestVersion: 1,
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
      },
    },
    pkgError: null,
    cordisPatchRaw: null,
    bundlePatches: [{ path: './cordis.patch.yml', exists: true, raw: '- insert:\n    - id: ui-fixture\n      name: ui-fixture\n' }],
    clientBundleExists: true,
    clientBundleRaw: 'window.__ModuleLoader__.load({ id: "ui-fixture", factory: (require) => { return {}; } });',
    defaultClientBundleExists: true,
    clientSourceFiles: [{ path: 'X:/ui-fixture/src/client.js', relative: 'src/client.js', content: clientSource }],
    clientSourceMtimeMax: 10000,
    clientBundleMtime: 1000,
    iconExists: true,
    iconBytes: 100,
    iconExt: 'svg',
    sourceFiles: [
      { path: 'X:/ui-fixture/src/client.js', relative: 'src/client.js', content: clientSource },
      { path: 'X:/ui-fixture/src/host.js', relative: 'src/host.js', content: hostSource },
    ],
    hasTests: true,
    hasReadme: true,
    hasLicense: true,
    harnessVersion: '0.2.1-rc.2',
  })
  const ids = result.issues.map((issue) => issue.id)
  for (const expected of [
    'CLIENT_BUILD_STALE', 'CLIENT_STYLES_SERVICE', 'CLIENT_REACT_MISSING',
    'CLIENT_BUNDLE_NO_APPLY', 'CLIENT_ROUTE_MISSING', 'WEBSERVER_NOT_INJECTED',
    'CLIENT_NO_BUILD_SCRIPT', 'CLIENT_WORKSPACES_PICKDIRECTORY', 'CLIENT_UNKNOWN_SERVICE',
  ]) {
    assert.ok(ids.includes(expected), 'missing finding ' + expected + '; got ' + ids.join(','))
  }
})
