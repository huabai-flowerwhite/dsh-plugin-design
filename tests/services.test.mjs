import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLIENT_SERVICE_CATALOG,
  FRAMEWORK_SERVICES,
  LEGACY_CLIENT_SERVICES,
  collectClientServiceRefs,
  findEagerServiceLookups,
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

test('findEagerServiceLookups flags cached non-framework lookups at top level and in apply', () => {
  const topLevel = [
    "const ui = ctx.get('uiWorkspace')",
    "const pick = ui && typeof ui.pickDirectory === 'function' ? ui.pickDirectory : null",
  ].join('\n')
  assert.equal(findEagerServiceLookups(topLevel).length, 1)
  assert.equal(findEagerServiceLookups(topLevel)[0].scope, 'top-level')

  const inApply = [
    'export default {',
    '  apply(ctx) {',
    "    const ui = ctx.get('uiWorkspace')",
    "    const pick = ui && typeof ui.pickDirectory === 'function' ? ui.pickDirectory : null",
    '  },',
    '}',
  ].join('\n')
  const applyHits = findEagerServiceLookups(inApply)
  assert.equal(applyHits.length, 1)
  assert.equal(applyHits[0].scope, 'apply')
})

test('findEagerServiceLookups ignores lazy helpers, framework services and uncached use', () => {
  const lazyHelper = [
    'const pickDirectory = function () {',
    "  const ui = ctx.get('uiWorkspace')",
    "  if (ui && typeof ui.pickDirectory === 'function') return ui.pickDirectory()",
    '  return null',
    '}',
  ].join('\n')
  assert.deepEqual(findEagerServiceLookups(lazyHelper), [])

  const arrowHelper = [
    'const getUi = () => {',
    "  const ui = ctx.get('uiWorkspace')",
    '  return ui && typeof ui.pickDirectory === "function" ? ui : null',
    '}',
  ].join('\n')
  assert.deepEqual(findEagerServiceLookups(arrowHelper), [])

  const framework = [
    "const slots = ctx.get('slots')",
    "const ok = slots && typeof slots.register === 'function'",
  ].join('\n')
  assert.deepEqual(findEagerServiceLookups(framework), [])

  const uncached = [
    "const ui = ctx.get('uiWorkspace')",
    'return ui?.pickDirectory?.()',
  ].join('\n')
  assert.deepEqual(findEagerServiceLookups(uncached), [])

  const reference = [
    'var getWorkspace = function () {',
    "  return ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null",
    '}',
  ].join('\n')
  assert.deepEqual(findEagerServiceLookups(reference), [])
})

test('framework service set names the apply-time guarantee', () => {
  assert.ok(FRAMEWORK_SERVICES.has('slots'))
  assert.ok(FRAMEWORK_SERVICES.has('inject'))
  assert.equal(FRAMEWORK_SERVICES.has('uiWorkspace'), false)
})
