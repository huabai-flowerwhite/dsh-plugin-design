// Test harness: a realistic stand-in for the DSH host surface.
//
// It provides the services the plugin actually uses (agent-scoped fs with
// version tokens, sandboxPolicy, webServer, approval, clientModules), records
// tool/route registrations, and lets a test choose the sandbox mode so both the
// "danger-full-access" and the "approval service" authorization paths are
// exercised.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import plugin from '../../src/host.js'
import { NodeFileSystem } from '../../src/recovery/node-fs-service.js'

export function tempDir(prefix = 'dshpd-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function createHarness(options = {}) {
  const dshHome = options.dshHome || tempDir('dshpd-home-')
  const stateRoot = options.stateRoot || join(dshHome, 'plugin-design-state')
  const mode = options.mode || 'danger-full-access'
  const tools = new Map()
  const routes = new Map()
  const cleanup = []
  const baseFs = new NodeFileSystem()
  const fsHooks = options.fsHooks || {}
  const fsService = {
    ...baseFs,
    async writeText(...args) {
      if (typeof fsHooks.writeText === 'function') {
        const blocked = await fsHooks.writeText(...args)
        if (blocked !== undefined && blocked !== null) throw blocked
      }
      return baseFs.writeText(...args)
    },
    async editText(...args) {
      if (typeof fsHooks.editText === 'function') {
        const blocked = await fsHooks.editText(...args)
        if (blocked !== undefined && blocked !== null) throw blocked
      }
      return baseFs.editText(...args)
    },
    async readBytes(...args) {
      if (typeof fsHooks.readBytes === 'function') {
        const blocked = await fsHooks.readBytes(...args)
        if (blocked !== undefined && blocked !== null) throw blocked
      }
      return baseFs.readBytes(...args)
    },
  }
  Object.setPrototypeOf(fsService, baseFs)
  const approvalCalls = []
  const approvalOutcome = options.approvalOutcome || 'allowed-once'
  const approval = options.approval === false ? undefined : {
    async request(request) {
      approvalCalls.push({
        toolName: request.toolName,
        reason: request.reason,
        agentId: request.agent && request.agent.id,
        callId: request.callId,
      })
      return typeof options.approvalOutcome === 'function' ? options.approvalOutcome(request) : approvalOutcome
    },
  }
  const sandboxPolicy = {
    resolve() {
      return { mode, workspaceRoot: options.workspaceRoot || process.cwd(), writableRoots: [options.workspaceRoot || process.cwd()] }
    },
  }
  const clientEntries = options.clientEntries || []
  const clientModules = {
    graph() {
      return { rev: 'test-graph-rev', entries: clientEntries }
    },
    clientPath(name) {
      return options.clientPaths ? options.clientPaths[name] : undefined
    },
  }
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error('duplicate tool: ' + definition.name)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    get(name) {
      if (name === 'fs') return fsService
      if (name === 'sandboxPolicy') return sandboxPolicy
      if (name === 'clientModules') return clientModules
      if (name === 'approval') return approval
      if (name === 'pluginManager') return options.pluginManager
      if (name === 'runtimeInfo') return options.runtimeInfo
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') cleanup.push(disposer)
      return disposer
    },
    inject(names, callback) {
      if (!names.includes('webServer')) throw new Error('unexpected inject: ' + names.join(','))
      return callback({
        webServer: {
          register(route) {
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          },
        },
        effect(callback2) {
          const disposer = callback2()
          if (typeof disposer === 'function') cleanup.push(disposer)
          return disposer
        },
      })
    },
  }
  const previousHome = process.env.DSH_HOME
  const previousState = process.env.DSHPD_STATE_ROOT
  process.env.DSH_HOME = dshHome
  process.env.DSHPD_STATE_ROOT = stateRoot
  try {
    plugin.apply(ctx)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousState === undefined) delete process.env.DSHPD_STATE_ROOT
    else process.env.DSHPD_STATE_ROOT = previousState
  }
  mkdirSync(stateRoot, { recursive: true })
  const agent = {
    id: options.agentId || 'test-agent',
    session: { id: options.sessionId || 'test-session' },
    ctx: {
      get(name) {
        if (name === 'fs') return fsService
        if (name === 'sandboxPolicy') return sandboxPolicy
        return undefined
      },
    },
  }
  const exec = {
    agent,
    callId: 'test-call',
    signal: options.signal,
  }
  async function call(name, args) {
    const definition = tools.get(name)
    if (definition === undefined) throw new Error('tool missing: ' + name)
    return definition.execute(args || {}, exec)
  }
  async function callAs(name, args, identity = {}) {
    const definition = tools.get(name)
    if (definition === undefined) throw new Error('tool missing: ' + name)
    const other = {
      ...exec,
      agent: {
        ...agent,
        id: identity.agentId || agent.id,
        session: { id: identity.sessionId || agent.session.id },
      },
    }
    return definition.execute(args || {}, other)
  }
  function write(path, content) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
  function read(path) {
    return readFileSync(path, 'utf8')
  }
  function close() {
    for (const disposer of cleanup.reverse()) {
      try { disposer() } catch (error) { /* ignore */ }
    }
    if (options.keepDirs !== true) {
      try { rmSync(dshHome, { recursive: true, force: true }) } catch (error) { /* ignore */ }
    }
  }
  return {
    ctx, exec, tools, routes, dshHome, stateRoot, mode, approvalCalls, call, callAs, write, read, close,
    fsService,
    exists: (path) => {
      try { return statSync(path) !== null } catch (error) { return false }
    },
  }
}

/** A patch row in a profile, as the Loader reads it. */
export function writeProfile(dshHome, profile, { rows = [], packageJson = {}, packages = {} } = {}) {
  const dir = join(dshHome, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.patch.yml'), rows.join('\n') + (rows.length > 0 ? '\n' : ''), 'utf8')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + profile,
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    ...packageJson,
  }, null, 2) + '\n', 'utf8')
  for (const [name, version] of Object.entries(packages)) {
    const packageDir = join(dir, 'node_modules', name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }) + '\n', 'utf8')
  }
  return dir
}
