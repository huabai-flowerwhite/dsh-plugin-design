// Placeholder test so the fixture has a test surface.
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('legacy fixture loads', () => {
  assert.equal(typeof globalThis.legacyPluginState, 'object')
})
