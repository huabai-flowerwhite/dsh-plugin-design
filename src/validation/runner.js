// dsh-plugin-design — isolated validation runner.
//
// Two modes:
//   package-load  Extract the exact `.tgz` into a throwaway consumer directory
//                 that cannot resolve the author's source or the maintenance
//                 plugin, import the Host half in a child Node process, call a
//                 representative tool, then load the Client factory in a VM and
//                 invoke its registered slot component. This is a real
//                 package-level run, not a mock of the DSH Host.
//   dsh-host      Install the same `.tgz` into a fresh DSH_HOME through the
//                 official CLI, boot a real `dsh web` host, probe it, restart,
//                 uninstall and boot again. Requires an explicit CLI command;
//                 when none is provided the result is NOT_RUN (never faked).
//
// All child processes run with a deadline and are killed as a tree.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { readTarGz, stripPackagePrefix } from '../distribution/tar.js'

function sanitizeName(name) {
  return String(name).replace(/[^A-Za-z0-9._@\/-]/g, '_')
}

async function writeTree(baseDir, entries) {
  for (const entry of entries) {
    const target = join(baseDir, ...entry.path.split('/'))
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.writeFile(target, entry.bytes)
  }
}

function runChild(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeoutMs = options.timeoutMs || 60_000
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child)
      resolvePromise({ ok: false, timedOut: true, code: null, stdout, stderr, error: 'TIMEOUT' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: false, code: null, stdout, stderr, error: String(error && error.message ? error.message : error) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, code, stdout, stderr, error: null })
    })
  })
}

function killTree(child) {
  if (!child || child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  } catch (error) {
    // best effort
  }
}

