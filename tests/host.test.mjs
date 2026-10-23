// Host-half tests: tool registration, route registration, analyzer against
// fixtures, and the full approval → backup → apply → verify → rollback flow
// plus manifest migrations. Uses a node:fs-backed mock of the harness ctx.fs
// contract (resolve returns a target object; readText/editText take targets).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import host from '../src/host.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(here, 'fixtures')
const temporaryRoots = []

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

function targetPath(target) {
  return typeof target === 'string' ? target : target.displayPath
}

function createFs() {
  return {
    async resolve(target) { return { displayPath: target } },
    async readText(target) {
      try { return readFileSync(targetPath(target), 'utf8') } catch (error) { return null }
    },
    async writeText(target, content) {
      mkdirSync(dirname(targetPath(target)), { recursive: true })
      writeFileSync(targetPath(target), content, 'utf8')
      return { bytes: Buffer.byteLength(content, 'utf8') }
    },
    async editText(target, edit) {
      const before = readFileSync(targetPath(target), 'utf8')
      const matches = before.split(edit.oldString).length - 1
      if (matches === 0) throw new Error('oldString not found')
      if (matches > 1 && edit.replaceAll !== true) throw new Error('oldString matched ' + matches + ' times')
      const after = before.split(edit.oldString).join(edit.newString)
      writeFileSync(targetPath(target), after, 'utf8')
      return { before, after }
    },
    async listDir(target) {
      return readdirSync(targetPath(target), { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        // Mirror the real harness FsDirEntry: children carry a resolved target.
        target: { displayPath: join(targetPath(target), entry.name) },
      }))
    },
    async stat(target) {
      try { return statSync(targetPath(target)) } catch (error) { return undefined }
    },
  }
}

function createHarness() {
  const tools = new Map()
  const routes = []
  const fsService = createFs()
  const sandboxPolicy = { resolve() { return undefined }, workspaceRoot: undefined }
  const clientModules = {
    graph() {
      return {
        rev: 'test-rev',
        entries: [{ id: 'modern-plugin', rev: 'bundle-rev' }],
      }
    },
    table: new Map([
      ['modern-plugin', {
        meta: {
          clientPath: join(FIXTURES, 'modern-plugin', 'lib', 'client.js'),
          inject: ['slots'],
          external: [],
          immediately: false,
        },
      }],
    ]),
    clientPath(name) {
      const record = this.table.get(name)
      return record === undefined ? undefined : record.meta.clientPath
    },
  }
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(tools.has(definition.name), false, 'duplicate tool registration: ' + definition.name)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    get(name) {
      if (name === 'fs') return fsService
      if (name === 'sandboxPolicy') return sandboxPolicy
      if (name === 'clientModules') return clientModules
      return undefined
    },
    effect(callback) { return callback() },
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['webServer'])
      return callback({
        webServer: {
          register(route) { routes.push(route); return () => {} },
        },
        effect(fn) { return fn() },
      })
    },
  }
  host.apply(ctx)
  // 0.2.x: fs and sandboxPolicy are agent-plane services, so tools receive
  // them through exec.agent.ctx rather than the plugin context.
  const exec = {
    agent: {
      id: 'test-agent',
      ctx: {
        get(name) {
          if (name === 'fs') return fsService
          if (name === 'sandboxPolicy') return sandboxPolicy
          return undefined
        },
      },
    },
  }
  return { tools, routes, exec }
}

function call(harness, name, args) {
  const definition = harness.tools.get(name)
  assert.ok(definition, 'tool missing: ' + name)
  return definition.execute(args, harness.exec)
}

function copyFixture(name) {
  const root = mkdtempSync(join(tmpdir(), 'dshpd-test-'))
  temporaryRoots.push(root)
  const work = join(root, 'plugin')
  cpSync(join(FIXTURES, name), work, { recursive: true })
  return work
}

function makeRouteRequest(method, url, body) {
  return {
    method,
    url,
    async* [Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
}

function makeRouteResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(value) { this.body += value === undefined ? '' : String(value) },
  }
}

