// rc.3 Host probe: install the exact plugin tgz into a throwaway DSH_HOME,
// boot the packaged web host with the rc.3 CLI, and capture the full /info
// payload (runtime identity + deployment capability matrix).
//
// Usage:
//   node rc3-host-info.mjs <cli-json> <plugin.tgz> <out.json>

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [cliJsonPath, tgzPath, outPath] = process.argv.slice(2)
const cli = JSON.parse(readFileSync(cliJsonPath, 'utf8'))
const dshHome = mkdtempSync(join(tmpdir(), 'dshpd-rc3-host-'))
const env = { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' }
const tgzBytes = readFileSync(tgzPath)
const result = { schema: 1, collectedAt: new Date().toISOString(), cli, tgzPath, artifact: { path: tgzPath, sha256: createHash('sha256').update(tgzBytes).digest('hex'), bytes: tgzBytes.length }, dshHome, steps: [] }

function run(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cli[0], [...cli.slice(1), ...args], { env, cwd: dshHome, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch (error) { /* ignore */ }
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

function killTree(child) {
  try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch (error) { /* ignore */ }
}

const install = await run(['plugin', '--profile', 'web', 'add', tgzPath], 180_000)
result.steps.push({ step: 'install', code: install.code, stdout: install.stdout.slice(-2000), stderr: install.stderr.slice(-1000) })

const child = spawn(cli[0], [...cli.slice(1), 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, cwd: dshHome, windowsHide: true })
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk })
child.stderr.on('data', (chunk) => { stderr += chunk })
const started = Date.now()
let url = null
while (Date.now() - started < 90_000 && url === null) {
  const match = /dsh web:\s*(\S+)/.exec(stdout)
  if (match !== null) {
    url = match[1]
    break
  }
  if (child.exitCode !== null) break
  await new Promise((resolve) => setTimeout(resolve, 250))
}
result.boot = { url, exitCode: child.exitCode, stdout: stdout.slice(-3000), stderr: stderr.slice(-1000) }
if (url !== null) {
  const base = new URL(url)
  const target = new URL('/dsh-plugin-design/info', base.origin)
  const token = base.searchParams.get('token')
  if (token !== null) target.searchParams.set('token', token)
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(20_000) })
    result.info = { status: response.status, body: JSON.parse(await response.text()) }
  } catch (error) {
    result.info = { error: String(error && error.message ? error.message : error) }
  }
}
killTree(child)
await new Promise((resolve) => setTimeout(resolve, 1500))

const info = result.info && result.info.body ? result.info.body : null
result.checks = {
  installOk: install.code === 0,
  urlFound: url !== null,
  infoOk: result.info ? result.info.status === 200 : false,
  runtimeVersion: info && info.runtime && info.runtime.running ? info.runtime.running.version : null,
  runtimeSource: info && info.runtime && info.runtime.running ? info.runtime.running.versionSource : null,
  carrier: info && info.runtime && info.runtime.running ? info.runtime.running.carrier : null,
  pluginManagerPresent: Boolean(info && info.deploymentAdapter && info.deploymentAdapter.available),
  adapterCapabilities: info && info.deploymentAdapter ? info.deploymentAdapter.capabilities : null,
  adapterUnsupported: info && info.deploymentAdapter ? info.deploymentAdapter.unsupported.map((entry) => entry.method) : null,
  pluginVersion: info ? info.version : null,
}
result.ok = result.checks.installOk && result.checks.urlFound && result.checks.infoOk
  && result.checks.runtimeVersion === '0.2.1-rc.3'
  && result.checks.pluginManagerPresent === true
  && result.checks.adapterCapabilities && result.checks.adapterCapabilities.update === false
  && result.checks.adapterUnsupported && result.checks.adapterUnsupported.includes('updateBundle')
writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8')
try { rmSync(dshHome, { recursive: true, force: true }) } catch (error) { /* ignore */ }
console.log(JSON.stringify({ ok: result.ok, checks: result.checks, outPath }, null, 2))
process.exit(result.ok ? 0 : 1)