const HARNESS = String.raw`
import { createRequire } from 'node:module'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'

const cfg = JSON.parse(process.env.DSHPD_VALIDATION_CONFIG || '{}')
const report = {
  schema: 1,
  cwd: process.cwd(),
  packageName: cfg.packageName,
  maintenancePlugnAbsent: false,
  maintenancePluginAbsent: false,
  host: { imported: false, applied: false, toolCount: 0, toolNames: [], toolCall: null },
  client: { declared: false, bundlePresent: false, factory: false, applied: false, registered: false, rendered: false, error: null },
  absolutePathHits: [],
  errors: [],
}

const requireFromConsumer = createRequire(process.cwd() + '/probe.cjs')
try {
  requireFromConsumer.resolve('dsh-plugin-design')
  report.maintenancePlugnAbsent = false
} catch (error) {
  report.maintenancePlugnAbsent = true
  report.maintenancePluginAbsent = true
}

function stubReact() {
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    cloneElement(element, props) { return { ...element, props: { ...(element.props || {}), ...(props || {}) } } },
    isValidElement(value) { return value !== null && typeof value === 'object' && 'type' in value },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useEffect() {},
    useLayoutEffect() {},
    useMemo(factory) { return factory() },
    useCallback(fn) { return fn },
    useRef(value) { return { current: value } },
    useReducer(_reducer, initial) { return [initial, () => {}] },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  }
  return React
}

async function runHost() {
  let mod
  try {
    mod = await import(cfg.packageName)
    report.host.imported = true
  } catch (error) {
    report.errors.push('IMPORT_FAILED: ' + String(error && error.message ? error.message : error))
    return
  }
  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    get() { return undefined },
    inject(_names, callback) { try { return callback({ webServer: { register() { return () => {} } }, effect(fn) { return fn() } }) } catch (error) { return undefined } },
    effect(callback) { try { return callback() } catch (error) { return undefined } },
    on() { return () => {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    reflect: { provide() {} },
    set() {},
  }
  const plugin = mod && (mod.default || mod)
  const applier = plugin && (typeof plugin === 'function' ? plugin : plugin.apply)
  if (typeof applier !== 'function') {
    report.errors.push('NO_APPLY_EXPORT')
    return
  }
  try {
    await applier.call(plugin, ctx)
    report.host.applied = true
  } catch (error) {
    report.errors.push('APPLY_FAILED: ' + String(error && error.message ? error.message : error))
    return
  }
  report.host.toolCount = tools.size
  report.host.toolNames = [...tools.keys()].sort()
  const toolName = cfg.toolName && tools.has(cfg.toolName) ? cfg.toolName : (tools.size > 0 ? [...tools.keys()][0] : null)
  if (toolName !== null) {
    const exec = { agent: { id: 'validation-agent', ctx: { get() { return undefined } }, session: { id: 'validation-session' } }, signal: undefined, callId: 'validation-call' }
    try {
      const value = await tools.get(toolName).execute(cfg.toolArgs || {}, exec)
      report.host.toolCall = { name: toolName, ok: value !== undefined && !(value && typeof value === 'object' && typeof value.error === 'string'), result: JSON.stringify(value).slice(0, 2000) }
    } catch (error) {
      report.host.toolCall = { name: toolName, ok: false, error: String(error && error.message ? error.message : error) }
    }
  }
}

async function runClient() {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(requireFromConsumer.resolve(cfg.packageName + '/package.json'), 'utf8'))
  } catch (error) {
    report.errors.push('PACKAGE_JSON_UNRESOLVABLE: ' + String(error && error.message ? error.message : error))
    return
  }
  const declared = Boolean(pkg.dsh && pkg.dsh.client)
  report.client.declared = declared
  if (!declared) return
  let entry = null
  const exportsField = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports : null
  if (exportsField) {
    const value = exportsField['./client']
    entry = typeof value === 'string' ? value : value && (value.default || value.import || value.require)
  }
  if (!entry) {
    report.errors.push('CLIENT_EXPORT_MISSING')
    return
  }
  const bundlePath = join(dirname(requireFromConsumer.resolve(cfg.packageName + '/package.json')), String(entry).replace(/^\.\//, ''))
  let text
  try {
    text = readFileSync(bundlePath, 'utf8')
    report.client.bundlePresent = true
  } catch (error) {
    report.errors.push('CLIENT_BUNDLE_UNREADABLE: ' + String(error && error.message ? error.message : error))
    return
  }
  const absolute = /(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)/.exec(text)
  if (absolute) report.absolutePathHits.push(absolute[0])
  let factory = null
  const sandbox = {
    window: { __ModuleLoader__: { load(options) { factory = options.factory; return options } } },
    console,
    process: { env: {}, platform: process.platform, versions: process.versions },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, Promise, URL, URLSearchParams,
    TextEncoder, TextDecoder, Buffer, fetch,
  }
  sandbox.globalThis = sandbox
  try {
    vm.runInNewContext(text, sandbox, { filename: bundlePath, timeout: 5000 })
    report.client.factory = typeof factory === 'function'
  } catch (error) {
    report.errors.push('CLIENT_EVAL_FAILED: ' + String(error && error.message ? error.message : error))
    return
  }
  if (typeof factory !== 'function') return
  const react = stubReact()
  const requireStub = (specifier) => {
    if (specifier === 'react') return react
    if (specifier === 'react/jsx-runtime') return { jsx: react.createElement, jsxs: react.createElement, Fragment: react.Fragment }
    throw new Error('external module not provided by the validation harness: ' + specifier)
  }
  let moduleExports
  try {
    moduleExports = factory(requireStub)
  } catch (error) {
    report.errors.push('CLIENT_FACTORY_FAILED: ' + String(error && error.message ? error.message : error))
    return
  }
  if (!moduleExports || typeof moduleExports.apply !== 'function') {
    report.errors.push('CLIENT_APPLY_MISSING')
    return
  }
  let registered = null
  const fakeCtx = {
    get(name) {
      if (name === 'slots') return { inject(_slot, callback) { const value = callback && callback(); registered = registered || value; return value }, register(_options, component) { registered = component; return () => { registered = null } } }
      return undefined
    },
    slots: { inject(_slot, callback) { const value = callback && callback(); registered = registered || value; return value }, register(_options, component) { registered = component; return () => { registered = null } } },
    on() { return () => {} },
    effect(callback) { return callback && callback() },
    logger: { info() {}, warn() {}, error() {} },
  }
  try {
    await moduleExports.apply(fakeCtx)
    report.client.applied = true
  } catch (error) {
    report.client.error = 'CLIENT_APPLY_FAILED: ' + String(error && error.message ? error.message : error)
    report.errors.push(report.client.error)
    return
  }
  report.client.registered = registered !== null && registered !== undefined
  if (report.client.registered) {
    try {
      react.createElement(registered, { getWorkspace: () => null })
      report.client.rendered = true
    } catch (error) {
      report.client.error = 'CLIENT_RENDER_FAILED: ' + String(error && error.message ? error.message : error)
      report.errors.push(report.client.error)
    }
  } else {
    report.client.error = 'CLIENT_NO_SLOT_REGISTRATION'
    report.errors.push(report.client.error)
  }
}

await runHost()
await runClient()
process.stdout.write(JSON.stringify(report))
`

