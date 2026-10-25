// Isolated Desktop-window probe.
//
// Goal: determine whether a second Desktop instance can run with its own
// DSH_HOME/userData for real renderer verification. It must never touch the
// user's real profile. The Desktop claims a process-lifetime single-instance
// lock; if the launch exits without a window, the result is NOT_RUN with the
// exact observation, not a fabricated renderer PASS.

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const outPath = process.argv[2]
const exe = 'E:/运行包/DSHpc/DeepSeek Harness.exe'
const root = mkdtempSync(join(tmpdir(), 'dsh-rc3-desktop-probe-'))
const userData = join(root, 'userdata')
const env = { ...process.env, DSH_HOME: root }
const cdpPort = 9333
const evidence = {
  schema: 1,
  startedAt: new Date().toISOString(),
  exe,
  dshHome: root,
  userData,
  args: ['--user-data-dir', userData, `--remote-debugging-port=${cdpPort}`],
  realProfileTouched: false,
}
const child = spawn(exe, evidence.args, { env, detached: false, windowsHide: false })
evidence.pid = child.pid
let exited = false
let exitCode = null
child.on('exit', (code) => { exited = true; exitCode = code })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let cdp = null
let processes = []
for (let attempt = 0; attempt < 40; attempt += 1) {
  await sleep(500)
  if (attempt === 6 || attempt === 19) {
    try {
      const json = execFileSync('powershell', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*.dsh*profiles*desktop*" } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],
      { encoding: 'utf8', timeout: 15_000 })
      if (json.trim() !== '') {
        const parsed = JSON.parse(json)
        processes = Array.isArray(parsed) ? parsed : [parsed]
      }
    } catch (error) {
      evidence.processProbeError = String(error && error.message ? error.message : error)
    }
    if (processes.some((entry) => String(entry.CommandLine || '').includes('.dsh\\profiles\\desktop') || String(entry.CommandLine || '').includes('.dsh/profiles/desktop'))) {
      evidence.realProfileTouched = true
    }
  }
  if (exited) break
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1500) })
    cdp = { status: response.status, body: await response.json() }
    break
  } catch (error) {
    cdp = { error: String(error && error.message ? error.message : error) }
  }
}
evidence.exited = exited
evidence.exitCode = exitCode
evidence.cdp = cdp
evidence.processes = processes.map((entry) => ({ ProcessId: entry.ProcessId, ParentProcessId: entry.ParentProcessId, CommandLine: String(entry.CommandLine || '').slice(0, 400) }))
evidence.profileFiles = existsSync(join(root, 'profiles')) ? readdirSync(join(root, 'profiles')) : []
evidence.rootFiles = readdirSync(root)
if (!exited) {
  try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch (error) { /* ignore */ }
  await sleep(1000)
}
evidence.finishedAt = new Date().toISOString()
evidence.verdict = evidence.realProfileTouched
  ? 'ABORTED_REAL_PROFILE_RISK'
  : exited && cdp === null
    ? 'NOT_RUN_SINGLE_INSTANCE_LOCK'
    : 'ISOLATED_INSTANCE_STARTED'
evidence.reason = evidence.verdict === 'NOT_RUN_SINGLE_INSTANCE_LOCK'
  ? 'the second Desktop process exited before exposing CDP and created no profile; the application holds a process-lifetime single-instance lock, so a separate DSH_HOME/userData alone cannot yield an isolated Desktop renderer'
  : evidence.verdict === 'ABORTED_REAL_PROFILE_RISK'
    ? 'the probe observed a host process targeting the real desktop profile and aborted; real profile must not be used for testing'
    : 'an isolated instance exposed CDP; renderer checks can proceed'
try { rmSync(root, { recursive: true, force: true }) } catch (error) { /* ignore */ }
writeFileSync(outPath, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ verdict: evidence.verdict, exited, exitCode, cdp: cdp === null ? null : Object.keys(cdp), outPath }, null, 2))
process.exit(evidence.verdict === 'ISOLATED_INSTANCE_STARTED' ? 0 : 2)
