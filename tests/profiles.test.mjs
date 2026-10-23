import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ensureDesktopMount,
  inspectDeployment,
  mountRowYaml,
  parseMountRows,
} from '../src/profiles.js'

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dshpd-profile-'))
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  return home
}

function installPackage(home, profile, name) {
  const dir = join(home, 'profiles', profile, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf8')
}

test('parseMountRows reads inserted ids and display names', () => {
  const rows = parseMountRows([
    '- insert:',
    '    - id: ui-settings',
    "      name: 'Settings'",
    '    - id: dsh-ui-skin',
    "      name: 'UI 皮肤'",
    '',
  ].join('\n'))
  assert.deepEqual(rows.map((row) => row.id), ['ui-settings', 'dsh-ui-skin'])
  assert.equal(rows[1].name, 'UI 皮肤')
})

test('deployment detects desktop/web mounts and package resolution separately', () => {
  const home = makeHome()
  writeFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), [
    '- insert:',
    '    - id: dsh-plugin-design',
    "      name: 'dsh-plugin-design'",
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- insert:',
    '    - id: dsh-plugin-manager',
    "      name: 'dsh-plugin-manager'",
    '',
  ].join('\n'), 'utf8')
  installPackage(home, 'desktop', 'dsh-plugin-design')
  installPackage(home, 'web', 'dsh-plugin-manager')

  const design = inspectDeployment('dsh-plugin-design', { dshHome: home })
  assert.equal(design.desktop.mounted, true)
  assert.equal(design.desktop.packageResolvable, true)
  assert.equal(design.web.mounted, false)

  const manager = inspectDeployment('dsh-plugin-manager', { dshHome: home })
  assert.equal(manager.desktop.mounted, false)
  assert.equal(manager.web.mounted, true)
  assert.equal(manager.needsDesktopMount, true)
  assert.match(manager.mountRow, /- id: dsh-plugin-manager/)
})

test('ensureDesktopMount is a dry run by default and backs up before applying', () => {
  const home = makeHome()
  const patchPath = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  writeFileSync(patchPath, '- insert:\n    - id: ui-settings\n', 'utf8')
  installPackage(home, 'desktop', 'demo-plugin')
  const before = readFileSync(patchPath, 'utf8')

  const dry = ensureDesktopMount('demo-plugin', { dshHome: home })
  assert.equal(dry.applied, false)
  assert.equal(dry.dryRun, true)
  assert.match(dry.append, /- id: demo-plugin/)
  assert.equal(readFileSync(patchPath, 'utf8'), before)

  const applied = ensureDesktopMount('demo-plugin', { dshHome: home, apply: true })
  assert.equal(applied.applied, true)
  assert.equal(existsSync(applied.backupPath), true)
  assert.match(readFileSync(patchPath, 'utf8'), /- id: demo-plugin/)
  assert.equal(inspectDeployment('demo-plugin', { dshHome: home }).desktop.mounted, true)

  const again = ensureDesktopMount('demo-plugin', { dshHome: home, apply: true })
  assert.equal(again.applied, false)
  assert.equal(again.alreadyMounted, true)
})

test('mountRowYaml escapes single quotes in display names', () => {
  assert.match(mountRowYaml('demo-plugin', "Demo's UI"), /name: 'Demo''s UI'/)
})