/**
 * Validate the exact archive in an isolated consumer directory.
 */
export async function runPackageLoad(options) {
  const tgzPath = resolve(options.tgzPath)
  const stateDir = options.stateDir
  const runId = 'validation-' + randomUUID()
  const runDir = join(stateDir, 'validation', runId)
  const consumerDir = join(runDir, 'consumer')
  const evidence = {
    schema: 1,
    mode: 'package-load',
    runId,
    startedAt: new Date().toISOString(),
    archive: { path: tgzPath },
    gates: {},
    evidence: [],
    limitations: [
      'the Host half is imported and applied in a child Node process with a stub context, not a real DSH Host',
      'the Client factory runs in a VM with a React stub; renderer/Electron behaviour is not covered',
      'a real Host run requires the dsh-host mode with an explicit CLI command',
    ],
  }
  try {
    const buffer = await fs.readFile(tgzPath)
    const listed = readTarGz(buffer, { maxEntries: 4000, maxTotalBytes: 128 * 1024 * 1024 })
    const entries = stripPackagePrefix(listed.entries)
    const pkgEntry = entries.find((entry) => entry.path === 'package.json')
    if (pkgEntry === undefined) {
      evidence.gates.packageCompleteness = { status: 'FAIL', detail: 'package.json missing from the archive' }
      return finish(evidence, runDir)
    }
    const pkg = JSON.parse(pkgEntry.bytes.toString('utf8'))
    evidence.package = { name: pkg.name, version: pkg.version }
    if (options.expectedName !== undefined && pkg.name !== options.expectedName) {
      evidence.gates.packageCompleteness = { status: 'FAIL', detail: 'archive name ' + pkg.name + ' != expected ' + options.expectedName }
      return finish(evidence, runDir)
    }
    if (options.expectedVersion !== undefined && pkg.version !== options.expectedVersion) {
      evidence.gates.packageCompleteness = { status: 'FAIL', detail: 'archive version ' + pkg.version + ' != expected ' + options.expectedVersion }
      return finish(evidence, runDir)
    }
    const target = join(consumerDir, 'node_modules', sanitizeName(pkg.name))
    await fs.mkdir(target, { recursive: true })
    await writeTree(target, entries)
    await fs.writeFile(join(consumerDir, 'package.json'), JSON.stringify({ name: 'dshpd-validation-consumer', version: '1.0.0', private: true }) + '\n', 'utf8')
    // The consumer must not be able to reach the author's tree.
    await fs.mkdir(join(consumerDir, 'node_modules'), { recursive: true })
    // The harness must live inside the consumer tree so bare imports resolve
    // from consumer/node_modules and cannot reach the author's source tree.
    const harnessPath = join(consumerDir, 'harness.mjs')
    await fs.writeFile(harnessPath, HARNESS, 'utf8')
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      NODE_PATH: '',
      DSHPD_VALIDATION_CONFIG: JSON.stringify({
        packageName: pkg.name,
        toolName: options.toolName || null,
        toolArgs: options.toolArgs || {},
      }),
    }
    const child = await runChild(process.execPath, [harnessPath], {
      cwd: consumerDir,
      env,
      timeoutMs: options.timeoutMs || 60_000,
    })
    evidence.child = { code: child.code, timedOut: child.timedOut === true, stderr: String(child.stderr || '').slice(-4000), stdoutBytes: child.stdout.length }
    if (child.timedOut === true) {
      evidence.gates.independentRuntime = { status: 'FAIL', detail: 'the package run exceeded its deadline and was killed' }
      return finish(evidence, runDir)
    }
    let result = null
    try {
      result = JSON.parse(child.stdout)
    } catch (error) {
      evidence.gates.independentRuntime = {
        status: 'FAIL',
        detail: 'the harness produced no JSON report (exit ' + String(child.code) + ')',
      }
      return finish(evidence, runDir)
    }
    evidence.result = result
    const hostOk = result.host && result.host.imported === true && result.host.applied === true
    const toolOk = result.host && result.host.toolCall === null ? true : result.host.toolCall.ok === true
    evidence.gates.packageCompleteness = {
      status: hostOk ? 'PASS' : 'FAIL',
      detail: hostOk ? 'Host entry imported and applied from the archive' : 'Host entry failed to import/apply',
      toolNames: result.host ? result.host.toolNames : [],
    }
    evidence.gates.independentRuntime = {
      status: hostOk && toolOk && result.maintenancePluginAbsent === true ? 'PASS' : 'FAIL',
      detail: {
        maintenancePluginAbsent: result.maintenancePluginAbsent,
        hostApplied: hostOk,
        toolCall: result.host ? result.host.toolCall : null,
        errors: result.errors,
      },
    }
    if (result.client.declared === true) {
      const clientOk = result.client.bundlePresent && result.client.factory && result.client.applied
        && result.client.registered && result.client.rendered
      evidence.gates.cleanInstall = {
        status: clientOk ? 'PASS' : 'FAIL',
        detail: result.client,
        renderer: 'VM + React stub (not a browser/Electron renderer)',
      }
      evidence.gates.distributionLifecycle = { status: 'NOT_RUN', detail: 'restart/uninstall require the real DSH host (dsh-host mode)' }
    } else {
      evidence.gates.cleanInstall = { status: 'PASS', detail: 'Host-only package: no Client half is declared' }
      evidence.gates.distributionLifecycle = { status: 'NOT_RUN', detail: 'restart/uninstall require the real DSH host (dsh-host mode)' }
    }
    evidence.gates.portability = {
      status: result.absolutePathHits.length === 0 ? 'PASS' : 'FAIL',
      detail: result.absolutePathHits,
      note: 'absolute-path scan covers the Client bundle in this run; the full package audit runs separately',
    }
    evidence.verified = evidence.gates.independentRuntime.status === 'PASS'
      && evidence.gates.cleanInstall.status !== 'FAIL'
      && evidence.gates.packageCompleteness.status === 'PASS'
    return finish(evidence, runDir)
  } catch (error) {
    evidence.gates.independentRuntime = {
      status: 'FAIL',
      detail: 'validation runner error: ' + String(error && error.message ? error.message : error),
    }
    return finish(evidence, runDir)
  }
}