test('registers exactly 13 tools and 3 settings routes', () => {
  const harness = createHarness()
  assert.equal(harness.tools.size, 13)
  assert.deepEqual([...harness.tools.keys()].sort(), [
    'dshpd_analyze', 'dshpd_apply', 'dshpd_approve', 'dshpd_backup',
    'dshpd_design', 'dshpd_discover', 'dshpd_inspect', 'dshpd_migrate',
    'dshpd_report', 'dshpd_rollback', 'dshpd_status', 'dshpd_ui_check', 'dshpd_verify',
  ])
  assert.deepEqual(harness.routes.map((route) => route.path).sort(), [
    '/dsh-plugin-design/analyze', '/dsh-plugin-design/discover', '/dsh-plugin-design/info',
  ])
  for (const route of harness.routes) assert.equal(route.kind, 'exact')
})

test('modern fixture is READY_TO_MODIFY under a 0.2.1 runtime', async () => {
  const harness = createHarness()
  const result = await call(harness, 'dshpd_analyze', {
    pluginPath: join(FIXTURES, 'modern-plugin'),
    harnessVersion: '0.2.1-rc.2',
  })
  assert.equal(result.overall, 'READY_TO_MODIFY')
  assert.equal(result.official.compatibility.satisfied, true)
  assert.equal(result.official.compatibility.source, 'engines.dsh')
  assert.equal(result.official.bundle.declared, true)
  assert.equal(result.official.client.factoryForm, true)
  for (const severity of ['BLOCKER', 'CRITICAL', 'HIGH']) {
    assert.equal(result.counts[severity], 0, severity + ' findings: ' + JSON.stringify(result.issues.filter((issue) => issue.severity === severity)))
  }
})

test('legacy fixture accumulates the expected pre-0.2 findings', async () => {
  const harness = createHarness()
  const result = await call(harness, 'dshpd_analyze', { pluginPath: join(FIXTURES, 'legacy-plugin') })
  const ids = new Set(result.issues.map((issue) => issue.id))
  for (const expected of [
    'ENGINES_DSH_MISSING', 'BUNDLE_NOT_DECLARED', 'CORE_ROW_REPLACE',
    'GLOBALTHIS_PATCH', 'GLOBAL_MUTABLE_STATE', 'TOOL_NO_OUTPUT',
    'MANIFEST_NO_ID', 'MANIFEST_NO_HARNESS',
  ]) {
    assert.ok(ids.has(expected), 'missing finding ' + expected + '; got ' + [...ids].join(','))
  }
  assert.equal(result.overall, 'BLOCKED')
  assert.ok(result.migrations.some((migration) => migration.id === 'engines-dsh'))
  assert.ok(result.migrations.some((migration) => migration.id === 'bundle-patch'))
})

test('removed 0.2.0 APIs are flagged as blockers', async () => {
  const harness = createHarness()
  const result = await call(harness, 'dshpd_analyze', { pluginPath: join(FIXTURES, 'removed-api-plugin') })
  const ids = new Set(result.issues.map((issue) => issue.id))
  for (const expected of ['INVARIANTS_DEP', 'INVARIANTS_IMPORT', 'SUBPATH_PACKAGE_JSON', 'ENGINES_DSH_MISSING']) {
    assert.ok(ids.has(expected), 'missing finding ' + expected + '; got ' + [...ids].join(','))
  }
  assert.equal(result.overall, 'BLOCKED')
})

test('discover finds all fixtures and reports their official roles', async () => {
  const harness = createHarness()
  const result = await call(harness, 'dshpd_discover', { root: FIXTURES, maxDepth: 3 })
  assert.ok(result.count >= 3)
  const modern = result.plugins.find((plugin) => plugin.name === 'modern-plugin')
  assert.ok(modern)
  assert.equal(modern.bundle, true)
  assert.equal(modern.client, true)
  assert.equal(modern.enginesDsh, '>=0.1.5-rc.1 <0.3.0')
})

