// dsh-plugin-design — Host half (persistent plugin)
//
// Loaded by an agent preset via an absolute-path row. Registers 10 dshpd_*
// model tools implementing the DH-TP-SDK adaptation workflow:
//   discover -> inspect -> analyze -> design -> approve -> backup -> apply -> rollback -> status -> report
//
// This file is a plain ESM module (no bundler). It uses `ctx.tools.register`
// with RAW ToolDefinition objects (not the `defineTool` helper) so it has no
// import dependency on `@deepseek-ai/dsh-tools`, which would be unresolvable
// from a workspace directory outside the harness node_modules tree.

import { readFileSync, readdirSync } from 'node:fs'
import { resolve as pathResolve, basename as pathBasename, join as pathJoin } from 'node:path'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'out',
  '.dsh-plugin-design', '.next', '.turbo', 'target',
])

export default {
  inject: ['tools', 'fs', 'webServer'],

  apply(ctx) {
    const fs = ctx.fs

    // ---- in-memory task state (process-local) ----
    const tasks = new Map() // approvalToken -> task

    // ---- helpers ----
    function makeToken() {
      return btoa(String(Date.now()) + '.' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2))
    }
    function basename(p) {
      const parts = String(p).split(/[\\/]/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : String(p)
    }
    async function readText(p) {
      return fs.readText(await fs.resolve(p))
    }
    async function tryReadText(p) {
      try { return await readText(p) } catch (e) { return null }
    }
    async function writeText(p, content) {
      return fs.writeText(await fs.resolve(p), content)
    }
    function renderText(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    }

    // Register a raw tool definition. `properties` is a raw JSON-Schema
    // properties map; `required` is an array of property names.
    function reg(name, description, properties, required, execute) {
      const parameters = { type: 'object', properties }
      if (required && required.length > 0) parameters.required = required
      ctx.tools.register({
        name,
        description,
        parameters,
        output: {
          schema: { type: 'object' },
          render: renderText,
        },
        async execute(args, exec) {
          try {
            return await execute(args, exec)
          } catch (e) {
            return { error: String(e && e.message ? e.message : e) }
          }
        },
      })
    }

    // ---- detect DSH's own npx-install directory (not a third-party plugin) ----
    async function isDshSelfDir(targetPath) {
      const pkgText = await tryReadText(targetPath + '/package.json')
      if (pkgText === null) return false
      try {
        const pkg = JSON.parse(pkgText)
        if (pkg && pkg._npx && Array.isArray(pkg._npx.packages) && pkg._npx.packages.indexOf('@deepseek-ai/dsh') !== -1) return true
        if (pkg && pkg.dependencies && pkg.dependencies['@deepseek-ai/dsh']) return true
      } catch (e) { /* regex fallback below */ }
      return /"_npx"\s*:\s*\{[^}]*"packages"\s*:\s*\[[^\]]*@deepseek-ai\/dsh/.test(pkgText) || /"@deepseek-ai\/dsh"\s*:/.test(pkgText)
    }

    // ---- discover ----
    async function discoverPlugins(rootPath, maxDepth) {
      const results = []
      const rootTarget = await fs.resolve(rootPath)
      async function walk(target, depth) {
        if (depth > maxDepth) return
        let entries
        try { entries = await fs.listDir(target) } catch (e) { return }
        let hasManifest = false, hasPkg = false, hasPatch = false
        const subdirs = []
        for (const e of entries) {
          const n = e.name
          if (SKIP_DIRS.has(n)) continue
          if (e.type === 'directory') subdirs.push(e.target)
          else if (n === 'dsh.plugin.yaml') hasManifest = true
          else if (n === 'package.json') hasPkg = true
          else if (n === 'cordis.patch.yml') hasPatch = true
        }
        if (hasPkg && (await isDshSelfDir(target.displayPath))) return
        if (hasManifest || hasPkg) {
          results.push({
            path: target.displayPath,
            name: basename(target.displayPath),
            hasManifest: hasManifest,
            hasPackageJson: hasPkg,
            hasCordisPatch: hasPatch,
            depth: depth,
          })
        }
        if (depth < maxDepth) {
          for (const s of subdirs) await walk(s, depth + 1)
        }
      }
      await walk(rootTarget, 0)
      return results
    }

    // ---- node:fs based discovery (host-plane route reads arbitrary folders) ----
    function nodeListDir(dirPath) {
      try {
        const entries = readdirSync(dirPath, { withFileTypes: true })
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', path: pathJoin(dirPath, e.name) }))
      } catch (e) { return null }
    }
    function nodeIsDshSelf(dirPath) {
      let pkgText = null
      try { pkgText = readFileSync(pathJoin(dirPath, 'package.json'), 'utf8') } catch (e) { pkgText = null }
      if (pkgText === null) return false
      try {
        const pkg = JSON.parse(pkgText)
        if (pkg && pkg._npx && Array.isArray(pkg._npx.packages) && pkg._npx.packages.indexOf('@deepseek-ai/dsh') !== -1) return true
        if (pkg && pkg.dependencies && pkg.dependencies['@deepseek-ai/dsh']) return true
      } catch (e) { /* regex fallback below */ }
      return /"_npx"\s*:\s*\{[^}]*"packages"\s*:\s*\[[^\]]*@deepseek-ai\/dsh/.test(pkgText) || /"@deepseek-ai\/dsh"\s*:/.test(pkgText)
    }
    function nodeDiscoverPlugins(rootPath, maxDepth) {
      const results = []
      function walk(dirPath, depth) {
        if (depth > maxDepth) return
        const entries = nodeListDir(dirPath)
        if (entries === null) return
        let hasManifest = false, hasPkg = false, hasPatch = false
        const subdirs = []
        for (const e of entries) {
          const n = e.name
          if (SKIP_DIRS.has(n)) continue
          if (e.type === 'directory') subdirs.push(e.path)
          else if (n === 'dsh.plugin.yaml') hasManifest = true
          else if (n === 'package.json') hasPkg = true
          else if (n === 'cordis.patch.yml') hasPatch = true
        }
        if (hasPkg && nodeIsDshSelf(dirPath)) return
        if (hasManifest || hasPkg) {
          results.push({
            path: dirPath,
            name: pathBasename(dirPath),
            hasManifest: hasManifest,
            hasPackageJson: hasPkg,
            hasCordisPatch: hasPatch,
            depth: depth,
          })
        }
        if (depth < maxDepth) for (const s of subdirs) walk(s, depth + 1)
      }
      walk(pathResolve(rootPath), 0)
      return results
    }

    // ---- collect source files (bounded) ----
    async function collectSource(target, depth, out) {
      if (depth > 5) return
      let entries
      try { entries = await fs.listDir(target) } catch (e) { return }
      for (const e of entries) {
        const n = e.name
        if (SKIP_DIRS.has(n)) continue
        if (e.type === 'directory') await collectSource(e.target, depth + 1, out)
        else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(n)) out.push({ path: e.target.displayPath, name: n })
      }
    }

    function parseManifestHeuristic(raw) {
      if (raw === null) return null
      const out = {}
      for (const line of raw.split('\n')) {
        if (/^\s*#/.test(line) || line.trim() === '') continue
        const m = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/)
        if (m) {
          const key = m[1]
          const val = m[2].trim()
          if (val === '' || val === '{}' || val === '[]') out[key] = {}
          else out[key] = val
        }
      }
      return out
    }

    function addIssue(issues, id, severity, category, title, detail, file) {
      issues.push({ id, severity, category, title, detail, file: file || null })
    }

    // ---- analyze (deterministic heuristic static scan) ----
    async function analyzePlugin(pluginPath) {
      const issues = []
      const base = await fs.resolve(pluginPath)
      const manifestRaw = await tryReadText(pluginPath + '/dsh.plugin.yaml')
      const pkgRaw = await tryReadText(pluginPath + '/package.json')
      const patchRaw = await tryReadText(pluginPath + '/cordis.patch.yml')
      let pkg = null
      if (pkgRaw !== null) { try { pkg = JSON.parse(pkgRaw) } catch (e) { pkg = null } }
      const manifest = parseManifestHeuristic(manifestRaw)

      if (manifestRaw === null) {
        addIssue(issues, 'MANIFEST_MISSING', 'BLOCKER', 'manifest', '缺少 dsh.plugin.yaml', 'DH-TP-SDK 要求每个第三方插件提供 dsh.plugin.yaml 并显式声明运行时/Capability/权限/资源/生命周期/安全等级。', 'dsh.plugin.yaml')
      } else {
        if (manifest === null || manifest['plugin.id'] === undefined) addIssue(issues, 'MANIFEST_NO_ID', 'HIGH', 'manifest', 'Manifest 缺少 plugin.id', '缺少全局唯一插件 ID。', 'dsh.plugin.yaml')
        if (manifest === null || manifest['runtime.harness'] === undefined) addIssue(issues, 'MANIFEST_NO_HARNESS', 'HIGH', 'manifest', 'Manifest 缺少 runtime.harness 兼容范围', '必须显式声明 Harness min/max。', 'dsh.plugin.yaml')
        if (manifest === null || manifest['cordis.apiLevel'] === undefined) addIssue(issues, 'MANIFEST_NO_API_LEVEL', 'MEDIUM', 'manifest', 'Manifest 缺少 cordis.apiLevel', '建议声明 Cordis API level。', 'dsh.plugin.yaml')
        if (manifest === null || manifest['permissions'] === undefined) addIssue(issues, 'MANIFEST_NO_PERMISSIONS', 'MEDIUM', 'manifest', 'Manifest 缺少 permissions', '权限必须 Manifest 化。', 'dsh.plugin.yaml')
        if (manifest === null || manifest['resources'] === undefined) addIssue(issues, 'MANIFEST_NO_RESOURCES', 'MEDIUM', 'manifest', 'Manifest 缺少 resources 资源上限', '建议声明 maxRuntimeMs/maxMemoryMb 等。', 'dsh.plugin.yaml')
        if (manifest === null || manifest['lifecycle'] === undefined) addIssue(issues, 'MANIFEST_NO_LIFECYCLE', 'MEDIUM', 'manifest', 'Manifest 缺少 lifecycle', '应声明 unloadable/reversible。', 'dsh.plugin.yaml')
      }

      if (pkgRaw === null || pkg === null) {
        addIssue(issues, 'NO_PACKAGE_JSON', 'MEDIUM', 'manifest', '缺少或无法解析 package.json', 'package.json 应声明 name/version/engines/dsh 兼容范围。', 'package.json')
      } else {
        if (!pkg.name) addIssue(issues, 'PKG_NO_NAME', 'LOW', 'manifest', 'package.json 缺少 name', null, 'package.json')
        if (!pkg.version) addIssue(issues, 'PKG_NO_VERSION', 'LOW', 'manifest', 'package.json 缺少 version', null, 'package.json')
        if (!pkg.engines || !pkg.engines.node) addIssue(issues, 'PKG_NO_NODE_RANGE', 'MEDIUM', 'compat', 'package.json 缺少 engines.node', '应声明 Node min/max。', 'package.json')
      }

      if (patchRaw === null) {
        addIssue(issues, 'NO_CORDIS_PATCH', 'INFO', 'bundle', '未提供 cordis.patch.yml', '如仅新增能力，建议新增自己的 row 而非替换 Core row。', 'cordis.patch.yml')
      } else if (/replace|replacement/i.test(patchRaw)) {
        addIssue(issues, 'CORE_ROW_REPLACE', 'CRITICAL', 'bundle', 'cordis.patch.yml 疑似替换 Core row', 'DH-TP-SDK 建议新增能力时新增自己的 row；如必须替换需声明目标 row/版本范围/冲突检测/回滚。', 'cordis.patch.yml')
      }

      const sources = []
      await collectSource(base, 0, sources)
      const joined = []
      for (const s of sources) {
        const content = await tryReadText(s.path)
        if (content === null) continue
        joined.push({ path: s.path, content })
      }

      for (const f of joined) {
        const lines = f.content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          const loc = f.path + ':' + (i + 1)
          if (/globalThis\s*\.\s*\w+\s*=/.test(line)) addIssue(issues, 'GLOBALTHIS_PATCH', 'BLOCKER', 'security', '修改 globalThis', 'DH-TP-SDK 禁止修改 globalThis。', loc)
          if (/window\s*\.\s*\w+\s*=/.test(line)) addIssue(issues, 'GLOBALTHIS_PATCH', 'BLOCKER', 'security', '修改 window 全局', '禁止修改全局对象。', loc)
          if (/\b\w+\.prototype\.\w+\s*=/.test(line)) addIssue(issues, 'PROTOTYPE_PATCH', 'BLOCKER', 'security', 'Monkey/Prototype Patch', '禁止修改原型。', loc)
          if (/\bas\s+any\b|\bas\s+unknown\b/.test(line)) addIssue(issues, 'PRIVATE_API', 'CRITICAL', 'compat', '使用 as any / as unknown 绕过类型', '禁止访问 undocumented private API。', loc)
          if (/^\s*(let|var)\s+(currentSession|currentAgent|currentRequest|globalState)\b/.test(line)) addIssue(issues, 'GLOBAL_MUTABLE_STATE', 'CRITICAL', 'session', '模块级可变全局状态', '禁止 global session/agent/request state，应绑定 agent/session/request scope。', loc)
          if (/(rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-fd|git\s+push\s+--force|rmdir\s+\/s)/i.test(line)) addIssue(issues, 'DANGEROUS_COMMAND', 'BLOCKER', 'security', '危险破坏性命令', '默认禁止不可逆破坏性操作。', loc)
          if (/exec\s*\(\s*["'][^"']*\+/.test(line) || /exec\s*\(\s*`[^`]*\$\{/.test(line)) addIssue(issues, 'COMMAND_INJECTION', 'CRITICAL', 'security', '疑似命令注入', '禁止 exec 拼接用户输入，优先 spawn(command, args)。', loc)
          if (/(api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][A-Za-z0-9_\-]{12,}["']/i.test(line)) addIssue(issues, 'SECRET_LEAK', 'BLOCKER', 'security', '疑似硬编码密钥', '禁止将 secret 写入源码/Session/日志，必须 redaction。', loc)
        }
      }

      let hasWaterfallHint = false, hasNextCall = false
      for (const f of joined) {
        if (/pre-step|pre-execute|post-execute|llm\/stream|agent\/request|waterfall/i.test(f.content)) hasWaterfallHint = true
        if (/\bnext\s*\(/.test(f.content)) hasNextCall = true
      }
      if (hasWaterfallHint && !hasNextCall) {
        addIssue(issues, 'WATERFALL_NEXT', 'CRITICAL', 'compat', 'waterfall listener 疑似未调用 next()', 'waterfall listener MUST 调用并返回 next()，除非是终止型 interceptor。', null)
      }

      let hasTests = false
      const topEntries = await (async () => { try { return await fs.listDir(base) } catch (e) { return [] } })()
      for (const e of topEntries) {
        if (e.type === 'directory' && /(^|-)tests?$|__tests__/.test(e.name)) hasTests = true
      }
      if (!hasTests) addIssue(issues, 'NO_TESTS', 'MEDIUM', 'testing', '未检测到 tests 目录', '建议提供 unit/integration/lifecycle/security/compatibility 测试。', null)

      return { issues }
    }

    function score(issues) {
      const dims = { compatibility: 100, security: 100, lifecycle: 100, session: 100, tool: 100, bundle: 100, testing: 100, manifest: 100 }
      const w = { BLOCKER: 50, CRITICAL: 25, HIGH: 15, MEDIUM: 8, LOW: 3, INFO: 1 }
      const catMap = { manifest: 'manifest', compat: 'compatibility', security: 'security', lifecycle: 'lifecycle', session: 'session', tool: 'tool', bundle: 'bundle', testing: 'testing' }
      for (const it of issues) {
        const dim = catMap[it.category] || 'compatibility'
        dims[dim] = Math.max(0, dims[dim] - (w[it.severity] || 3))
      }
      return dims
    }

    function taskByToken(tok) {
      return tok ? tasks.get(tok) : undefined
    }

    // ================= TOOLS =================
    reg('dshpd_discover',
      'Discover third-party DSH plugin projects on the filesystem by recursively scanning for dsh.plugin.yaml or package.json (skips node_modules/.git/dist/build, and skips DSH\'s own npx-install directory). Returns candidate plugin projects. Use this first in the dsh-plugin-design workflow.',
      {
        root: { type: 'string', description: 'Scan root directory. Defaults to the session workspace root.' },
        maxDepth: { type: 'integer', description: 'Max recursion depth, default 5.' },
      },
      [],
      async (args) => {
        const sp = ctx.get('sandboxPolicy')
        const rootPath = args.root || (sp && sp.workspaceRoot ? sp.workspaceRoot : null)
        if (!rootPath) return { error: 'no scan root: provide root, or workspace root unavailable', plugins: [], count: 0 }
        const maxDepth = args.maxDepth !== undefined ? args.maxDepth : 5
        const plugins = await discoverPlugins(rootPath, maxDepth)
        return { root: rootPath, count: plugins.length, plugins }
      })

    reg('dshpd_inspect',
      'Inspect one third-party plugin project: read dsh.plugin.yaml (raw + heuristic parse), package.json (parsed), cordis.patch.yml (raw), top-level directory layout, source file list, and git-repo presence. Facts only; missing items are reported as null/false, never invented.',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory.' },
      },
      ['pluginPath'],
      async (args) => {
        const base = await fs.resolve(args.pluginPath)
        const manifestRaw = await tryReadText(args.pluginPath + '/dsh.plugin.yaml')
        const pkgRaw = await tryReadText(args.pluginPath + '/package.json')
        const patchRaw = await tryReadText(args.pluginPath + '/cordis.patch.yml')
        let pkg = null
        if (pkgRaw !== null) { try { pkg = JSON.parse(pkgRaw) } catch (e) { pkg = null } }
        let entries = []
        try { entries = await fs.listDir(base) } catch (e) { entries = [] }
        const topLevel = entries.map((e) => ({ name: e.name, type: e.type }))
        const sources = []
        await collectSource(base, 0, sources)
        let isGitRepo = false
        for (const e of entries) if (e.name === '.git' && e.type === 'directory') isGitRepo = true
        return {
          pluginPath: base.displayPath,
          name: basename(base.displayPath),
          hasManifest: manifestRaw !== null,
          manifestRaw: manifestRaw,
          manifestParsed: parseManifestHeuristic(manifestRaw),
          hasPackageJson: pkgRaw !== null,
          packageJson: pkg,
          hasCordisPatch: patchRaw !== null,
          cordisPatchRaw: patchRaw,
          topLevel: topLevel,
          sourceFiles: sources.map((s) => s.path),
          isGitRepo: isGitRepo,
          note: 'git status/commits require shell and are NOT_VERIFIED here; manifestParsed is a heuristic line-level parse, not a full YAML parse.',
        }
      })

    reg('dshpd_analyze',
      'Run a deterministic heuristic static compliance scan against DH-TP-SDK. Returns issues (id/severity/category/title/detail/file) plus per-dimension scores and an overall verdict. This is a heuristic scan, NOT an authoritative certification.',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory.' },
      },
      ['pluginPath'],
      async (args) => {
        const { issues } = await analyzePlugin(args.pluginPath)
        const scores = score(issues)
        const blockers = issues.filter((i) => i.severity === 'BLOCKER').length
        const criticals = issues.filter((i) => i.severity === 'CRITICAL').length
        const overall = blockers > 0 ? 'BLOCKED' : (criticals > 0 ? 'NEEDS_REVIEW' : 'READY_TO_MODIFY')
        return { pluginPath: args.pluginPath, issueCount: issues.length, blockers, criticals, scores, overall, issues, note: 'heuristic static scan; not authoritative, not a DeepSeek official certification.' }
      })

    reg('dshpd_design',
      'Generate a design.md skeleton for adapting a plugin to the DH-TP-SDK third-party plugin spec. Writes to <pluginPath>/.dsh-plugin-design/design.md. Never overwrites an existing design.md unless mode=overwrite (or mode=version to write design.vN.md).',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory.' },
        mode: { type: 'string', enum: ['create', 'version', 'overwrite'], description: 'create (default, refuse if exists) | version (write next design.vN.md) | overwrite.' },
      },
      ['pluginPath'],
      async (args) => {
        const dir = args.pluginPath + '/.dsh-plugin-design'
        const dirTarget = await fs.resolve(dir)
        const existing = await (async () => { try { return await fs.stat(dirTarget) } catch (e) { return undefined } })()
        if (existing === undefined) {
          await writeText(dir + '/.keep', '')
        }
        const mode = args.mode || 'create'
        let designName = 'design.md'
        if (mode === 'version') {
          let n = 2
          while ((await tryReadText(dir + '/design.v' + n + '.md')) !== null) n++
          designName = 'design.v' + n + '.md'
        } else if (mode !== 'overwrite') {
          const cur = await tryReadText(dir + '/design.md')
          if (cur !== null) return { wrote: false, designPath: dir + '/design.md', reason: 'design.md already exists; use mode=version or mode=overwrite' }
        }
        const { issues } = await analyzePlugin(args.pluginPath)
        const template = '# dsh plugin design — design.md\n\n> 依据 DH-TP-SDK 工程化第三方插件规范生成的可执行修改设计。\n> 注意：Bronze/Silver/Gold、P0-P4、S0-S4 为本工程化规范等级，不是 DeepSeek 官方认证。\n\n## 1. Target Plugin\n\n- Plugin ID: UNKNOWN\n- Name: ' + basename(args.pluginPath) + '\n- Path: ' + args.pluginPath + '\n\n## 2. Executive Summary\n\n（待补充：当前插件做什么、当前架构、是否已适配 dsh、最大兼容/安全/生命周期风险、是否存在 Core modification / private API / global mutable state）\n\n## 3. Current Architecture\n\n（逐项：Plugin Entry / Services / Tools / Events / Session / Filesystem / Network / Subprocess / Bundle；不存在则写 Not detected）\n\n## 4. Static Scan Summary\n\n- Issues found: ' + issues.length + '\n' + issues.map((i) => '- [' + i.severity + '] ' + i.id + ' — ' + i.title + (i.file ? ' (' + i.file + ')' : '')).join('\n') + '\n\n## 5. Modification Plan\n\n（逐项 M001/M002/...：ID、Reason、File、Before、After、Risk、Validation、Rollback）\n\n## 6. Verification\n\n（typecheck/lint/unit/integration/lifecycle/session/concurrency/security/compatibility；无则 NOT_AVAILABLE）\n\n## 7. Approval\n\n（用户确认后才执行修改；未确认前严禁修改目标插件源码）\n'
        await writeText(dir + '/' + designName, template)
        return { wrote: true, designPath: dir + '/' + designName, mode, issueCount: issues.length }
      })

    reg('dshpd_approve',
      'Open the approval gate for a design. Generates an approvalToken bound to (pluginPath, designPath) and records the task state as APPROVED. IMPORTANT: the model must obtain the user\'s explicit consent (e.g. via ask_user_question) BEFORE calling this tool. dshpd_apply/dshpd_backup require this token.',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory.' },
        designPath: { type: 'string', description: 'Absolute path to the design.md the user approved.' },
      },
      ['pluginPath', 'designPath'],
      async (args) => {
        const tok = makeToken()
        tasks.set(tok, {
          token: tok,
          pluginPath: args.pluginPath,
          designPath: args.designPath,
          state: 'APPROVED',
          backupId: null,
          journal: [],
          createdAt: new Date().toISOString(),
        })
        return { approvalToken: tok, pluginPath: args.pluginPath, designPath: args.designPath, state: 'APPROVED', note: 'approval gate open; next call dshpd_backup with the listed files to snapshot before editing.' }
      })

    reg('dshpd_backup',
      'Snapshot the exact files listed for modification into <pluginPath>/.dsh-plugin-design/backup/<backupId>/. Requires a valid approvalToken from dshpd_approve. Returns backupId used by dshpd_apply and dshpd_rollback.',
      {
        approvalToken: { type: 'string', description: 'Token from dshpd_approve.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files the design plans to modify.' },
      },
      ['approvalToken', 'files'],
      async (args) => {
        const task = taskByToken(args.approvalToken)
        if (!task) return { error: 'DENIED: invalid or missing approvalToken' }
        if (!Array.isArray(args.files) || args.files.length === 0) return { error: 'files must be a non-empty array of absolute paths' }
        const backupId = makeToken()
        const records = []
        const failures = []
        for (let i = 0; i < args.files.length; i++) {
          const p = args.files[i]
          try {
            const content = await readText(p)
            const bname = String(i) + '-' + basename(p)
            await writeText(task.pluginPath + '/.dsh-plugin-design/backup/' + backupId + '/' + bname, content)
            records.push({ index: i, path: p, resolved: (await fs.resolve(p)).displayPath, backupName: bname })
          } catch (e) {
            failures.push({ path: p, error: String(e && e.message ? e.message : e) })
          }
        }
        task.backupId = backupId
        task.state = 'BACKED_UP'
        task.files = records
        return { backupId, state: task.state, backedUp: records.length, failed: failures.length, files: records, failures }
      })

    reg('dshpd_apply',
      'Apply ONE literal text replacement to ONE file (atomic via fs.editText), gated by approvalToken + backupId. The file must be inside the backed-up file set. Records a journal entry. On any failure, stop and consider dshpd_rollback.',
      {
        approvalToken: { type: 'string', description: 'Token from dshpd_approve.' },
        backupId: { type: 'string', description: 'backupId from dshpd_backup.' },
        filePath: { type: 'string', description: 'Absolute path of the file to edit (must be in the backed-up set).' },
        oldText: { type: 'string', description: 'Literal text to replace (non-empty, exact match).' },
        newText: { type: 'string', description: 'Literal replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace every match instead of requiring exactly one.' },
      },
      ['approvalToken', 'backupId', 'filePath', 'oldText', 'newText'],
      async (args) => {
        const task = taskByToken(args.approvalToken)
        if (!task) return { error: 'DENIED: invalid or missing approvalToken' }
        if (task.backupId !== args.backupId) return { error: 'DENIED: backupId mismatch' }
        if (!task.files || !task.files.some((f) => f.path === args.filePath || f.resolved === args.filePath)) return { error: 'DENIED: filePath not in the backed-up file set' }
        if (typeof args.oldText !== 'string' || args.oldText.length === 0) return { error: 'oldText must be a non-empty string' }
        const target = await fs.resolve(args.filePath)
        const outcome = await fs.editText(target, { oldString: args.oldText, newString: args.newText, replaceAll: args.replaceAll === true })
        task.journal.push({ time: new Date().toISOString(), filePath: args.filePath, operation: 'edit' })
        return { applied: true, filePath: args.filePath, before: outcome.before, after: outcome.after, journalCount: task.journal.length }
      })

    reg('dshpd_rollback',
      'Restore every backed-up file from the snapshot directory created by dshpd_backup. Reversible recovery for a failed or unwanted modification run.',
      {
        backupId: { type: 'string', description: 'backupId from dshpd_backup.' },
      },
      ['backupId'],
      async (args) => {
        let owner = null
        for (const t of tasks.values()) if (t.backupId === args.backupId) owner = t
        if (!owner) return { error: 'backupId not found in task state' }
        const restored = []
        const failures = []
        for (const rec of owner.files || []) {
          try {
            const content = await readText(owner.pluginPath + '/.dsh-plugin-design/backup/' + args.backupId + '/' + rec.backupName)
            await writeText(rec.path, content)
            restored.push(rec.path)
          } catch (e) {
            failures.push({ path: rec.path, error: String(e && e.message ? e.message : e) })
          }
        }
        owner.state = 'ROLLED_BACK'
        return { state: owner.state, restored: restored.length, failed: failures.length, restoredFiles: restored, failures }
      })

    reg('dshpd_status',
      'Read the in-memory dsh-plugin-design task state for an approvalToken (or list all active tasks when omitted).',
      {
        approvalToken: { type: 'string', description: 'Optional token from dshpd_approve; omit to list all tasks.' },
      },
      [],
      async (args) => {
        if (args.approvalToken) {
          const t = taskByToken(args.approvalToken)
          if (!t) return { error: 'token not found' }
          return { state: t.state, pluginPath: t.pluginPath, designPath: t.designPath, backupId: t.backupId, journalCount: (t.journal || []).length, createdAt: t.createdAt }
        }
        const list = []
        for (const t of tasks.values()) list.push({ token: t.token, state: t.state, pluginPath: t.pluginPath, backupId: t.backupId, journalCount: (t.journal || []).length })
        return { activeTasks: list.length, tasks: list }
      })

    reg('dshpd_report',
      'Produce a modification report for a backupId (files backed up, journal edits, remaining risks). Use after modifications complete or before rollback.',
      {
        backupId: { type: 'string', description: 'backupId from dshpd_backup.' },
      },
      ['backupId'],
      async (args) => {
        let owner = null
        for (const t of tasks.values()) if (t.backupId === args.backupId) owner = t
        if (!owner) return { error: 'backupId not found in task state' }
        return {
          backupId: args.backupId,
          pluginPath: owner.pluginPath,
          designPath: owner.designPath,
          state: owner.state,
          filesBackedUp: (owner.files || []).map((f) => f.path),
          edits: (owner.journal || []),
          remainingRisks: ['validation/tests not run by this plugin — run them via shell/tooling and mark PASS/FAIL/NOT_AVAILABLE', 'heuristic analysis is not authoritative certification'],
          note: 'DH-TP-SDK certification levels (Bronze/Silver/Gold) are engineering spec levels, not DeepSeek official certification.',
        }
      })

    // ================= Client HTTP routes（设置页「选文件夹扫描」用） =================
    const webServer = ctx.webServer
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-design/discover',
      handler: async (req, res) => {
        try {
          let body = ''
          for await (const chunk of req) body += chunk
          let parsed = {}
          try { parsed = JSON.parse(body || '{}') } catch (e) { parsed = {} }
          const root = String(parsed.root || '').trim()
          if (!root) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'root path required', plugins: [], count: 0 }))
            return
          }
          const maxDepth = parsed.maxDepth !== undefined ? parsed.maxDepth : 5
          const plugins = nodeDiscoverPlugins(root, maxDepth)
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ root, count: plugins.length, plugins }))
        } catch (e) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: String(e && e.message ? e.message : e), plugins: [], count: 0 }))
        }
      },
    }))
  },
}
