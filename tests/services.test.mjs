import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLIENT_SERVICE_CATALOG,
  LEGACY_CLIENT_SERVICES,
  collectClientServiceRefs,
  findWorkspacesPickerMisuse,
} from '../src/services.js'

test('collectClientServiceRefs reads literal ctx.get names once', () => {
  const refs = collectClientServiceRefs([
    "const a = ctx.get('uiWorkspace')",
    'const b = ctx.get("workspaces")',
    "const c = ctx.get('uiWorkspace')",
    'const dynamic = ctx.get(name)',
  ].join('\n'))
  assert.deepEqual(refs, ['uiWorkspace', 'workspaces'])
})

test('catalog keeps workspaces and uiWorkspace as distinct valid services', () => {
  assert.ok(CLIENT_SERVICE_CATALOG.has('workspaces'))
  assert.ok(CLIENT_SERVICE_CATALOG.has('uiWorkspace'))
  assert.ok(CLIENT_SERVICE_CATALOG.has('sessions'))
  assert.ok(CLIENT_SERVICE_CATALOG.has('theme'))
  assert.equal(LEGACY_CLIENT_SERVICES.has('styles'), true)
  assert.equal(LEGACY_CLIENT_SERVICES.has('workspaces'), false)
})

test('findWorkspacesPickerMisuse catches direct and aliased calls', () => {
  assert.equal(findWorkspacesPickerMisuse("ctx.get('workspaces').pickDirectory()").length, 1)
  assert.equal(findWorkspacesPickerMisuse('ctx.workspaces?.pickDirectory()').length, 1)
  assert.equal(findWorkspacesPickerMisuse([
    "const ws = ctx.get('workspaces')",
    'await ws.pickDirectory()',
  ].join('\n')).length, 1)
})

test('findWorkspacesPickerMisuse leaves valid APIs alone', () => {
  assert.deepEqual(findWorkspacesPickerMisuse([
    "const ui = ctx.get('uiWorkspace')",
    'await ui.pickDirectory()',
    "const ws = ctx.get('workspaces')",
    'await ws.create({ title: "x" })',
  ].join('\n')), [])
})