test('approval → backup → apply → verify → report → rollback restores the file', async () => {
  const harness = createHarness()
  const work = copyFixture('modern-plugin')
  const readme = join(work, 'README.md')
  const packageJson = join(work, 'package.json')
  const original = readFileSync(readme, 'utf8')

  const approval = await call(harness, 'dshpd_approve', {
    pluginPath: work,
    designPath: join(work, '.dsh-plugin-design', 'design.md'),
  })
  assert.ok(approval.approvalToken)
  const backup = await call(harness, 'dshpd_backup', {
    approvalToken: approval.approvalToken,
    files: [readme, packageJson],
  })
  assert.equal(backup.failed, 0)
  assert.equal(backup.backedUp, 2)

  const dryRun = await call(harness, 'dshpd_apply', {
    approvalToken: approval.approvalToken,
    backupId: backup.backupId,
    filePath: readme,
    oldText: '# modern-plugin (fixture)',
    newText: '# modern-plugin (edited)',
    dryRun: true,
  })
  assert.equal(dryRun.matches, 1)

  const applied = await call(harness, 'dshpd_apply', {
    approvalToken: approval.approvalToken,
    backupId: backup.backupId,
    filePath: readme,
    oldText: '# modern-plugin (fixture)',
    newText: '# modern-plugin (edited)',
  })
  assert.equal(applied.applied, true)
  assert.match(readFileSync(readme, 'utf8'), /edited/)

  // A second edit to the same file must be allowed: the task tracks the hash
  // produced by the previous edit, not only the original backup hash.
  const appliedAgain = await call(harness, 'dshpd_apply', {
    approvalToken: approval.approvalToken,
    backupId: backup.backupId,
    filePath: readme,
    oldText: '# modern-plugin (edited)',
    newText: '# modern-plugin (edited twice)',
  })
  assert.equal(appliedAgain.applied, true)

  const verify = await call(harness, 'dshpd_verify', { pluginPath: work })
  assert.equal(verify.ok, true)
  assert.ok(verify.checks.some((check) => check.id === 'CLIENT_BUNDLE' && check.status === 'PASS'))

  const report = await call(harness, 'dshpd_report', { backupId: backup.backupId })
  assert.equal(report.edits.length, 2)
  assert.equal(report.analysisAfter.counts.BLOCKER, 0)

  // External change after the snapshot: the next edit must be refused.
  const tampered = readFileSync(readme, 'utf8') + '\nexternal change\n'
  writeFileSync(readme, tampered, 'utf8')
  const stale = await call(harness, 'dshpd_apply', {
    approvalToken: approval.approvalToken,
    backupId: backup.backupId,
    filePath: readme,
    oldText: '# modern-plugin (edited twice)',
    newText: '# modern-plugin (edited three times)',
  })
  assert.match(stale.error, /changed since the backup snapshot/)

  const rollback = await call(harness, 'dshpd_rollback', { backupId: backup.backupId })
  assert.equal(rollback.failed, 0)
  assert.equal(readFileSync(readme, 'utf8'), original)

  const status = await call(harness, 'dshpd_status', { pluginPath: work })
  assert.equal(status.backups.length, 1)
  assert.ok(status.journal.length >= 2)
  assert.ok(statSync(join(work, '.dsh-plugin-design', 'backup', backup.backupId, 'manifest.json')).size > 0)
})

test('manifest migrations upgrade a bare package.json', async () => {
  const harness = createHarness()
  const root = mkdtempSync(join(tmpdir(), 'dshpd-migrate-'))
  temporaryRoots.push(root)
  const work = join(root, 'plugin')
  mkdirSync(join(work, 'lib'), { recursive: true })
  mkdirSync(join(work, 'tests'), { recursive: true })
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'migrate-me', version: '0.1.0', main: 'index.js' }, null, 2) + '\n')
  writeFileSync(join(work, 'cordis.patch.yml'), "- insert:\n    - id: migrate-me\n      name: 'migrate-me'\n")
  writeFileSync(join(work, 'lib', 'client.js'), 'window.__ModuleLoader__.load({ id: "migrate-me", factory: (require) => { var module = { exports: {} }; function apply() {} module.exports.apply = apply; module.exports.inject = ["slots"]; module.exports.slots = ["settings.section"]; return module.exports; } });\n')
  writeFileSync(join(work, 'README.md'), '# migrate-me\n')
  writeFileSync(join(work, 'LICENSE'), 'MIT\n')
  writeFileSync(join(work, 'tests', 'smoke.test.js'), '// smoke\n')

  const packageJson = join(work, 'package.json')
  const approval = await call(harness, 'dshpd_approve', { pluginPath: work, designPath: join(work, 'design.md') })
  const backup = await call(harness, 'dshpd_backup', { approvalToken: approval.approvalToken, files: [packageJson] })
  const migrated = await call(harness, 'dshpd_migrate', {
    approvalToken: approval.approvalToken,
    backupId: backup.backupId,
    migrations: ['manifest-version', 'engines-dsh', 'bundle-patch', 'client-meta'],
    options: { dshRange: '>=0.2.0 <0.3.0' },
  })
  assert.equal(migrated.changed, true)
  assert.equal(migrated.skipped.length, 0)

  const pkg = JSON.parse(readFileSync(packageJson, 'utf8'))
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.equal(pkg.engines.dsh, '>=0.2.0 <0.3.0')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.exports['./package.json'], './package.json')

  const verify = await call(harness, 'dshpd_verify', { pluginPath: work })
  assert.equal(verify.ok, true)
})