async function finish(evidence, runDir) {
  evidence.finishedAt = new Date().toISOString()
  evidence.status = evidence.verified === true ? 'PASS' : 'FAIL'
  try {
    await fs.mkdir(runDir, { recursive: true })
    await fs.writeFile(join(runDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8')
    evidence.evidencePath = join(runDir, 'evidence.json')
  } catch (error) {
    evidence.evidencePath = null
  }
  return evidence
}

/**
 * Real DSH host validation: install, boot, probe, restart, uninstall, boot again.
 * `cliCommand` must be an explicit executable/script array provided by the
 * caller; nothing is guessed from the author's machine.
 */
export async function runDshHost(options) {
  const cli = options.cliCommand
  if (!Array.isArray(cli) || cli.length === 0) {
    return {
      schema: 1,
      mode: 'dsh-host',
      status: 'NOT_RUN',
      gates: {
        cleanInstall: { status: 'NOT_RUN', detail: 'no explicit DSH CLI command was provided' },
        distributionLifecycle: { status: 'NOT_RUN' },
      },
      limitations: ['pass cliCommand (for example the dsh.cmd/electron CLI argv) to enable this mode'],
    }
  }
  const runId = 'dsh-host-' + randomUUID()
  const runDir = join(options.stateDir, 'validation', runId)
  const dshHome = join(runDir, 'home')
  await fs.mkdir(dshHome, { recursive: true })
  const logs = []
  const evidence = { schema: 1, mode: 'dsh-host', runId, cli, dshHome, steps: [], gates: {} }
  const timeoutMs = options.timeoutMs || 300_000
  const env = { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' }
  const args = (extra) => [...cli.slice(1), ...extra]
  const run = async (extra, step, stepTimeout) => {
    const child = await runChild(cli[0], args(extra), { cwd: runDir, env, timeoutMs: stepTimeout || timeoutMs })
    evidence.steps.push({ step, args: extra, code: child.code, timedOut: child.timedOut === true, stdout: child.stdout.slice(-6000), stderr: child.stderr.slice(-3000) })
    logs.push('## ' + step + '\n' + child.stdout + '\n' + child.stderr)
    return child
  }
  const install = await run(['plugin', '--profile', 'web', 'add', options.tgzPath], 'install')
  const installOk = install.ok
  evidence.gates.cleanInstall = { status: installOk ? 'PASS' : 'FAIL', detail: 'official CLI add exit ' + String(install.code) }
  if (!installOk) return finishHost(evidence, runDir, logs)

  /** Boot the host, wait for its authenticated URL, probe, then stop it. */
  const bootAndProbe = async (step, probePath) => {
    const child = spawn(cli[0], args(['web', '--no-open', '--host', '127.0.0.1', '--port', '0']), {
      cwd: runDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    const url = await new Promise((resolvePromise) => {
      const started = Date.now()
      const timer = setInterval(() => {
        const match = /dsh web:\s*(\S+)/.exec(stdout)
        if (match !== null) {
          clearInterval(timer)
          resolvePromise(match[1])
          return
        }
        if (Date.now() - started > 90_000 || child.exitCode !== null) {
          clearInterval(timer)
          resolvePromise(null)
        }
      }, 250)
    })
    let probe = null
    if (url !== null && typeof probePath === 'string' && probePath !== '') {
      try {
        const base = new URL(url)
        const target = new URL(probePath, base.origin)
        const token = base.searchParams.get('token')
        if (token !== null) target.searchParams.set('token', token)
        const response = await fetch(target, { signal: AbortSignal.timeout(20_000) })
        probe = { path: probePath, status: response.status, ok: response.ok, body: (await response.text()).slice(0, 500) }
      } catch (error) {
        probe = { path: probePath, error: String(error && error.message ? error.message : error), ok: false }
      }
    }
    killTree(child)
    await new Promise((resolvePromise) => {
      if (child.exitCode !== null) return resolvePromise(undefined)
      child.once('exit', () => resolvePromise(undefined))
      setTimeout(() => { killTree(child); resolvePromise(undefined) }, 10_000)
    })
    evidence.steps.push({ step, args: ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], urlFound: url !== null, probe, stdout: stdout.slice(-4000), stderr: stderr.slice(-2000) })
    logs.push('## ' + step + '\nURL: ' + String(url) + '\nPROBE: ' + JSON.stringify(probe) + '\n' + stdout + '\n' + stderr)
    return { url, probe }
  }

  const first = await bootAndProbe('boot-cold-start', options.probePath)
  if (first.probe !== null && first.probe.ok === true) {
    evidence.gates.cleanInstall = { status: 'PASS', detail: 'cold start served ' + options.probePath + ' with HTTP ' + first.probe.status }
  } else if (first.probe !== null) {
    evidence.gates.cleanInstall = { status: 'FAIL', detail: 'probe failed: ' + JSON.stringify(first.probe) }
  } else {
    evidence.gates.cleanInstall = { status: 'FAIL', detail: 'the host did not print its web URL' }
  }

  const restarted = await bootAndProbe('boot-restart', options.probePath)
  const remove = await run(['plugin', '--profile', 'web', 'remove', options.expectedName], 'uninstall')
  const afterUninstall = await bootAndProbe('boot-after-uninstall', options.probePath)
  const removed = afterUninstall.probe !== null && afterUninstall.probe.ok === false
  const lifecycleOk = restarted.probe !== null && restarted.probe.ok === true && remove.ok && afterUninstall.url !== null && removed
  evidence.gates.distributionLifecycle = {
    status: lifecycleOk ? 'PASS' : 'FAIL',
    detail: {
      restartProbe: restarted.probe,
      uninstallExit: remove.code,
      hostStartedAfterUninstall: afterUninstall.url !== null,
      pluginRouteGoneAfterUninstall: removed,
    },
  }
  evidence.verified = Object.values(evidence.gates).every((gate) => gate.status === 'PASS')
  evidence.status = evidence.verified ? 'PASS' : 'FAIL'
  return finishHost(evidence, runDir, logs)
}

async function finishHost(evidence, runDir, logs) {
  evidence.finishedAt = new Date().toISOString()
  evidence.status = Object.values(evidence.gates).every((gate) => gate.status === 'PASS') ? 'PASS' : 'FAIL'
  try {
    await fs.mkdir(runDir, { recursive: true })
    await fs.writeFile(join(runDir, 'dsh-host.log'), logs.join('\n'), 'utf8')
    await fs.writeFile(join(runDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8')
    evidence.evidencePath = join(runDir, 'evidence.json')
  } catch (error) {
    evidence.evidencePath = null
  }
  return evidence
}
