// Package-manifest / bundle / client-artifact smoke tests
//
// Run: node --test (package.json "test")
//
// Verifies this plugin's own official 0.2.x packaging plus the DH-TP-SDK
// engineering manifest, and proves the checked-in client artifact is generated
// from src/client.js rather than hand-edited.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { checkClient } from '../scripts/build-client.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

const TOOL_NAMES = [
  'dshpd_discover', 'dshpd_inspect', 'dshpd_analyze', 'dshpd_ui_check', 'dshpd_design',
  'dshpd_approve', 'dshpd_backup', 'dshpd_apply', 'dshpd_migrate',
  'dshpd_verify', 'dshpd_rollback', 'dshpd_status', 'dshpd_report',
]

test('package.json follows the official 0.2.x plugin contract', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.name, 'dsh-plugin-design')
  assert.equal(pkg.version, '1.2.2')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.license, 'MIT')
  assert.match(pkg.engines.dsh, />=0\.1\.5-rc\.1/)
  assert.match(pkg.engines.node, />=22/)
  assert.equal(pkg.exports['.'], './src/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.exports['./package.json'], './package.json')
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.compatibility.harness, pkg.engines.dsh)
  assert.ok(existsSync(join(root, pkg.icon)), 'declared icon must exist inside the package')
  assert.ok(pkg.repository && pkg.repository.url)
})

test('dsh.plugin.yaml keeps the DH-TP-SDK engineering manifest in sync', () => {
  const raw = read('dsh.plugin.yaml')
  assert.match(raw, /^manifestVersion:\s*1\s*$/m)
  assert.match(raw, /^\s+id:\s*com\.example\.dsh\.plugin-design\s*$/m)
  assert.match(raw, /^\s+version:\s*1\.2\.2\s*$/m)
  assert.match(raw, /^\s+min:\s*0\.1\.5-rc\.1\s*$/m)
  assert.match(raw, /^\s+max:\s*"<0\.3\.0"\s*$/m)
  assert.match(raw, /^\s+apiLevel:\s*1\s*$/m)
  assert.match(raw, /^permissions:/m)
  assert.match(raw, /^resources:/m)
  assert.match(raw, /^lifecycle:/m)
  assert.match(raw, /^\s+level:\s*S2\s*$/m)
  for (const tool of TOOL_NAMES) {
    assert.match(raw, new RegExp('tool\\.' + tool), 'capabilities should list ' + tool)
  }
  assert.match(raw, /outbound:\s*false/)
  assert.match(raw, /^\s+enabled:\s*false\s*$/m)
  assert.match(raw, /access:\s*false/)
})

test('cordis.patch.yml only inserts this plugin row (bare package name)', () => {
  const raw = read('cordis.patch.yml')
  assert.match(raw, /- insert:/)
  assert.match(raw, /id:\s*dsh-plugin-design/)
  assert.match(raw, /name:\s*'dsh-plugin-design'/)
  assert.doesNotMatch(raw, /^\s*-?\s*replace:/m)
})

test('client bundle is generated from source and not stale', () => {
  const result = checkClient()
  assert.equal(result.ok, true, result.reason || 'lib/client.js is stale')
  const raw = read('lib/client.js')
  assert.match(raw, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(raw, /factory: \(require\) => \{/)
})

test('source code avoids high-risk patterns', () => {
  const files = ['src/host.js', 'src/rules.js', 'src/client.js', 'src/index.js', 'lib/client.js']
  for (const relativePath of files) {
    const lines = read(relativePath).split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const location = relativePath + ':' + (index + 1)
      assert.doesNotMatch(line, /globalThis\s*\.\s*[A-Za-z_$][\w$]*\s*=/, 'globalThis assignment at ' + location)
      assert.doesNotMatch(line, /window\s*\.\s*[A-Za-z_$][\w$]*\s*=/, 'window assignment at ' + location)
      assert.doesNotMatch(line, /\b[A-Za-z_$][\w$]*\.prototype\.[A-Za-z_$][\w$]*\s*=/, 'prototype patch at ' + location)
      assert.doesNotMatch(line, /\bas\s+(?:any|unknown)\b/, 'type escape at ' + location)
      assert.doesNotMatch(line, /(rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-fd|git\s+push\s+--force|rmdir\s+\/s)/i, 'destructive command at ' + location)
      assert.doesNotMatch(line, /exec\s*\(\s*["'][^"']*\+|exec\s*\(\s*`[^`]*\$\{/, 'command injection at ' + location)
    }
  }
})

test('host half resolves no @deepseek-ai package at runtime', () => {
  for (const relativePath of ['src/host.js', 'src/rules.js']) {
    const raw = read(relativePath)
    assert.doesNotMatch(raw, /from\s+['"]@deepseek-ai\//, relativePath + ' imports a harness package')
    assert.doesNotMatch(raw, /import\s*\(\s*['"]@deepseek-ai\//, relativePath + ' dynamically imports a harness package')
  }
})

test('install scripts prefer the official bundle installer and keep a link fallback', () => {
  const powershell = read('install.ps1')
  assert.match(powershell, /dsh plugin --profile|'plugin', '--profile'/)
  assert.match(powershell, /fallback link mode/)
  assert.match(powershell, /Test-BundleInstalled/)
  const shell = read('install.sh')
  assert.match(shell, /plugin --profile/)
  assert.match(shell, /fallback link mode/)
  assert.match(shell, /has_bundle/)
})
