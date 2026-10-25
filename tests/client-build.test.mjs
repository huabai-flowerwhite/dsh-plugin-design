// Client bundle tests: source/lib drift, factory-form contract, placeholders.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { checkClient, renderClientBundle } from '../scripts/build-client.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('lib/client.js matches src/client.js (no hand-edited drift)', () => {
  const result = checkClient()
  assert.equal(result.ok, true, result.reason || 'client bundle is stale')
})

test('client bundle is factory-form and carries package metadata', () => {
  const rendered = renderClientBundle()
  assert.match(rendered, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(rendered, /id: "dsh-plugin-design"/)
  assert.match(rendered, /factory: \(require\) => \{/)
  assert.ok(rendered.includes(pkg.version), 'bundle should carry package.json version')
  assert.match(rendered, />=0\.1\.5-rc\.1 <0\.3\.0/)
  assert.doesNotMatch(rendered, /__DSHPD_VERSION__|__DSHPD_HARNESS__/)
  assert.doesNotThrow(() => new Function(rendered))
})

test('checked-in artifact has the rendered byte length', () => {
  const rendered = renderClientBundle()
  assert.equal(statSync(join(root, 'lib', 'client.js')).size, Buffer.byteLength(rendered, 'utf8'))
})

test('client source never calls array methods on a React element', () => {
  // Regression: 1.4.1 shipped `h(...).concat(...)` in FindingList. It only
  // executes when analysis returns findings, so source/artifact/stub checks
  // missed it and the real settings slot crashed with a TypeError.
  const source = readFileSync(join(root, 'src', 'client.js'), 'utf8')
  assert.doesNotMatch(source, /\bh\([^\n]*\)\s*\.\s*concat\(/, 'h(...) returns a React element, not an array')
  assert.doesNotMatch(source, /\}\)\s*\.\s*concat\(/, 'build a children array before calling h()')
})
