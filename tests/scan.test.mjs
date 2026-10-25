// Worker-based scanning: budgets, coverage, cancellation, queueing and the
// guarantee that a big scan does not block the Host event loop.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { collectPluginModel } from '../src/scan/collector.js'
import { ScanScheduler } from '../src/scan/service.js'
import { createHarness, tempDir } from './helpers/harness.mjs'

function makeTree(fileCount, { dirs = 20 } = {}) {
  const root = tempDir('dshpd-tree-')
  for (let dir = 0; dir < dirs; dir += 1) {
    const directory = join(root, 'dir' + dir)
    mkdirSync(directory, { recursive: true })
    for (let file = 0; file < Math.ceil(fileCount / dirs); file += 1) {
      writeFileSync(join(directory, 'file' + file + '.js'), 'export const x = 1\n', 'utf8')
    }
  }
  return root
}

test('the collector stops at its file budget and reports INCOMPLETE', async () => {
  const root = makeTree(400, { dirs: 20 })
  const { coverage } = await collectPluginModel(root, { budget: { maxFiles: 50, deadlineMs: 5000 } })
  assert.equal(coverage.incomplete, true)
  assert.ok(coverage.incompleteReasons.includes('FILES_EXCEEDED'))
  assert.ok(coverage.filesVisited <= 60)
})

test('an oversized file is skipped with an explicit coverage record', async () => {
  const root = tempDir('dshpd-big-')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'big', version: '1.0.0', main: 'src/index.js' }), 'utf8')
  writeFileSync(join(root, 'src', 'index.js'), 'export default { apply() {} }\n' + 'x'.repeat(5000), 'utf8')
  const { coverage } = await collectPluginModel(root, { budget: { maxFileBytes: 1024 } })
  assert.equal(coverage.incomplete, true)
  assert.ok(coverage.skippedOversize.some((entry) => entry.path === 'src/index.js'))
  assert.ok(coverage.incompleteReasons.some((reason) => reason.startsWith('FILE_OVERSIZE')))
})

test('a lib-only package is still inspected through its real entry', async () => {
  const root = tempDir('dshpd-libonly-')
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'lib-only', version: '1.0.0', type: 'module',
    exports: { '.': './lib/index.js', './client': './lib/client.js' },
    dsh: { client: { platform: 'web' } },
  }, null, 2), 'utf8')
  writeFileSync(join(root, 'lib', 'index.js'), 'export default { name: "lib-only", apply() {} }\n', 'utf8')
  writeFileSync(join(root, 'lib', 'client.js'), 'window.__ModuleLoader__.load({ id: "lib-only", factory: (require) => { var module = { exports: {} }; module.exports.apply = function () {}; return module.exports; } });\n', 'utf8')
  const { model, coverage } = await collectPluginModel(root)
  assert.equal(coverage.incomplete, false)
  assert.equal(model.hostEntry.text !== null, true)
  assert.equal(model.clientBundleExists, true)
  assert.ok(model.sourceFiles.some((file) => file.kind === 'artifact' && file.relative === 'lib/client.js'))
})

test('an unreadable root is INCOMPLETE instead of an empty success', async () => {
  const missing = join(tempDir('dshpd-missing-root-'), 'nope')
  const { coverage } = await collectPluginModel(missing)
  assert.equal(coverage.incomplete, true)
  assert.ok(coverage.incompleteReasons.includes('ROOT_UNREADABLE'))
})

test('the scan scheduler cancels a running worker through its signal', async () => {
  const scheduler = new ScanScheduler({ timeoutMs: 20_000 })
  const root = makeTree(3000)
  const controller = new AbortController()
  const promise = scheduler.request('discover', { rootPath: root, budget: { deadlineMs: 20_000 } }, { signal: controller.signal })
  for (let attempt = 0; attempt < 200 && scheduler.stats.started === 0; attempt += 1) await sleep(5)
  controller.abort()
  await assert.rejects(promise, (error) => error.code === 'SCAN_CANCELLED')
  await scheduler.dispose()
})

test('the scan scheduler enforces a finite queue', async () => {
  const scheduler = new ScanScheduler({ timeoutMs: 20_000, maxQueue: 0 })
  const root = makeTree(2000)
  const first = scheduler.request('discover', { rootPath: root, budget: { deadlineMs: 20_000 } })
  await assert.rejects(
    scheduler.request('discover', { rootPath: root, budget: { deadlineMs: 20_000 } }),
    (error) => error.code === 'SCAN_QUEUE_FULL',
  )
  await first.catch(() => {})
  await scheduler.dispose()
})

test('a large scan does not block the Host event loop', async () => {
  const harness = createHarness()
  try {
    const root = makeTree(3000, { dirs: 30 })
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 5)
    const started = Date.now()
    const result = await harness.call('dshpd_discover', { root, maxDepth: 4 })
    clearInterval(timer)
    const elapsed = Date.now() - started
    assert.ok(result.ok === true || result.ok === false)
    assert.ok(ticks > 0, 'the Host timer must fire while the worker scans (elapsed ' + elapsed + 'ms)')
  } finally {
    harness.close()
  }
})

test('a missing plugin path produces an explicit failure, not a clean verdict', async () => {
  const harness = createHarness()
  try {
    const result = await harness.call('dshpd_analyze', { pluginPath: join(tempDir('dshpd-none-'), 'missing') })
    assert.equal(result.ok, false)
    assert.equal(result.scan.status, 'INCOMPLETE')
    assert.equal(result.overall, 'INCOMPLETE')
  } finally {
    harness.close()
  }
})
