// Deployment adapter capability negotiation.
//
// DSH 0.2.1-rc.3 release plugin-manager exposes install/remove/enable but not
// `updateBundle` or `listVersions`. Those must be capability-probed, not
// required: requiring them would mark the whole official manager unavailable
// and block a supported install path.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  REQUIRED_METHODS, OPTIONAL_METHODS, detectDeploymentAdapter, planMount, applyMount, removeDeployment,
} from '../src/deploy/adapter.js'
import { tempDir, writeProfile } from './helpers/harness.mjs'

/** The management surface observed in the installed 0.2.1-rc.3 release. */
function rc3Manager(overrides = {}) {
  const manager = {
    async listBundles() { return [] },
    async listPlugins() { return [] },
    async installBundle(spec, options) {
      manager.calls.push({ method: 'installBundle', spec, options })
      return { changed: true, application: 'restart-required', restartReason: 'no-hmr', stage: 'install', target: spec }
    },
    async removeBundle(name) {
      manager.calls.push({ method: 'removeBundle', name })
      return { changed: true, application: 'applied', stage: 'remove', target: name }
    },
    async setBundleEnabled(name, enabled) {
      manager.calls.push({ method: 'setBundleEnabled', name, enabled })
      return { changed: true, application: 'applied', stage: 'enable', target: name }
    },
    async setPluginEnabled(id, enabled) {
      manager.calls.push({ method: 'setPluginEnabled', id, enabled })
      return { changed: true, application: 'applied', stage: 'enable', target: id }
    },
    async inspect() { return {} },
    async registries() { return {} },
    async waitForInstall() { return {} },
    async cancelInstall() { return {} },
    calls: [],
    ...overrides,
  }
  return manager
}

function fakeCtx(manager) {
  return { get: (name) => (name === 'pluginManager' ? manager : undefined) }
}

function deployableHome() {
  const dshHome = tempDir('dshpd-adapter-')
  writeProfile(dshHome, 'web', {
    rows: ['- insert:\n    - id: demo-plugin\n      name: \'demo-plugin\''],
    packages: { 'demo-plugin': '1.0.0' },
  })
  return dshHome
}

test('the rc.3 manager surface is accepted without updateBundle/listVersions', () => {
  assert.equal(REQUIRED_METHODS.includes('updateBundle'), false)
  assert.equal(REQUIRED_METHODS.includes('listVersions'), false)
  assert.ok(OPTIONAL_METHODS.includes('updateBundle'))
  const adapter = detectDeploymentAdapter(fakeCtx(rc3Manager()))
  assert.equal(adapter.available, true, JSON.stringify(adapter))
  assert.deepEqual(adapter.missingRequired, [])
  assert.equal(adapter.capabilities.install, true)
  assert.equal(adapter.capabilities.remove, true)
  assert.equal(adapter.capabilities.enable, true)
  assert.equal(adapter.capabilities.update, false)
  assert.equal(adapter.capabilities.versionDiscovery, false)
  const unsupported = new Map(adapter.unsupported.map((entry) => [entry.method, entry]))
  assert.equal(unsupported.get('updateBundle').status, 'UNSUPPORTED')
  assert.equal(unsupported.get('listVersions').status, 'UNSUPPORTED')
  assert.match(unsupported.get('updateBundle').reason, /0\.2\.1-rc\.3/)
  assert.match(adapter.note, /installBundle/)
})

test('a missing required method keeps the adapter unavailable and names it', () => {
  const manager = rc3Manager()
  delete manager.removeBundle
  const adapter = detectDeploymentAdapter(fakeCtx(manager))
  assert.equal(adapter.available, false)
  assert.deepEqual(adapter.missingRequired, ['removeBundle'])
  assert.match(adapter.reason, /removeBundle/)
})

test('no manager means no profile writer, and nothing claims update support', () => {
  const adapter = detectDeploymentAdapter(fakeCtx(undefined))
  assert.equal(adapter.available, false)
  assert.equal(adapter.source, 'none')
  assert.equal(adapter.capabilities.update, false)
  assert.equal(adapter.capabilities.install, false)
  assert.match(adapter.reason, /will not fall back to writing profile files/)
})

test('planMount stays applyable on rc.3 and reports the missing update capability', () => {
  const dshHome = deployableHome()
  const plan = planMount({
    ctx: fakeCtx(rc3Manager()),
    dshHome,
    packageName: 'demo-plugin',
    profile: 'web',
    spec: 'demo-plugin@1.0.0',
  })
  assert.equal(plan.applySupported, true, JSON.stringify(plan.blocked))
  assert.equal(plan.adapter.available, true)
  assert.equal(plan.adapter.capabilities.update, false)
  assert.ok(plan.adapter.unsupported.some((entry) => entry.method === 'updateBundle'))
  assert.match(plan.note, /installBundle/)
  assert.match(plan.note, /no updateBundle/)
})

test('applyMount and removeDeployment use only the supported rc.3 methods', async () => {
  const manager = rc3Manager()
  const ctx = fakeCtx(manager)
  const dshHome = deployableHome()
  const applied = await applyMount({
    ctx,
    dshHome,
    packageName: 'demo-plugin',
    profile: 'web',
    spec: 'demo-plugin@1.0.0',
  })
  assert.equal(applied.applied, true, JSON.stringify(applied))
  assert.equal(applied.status, 'restart-required')
  assert.equal(applied.restartRequired, true)
  assert.deepEqual(manager.calls.map((call) => call.method), ['installBundle'])

  const removed = await removeDeployment({ ctx, packageName: 'demo-plugin' })
  assert.equal(removed.applied, true)
  assert.equal(removed.status, 'applied')
  assert.deepEqual(manager.calls.map((call) => call.method), ['installBundle', 'removeBundle'])
})

test('a manager that does expose updateBundle is reported as update-capable', () => {
  const manager = rc3Manager({
    async updateBundle() { return { changed: true, application: 'applied', step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: 'x' } } },
    async listVersions() { return { versions: [] } },
  })
  const adapter = detectDeploymentAdapter(fakeCtx(manager))
  assert.equal(adapter.capabilities.update, true)
  assert.equal(adapter.capabilities.versionDiscovery, true)
  assert.equal(adapter.unsupported.length < OPTIONAL_METHODS.length, true)
  assert.equal(adapter.capabilities.inspection, true)
})

test('planMount still refuses when the package cannot be resolved', () => {
  const dshHome = tempDir('dshpd-adapter-missing-')
  writeProfile(dshHome, 'web', { rows: [] })
  const plan = planMount({
    ctx: fakeCtx(rc3Manager()),
    dshHome,
    packageName: 'demo-plugin',
    profile: 'web',
    spec: 'demo-plugin@1.0.0',
  })
  assert.equal(plan.applySupported, false)
  assert.ok(plan.blocked.includes('PACKAGE_NOT_RESOLVABLE'))
})