test('ui_check combines runtime client graph with static UI diagnostics', async () => {
  const harness = createHarness()
  const result = await call(harness, 'dshpd_ui_check', { pluginPath: join(FIXTURES, 'modern-plugin') })
  assert.equal(result.packageName, 'modern-plugin')
  assert.equal(result.runtime.available, true)
  assert.equal(result.runtime.inGraph, true)
  assert.equal(result.runtime.rev, 'bundle-rev')
  assert.equal(result.buildStale, false)
  assert.equal(result.applyPresent, true)
  assert.ok(result.uiSlots.includes('settings.section'))
})

test('design proposes a UI for a plugin without a client half and verify expects it', async () => {
  const harness = createHarness()
  const work = copyFixture('legacy-plugin')
  const design = await call(harness, 'dshpd_design', { pluginPath: work })
  assert.equal(design.wrote, true)
  assert.equal(design.ui.proposed, true)
  assert.equal(design.ui.entry, 'settings.section')
  assert.match(design.ui.wireframe, /┌/)
  assert.match(design.ui.userMessage, /设置/)
  assert.match(design.ui.userMessage, /```text/)
  const markdown = readFileSync(design.designPath, 'utf8')
  assert.match(markdown, /UI 方案建议/)
  assert.match(markdown, /settings\.section/)
  const meta = JSON.parse(readFileSync(design.designMetaPath, 'utf8'))
  assert.equal(meta.ui.expected, true)
  assert.equal(meta.ui.proposed, true)

  const approval = await call(harness, 'dshpd_approve', { pluginPath: work, designPath: design.designPath })
  await call(harness, 'dshpd_backup', { approvalToken: approval.approvalToken, files: [join(work, 'package.json')] })
  const verify = await call(harness, 'dshpd_verify', { pluginPath: work })
  assert.equal(verify.ok, false)
  assert.ok(verify.checks.some((check) => check.id === 'UI_EXPECTED' && check.status === 'FAIL'))
})

test('settings routes answer info/analyze/discover over the wire contract', async () => {
  const harness = createHarness()
  const byPath = new Map(harness.routes.map((route) => [route.path, route]))

  const info = makeRouteResponse()
  await byPath.get('/dsh-plugin-design/info').handler(makeRouteRequest('GET', '/dsh-plugin-design/info'), info)
  assert.equal(info.statusCode, 200)
  const infoJson = JSON.parse(info.body)
  assert.equal(infoJson.version, '1.2.3')
  assert.equal(infoJson.tools.length, 13)

  const analyze = makeRouteResponse()
  await byPath.get('/dsh-plugin-design/analyze').handler(
    makeRouteRequest('POST', '/dsh-plugin-design/analyze', { pluginPath: join(FIXTURES, 'modern-plugin') }),
    analyze,
  )
  assert.equal(analyze.statusCode, 200)
  assert.equal(JSON.parse(analyze.body).overall, 'READY_TO_MODIFY')

  const discover = makeRouteResponse()
  await byPath.get('/dsh-plugin-design/discover').handler(
    makeRouteRequest('GET', '/dsh-plugin-design/discover?root=' + encodeURIComponent(FIXTURES)),
    discover,
  )
  assert.equal(discover.statusCode, 200)
  assert.ok(JSON.parse(discover.body).count >= 3)
})
