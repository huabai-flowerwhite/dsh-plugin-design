// Host-half regressions: tool/route registration, worker-backed analysis,
// classification, UI health receipts and the read-only settings routes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync } from 'node:fs'
import { join } from 'node:path'

import { createHarness, tempDir } from './helpers/harness.mjs'

const FIXTURES = join('tests', 'fixtures')

function copyFixture(name) {
  const root = tempDir('dshpd-host-')
  const work = join(root, 'plugin')
  cpSync(join(FIXTURES, name), work, { recursive: true })
  return work
}

function makeRequest(method, url, body) {
  return {
    method,
    url,
    async* [Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(value) { this.body += value === undefined ? '' : String(value) },
  }
}

test('registers the documented tools and read-only settings routes', () => {
  const harness = createHarness()
  try {
    assert.equal(harness.tools.size, 18)
    assert.deepEqual([...harness.tools.keys()].sort(), [
      'dshpd_analyze', 'dshpd_apply', 'dshpd_approve', 'dshpd_backup', 'dshpd_design',
      'dshpd_discover', 'dshpd_distribute', 'dshpd_inspect', 'dshpd_migrate', 'dshpd_mount',
      'dshpd_plan', 'dshpd_report', 'dshpd_rollback', 'dshpd_status', 'dshpd_ui_check',
      'dshpd_validate', 'dshpd_verify', 'dshpd_write',
    ])
    assert.deepEqual([...harness.routes.keys()].sort(), [
      '/dsh-plugin-design/analyze',
      '/dsh-plugin-design/client-health',
      '/dsh-plugin-design/discover',
      '/dsh-plugin-design/health',
      '/dsh-plugin-design/info',
    ])
    for (const route of harness.routes.values()) assert.equal(route.kind, 'exact')
  } finally {
    harness.close()
  }
})

test('analyze reports scan coverage, real artifacts and official SemVer results', async () => {
  const previous = process.env.DSH_VERSION
  process.env.DSH_VERSION = '0.2.1-rc.2'
  const harness = createHarness()
  try {
    const result = await harness.call('dshpd_analyze', { pluginPath: join(FIXTURES, 'modern-plugin') })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.overall, 'READY_TO_MODIFY')
    assert.equal(result.official.compatibility.satisfied, true)
    assert.equal(result.official.compatibility.source, 'engines.dsh')
    assert.equal(result.scan.status, 'COMPLETE')
    assert.equal(result.scan.coverage.incomplete, false)
    assert.equal(result.official.host.entryPresent, true)
    assert.ok(result.official.artifacts.scanned >= 1, 'lib/client.js must be scanned as an artifact')
    assert.equal(result.safetyClaim, 'static-preflight-only')
    assert.equal(result.runtime.effectiveSource, 'running')
  } finally {
    harness.close()
    if (previous === undefined) delete process.env.DSH_VERSION
    else process.env.DSH_VERSION = previous
  }
})

test('unknown runtime yields UNKNOWN compatibility instead of a false pass', async () => {
  const previous = process.env.DSH_VERSION
  delete process.env.DSH_VERSION
  const harness = createHarness()
  try {
    const result = await harness.call('dshpd_analyze', { pluginPath: join(FIXTURES, 'modern-plugin') })
    assert.equal(result.official.compatibility.satisfied, null)
    assert.ok(result.issues.some((issue) => issue.id === 'ENGINES_DSH_RUNTIME_UNKNOWN'))
    assert.equal(result.runtime.effectiveSource, 'unknown')
  } finally {
    harness.close()
    if (previous !== undefined) process.env.DSH_VERSION = previous
  }
})

test('a runtime-killing pattern is flagged and requires isolated verification', async () => {
  const harness = createHarness()
  try {
    const result = await harness.call('dshpd_analyze', { pluginPath: join(FIXTURES, 'legacy-plugin') })
    assert.equal(result.overall, 'BLOCKED')
    const ids = new Set(result.issues.map((issue) => issue.id))
    for (const id of ['ENGINES_DSH_MISSING', 'BUNDLE_NOT_DECLARED', 'GLOBALTHIS_PATCH', 'TOOL_NO_OUTPUT']) {
      assert.ok(ids.has(id), 'missing ' + id)
    }
    assert.ok(result.issues.some((issue) => issue.ruleVersion && issue.confidence && issue.source))
  } finally {
    harness.close()
  }
})

test('inspect lists the Host/Client entries and build artifacts', async () => {
  const harness = createHarness()
  try {
    const result = await harness.call('dshpd_inspect', { pluginPath: join(FIXTURES, 'modern-plugin') })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.hostEntry.present, true)
    assert.equal(result.client.bundleExists, true)
    assert.ok(result.artifacts.includes('lib/client.js'))
    assert.ok(result.sourceFiles.includes('src/index.js'))
    assert.equal(result.coverage.incomplete, false)
  } finally {
    harness.close()
  }
})

test('discover runs in a worker and reports coverage', async () => {
  const harness = createHarness()
  try {
    const result = await harness.call('dshpd_discover', { root: FIXTURES, maxDepth: 3 })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(result.count >= 4)
    const modern = result.plugins.find((plugin) => plugin.name === 'modern-plugin')
    assert.equal(modern.bundle, true)
    assert.equal(modern.client, true)
    assert.equal(result.coverage.incomplete, false)
  } finally {
    harness.close()
  }
})

