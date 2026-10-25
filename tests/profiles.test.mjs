// Read-only profile inspection and the removed direct-write path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ensureDesktopMount, homePatchLayer, inspectDeployment, inspectProfile, mountRowYaml, parseMountRows,
} from '../src/profiles.js'
import { tempDir, writeProfile } from './helpers/harness.mjs'

test('parseMountRows reads insert rows, overrides, names and disabled flags', () => {
  const rows = parseMountRows([
    '- insert:',
    '    - id: alpha',
    "      name: 'Alpha plugin'",
    '    - id: beta',
    '      disabled: true',
    '- id: gamma',
    "  name: 'Gamma'",
  ].join('\n'))
  assert.deepEqual(rows.map((row) => row.id), ['alpha', 'beta', 'gamma'])
  assert.equal(rows[0].name, 'Alpha plugin')
  assert.equal(rows[1].disabled, true)
  assert.equal(rows[2].disabled, false)
})

test('deployment reports installed, selected and enabled as different states', () => {
  const dshHome = tempDir('dshpd-profiles-')
  writeProfile(dshHome, 'desktop', {
    rows: ["- insert:\n    - id: demo\n      name: 'demo'"],
    packages: { demo: '1.0.0' },
  })
  writeProfile(dshHome, 'web', {
    rows: ["- insert:\n    - id: demo\n      name: 'demo'\n      disabled: true"],
  })
  const deployment = inspectDeployment('demo', { dshHome })
  assert.equal(deployment.installedAnywhere, true)
  assert.equal(deployment.selectedAnywhere, true)
  assert.equal(deployment.enabledAnywhere, true)
  const desktop = deployment.profiles.find((profile) => profile.profile === 'desktop')
  const web = deployment.profiles.find((profile) => profile.profile === 'web')
  assert.equal(desktop.selected, true)
  assert.equal(desktop.enabled, true)
  assert.equal(web.selected, true)
  assert.equal(web.enabled, false)
  assert.equal(web.packageResolvable, false)
})

test('the home patch layer is reported separately from profile patches', () => {
  const dshHome = tempDir('dshpd-home-layer-')
  writeFileSync(join(dshHome, 'cordis.patch.yml'), '- id: demo\n  disabled: true\n', 'utf8')
  const layer = homePatchLayer(dshHome)
  assert.equal(layer.exists, true)
  assert.equal(layer.rows.length, 1)
  assert.equal(layer.rows[0].disabled, true)
})

test('mountRowYaml refuses an invalid package name and escapes the label', () => {
  assert.throws(() => mountRowYaml('evil\n- remove: core', 'x'), /refusing to render/)
  assert.throws(() => mountRowYaml('Has Space', 'x'), /refusing to render/)
  const scoped = mountRowYaml('@scope/demo', "O'Brien")
  assert.match(scoped, /- id: @scope\/demo/)
  assert.match(scoped, /name: 'O''Brien'/)
  assert.equal(scoped.trim().split('\n').filter((line) => line.startsWith('- insert:')).length, 1)
})

test('ensureDesktopMount is a hard failure now and never writes a profile', () => {
  const dshHome = tempDir('dshpd-no-write-')
  const profileDir = writeProfile(dshHome, 'desktop', { rows: ['- insert:\n    - id: other'] })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const before = readFileSync(patchPath, 'utf8')
  const result = ensureDesktopMount('demo', { dshHome, apply: true })
  assert.equal(result.applied, false)
  assert.equal(result.error, 'DEPRECATED_WRITE_PATH')
  assert.equal(readFileSync(patchPath, 'utf8'), before)
})

test('inspectProfile tolerates a missing patch and reports it as unselected', () => {
  const dshHome = tempDir('dshpd-missing-patch-')
  mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true })
  const profile = inspectProfile(dshHome, 'web', 'demo')
  assert.equal(profile.patchExists, false)
  assert.equal(profile.selected, false)
  assert.equal(profile.packageResolvable, false)
})
