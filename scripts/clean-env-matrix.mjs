#!/usr/bin/env node
// Clean-environment validation driver.
//
// This is a development/release tool, not part of the plugin runtime. It takes
// an explicit DSH CLI argv (never guessed from the author's machine) and runs
// the exact `.tgz` through install -> cold start -> probe -> restart ->
// uninstall -> boot again in a fresh DSH_HOME. The JSON evidence is written to
// the requested output directory.
//
// Example:
//   node scripts/clean-env-matrix.mjs --cli-json '["C:/path/to/dsh-launcher","--expose-internals","C:/path/to/cli.js"]' \
//     --tgz out/package.tgz --name my-plugin --probe /my-plugin/health --out out/evidence

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { runDshHost } from '../src/validation/runner.js'

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      out[name] = true
      continue
    }
    out[name] = value
    index += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const outDir = resolve(typeof args.out === 'string' ? args.out : 'clean-env-evidence')
const stateDir = join(outDir, 'state')
mkdirSync(stateDir, { recursive: true })
let cliCommand = null
if (typeof args['cli-json'] === 'string') {
  try {
    cliCommand = JSON.parse(args['cli-json'])
  } catch (error) {
    console.error('invalid --cli-json: ' + String(error && error.message ? error.message : error))
    process.exit(64)
  }
}
if (typeof args['cli-json-file'] === 'string') {
  try {
    cliCommand = JSON.parse(readFileSync(args['cli-json-file'], 'utf8'))
  } catch (error) {
    console.error('invalid --cli-json-file: ' + String(error && error.message ? error.message : error))
    process.exit(64)
  }
}
if (args['dry-run'] === true) {
  console.log(JSON.stringify({ ok: true, dryRun: true, wouldValidate: args.tgz, cliCommand }, null, 2))
  process.exit(0)
}
const evidence = await runDshHost({
  tgzPath: resolve(String(args.tgz)),
  expectedName: typeof args.name === 'string' ? args.name : undefined,
  probePath: typeof args.probe === 'string' ? args.probe : undefined,
  stateDir,
  cliCommand,
  timeoutMs: Number.isFinite(Number(args['timeout-ms'])) ? Number(args['timeout-ms']) : undefined,
})
const artifactPath = resolve(String(args.tgz))
evidence.artifact = {
  path: artifactPath,
  sha256: createHash('sha256').update(readFileSync(artifactPath)).digest('hex'),
  bytes: readFileSync(artifactPath).length,
  expectedName: typeof args.name === 'string' ? args.name : null,
  probePath: typeof args.probe === 'string' ? args.probe : null,
}
mkdirSync(outDir, { recursive: true })
const evidencePath = join(outDir, 'clean-env-evidence.json')
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({
  status: evidence.status,
  gates: evidence.gates,
  evidencePath,
  runDir: evidence.evidencePath || null,
  verified: evidence.verified === true,
}, null, 2))
process.exit(evidence.status === 'PASS' ? 0 : 1)