test('design classifies the target, does not invent a Client half and names distribution duties', async () => {
  const harness = createHarness()
  try {
    const result = await harness.call('dshpd_design', { pluginPath: copyFixture('legacy-plugin') })
    assert.equal(result.wrote, true, JSON.stringify(result))
    assert.equal(result.classification.type, 'tool')
    assert.equal(result.classification.clientNeed, 'optional')
    assert.equal(result.ui.proposed, false)
    assert.equal(result.uiMode.mode, 'not-needed')
    const markdown = harness.read(result.designPath)
    assert.match(markdown, /Host\/Client 必要性/)
    assert.match(markdown, /Independent Distribution/)
    assert.match(markdown, /planHash/)
    assert.doesNotMatch(markdown, /Desktop Profile Deployment（桌面版必做）/)
  } finally {
    harness.close()
  }
})

test('design proposes a UI only when asked, and marks it for recovery when one exists', async () => {
  const harness = createHarness()
  try {
    const forced = await harness.call('dshpd_design', { pluginPath: copyFixture('legacy-plugin'), ui: 'propose' })
    assert.equal(forced.ui.proposed, true)
    const withClient = await harness.call('dshpd_design', { pluginPath: copyFixture('modern-plugin') })
    assert.equal(withClient.ui.recovery, true)
    assert.equal(withClient.ui.proposed, false)
  } finally {
    harness.close()
  }
})

test('client health receipts distinguish registered from rendered', async () => {
  const harness = createHarness({
    clientEntries: [{ id: 'modern-plugin', rev: 'rev-1' }],
    clientPaths: { 'modern-plugin': join(FIXTURES, 'modern-plugin', 'lib', 'client.js') },
  })
  try {
    const before = await harness.call('dshpd_ui_check', { pluginPath: join(FIXTURES, 'modern-plugin') })
    assert.equal(before.runtime.inGraph, true)
    assert.equal(before.status, 'UNKNOWN')
    assert.match(before.reason, /no fresh activation\/render receipt/)
    const route = harness.routes.get('/dsh-plugin-design/client-health')
    const response = makeResponse()
    await route.handler(makeRequest('POST', '/dsh-plugin-design/client-health', {
      packageName: 'modern-plugin', activated: true, rendered: true, version: '1.0.0',
    }), response)
    assert.equal(response.statusCode, 200)
    const after = await harness.call('dshpd_ui_check', { pluginPath: join(FIXTURES, 'modern-plugin') })
    assert.equal(after.status, 'PASS')
    assert.equal(after.stages.rendered, true)
    const health = await harness.routes.get('/dsh-plugin-design/health')
      .handler(makeRequest('GET', '/dsh-plugin-design/health?packageName=modern-plugin'), makeResponse())
    void health
  } finally {
    harness.close()
  }
})

test('a declared Client half missing from the graph is FAIL, not WARN', async () => {
  const harness = createHarness({ clientEntries: [] })
  try {
    const result = await harness.call('dshpd_ui_check', { pluginPath: join(FIXTURES, 'modern-plugin') })
    assert.equal(result.status, 'FAIL')
    assert.equal(result.ok, false)
  } finally {
    harness.close()
  }
})

test('settings routes answer info/analyze/discover over the wire contract', async () => {
  const harness = createHarness()
  try {
    const info = makeResponse()
    await harness.routes.get('/dsh-plugin-design/info').handler(makeRequest('GET', '/dsh-plugin-design/info'), info)
    assert.equal(info.statusCode, 200)
    const infoJson = JSON.parse(info.body)
    assert.equal(infoJson.version, '1.4.3')
    assert.equal(infoJson.tools.length, 18)
    assert.ok(infoJson.runtime.running)
    assert.equal(infoJson.deploymentAdapter.available, false)

    const analyze = makeResponse()
    await harness.routes.get('/dsh-plugin-design/analyze').handler(
      makeRequest('POST', '/dsh-plugin-design/analyze', { pluginPath: join(FIXTURES, 'modern-plugin') }), analyze,
    )
    assert.equal(analyze.statusCode, 200)
    assert.equal(JSON.parse(analyze.body).scan.status, 'COMPLETE')

    const discover = makeResponse()
    await harness.routes.get('/dsh-plugin-design/discover').handler(
      makeRequest('GET', '/dsh-plugin-design/discover?root=' + encodeURIComponent(FIXTURES)), discover,
    )
    assert.equal(discover.statusCode, 200)
    assert.ok(JSON.parse(discover.body).count >= 4)
  } finally {
    harness.close()
  }
})

test('an unreadable settings request is rejected without crashing the route', async () => {
  const harness = createHarness()
  try {
    const analyze = makeResponse()
    await harness.routes.get('/dsh-plugin-design/analyze').handler(
      makeRequest('POST', '/dsh-plugin-design/analyze', { pluginPath: join(FIXTURES, 'does-not-exist') }), analyze,
    )
    assert.ok([200, 503].includes(analyze.statusCode))
    const body = JSON.parse(analyze.body)
    if (analyze.statusCode === 503) assert.equal(body.scan.status, 'INCOMPLETE')
    else assert.equal(body.ok, false)
  } finally {
    harness.close()
  }
})
