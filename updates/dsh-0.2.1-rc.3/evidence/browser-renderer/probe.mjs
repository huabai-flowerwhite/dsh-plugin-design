// Browser-renderer probe v3: real Chromium against the rc.3 web host.
// Drives the actual DSH UI: welcome -> continue -> workspace/settings discovery.

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [cliJsonPath, tgzPath, outDir, browserPath] = process.argv.slice(2)
const cli = JSON.parse(readFileSync(cliJsonPath, 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'dshpd-browser-'))
const dshHome = join(work, 'home')
const userData = join(work, 'browser')
mkdirSync(dshHome, { recursive: true })
mkdirSync(userData, { recursive: true })
mkdirSync(outDir, { recursive: true })
const env = { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' }
const tgzBytes = readFileSync(tgzPath)
const result = { schema: 1, startedAt: new Date().toISOString(), artifact: { path: tgzPath, sha256: createHash('sha256').update(tgzBytes).digest('hex'), bytes: tgzBytes.length }, dshHome, browserPath, steps: [] }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const killTree = (child) => { try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch (error) {} }

function run(args, timeout) {
  return new Promise((resolve) => {
    const child = spawn(cli[0], [...cli.slice(1), ...args], { env, cwd: work, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    const timer = setTimeout(() => { killTree(child); resolve({ code: null, stdout, stderr, timeout: true }) }, timeout)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id === undefined) this.events.push(message)
      const entry = message.id === undefined ? undefined : this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
  }
  open(timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP open timeout')), timeoutMs)
      this.ws.onopen = () => { clearTimeout(timer); resolve() }
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP socket error')) }
    })
  }
  send(method, params = {}, timeoutMs = 25_000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timeout')) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() { try { this.ws.close() } catch (error) {} }
}

const install = await run(['plugin', '--profile', 'web', 'add', tgzPath], 180_000)
result.install = { code: install.code, stdout: install.stdout.slice(-1000) }
const host = spawn(cli[0], [...cli.slice(1), 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, cwd: work, windowsHide: true })
let hostOut = ''
let hostErr = ''
host.stdout.on('data', (c) => { hostOut += c })
host.stderr.on('data', (c) => { hostErr += c })
let hostUrl = null
for (let i = 0; i < 240 && hostUrl === null; i += 1) {
  const match = /dsh web:\s*(\S+)/.exec(hostOut)
  if (match) hostUrl = match[1]
  if (host.exitCode !== null) break
  if (hostUrl === null) await sleep(250)
}
result.host = { urlFound: hostUrl !== null, stderr: hostErr.slice(-800) }

const browserPort = 9225
const browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${browserPort}`, `--user-data-dir=${userData}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { windowsHide: true })
let targetWs = null
for (let i = 0; i < 120 && targetWs === null; i += 1) {
  try {
    const pages = await (await fetch(`http://127.0.0.1:${browserPort}/json/list`, { signal: AbortSignal.timeout(1500) })).json()
    const page = pages.find((entry) => entry.type === 'page')
    if (page !== undefined) targetWs = page.webSocketDebuggerUrl
  } catch (error) {}
  if (targetWs === null) await sleep(250)
}

let cdp = null
try {
  if (hostUrl === null || targetWs === null) throw new Error('host/browser not ready')
  cdp = new Cdp(targetWs)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Page.navigate', { url: hostUrl })
  const evaluate = async (expression) => {
    const value = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails).slice(0, 600))
    return value.result ? value.result.value : undefined
  }
  const snapshot = async (label) => {
    const data = await evaluate(`JSON.stringify({
      title: document.title,
      url: location.href,
      text: document.body ? document.body.innerText.slice(0, 7000) : '',
      buttons: [...document.querySelectorAll('button,[role=button],a')].slice(0,150).map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim()).filter(Boolean),
      inputs: [...document.querySelectorAll('input,textarea')].slice(0,50).map((el) => ({ placeholder: el.getAttribute('placeholder') || '', type: el.type })),
      headings: [...document.querySelectorAll('h1,h2,h3,h4')].slice(0,100).map((el) => (el.innerText || '').trim()).filter(Boolean),
    })`)
    const parsed = JSON.parse(data)
    result.steps.push({ step: label, ...parsed })
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, 30_000)
    writeFileSync(join(outDir, label + '.png'), Buffer.from(shot.data, 'base64'))
    return parsed
  }
  const clickExact = async (text) => evaluate(`(() => {
    const nodes = [...document.querySelectorAll('button,[role=button],a,div,span')];
    const exact = nodes.find((el) => ((el.innerText || el.getAttribute('aria-label') || '').trim()) === ${JSON.stringify(text)});
    const target = exact || nodes.find((el) => ((el.innerText || el.getAttribute('aria-label') || '').trim()).includes(${JSON.stringify(text)}));
    if (!target) return false;
    target.click();
    return true;
  })()`)
  const waitText = async (needle, attempts = 30) => {
    for (let i = 0; i < attempts; i += 1) {
      await sleep(500)
      const text = await evaluate('document.body ? document.body.innerText : ""')
      if (typeof text === 'string' && text.includes(needle)) return true
    }
    return false
  }

  for (let i = 0; i < 40; i += 1) {
    await sleep(500)
    const ready = await evaluate('document.readyState + "|" + (document.body ? document.body.innerText.length : 0)')
    if (typeof ready === 'string' && ready.startsWith('complete|') && Number(ready.split('|')[1]) > 50) break
  }
  await snapshot('01-welcome')

  const clicked = await clickExact('继续')
  result.continueClicked = clicked
  await sleep(2500)
  await snapshot('02-after-continue')

  const clickAndSnapshot = async (label, step) => {
    const found = await clickExact(label)
    if (!found) return false
    await sleep(2000)
    await snapshot(step)
    return true
  }

  result.clickedPlugins = await clickAndSnapshot('插件', '05-plugins')
  result.pluginTextOnPlugins = await evaluate('document.body ? document.body.innerText.includes("dsh-plugin-design") : false')
  result.clickedAccount = await clickAndSnapshot('账号菜单', '06-account-menu')
  if (await clickExact('设置')) {
    result.settingsAction = '设置'
    await sleep(2000)
    await snapshot('07-settings')
  }
  if (await clickExact('dsh plugin design')) {
    await sleep(2500)
    await snapshot('08-plugin-panel')
  }
  const setPath = (value) => evaluate('(() => {'
    + ' const el = [...document.querySelectorAll("input")].find((x) => x.placeholder && x.placeholder.includes("插件库"));'
    + ' if (!el) return false;'
    + ' const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;'
    + ' setter.call(el, ' + JSON.stringify(value) + ');'
    + ' el.dispatchEvent(new Event("input", { bubbles: true }));'
    + ' return true; })()')
  result.pathSet = await setPath('E:/creat/DSH/rule/dsh-plugin-design/tests/fixtures')
  if (await clickExact('扫描')) {
    result.scanClicked = true
    await sleep(4000)
    await snapshot('09-scan-result')
  }
  const afterScan = await evaluate('document.body ? document.body.innerText : ""')
  result.scanFoundPlugins = typeof afterScan === 'string'
    && ['modern-plugin', 'legacy-plugin', 'minimal-host-client'].some((name) => afterScan.includes(name))
  if (await clickExact('分析')) {
    result.analyzeClicked = true
    await sleep(4000)
    await snapshot('10-analyze-result')
  }
  const afterAnalyze = await evaluate('document.body ? document.body.innerText : ""')
  result.analysisVisible = typeof afterAnalyze === 'string'
    && ['READY_TO_MODIFY', 'BLOCKED', '问题', '阻断'].some((needle) => afterAnalyze.includes(needle))
  if (await setPath('E:/no-such-dshpd-directory')) {
    await clickExact('扫描')
    await sleep(3000)
    await snapshot('11-scan-error')
  }
  const afterError = await evaluate('document.body ? document.body.innerText : ""')
  result.errorVisible = typeof afterError === 'string'
    && ['失败', '错误', '不存在', 'ENOENT', '未找到', '扫描状态', '扫描未完成'].some((needle) => afterError.includes(needle))
  try {
    const base = new URL(hostUrl)
    const healthUrl = new URL('/dsh-plugin-design/health', base.origin)
    healthUrl.searchParams.set('packageName', 'dsh-plugin-design')
    const token = base.searchParams.get('token')
    if (token !== null) healthUrl.searchParams.set('token', token)
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) })
    result.health = { status: response.status, body: await response.json() }
  } catch (error) {
    result.health = { error: String(error && error.message ? error.message : error) }
  }
  result.consoleEvents = cdp.events
    .filter((event) => event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.consoleAPICalled' || event.method === 'Log.entryAdded')
    .map((event) => ({ method: event.method, params: event.params }))
    .slice(-40)
  if (await clickExact('关闭')) {
    await sleep(1000)
    await snapshot('12-settings-closed')
  }
} catch (error) {
  result.error = String(error && error.message ? error.message : error)
} finally {
  if (cdp) cdp.close()
  killTree(browser)
  killTree(host)
  await sleep(1200)
  result.finishedAt = new Date().toISOString()
  writeFileSync(join(outDir, 'probe.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
  try { rmSync(work, { recursive: true, force: true }) } catch (error) {}
}
console.log(JSON.stringify({
  host: result.host && result.host.urlFound,
  steps: result.steps.map((s) => ({ step: s.step, buttons: s.buttons.length, textHead: (s.text || '').slice(0, 200) })),
  continueClicked: result.continueClicked,
  workspaceAction: result.workspaceAction || null,
  settingsAction: result.settingsAction || null,
  pluginTextVisible: result.pluginTextVisible === true,
  error: result.error || null,
  probe: join(outDir, 'probe.json'),
}, null, 2))
