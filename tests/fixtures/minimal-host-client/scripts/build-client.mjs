// Build the prebuilt client bundle for the distribution fixture.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const body = readFileSync(join(root, 'src', 'client.js'), 'utf8')
const indented = body.split('\n').map((line) => (line.trim() === '' ? '' : '    ' + line)).join('\n')
const rendered = [
  '// Generated from src/client.js - do not edit by hand.',
  'window.__ModuleLoader__.load({',
  '  id: ' + JSON.stringify(pkg.name) + ',',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  indented,
  '    return module.exports;',
  '  },',
  '});',
  '',
].join('\n')
mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), rendered, 'utf8')
console.log('wrote lib/client.js (' + Buffer.byteLength(rendered) + ' bytes)')
