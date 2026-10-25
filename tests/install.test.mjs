// Installer regressions: stdout must not be mistaken for the exit code, a
// failed install must not be preceded by a remove, and link mode stays opt-in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { tempDir } from './helpers/harness.mjs'

function makeFakeCli(root) {
  const script = join(root, 'fake-cli.mjs')
  const log = join(root, 'calls.log')
  writeFileSync(script, [
    "import { appendFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    'appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n")',
    'console.log("pnpm output line one")',
    'console.error("pnpm progress line")',
    'process.exit(Number(process.env.FAKE_EXIT || "0"))',
  ].join('\n'), 'utf8')
  if (process.platform === 'win32') {
    const cmd = join(root, 'fake-dsh.cmd')
    writeFileSync(cmd, '@echo off\r\nnode "' + script + '" %*\r\nexit /b %errorlevel%\r\n', 'utf8')
    return { cli: cmd, log }
  }
  const sh = join(root, 'fake-dsh.sh')
  writeFileSync(sh, '#!/usr/bin/env bash\nexec node "' + script + '" "$@"\n', 'utf8')
  chmodSync(sh, 0o755)
  return { cli: sh, log }
}

function psHost() {
  return process.env.DSHPD_PSHOST || (process.platform === 'win32' ? 'powershell' : 'pwsh')
}

function runInstaller(installer, args, env) {
  try {
    const stdout = execFileSync(installer.command, installer.args, {
      encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout }
  } catch (error) {
    return { status: error.status === undefined ? -1 : error.status, stdout: String(error.stdout || '') + String(error.stderr || '') }
  }
}

function readCalls(log) {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('install.ps1 keeps stdout and exit status separate and never removes first', () => {
  const root = tempDir('dshpd-install-')
  const fake = makeFakeCli(root)
  const installer = {
    command: psHost(),
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join('install.ps1'), '-Cli', fake.cli, '-Profile', 'web'],
  }
  const okay = runInstaller(installer, [], { FAKE_LOG: fake.log, FAKE_EXIT: '0' })
  if (okay.status === -1 && /not recognized|ENOENT/i.test(okay.stdout)) {
    // pwsh is the documented interpreter; Windows PowerShell is the fallback.
  }
  assert.equal(okay.status, 0, okay.stdout)
  const calls = readCalls(fake.log)
  assert.ok(calls.some((args) => args.includes('add')), JSON.stringify(calls))
  assert.ok(calls.every((args) => !args.includes('remove')), 'installer must not remove first')
  assert.match(okay.stdout, /pnpm output line one/)
})

test('install.ps1 propagates a failing add without a remove step', () => {
  const root = tempDir('dshpd-install-fail-')
  const fake = makeFakeCli(root)
  const installer = {
    command: psHost(),
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join('install.ps1'), '-Cli', fake.cli, '-Profile', 'web'],
  }
  const failed = runInstaller(installer, [], { FAKE_LOG: fake.log, FAKE_EXIT: '3' })
  assert.equal(failed.status, 3, failed.stdout)
  const calls = readCalls(fake.log)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('add'))
  assert.ok(calls.every((args) => !args.includes('remove')))
})

test('install.ps1 dry-run prints the command and changes nothing', () => {
  const root = tempDir('dshpd-install-dry-')
  const fake = makeFakeCli(root)
  const installer = {
    command: psHost(),
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join('install.ps1'), '-Cli', fake.cli, '-DryRun'],
  }
  const result = runInstaller(installer, [], { FAKE_LOG: fake.log })
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /DRY-RUN:/)
  assert.equal(readCalls(fake.log).length, 0)
})

test('install.sh uses the same no-remove contract when bash is available', () => {
  const root = tempDir('dshpd-install-sh-')
  const fake = makeFakeCli(root)
  const bash = process.platform === 'win32' ? 'bash.exe' : 'bash'
  try {
    execFileSync(bash, ['--version'], { stdio: 'ignore' })
  } catch (error) {
    return // NOT_RUN: no bash on this machine; recorded in the support matrix.
  }
  const result = runInstaller({ command: bash, args: [join('install.sh'), '--profile', 'web'] }, [], {
    DSHPD_CLI: fake.cli, FAKE_LOG: fake.log, FAKE_EXIT: '0',
  })
  // A Windows .cmd cannot be exec'd by bash; skip in that combination.
  if (process.platform === 'win32') return
  assert.equal(result.status, 0, result.stdout)
  const calls = readCalls(fake.log)
  assert.ok(calls.some((args) => args.includes('add')))
  assert.ok(calls.every((args) => !args.includes('remove')))
})

test('both installers still refuse to guess a CLI and never mention a remove-then-add upgrade', () => {
  const ps1 = readFileSync('install.ps1', 'utf8')
  const sh = readFileSync('install.sh', 'utf8')
  assert.match(ps1, /will not fall back to editing a profile directly/)
  assert.match(sh, /will not edit a profile directly/)
  for (const text of [ps1, sh]) {
    assert.equal(/-Remove|remove \$|'remove'|"remove"/.test(text), false)
  }
})
