// dsh-plugin-design - Host half (persistent plugin)
//
// Workflow:
//   discover -> inspect -> analyze -> design -> plan -> approve -> backup
//   -> apply/write/migrate -> verify -> report/rollback
//   distribution: distribute -> validate
//
// Design constraints (M1/M2):
//   - No profile writes: deployment is delegated to the official
//     `pluginManager` service; without it the tool returns a dry-run plan.
//   - No unbounded scanning on the Host thread: every walk/read/rule run goes
//     through a worker with a deadline, a byte/file/dir budget and a cancel
//     path; a timeout is reported as INCOMPLETE, never as a clean result.
//   - Approvals are bound to one exact plan (planHash + file baselines +
//     operations + root + design hash + identity + expiry) and are issued only
//     through the official approval seam or an already-granted full-access
//     preset.
//   - Mutations are compare-and-swap through ctx.fs with an explicit
//     sandboxPolicy and a durable prepare/commit journal.
//   - Durable state (snapshots, journal, approvals, conflicts, validation
//     evidence) lives in the plugin-design state root, outside the reviewed
//     plugin tree.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { analyzeModel, countBySeverity, parseManifestHeuristic, RULESET } from './rules.js'
import { isValidRange } from './semver.js'
import { resolveDshHome, resolveStateRoot, runtimeFingerprint, serviceWithRealm } from './runtime/fingerprint.js'
import { ScanScheduler } from './scan/service.js'
import { canonicalPath, pathKey, resolveInside, stateId, validatePackageName } from './change/paths.js'
import { buildPlan } from './change/plan.js'
import { authorizeMutation, effectiveSandboxMode, issueApproval, callerIdentity } from './change/approval.js'
import {
  createSnapshot, isSafeBackupId, loadSnapshot, previewRestore, restoreSnapshot, verifySnapshotPayloads,
} from './change/snapshot.js'
import {
  appendJournal, ensureStateLayout, operationStates, readJournal, recoveryRequired,
} from './change/journal.js'
import { editTextCas, readTargetText, resolvePolicy, sha256Text, writeTextCas } from './change/transaction.js'
import { applyMount, detectDeploymentAdapter, planMount } from './deploy/adapter.js'
import { deploymentStates, inspectDeployment } from './deploy/profiles.js'
import { buildDesignTemplate, buildUiProposal, classifyTarget, resolveUiMode } from './design.js'
import { auditPackageDirectory } from './distribution/audit.js'
import { exportDistribution, verifyRelease } from './distribution/exporter.js'
import { runDshHost, runPackageLoad } from './validation/runner.js'

const STATE_SCHEMA = 2
const MAX_BODY_BYTES = 1024 * 1024
const MAX_RECEIPT_AGE_MS = 10 * 60 * 1000
const TOOL_NAMES = [
  'dshpd_discover', 'dshpd_inspect', 'dshpd_analyze', 'dshpd_ui_check', 'dshpd_design', 'dshpd_plan',
  'dshpd_approve', 'dshpd_backup', 'dshpd_apply', 'dshpd_write', 'dshpd_migrate', 'dshpd_mount',
  'dshpd_verify', 'dshpd_rollback', 'dshpd_status', 'dshpd_report', 'dshpd_distribute', 'dshpd_validate',
]
const MIGRATION_IDS = ['manifest-version', 'engines-dsh', 'bundle-patch', 'client-meta', 'remove-invariants-dep']
const OPERATIONS = ['backup', 'apply', 'migrate', 'write', 'mount', 'deploy', 'distribute']

const PLUGIN = readPluginMeta()

function readPluginMeta() {
  const fallback = { name: 'dsh-plugin-design', version: '0.0.0', engines: null }
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return {
      name: typeof pkg.name === 'string' ? pkg.name : fallback.name,
      version: typeof pkg.version === 'string' ? pkg.version : fallback.version,
      engines: pkg.engines && typeof pkg.engines.dsh === 'string' ? pkg.engines.dsh : null,
    }
  } catch (error) {
    return fallback
  }
}

function messageOf(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function hashText(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function shortText(value, max) {
  if (typeof value !== 'string') return value
  return value.length <= max ? value : value.slice(0, max) + '\n... (truncated)'
}

function analysisSummary(result) {
  const counts = countBySeverity(result.issues)
  return {
    issueCount: result.issues.length,
    counts,
    blockers: counts.BLOCKER,
    criticals: counts.CRITICAL,
    overall: result.overall,
    issueIds: result.issues.map((issue) => issue.id + '@' + String(issue.file || '')),
  }
}

function statusOfChecks(checks, requiredLayers) {
  const required = checks.filter((check) => requiredLayers.includes(check.layer))
  if (required.some((check) => check.status === 'FAIL')) return 'FAIL'
  if (required.some((check) => check.status === 'UNKNOWN' || check.status === 'NOT_RUN')) return 'INCOMPLETE'
  if (required.some((check) => check.status === 'PENDING')) return 'INCOMPLETE'
  return 'PASS'
}

export default {
  name: 'dsh-plugin-design',
  inject: ['tools'],

  apply(ctx) {
    const receipts = new Map()
    const backups = new Map()
    const scan = new ScanScheduler({ timeoutMs: 30_000, heapMb: 256, maxQueue: 4 })
    const health = new Map()
    const stateRoot = resolveStateRoot()
    const dshHome = resolveDshHome()
    const toolVersion = PLUGIN.version

    // ---- service realm resolution ---------------------------------------
    function serviceFor(exec, name) {
      return serviceWithRealm(ctx, exec, name)
    }

    function requireFs(exec) {
      const resolved = serviceFor(exec, 'fs')
      if (!resolved.value || typeof resolved.value.resolve !== 'function') {
        throw new Error('NO_FS_SERVICE: fs is an agent-plane service; call this tool from an agent session')
      }
      return resolved.value
    }

    function policyFor(exec) {
      return resolvePolicy(ctx, exec)
    }

    function pluginStateDir(pluginRoot) {
      return join(stateRoot, 'plugins', stateId(canonicalPath(pluginRoot)))
    }

    async function ensurePluginState(pluginRoot) {
      const dir = pluginStateDir(pluginRoot)
      await ensureStateLayout(dir)
      return dir
    }

    // ---- scanning --------------------------------------------------------
    async function scanRequest(kind, args, exec, options = {}) {
      const signal = exec && exec.signal ? exec.signal : options.signal
      const message = await scan.request(kind, args, {
        signal,
        timeoutMs: options.timeoutMs || 30_000,
      })
      return message
    }

    async function analyzePlugin(pluginPath, harnessVersion, exec) {
      const runtime = runtimeFingerprint({ ctx, requestedVersion: harnessVersion })
      const effective = runtime.effectiveVersion
      const message = await scanRequest('analyze', {
        pluginPath,
        harnessVersion: effective,
      }, exec)
      const summary = message.summary || {}
      const result = message.result
      const coverage = message.coverage || summary.coverage || {}
      const incomplete = coverage.incomplete === true
      return {
        model: summary,
        result: {
          ...result,
          overall: incomplete ? 'INCOMPLETE' : result.overall,
        },
        coverage,
        runtime,
        incomplete,
      }
    }

    function scanFailure(error, extra = {}) {
      const code = error && typeof error.code === 'string' ? error.code : 'SCAN_FAILED'
      return {
        ok: false,
        error: messageOf(error),
        scan: { status: 'INCOMPLETE', code, detail: 'the scan did not complete; no clean verdict is available' },
        ...extra,
      }
    }

    // ---- UI health -------------------------------------------------------
    function healthFile() {
      return join(stateRoot, 'client-health.json')
    }

    function recordHealth(entry) {
      health.set(entry.packageName, entry)
      try {
        const all = {}
        for (const [key, value] of health) all[key] = value
        mkdirSync(stateRoot, { recursive: true })
        writeFileSync(healthFile(), JSON.stringify(all, null, 2) + '\n', 'utf8')
      } catch (error) {
        // health persistence is best effort; the in-memory receipt still counts
      }
    }

    function healthFor(packageName) {
      const entry = health.get(packageName)
      if (!entry) return { present: false, status: 'UNKNOWN' }
      const age = Date.now() - Date.parse(entry.receivedAt)
      return {
        present: true,
        ageMs: age,
        fresh: age <= MAX_RECEIPT_AGE_MS,
        activated: entry.activated === true,
        rendered: entry.rendered === true,
        error: entry.error || null,
        version: entry.version || null,
        buildRev: entry.buildRev || null,
        receivedAt: entry.receivedAt,
      }
    }

    function uiStatus(packageName) {
      if (typeof packageName !== 'string' || packageName.trim() === '') {
        return { available: false, reason: 'package name unknown' }
      }
      const clientModules = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
      if (!clientModules) {
        return { available: false, reason: 'clientModules service is not visible from this host context' }
      }
      let graph = null
      try {
        graph = typeof clientModules.graph === 'function' ? clientModules.graph() : null
      } catch (error) {
        return { available: false, reason: messageOf(error) }
      }
      const entry = graph && Array.isArray(graph.entries)
        ? graph.entries.find((item) => item && item.id === packageName) || null
        : null
      let clientPath = null
      try {
        clientPath = typeof clientModules.clientPath === 'function' ? clientModules.clientPath(packageName) : null
      } catch (error) {
        clientPath = null
      }
      let bundleExists = false
      if (typeof clientPath === 'string') {
        try { bundleExists = existsSync(clientPath) } catch (error) { bundleExists = false }
      }
      return {
        available: true,
        packageName,
        inGraph: entry !== null,
        rev: entry && typeof entry.rev === 'string' ? entry.rev : null,
        clientPath: typeof clientPath === 'string' ? clientPath : null,
        bundleExists,
        graphRev: graph && typeof graph.rev === 'string' ? graph.rev : null,
        health: healthFor(packageName),
        stages: {
          served: bundleExists,
          registered: entry !== null,
          activated: healthFor(packageName).activated === true,
          rendered: healthFor(packageName).rendered === true,
        },
      }
    }

    function deploymentFor(packageName) {
      try {
        return inspectDeployment(packageName, { dshHome })
      } catch (error) {
        return { packageName, error: messageOf(error) }
      }
    }

    function validationSummaryFor(packageName) {
      if (typeof packageName !== 'string' || packageName === '') return null
      try {
        return JSON.parse(readFileSync(join(stateRoot, 'validation', packageName.replace(/[^A-Za-z0-9._@-]/g, '_') + '.json'), 'utf8'))
      } catch (error) {
        return null
      }
    }

    // ---- tool registration ----------------------------------------------
    function renderText(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    }

    function reg(name, description, properties, required, execute, options) {
      const parameters = { type: 'object', properties, additionalProperties: false }
      if (required && required.length > 0) parameters.required = required
      const definition = {
        name,
        description,
        parameters,
        output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
        async execute(args, exec) {
          try {
            const value = await execute(args || {}, exec || {})
            return value === undefined ? { ok: false, error: 'NO_RESULT' } : value
          } catch (error) {
            return {
              ok: false,
              error: messageOf(error),
              code: error && typeof error.code === 'string' ? error.code : null,
            }
          }
        },
      }
      if (options && options.concurrencySafe === true) definition.isConcurrencySafe = () => true
      ctx.tools.register(definition)
    }

    // ---- authorization helpers ------------------------------------------
    async function resolveBackup(pluginRoot, backupId) {
      if (!isSafeBackupId(backupId)) return { ok: false, error: 'INVALID_BACKUP_ID' }
      const fromMemory = backups.get(backupId)
      if (fromMemory !== undefined && (!pluginRoot || pathKey(fromMemory.pluginRoot) === pathKey(canonicalPath(pluginRoot)))) {
        return { ok: true, backup: fromMemory, stateDir: fromMemory.stateDir }
      }
      if (!pluginRoot) return { ok: false, error: 'PLUGIN_PATH_REQUIRED' }
      const stateDir = pluginStateDir(pluginRoot)
      const loaded = await loadSnapshot(stateDir, backupId)
      if (!loaded.ok) return loaded
      if (pathKey(loaded.manifest.pluginRoot) !== pathKey(canonicalPath(pluginRoot))) {
        return { ok: false, error: 'BACKUP_OWNERSHIP_MISMATCH', detail: 'the snapshot belongs to another plugin root' }
      }
      const afterHashes = new Map()
      for (const record of loaded.manifest.files) if (record.sha256) afterHashes.set(pathKey(record.path), record.sha256)
      const backup = {
        backupId,
        pluginRoot: loaded.manifest.pluginRoot,
        manifest: loaded.manifest,
        stateDir,
        afterHashes,
        designPath: loaded.manifest.design ? loaded.manifest.design.path : null,
      }
      backups.set(backupId, backup)
      return { ok: true, backup, stateDir }
    }

    async function requireApproval(args, exec, operation, filePaths) {
      const authorized = await authorizeMutation({
        receipts,
        token: args.approvalToken,
        exec,
        service: requireFs(exec),
        operation,
        filePaths,
        signal: exec.signal,
      })
      if (!authorized.ok) return authorized
      const receipt = authorized.receipt
      if (receipt.pluginRoot !== canonicalPath(args.pluginPath || receipt.pluginRoot)) {
        return { ok: false, error: 'PLUGIN_ROOT_MISMATCH' }
      }
      return { ok: true, receipt }
    }

    function runtimeBlock(exec) {
      const fingerprint = runtimeFingerprint({ ctx, requestedVersion: null, env: process.env })
      return {
        running: fingerprint.running,
        simulated: fingerprint.simulated,
        effectiveVersion: fingerprint.effectiveVersion,
        effectiveSource: fingerprint.effectiveSource,
        serviceRealm: {
          fs: serviceFor(exec, 'fs').realm,
          sandboxPolicy: serviceFor(exec, 'sandboxPolicy').realm,
        },
      }
    }

    /** Stable runtime identity for plan hashing (no timestamps/cwd). */
    function planRuntime(exec) {
      const running = runtimeBlock(exec).running
      return {
        version: running.version,
        versionSource: running.versionSource,
        commit: running.commit,
        node: running.node,
        electron: running.electron,
        platform: running.platform,
        arch: running.arch,
        carrier: running.carrier,
      }
    }

    // =====================================================================
    // Read-only tools
    // =====================================================================

    reg('dshpd_discover',
      'Discover third-party DSH plugin projects under a directory. The scan runs in a bounded worker (deadline, file/dir/byte budget) and reports coverage; it skips node_modules/.git but includes build output directories. Read-only. A timeout or budget overrun returns INCOMPLETE, not an empty success.',
      {
        root: { type: 'string', description: 'Scan root (absolute or workspace-relative). Defaults to the session workspace root.' },
        maxDepth: { type: 'integer', description: 'Max recursion depth (default 5, max 12).' },
      },
      [],
      async (args, exec) => {
        const policy = policyFor(exec)
        const root = nonEmpty(args.root)
          || (policy && typeof policy.workspaceRoot === 'string' ? policy.workspaceRoot : null)
          || process.cwd()
        const depth = args.maxDepth === undefined ? 5 : Math.max(0, Math.min(12, Number(args.maxDepth) || 0))
        try {
          const message = await scanRequest('discover', {
            rootPath: root,
            maxResults: 500,
            budget: { maxDepth: depth, deadlineMs: 30_000 },
          }, exec)
          const coverage = message.coverage || {}
          return {
            ok: coverage.incomplete !== true,
            root: message.root,
            count: (message.results || []).length,
            plugins: message.results || [],
            coverage,
            scan: { status: coverage.incomplete === true ? 'INCOMPLETE' : 'COMPLETE', reasons: coverage.incompleteReasons || [] },
          }
        } catch (error) {
          return scanFailure(error, { root, count: 0, plugins: [] })
        }
      },
      { concurrencySafe: true })

    reg('dshpd_inspect',
      'Inspect one plugin project: manifest, official roles, Host entry, bundle patch, Client entry/chunks, build artifacts under lib/dist, package scripts, lockfiles and the optional DH-TP-SDK manifest. Reads what would actually run, not only src/. Read-only facts with explicit scan coverage.',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory.' },
        maxBytes: { type: 'integer', description: 'Max bytes per raw file in the response (default 20000).' },
      },
      ['pluginPath'],
      async (args, exec) => {
        const maxBytes = args.maxBytes === undefined ? 20000 : Math.max(1000, Number(args.maxBytes) || 20000)
        try {
          const message = await scanRequest('collect', { pluginPath: args.pluginPath }, exec)
          const model = message.summary
          return {
            ok: (message.coverage || {}).incomplete !== true,
            pluginPath: model.pluginPath,
            name: basename(model.pluginPath),
            hasManifest: model.manifestRaw !== null,
            manifestParsed: model.manifestRaw === null ? null : parseManifestHeuristic(model.manifestRaw),
            hasPackageJson: model.pkgRaw !== null || model.pkg !== null,
            packageJson: model.pkg,
            packageJsonError: model.pkgError,
            hostEntry: model.hostEntry,
            clientEntry: model.clientEntry,
            bundlePatches: model.bundlePatches,
            client: {
              declared: Boolean(model.clientEntry || (model.pkg && model.pkg.dsh && model.pkg.dsh.client)),
              bundlePath: model.clientBundlePath,
              bundleExists: model.clientBundleExists,
            },
            artifacts: model.sourceFiles.filter((file) => file.kind === 'artifact').map((file) => file.relative),
            sourceFiles: model.sourceFiles.filter((file) => file.kind !== 'artifact').map((file) => file.relative),
            lockfiles: model.lockfiles,
            topLevel: model.topLevel,
            hasTests: model.hasTests,
            coverage: message.coverage,
            note: 'git status/commits are NOT_VERIFIED here; manifestParsed is an indentation-aware heuristic probe, not a YAML parser.',
          }
        } catch (error) {
          return scanFailure(error)
        }
      },
      { concurrencySafe: true })

    reg('dshpd_analyze',
      'Run the deterministic preflight scan against the official DSH 0.2.x plugin contract plus the optional DH-TP-SDK manifest. Scans actual entries and build artifacts in a bounded worker, reports coverage, uses official SemVer semantics, and returns issues/migrations/dimension scores. It is a static preflight, NOT proof that the plugin cannot block or terminate the Host.',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory.' },
        harnessVersion: { type: 'string', description: 'Optional SIMULATED target DSH version for offline checks. The running build identity always wins when available.' },
      },
      ['pluginPath'],
      async (args, exec) => {
        try {
          const { model, result, coverage, runtime, incomplete } = await analyzePlugin(args.pluginPath, args.harnessVersion, exec)
          const summary = analysisSummary(result)
          const pkg = isPlainObject(model.pkg) ? model.pkg : null
          const name = pkg && typeof pkg.name === 'string' ? pkg.name : null
          return {
            ok: !incomplete,
            pluginPath: model.pluginPath,
            pluginName: name,
            ui: name === null ? null : uiStatus(name),
            deployment: name === null ? null : deploymentFor(name),
            ruleset: RULESET,
            runtime: {
              running: runtime.running,
              simulated: runtime.simulated,
              effectiveVersion: runtime.effectiveVersion,
              effectiveSource: runtime.effectiveSource,
              serviceRealm: { fs: serviceFor(exec, 'fs').realm, sandboxPolicy: serviceFor(exec, 'sandboxPolicy').realm },
            },
            official: result.official,
            issueCount: result.issues.length,
            counts: summary.counts,
            blockers: summary.blockers,
            criticals: summary.criticals,
            scores: result.scores,
            overall: result.overall,
            safetyClaim: RULESET.safetyClaim,
            runtimeVerification: result.official.runtimeVerification,
            scan: {
              status: incomplete ? 'INCOMPLETE' : 'COMPLETE',
              coverage,
            },
            issues: result.issues.slice(0, 300),
            issuesTruncated: result.issues.length > 300,
            migrations: result.migrations,
            verdictRule: 'BLOCKED (any BLOCKER) | NEEDS_REVIEW (any CRITICAL) | INCOMPLETE (scan incomplete) | READY_TO_MODIFY (otherwise). READY_TO_MODIFY only means the static preflight found no blockers.',
            knownLimitations: RULESET.limitations,
            note: 'static preflight only; runtime isolation and clean-install validation are separate steps.',
          }
        } catch (error) {
          return scanFailure(error)
        }
      },
      { concurrencySafe: true })

    reg('dshpd_ui_check',
      'Check a plugin browser half by layer: bundle served, module registered in the running client graph, activation/render receipts sent by the loaded Client half, and static UI diagnostics. `registered` does NOT mean rendered; without a fresh receipt the UI health is UNKNOWN.',
      {
        pluginPath: { type: 'string', description: 'Plugin project directory (used to read package.json and run static checks).' },
        packageName: { type: 'string', description: 'Optional package name when only the runtime graph entry matters.' },
        harnessVersion: { type: 'string', description: 'Optional SIMULATED DSH version for engines.dsh evaluation.' },
      },
      [],
      async (args, exec) => {
        let packageName = nonEmpty(args.packageName)
        let model = null
        let result = null
        let coverage = null
        if (nonEmpty(args.pluginPath) !== null) {
          try {
            const analyzed = await analyzePlugin(args.pluginPath, args.harnessVersion, exec)
            model = analyzed.model
            result = analyzed.result
            coverage = analyzed.coverage
          } catch (error) {
            return scanFailure(error)
          }
          if (packageName === null && isPlainObject(model.pkg)) packageName = nonEmpty(model.pkg.name)
        }
        if (packageName === null) return { ok: false, error: 'PACKAGE_NAME_UNKNOWN' }
        const runtime = uiStatus(packageName)
        const deployment = deploymentFor(packageName)
        const declared = result === null ? null : result.official.client.declared
        const health = runtime.health || { present: false, status: 'UNKNOWN' }
        const metadataCache = {
          scope: 'client-modules package metadata (including a "not a client" result)',
          key: 'loader specifier + baseUrl',
          invalidatedBy: 'Host/Desktop restart only; a page refresh or HMR reload is not enough',
          source: 'DSH 0.2.1-rc.3 dsh-client-modules resolveMeta/pkgMeta cache',
        }
        let status = 'UNKNOWN'
        let reason = null
        if (declared === true) {
          if (runtime.available === false) {
            status = 'UNKNOWN'
            reason = 'the client module graph is not visible from this context'
          } else if (runtime.inGraph !== true) {
            status = 'FAIL'
            reason = 'the package is not registered in the running client graph'
              + '; if dsh.client / exports["./client"] / the entry file changed after this Host started,'
              + ' the rc.3 client-modules metadata cache (including a negative "not a client" result) can still'
              + ' hold the old answer until the Host/Desktop restarts'
          } else if (health.present === true && health.fresh === true && health.rendered === true) {
            status = 'PASS'
            reason = 'the loaded Client half reported a fresh rendered receipt'
          } else {
            status = 'UNKNOWN'
            reason = 'registered in the graph but no fresh activation/render receipt was received'
          }
        } else if (declared === false) {
          status = 'NOT_APPLICABLE'
          reason = 'the package declares no Client half'
        }
        return {
          ok: status === 'PASS' || status === 'NOT_APPLICABLE',
          packageName,
          status,
          reason,
          declared,
          runtime,
          deployment,
          metadataCache,
          stages: runtime.stages,
          health,
          client: result === null ? null : {
            buildStaleHint: result.official.client.buildStale,
            applyPresent: result.official.client.applyPresent,
            injectPresent: result.official.client.injectPresent,
            uiSlots: result.official.client.uiSlots,
            services: result.official.client.services,
            unknownServices: result.official.client.unknownServices,
            legacyServices: result.official.client.legacyServices,
            eagerLookups: result.official.client.eagerLookups,
          },
          issues: result === null ? [] : result.issues.filter((issue) => issue.category === 'client').slice(0, 50),
          coverage,
          howToUse: [
            'status=FAIL with inGraph=false: the package is not composed into this profile; install/enable it through the official plugin manager and restart the client.',
            'After changing dsh.client, exports["./client"] or the entry file, restart the whole Desktop/Host: the rc.3 client-modules metadata cache keeps the old result (including "this is not a client package") until then. Page refresh/HMR does not clear it.',
            'status=UNKNOWN with inGraph=true: the module graph only proves registration. The Client half must POST /dsh-plugin-design/client-health after it activates and renders.',
            'buildStaleHint is an mtime hint, not proof the bundle is current; rebuild and re-verify.',
            'Electron/browser interaction cannot be proven by this tool; use the distribution validation runner for real-host evidence.',
          ],
        }
      },
      { concurrencySafe: true })

    // =====================================================================
    // Design / plan / approval
    // =====================================================================

    reg('dshpd_design',
      'Generate a design.md draft: target classification, Host/Client necessity with retain/remove/move rationale, official-contract snapshot, findings, exact modification workflow, deployment target (never defaulted to desktop), UI decision (no Client half is invented without a need), independent-distribution obligations and verification requirements. Writes design.md + design.meta.json (inside the plugin when writable, else in the plugin-design state root). Never edits plugin sources.',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory.' },
        mode: { type: 'string', enum: ['create', 'version', 'overwrite'], description: 'create (default, refuse if exists) | version (write design.vN.md) | overwrite.' },
        harnessVersion: { type: 'string', description: 'Optional SIMULATED DSH version for offline checks.' },
        ui: { type: 'string', enum: ['auto', 'propose', 'off'], description: 'auto (default): propose only when there is a user-facing need; propose: force; off: never.' },
        targetProfile: { type: 'string', description: 'Optional deployment profile to describe. No profile is assumed by default.' },
      },
      ['pluginPath'],
      async (args, exec) => {
        const service = requireFs(exec)
        const analyzed = await analyzePlugin(args.pluginPath, args.harnessVersion, exec)
        const { model, result, coverage } = analyzed
        const classification = classifyTarget(model, result)
        const uiMode = resolveUiMode(args.ui || 'auto', model, classification, result)
        const uiProposal = buildUiProposal(model, result, classification, uiMode)
        const pkg = isPlainObject(model.pkg) ? model.pkg : {}
        const name = nonEmpty(pkg.name)
        const deployment = name === null ? null : deployInventory(name, args.targetProfile)
        const template = buildDesignTemplate(args.pluginPath, result, { classification, uiProposal, deployment })
        const pluginRoot = canonicalPath(args.pluginPath)
        const mode = args.mode || 'create'
        const stateDir = await ensurePluginState(pluginRoot)
        const localDir = join(pluginRoot, '.dsh-plugin-design')
        let designName = 'design.md'
        if (mode === 'version') {
          let index = 2
          while (await readTargetText(service, join(localDir, 'design.v' + index + '.md')).then((value) => value.exists).catch(() => false)) index += 1
          designName = 'design.v' + index + '.md'
        }
        const targetDesign = join(localDir, designName)
        if (mode !== 'overwrite') {
          const existing = await readTargetText(service, targetDesign).catch(() => ({ exists: false }))
          if (existing.exists === true) {
            return {
              ok: false,
              wrote: false,
              error: 'DESIGN_EXISTS',
              designPath: targetDesign,
              reason: 'design.md already exists; use mode=version or mode=overwrite',
            }
          }
        }
        let designPath = targetDesign
        let location = 'plugin'
        let write = await writeTextCas(service, designPath, template, { create: true, policy: policyFor(exec), signal: exec.signal })
        if (!write.ok) {
          designPath = join(stateDir, designName)
          location = 'state-root'
          write = await writeTextCas(service, designPath, template, { create: true, policy: policyFor(exec), signal: exec.signal })
        }
        if (!write.ok) return { ok: false, error: write.code, detail: write.detail }
        const meta = {
          schema: STATE_SCHEMA,
          pluginPath: pluginRoot,
          designPath,
          designSha256: hashText(template),
          createdAt: new Date().toISOString(),
          target: { type: classification.type, hostNeed: classification.hostNeed, clientNeed: classification.clientNeed },
          classification,
          deployment: deployment === null ? null : {
            targetProfile: args.targetProfile || null,
            installed: deployment.installedAnywhere,
            selected: deployment.selectedAnywhere,
            enabled: deployment.enabledAnywhere,
            profiles: deployment.profiles.map((profile) => ({
              name: profile.profile, selected: profile.selected, enabled: profile.enabled, packageResolvable: profile.packageResolvable,
            })),
          },
          ui: {
            expected: uiProposal.proposed === true,
            recovery: uiProposal.recovery === true,
            mode: uiMode.mode,
            entry: uiProposal.entry || null,
            title: uiProposal.title || null,
          },
          distribution: { required: true, status: 'NOT_RUN' },
          runtime: analyzed.runtime.running,
        }
        const metaPath = designPath.replace(/design(?:\.v\d+)?\.md$/i, 'design.meta.json')
        const metaWrite = await writeTextCas(service, metaPath, JSON.stringify(meta, null, 2) + '\n', {
          create: mode !== 'overwrite', policy: policyFor(exec), signal: exec.signal,
        })
        if (!metaWrite.ok && metaWrite.code === 'CAS_TARGET_EXISTS') {
          await writeTextCas(service, metaPath, JSON.stringify(meta, null, 2) + '\n', {
            create: false, policy: policyFor(exec), signal: exec.signal,
          })
        }
        return {
          ok: true,
          wrote: true,
          designPath,
          designLocation: location,
          designMetaPath: metaPath,
          designSha256: meta.designSha256,
          mode,
          classification,
          ui: uiProposal,
          uiMode,
          deployment,
          coverage,
          runtime: analyzed.runtime.running,
          issueCount: result.issues.length,
          overall: result.overall,
          migrations: result.migrations.map((migration) => migration.id),
          next: 'call dshpd_plan with the exact files you intend to change, then dshpd_approve with the returned planHash',
        }
      })

    function deployInventory(packageName, targetProfile) {
      const deployment = inspectDeployment(packageName, { dshHome })
      return {
        packageName,
        dshHome,
        installedAnywhere: deployment.installedAnywhere,
        selectedAnywhere: deployment.selectedAnywhere,
        enabledAnywhere: deployment.enabledAnywhere,
        homePatch: deployment.homePatch,
        targetProfile: targetProfile || null,
        profiles: deployment.profiles.map((profile) => ({
          profile: profile.profile,
          profileDir: profile.profileDir,
          patchPath: profile.patchPath,
          selected: profile.selected,
          enabled: profile.enabled,
          packageResolvable: profile.packageResolvable,
          packagePath: profile.packagePath,
          row: profile.row,
        })),
        states: deploymentStates(packageName, { dshHome, profile: targetProfile || null }),
        adapter: detectDeploymentAdapter(ctx),
        mountRow: deployment.mountRow,
      }
    }

    reg('dshpd_plan',
      'Build the exact change plan that an approval is bound to: canonical plugin root, design.md hash, every file with its current hash/version/presence, permitted operations, target profile and the runtime fingerprint. Returns a deterministic planHash. Read-only; never writes.',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory.' },
        designPath: { type: 'string', description: 'Absolute path to the design.md that describes the change.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Exact files the plan may modify (absolute or plugin-relative).' },
        operations: { type: 'array', items: { type: 'string' }, description: 'Permitted operations: backup, apply, write, migrate, mount, deploy, distribute.' },
        targetProfile: { type: 'string', description: 'Optional deployment profile this plan targets.' },
      },
      ['pluginPath', 'designPath', 'files'],
      async (args, exec) => {
        const service = requireFs(exec)
        const built = await buildPlan({
          service,
          pluginRoot: args.pluginPath,
          designPath: args.designPath,
          files: args.files,
          operations: args.operations,
          targetProfile: args.targetProfile,
          runtime: planRuntime(exec),
          tool: { name: PLUGIN.name, version: toolVersion, ruleset: RULESET.version },
          signal: exec.signal,
        })
        if (!built.ok) return { ok: false, error: built.error, detail: built.detail }
        return {
          ok: true,
          plan: built.plan,
          planHash: built.planHash,
          summary: {
            pluginRoot: built.plan.pluginRoot,
            package: built.plan.packageName,
            design: built.plan.design,
            files: built.plan.files.length,
            operations: built.plan.operations,
            targetProfile: built.plan.targetProfile,
          },
          next: 'review the plan, then call dshpd_approve with this exact planHash',
        }
      },
      { concurrencySafe: true })

    reg('dshpd_approve',
      'Open the approval gate for one EXACT plan. The caller must echo the planHash returned by dshpd_plan; the receipt binds the design hash, every file baseline, the operation set, the canonical root, the target profile, the calling agent/session and an expiry. Authorization is obtained from the official approval service when it can grant, or is taken from an already-granted danger-full-access preset; otherwise no token is issued. Editing the design, files or plan invalidates the receipt.',
      {
        pluginPath: { type: 'string', description: 'Absolute path to the plugin project directory.' },
        designPath: { type: 'string', description: 'Absolute path to the approved design.md.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Exact file set, identical to the plan.' },
        planHash: { type: 'string', description: 'planHash returned by dshpd_plan.' },
        operations: { type: 'array', items: { type: 'string' }, description: 'Permitted operations.' },
        targetProfile: { type: 'string', description: 'Optional deployment profile.' },
        ttlMinutes: { type: 'integer', description: 'Receipt lifetime in minutes (default 120).' },
      },
      ['pluginPath', 'designPath', 'files', 'planHash'],
      async (args, exec) => {
        if (nonEmpty(args.planHash) === null) {
          return { ok: false, error: 'PLAN_HASH_REQUIRED', detail: 'pass the exact planHash returned by dshpd_plan' }
        }
        const service = requireFs(exec)
        const built = await buildPlan({
          service,
          pluginRoot: args.pluginPath,
          designPath: args.designPath,
          files: args.files,
          operations: args.operations,
          targetProfile: args.targetProfile,
          runtime: planRuntime(exec),
          tool: { name: PLUGIN.name, version: toolVersion, ruleset: RULESET.version },
          signal: exec.signal,
        })
        if (!built.ok) return { ok: false, error: built.error, detail: built.detail }
        if (built.planHash !== String(args.planHash).trim()) {
          return {
            ok: false,
            error: 'PLAN_HASH_MISMATCH',
            detail: {
              expected: built.planHash,
              received: String(args.planHash).trim(),
              reason: 'the design, file baselines, operation set, root or runtime changed since the plan was read',
            },
            plan: built.plan,
          }
        }
        const stateDir = await ensurePluginState(built.plan.pluginRoot)
        const identity = callerIdentity(exec)
        const issued = await issueApproval({
          ctx,
          exec,
          stateDir,
          plan: built.plan,
          planHash: built.planHash,
          requestedPlanHash: args.planHash,
          toolVersion,
          ttlMs: Number.isFinite(args.ttlMinutes) ? Math.max(1, Math.min(720, Number(args.ttlMinutes))) * 60_000 : undefined,
        })
        if (!issued.ok) {
          return {
            ok: false,
            error: issued.error,
            detail: issued.detail,
            plan: built.plan,
            planHash: built.planHash,
            mutationEnabled: false,
            note: 'plans, diffs and checks remain available; a mutating token requires a granted approval channel',
          }
        }
        receipts.set(issued.token, issued.receipt)
        return {
          ok: true,
          approvalToken: issued.token,
          receipt: issued.receipt,
          planHash: built.planHash,
          planDigest: issued.receipt.planDigest,
          authorization: {
            basis: issued.receipt.basis,
            approvalOutcome: issued.receipt.approvalOutcome,
            channel: issued.receipt.approvalChannel,
            sandboxMode: effectiveSandboxMode(ctx, exec),
            identity: { agentId: identity.agentId, sessionId: identity.sessionId },
            expiresAt: issued.receipt.expiresAt,
            maxMutations: issued.receipt.maxMutations,
          },
          note: 'the token is process-local and single-plan; dshpd_backup/apply/write/migrate require it',
        }
      })

    // =====================================================================
    // Mutations
    // =====================================================================

    reg('dshpd_backup',
      'Snapshot every planned file byte-for-byte into the plugin-design state root with a schema-2 manifest (presence, size, SHA-256, encoding, captured version). All files must succeed; a partial failure removes the snapshot and returns an error. Requires a plan-bound approvalToken.',
      {
        approvalToken: { type: 'string', description: 'Token from dshpd_approve.' },
        pluginPath: { type: 'string', description: 'Plugin root (must match the approved plan).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional subset override; must be covered by the approved file set.' },
      },
      ['approvalToken', 'pluginPath'],
      async (args, exec) => {
        const pluginRoot = canonicalPath(args.pluginPath)
        const files = Array.isArray(args.files) && args.files.length > 0 ? args.files : null
        const authorized = await authorizeMutation({
          receipts,
          token: args.approvalToken,
          exec,
          service: requireFs(exec),
          operation: 'backup',
          filePaths: files || [],
          signal: exec.signal,
        })
        if (!authorized.ok) return { ok: false, error: authorized.error, detail: authorized.detail }
        const receipt = authorized.receipt
        if (pathKey(receipt.pluginRoot) !== pathKey(pluginRoot)) {
          return { ok: false, error: 'PLUGIN_ROOT_MISMATCH', detail: { approved: receipt.pluginRoot, received: pluginRoot } }
        }
        const planned = receipt.files.map((file) => file.path)
        if (files !== null) {
          const approved = new Set(planned.map(pathKey))
          for (const file of files) {
            const containment = resolveInside(pluginRoot, file, { label: 'file', rejectReparse: true })
            if (!containment.ok) return { ok: false, error: containment.error, detail: containment.detail }
            if (!approved.has(pathKey(containment.canonical))) {
              return { ok: false, error: 'FILE_NOT_IN_APPROVED_PLAN', detail: { file: containment.canonical } }
            }
          }
        }
        const targetFiles = planned
        const stateDir = await ensurePluginState(pluginRoot)
        const backupId = randomUUID()
        const analysis = await analyzePlugin(pluginRoot, null, exec).then((value) => analysisSummary(value.result)).catch((error) => ({ error: messageOf(error) }))
        await appendJournal(stateDir, {
          operationId: 'backup-' + backupId,
          phase: 'prepare',
          kind: 'backup',
          backupId,
          pluginRoot,
          files: targetFiles.map((path) => ({ path })),
          planHash: receipt.planHash,
        })
        const snapshot = await createSnapshot({
          service: requireFs(exec),
          pluginRoot,
          files: targetFiles,
          stateDir,
          backupId,
          design: { path: receipt.design.path, sha256: receipt.design.sha256 },
          authorization: {
            basis: receipt.basis,
            approvalOutcome: receipt.approvalOutcome,
            channel: receipt.approvalChannel,
            agentId: receipt.agentId,
            sessionId: receipt.sessionId,
            planHash: receipt.planHash,
          },
          analysis,
          toolVersion,
          signal: exec.signal,
        })
        if (!snapshot.ok) {
          await appendJournal(stateDir, {
            operationId: 'backup-' + backupId,
            phase: 'abort',
            kind: 'backup',
            backupId,
            pluginRoot,
            errors: snapshot.failures,
          })
          return { ok: false, error: snapshot.error, detail: snapshot.detail, failures: snapshot.failures, note: 'nothing was committed' }
        }
        const afterHashes = new Map()
        for (const record of snapshot.manifest.files) if (record.sha256) afterHashes.set(pathKey(record.path), record.sha256)
        backups.set(backupId, {
          backupId,
          pluginRoot,
          manifest: snapshot.manifest,
          stateDir,
          afterHashes,
          designPath: receipt.design.path,
          receipt,
        })
        await appendJournal(stateDir, {
          operationId: 'backup-' + backupId,
          phase: 'commit',
          kind: 'backup',
          backupId,
          pluginRoot,
          files: snapshot.manifest.files.map((record) => ({ path: record.path, sha256: record.sha256, bytes: record.bytes, exists: record.exists })),
        })
        return {
          ok: true,
          backupId,
          state: 'SNAPSHOT_VERIFIED',
          pluginRoot,
          stateRoot: stateDir,
          files: snapshot.manifest.files.map((record) => ({
            path: record.path, exists: record.exists, bytes: record.bytes, sha256: record.sha256, encoding: record.encoding,
          })),
          analysis,
          backupDir: snapshot.backupDir,
          note: 'raw bytes + hashes are durable under the plugin-design state root, outside the plugin',
        }
      })

    reg('dshpd_apply',
      'Apply ONE literal text replacement to ONE approved file with a compare-and-swap guard (fs version + approved revision hash). Supports dryRun. A file that changed since the approved revision is refused; there is no allowStale override. Writes a durable prepare/commit journal entry and reports a journal failure separately from a write failure.',
      {
        approvalToken: { type: 'string', description: 'Token from dshpd_approve.' },
        pluginPath: { type: 'string', description: 'Plugin root (must match the approved plan).' },
        backupId: { type: 'string', description: 'backupId from dshpd_backup.' },
        filePath: { type: 'string', description: 'File to edit (must be in the approved plan).' },
        oldText: { type: 'string', description: 'Literal text to replace (non-empty, exact match).' },
        newText: { type: 'string', description: 'Literal replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace every match instead of requiring exactly one.' },
        dryRun: { type: 'boolean', description: 'Report match counts without writing.' },
      },
      ['approvalToken', 'pluginPath', 'backupId', 'filePath', 'oldText', 'newText'],
      async (args, exec) => {
        if (args.allowStale !== undefined) {
          return {
            ok: false,
            error: 'DEPRECATED_ARGUMENT',
            detail: 'allowStale was removed: review the new diff, re-plan and approve again instead of overriding a conflict',
          }
        }
        if (typeof args.oldText !== 'string' || args.oldText.length === 0) return { ok: false, error: 'OLD_TEXT_REQUIRED' }
        if (typeof args.newText !== 'string') return { ok: false, error: 'NEW_TEXT_REQUIRED' }
        const pluginRoot = canonicalPath(args.pluginPath)
        const authorized = await authorizeMutation({
          receipts,
          token: args.approvalToken,
          exec,
          service: requireFs(exec),
          operation: 'apply',
          filePaths: [args.filePath],
          signal: exec.signal,
        })
        if (!authorized.ok) return { ok: false, error: authorized.error, detail: authorized.detail }
        const found = await resolveBackup(pluginRoot, args.backupId)
        if (!found.ok) return { ok: false, error: found.error, detail: found.detail }
        const backup = found.backup
        const record = backup.manifest.files.find((item) => pathKey(item.path) === pathKey(args.filePath))
        if (!record) return { ok: false, error: 'FILE_NOT_IN_BACKUP' }
        const service = requireFs(exec)
        const current = await readTargetText(service, record.path, exec.signal)
        if (!current.exists || current.text === null) return { ok: false, error: 'FILE_UNREADABLE' }
        const expected = backup.afterHashes.get(pathKey(record.path)) || record.sha256
        const currentHash = sha256Text(current.text)
        if (currentHash !== expected) {
          return {
            ok: false,
            error: 'CAS_STALE',
            detail: 'the file changed after the approved revision; re-run dshpd_plan/approve instead of forcing the edit',
            expectedHash: expected,
            currentHash,
          }
        }
        const occurrences = current.text.split(args.oldText).length - 1
        if (occurrences === 0) return { ok: false, error: 'OLD_TEXT_NOT_FOUND', filePath: record.path }
        if (occurrences > 1 && args.replaceAll !== true) {
          return { ok: false, error: 'MULTIPLE_MATCHES', matches: occurrences, hint: 'pass replaceAll=true or use a more specific oldText' }
        }
        if (args.dryRun === true) {
          return { ok: true, dryRun: true, filePath: record.path, matches: occurrences, beforeBytes: Buffer.byteLength(current.text, 'utf8') }
        }
        const stateDir = backup.stateDir
        const operationId = 'apply-' + randomUUID()
        const beforeHash = currentHash
        await appendJournal(stateDir, {
          operationId, phase: 'prepare', kind: 'apply', backupId: backup.backupId, pluginRoot,
          filePath: record.path, beforeHash, matches: occurrences,
        })
        const outcome = await editTextCas(service, record.path, {
          oldString: args.oldText,
          newString: args.newText,
          replaceAll: args.replaceAll === true,
        }, { policy: policyFor(exec), signal: exec.signal })
        if (!outcome.ok) {
          await appendJournal(stateDir, { operationId, phase: 'abort', kind: 'apply', backupId: backup.backupId, pluginRoot, filePath: record.path, error: outcome.code })
          return { ok: false, error: outcome.code, detail: outcome.detail, filePath: record.path }
        }
        const after = await readTargetText(service, record.path, exec.signal)
        const afterHash = after.text === null ? null : sha256Text(after.text)
        if (afterHash === null) {
          return {
            ok: false,
            error: 'POST_WRITE_UNREADABLE',
            detail: 'the write reported success but the file cannot be read back; recovery is required',
            operationId,
          }
        }
        backup.afterHashes.set(pathKey(record.path), afterHash)
        const journalEntry = {
          operationId, phase: 'commit', kind: 'apply', backupId: backup.backupId, pluginRoot,
          filePath: record.path, beforeHash, afterHash,
          bytesBefore: Buffer.byteLength(current.text, 'utf8'),
          bytesAfter: Buffer.byteLength(after.text, 'utf8'),
          matches: occurrences,
          cas: outcome.cas,
        }
        let journal = { status: 'COMMITTED' }
        try {
          await appendJournal(stateDir, journalEntry)
        } catch (error) {
          journal = { status: 'FAILED', error: messageOf(error), operationId }
        }
        return {
          ok: journal.status === 'COMMITTED',
          applied: true,
          filePath: record.path,
          matches: occurrences,
          beforeHash,
          afterHash,
          cas: outcome.cas,
          journal,
          note: journal.status === 'COMMITTED'
            ? 'write and journal committed; run dshpd_verify'
            : 'THE FILE WAS CHANGED but the journal commit failed; run dshpd_status and recovery before further edits',
        }
      })

    reg('dshpd_write',
      'Create or fully replace one approved text file with an explicit createIfAbsent/replaceIfVersion guard and an approved-revision hash check. Use it for files that do not exist yet (backup records them as absent). Supports dryRun; journal semantics match dshpd_apply.',
      {
        approvalToken: { type: 'string', description: 'Token from dshpd_approve.' },
        pluginPath: { type: 'string', description: 'Plugin root (must match the approved plan).' },
        backupId: { type: 'string', description: 'backupId from dshpd_backup.' },
        filePath: { type: 'string', description: 'File to create or replace.' },
        content: { type: 'string', description: 'Full new content.' },
        mode: { type: 'string', enum: ['create', 'replace'], description: 'create refuses an existing file; replace requires an existing file.' },
        dryRun: { type: 'boolean', description: 'Validate without writing.' },
      },
      ['approvalToken', 'pluginPath', 'backupId', 'filePath', 'content', 'mode'],
      async (args, exec) => {
        const pluginRoot = canonicalPath(args.pluginPath)
        const authorized = await authorizeMutation({
          receipts,
          token: args.approvalToken,
          exec,
          service: requireFs(exec),
          operation: 'write',
          filePaths: [args.filePath],
          signal: exec.signal,
        })
        if (!authorized.ok) return { ok: false, error: authorized.error, detail: authorized.detail }
        const found = await resolveBackup(pluginRoot, args.backupId)
        if (!found.ok) return { ok: false, error: found.error, detail: found.detail }
        const backup = found.backup
        const record = backup.manifest.files.find((item) => pathKey(item.path) === pathKey(args.filePath))
        if (!record) return { ok: false, error: 'FILE_NOT_IN_BACKUP' }
        const create = args.mode === 'create'
        if (create && record.exists === true) return { ok: false, error: 'MODE_CONFLICT', detail: 'the plan recorded an existing file; use mode=replace' }
        if (!create && record.exists !== true) return { ok: false, error: 'MODE_CONFLICT', detail: 'the plan recorded an absent file; use mode=create' }
        const service = requireFs(exec)
        if (args.dryRun === true) {
          return { ok: true, dryRun: true, filePath: record.path, mode: args.mode, bytes: Buffer.byteLength(args.content, 'utf8') }
        }
        const stateDir = backup.stateDir
        const operationId = 'write-' + randomUUID()
        const beforeHash = record.sha256
        await appendJournal(stateDir, { operationId, phase: 'prepare', kind: 'write', backupId: backup.backupId, pluginRoot, filePath: record.path, beforeHash })
        const outcome = await writeTextCas(service, record.path, args.content, {
          create,
          expectedHash: create ? undefined : (backup.afterHashes.get(pathKey(record.path)) || record.sha256),
          policy: policyFor(exec),
          signal: exec.signal,
        })
        if (!outcome.ok) {
          await appendJournal(stateDir, { operationId, phase: 'abort', kind: 'write', backupId: backup.backupId, pluginRoot, filePath: record.path, error: outcome.code })
          return { ok: false, error: outcome.code, detail: outcome.detail, filePath: record.path }
        }
        const afterHash = sha256Text(args.content)
        backup.afterHashes.set(pathKey(record.path), afterHash)
        let journal = { status: 'COMMITTED' }
        try {
          await appendJournal(stateDir, {
            operationId, phase: 'commit', kind: 'write', backupId: backup.backupId, pluginRoot,
            filePath: record.path, beforeHash, afterHash, bytesAfter: Buffer.byteLength(args.content, 'utf8'), cas: outcome.cas,
          })
        } catch (error) {
          journal = { status: 'FAILED', error: messageOf(error), operationId }
        }
        return { ok: journal.status === 'COMMITTED', applied: true, filePath: record.path, mode: args.mode, afterHash, cas: outcome.cas, journal }
      })

    reg('dshpd_migrate',
      'Apply manifest-only migrations to package.json with a compare-and-swap guard. engines-dsh requires an explicit, syntactically valid range: it never invents or widens the supported range. Permitted only for files in the approved plan. Writes a durable journal entry.',
      {
        approvalToken: { type: 'string', description: 'Token from dshpd_approve.' },
        pluginPath: { type: 'string', description: 'Plugin root (must match the approved plan).' },
        backupId: { type: 'string', description: 'backupId from dshpd_backup (must include package.json).' },
        migrations: { type: 'array', items: { type: 'string', enum: MIGRATION_IDS }, description: 'Migration IDs to apply.' },
        options: { type: 'object', description: 'Optional values: dshRange (required for engines-dsh).', additionalProperties: true },
      },
      ['approvalToken', 'pluginPath', 'backupId', 'migrations'],
      async (args, exec) => {
        const pluginRoot = canonicalPath(args.pluginPath)
        const packageJsonPath = join(pluginRoot, 'package.json')
        const authorized = await authorizeMutation({
          receipts,
          token: args.approvalToken,
          exec,
          service: requireFs(exec),
          operation: 'migrate',
          filePaths: [packageJsonPath],
          signal: exec.signal,
        })
        if (!authorized.ok) return { ok: false, error: authorized.error, detail: authorized.detail }
        const found = await resolveBackup(pluginRoot, args.backupId)
        if (!found.ok) return { ok: false, error: found.error, detail: found.detail }
        const backup = found.backup
        const record = backup.manifest.files.find((item) => pathKey(item.path) === pathKey(packageJsonPath))
        if (!record) return { ok: false, error: 'PACKAGE_JSON_NOT_BACKED_UP' }
        if (!Array.isArray(args.migrations) || args.migrations.length === 0) return { ok: false, error: 'MIGRATIONS_REQUIRED' }
        const service = requireFs(exec)
        const current = await readTargetText(service, packageJsonPath, exec.signal)
        if (!current.exists || current.text === null) return { ok: false, error: 'PACKAGE_JSON_UNREADABLE' }
        const expected = backup.afterHashes.get(pathKey(packageJsonPath)) || record.sha256
        if (sha256Text(current.text) !== expected) {
          return { ok: false, error: 'CAS_STALE', detail: 'package.json changed after the approved revision' }
        }
        let pkg
        try {
          pkg = JSON.parse(current.text)
        } catch (error) {
          return { ok: false, error: 'PACKAGE_JSON_INVALID', detail: messageOf(error) }
        }
        const options = isPlainObject(args.options) ? args.options : {}
        const applied = []
        const skipped = []
        for (const migrationId of args.migrations) {
          if (!MIGRATION_IDS.includes(migrationId)) {
            skipped.push({ id: migrationId, reason: 'unknown migration id' })
            continue
          }
          const outcome = applyManifestMigration(pkg, migrationId, options, pluginRoot)
          if (outcome.changed) applied.push({ id: migrationId, detail: outcome.detail })
          else skipped.push({ id: migrationId, reason: outcome.detail })
        }
        if (applied.length === 0) return { ok: true, changed: false, applied, skipped, filePath: packageJsonPath }
        const next = JSON.stringify(pkg, null, 2) + '\n'
        const operationId = 'migrate-' + randomUUID()
        await appendJournal(backup.stateDir, {
          operationId, phase: 'prepare', kind: 'migrate', backupId: backup.backupId, pluginRoot,
          filePath: packageJsonPath, beforeHash: sha256Text(current.text),
        })
        const outcome = await writeTextCas(service, packageJsonPath, next, {
          create: false,
          expectedHash: expected,
          policy: policyFor(exec),
          signal: exec.signal,
        })
        if (!outcome.ok) {
          await appendJournal(backup.stateDir, { operationId, phase: 'abort', kind: 'migrate', backupId: backup.backupId, pluginRoot, filePath: packageJsonPath, error: outcome.code })
          return { ok: false, error: outcome.code, detail: outcome.detail }
        }
        const afterHash = sha256Text(next)
        backup.afterHashes.set(pathKey(packageJsonPath), afterHash)
        await appendJournal(backup.stateDir, {
          operationId, phase: 'commit', kind: 'migrate', backupId: backup.backupId, pluginRoot,
          filePath: packageJsonPath, beforeHash: sha256Text(current.text), afterHash,
          migrations: applied.map((item) => item.id),
        })
        return { ok: true, changed: true, applied, skipped, filePath: packageJsonPath, backupId: backup.backupId, afterHash }
      })

    reg('dshpd_mount',
      'Inspect a deployment and, when the official plugin manager is composed, delegate installBundle to it. Without that service this tool NEVER writes a profile file: it returns the exact dry-run row/plan and the official command. apply=true requires a plan-bound approvalToken whose operation set includes mount.',
      {
        packageName: { type: 'string', description: 'Package name to deploy.' },
        pluginPath: { type: 'string', description: 'Plugin project directory (used to read the package name/spec).' },
        profile: { type: 'string', description: 'Target profile (e.g. web, desktop). Required for apply.' },
        spec: { type: 'string', description: 'Install spec passed to the official pluginManager (directory, link:, .tgz, registry name).' },
        apply: { type: 'boolean', description: 'false (default): dry-run; true: delegate to the official manager with an approvalToken.' },
        approvalToken: { type: 'string', description: 'Token from dshpd_approve with mount in its operation set.' },
        label: { type: 'string', description: 'Optional display name for the row.' },
      },
      [],
      async (args, exec) => {
        let packageName = nonEmpty(args.packageName)
        if (packageName === null && nonEmpty(args.pluginPath) !== null) {
          try {
            const raw = await readTargetText(requireFs(exec), join(args.pluginPath, 'package.json'))
            if (raw.exists) packageName = nonEmpty(JSON.parse(raw.text).name)
          } catch (error) {
            packageName = null
          }
        }
        if (packageName === null) return { ok: false, error: 'PACKAGE_NAME_UNKNOWN' }
        const validated = validatePackageName(packageName)
        if (!validated.ok) return { ok: false, error: 'INVALID_PACKAGE_NAME', detail: validated.reason }
        const plan = planMount({
          ctx,
          packageName,
          dshHome,
          profile: nonEmpty(args.profile),
          spec: nonEmpty(args.spec) || nonEmpty(args.pluginPath) || packageName,
        })
        if (args.apply !== true) {
          return {
            ok: true,
            applied: false,
            dryRun: true,
            packageName,
            plan,
            note: plan.applySupported
              ? 'dry run only; pass apply=true with an approvalToken to delegate to the official plugin manager'
              : 'dry run only: the official management service is unavailable, so this plugin will not write the profile itself',
          }
        }
        if (plan.applySupported !== true) {
          return { ok: false, error: 'DEPLOYMENT_ADAPTER_UNAVAILABLE', detail: plan.blocked, plan }
        }
        const authorized = await authorizeMutation({
          receipts,
          token: args.approvalToken,
          exec,
          service: requireFs(exec),
          operation: 'mount',
          filePaths: [],
          signal: exec.signal,
        })
        if (!authorized.ok) return { ok: false, error: authorized.error, detail: authorized.detail }
        if (authorized.receipt.targetProfile !== null && nonEmpty(args.profile) !== authorized.receipt.targetProfile) {
          return { ok: false, error: 'PROFILE_NOT_APPROVED', detail: { approved: authorized.receipt.targetProfile, received: args.profile } }
        }
        const result = await applyMount({
          ctx,
          packageName,
          dshHome,
          profile: nonEmpty(args.profile),
          spec: nonEmpty(args.spec) || nonEmpty(args.pluginPath) || packageName,
        })
        const stateDir = await ensurePluginState(canonicalPath(args.pluginPath || process.cwd()))
        await appendJournal(stateDir, {
          operationId: 'mount-' + randomUUID(),
          phase: result.applied ? 'commit' : 'abort',
          kind: 'deploy',
          pluginRoot: args.pluginPath || null,
          target: packageName,
          status: result.status,
          error: result.error || null,
        })
        return { ok: result.applied === true, ...result, packageName }
      })

    // =====================================================================
    // Verification / recovery / reporting
    // =====================================================================

    reg('dshpd_verify',
      'Layered verification. Snapshot integrity, applied-revision hashes, static blockers, entry/artifact presence, client bundle/export checks and (for intent=deployment) profile/client-graph/health evidence are evaluated separately. Any FAIL makes ok=false; missing evidence yields INCOMPLETE, never PASS. `ok` is true only for status PASS.',
      {
        pluginPath: { type: 'string', description: 'Plugin project directory.' },
        backupId: { type: 'string', description: 'Optional backupId; defaults to the latest snapshot in the state root.' },
        harnessVersion: { type: 'string', description: 'Optional SIMULATED DSH version.' },
        intent: { type: 'string', enum: ['local-modification', 'deployment'], description: 'local-modification (default) requires snapshot+static; deployment additionally requires profile/client-graph/health evidence.' },
        targetProfile: { type: 'string', description: 'Profile that deployment intent must verify.' },
      },
      ['pluginPath'],
      async (args, exec) => {
        const pluginRoot = canonicalPath(args.pluginPath)
        const stateDir = pluginStateDir(pluginRoot)
        const intent = args.intent === 'deployment' ? 'deployment' : 'local-modification'
        let backupId = nonEmpty(args.backupId)
        if (backupId === null) {
          const listed = await listSnapshotIds(stateDir)
          if (listed.length === 0) return { ok: false, status: 'INCOMPLETE', error: 'NO_SNAPSHOT', detail: 'no snapshot exists for this plugin; nothing can be verified against' }
          backupId = listed[0]
        }
        const found = await resolveBackup(pluginRoot, backupId)
        if (!found.ok) return { ok: false, status: 'FAIL', error: found.error, detail: found.detail }
        const backup = found.backup
        const checks = []
        const add = (layer, id, status, detail) => checks.push({ layer, id, status, detail })

        // snapshot layer
        const structural = backup.manifest
        add('snapshot', 'MANIFEST_SCHEMA', structural.schema === STATE_SCHEMA ? 'PASS' : 'FAIL', 'schema=' + String(structural.schema))
        const integrity = await verifySnapshotPayloads(stateDir, structural)
        add('snapshot', 'PAYLOAD_INTEGRITY', integrity.ok ? 'PASS' : 'FAIL', integrity.checks.filter((check) => check.status !== 'PASS'))
        const journal = await readJournal(stateDir, 2000)
        const lastApplied = new Map()
        for (const record of journal) {
          if (record && record.backupId === backupId && (record.kind === 'apply' || record.kind === 'write' || record.kind === 'migrate')
            && typeof record.filePath === 'string' && typeof record.afterHash === 'string') {
            lastApplied.set(pathKey(record.filePath), record.afterHash)
          }
        }
        const service = requireFs(exec)
        for (const record of structural.files) {
          const current = await readTargetText(service, record.path, exec.signal).catch(() => ({ exists: false, text: null }))
          if (record.exists === true && !current.exists) {
            add('snapshot', 'FILE_PRESENT:' + record.relative, 'FAIL', 'backed-up file is missing')
            continue
          }
          if (typeof current.text === 'string') {
            if (/^(<{7}|={7}|>{7})/m.test(current.text)) add('snapshot', 'CONFLICT_MARKERS:' + record.relative, 'FAIL', 'merge conflict markers found')
            const expected = lastApplied.get(pathKey(record.path))
            if (expected !== undefined && sha256Text(current.text) !== expected) {
              add('snapshot', 'APPLIED_HASH:' + record.relative, 'FAIL', 'the file no longer matches the last applied revision')
            } else {
              add('snapshot', 'APPLIED_HASH:' + record.relative, 'PASS', expected === undefined ? 'untouched since the snapshot' : 'matches the last applied revision')
            }
          } else if (record.exists === true) {
            add('snapshot', 'FILE_READABLE:' + record.relative, 'UNKNOWN', 'the file cannot be read through ctx.fs')
          }
        }

        // static layer
        const analyzed = await analyzePlugin(pluginRoot, args.harnessVersion, exec)
        const { model, result, coverage, incomplete } = analyzed
        add('static', 'SCAN_COMPLETE', incomplete ? 'FAIL' : 'PASS', coverage.incompleteReasons || [])
        add('static', 'PACKAGE_JSON_PARSE', model.pkg === null ? 'FAIL' : 'PASS', model.pkg === null ? 'package.json is not valid JSON' : 'package.json parses')
        add('static', 'HOST_ENTRY', result.official.host.entryPresent ? 'PASS' : (result.official.roles.length > 0 ? 'FAIL' : 'NOT_APPLICABLE'), String(result.official.host.entryTarget || 'no entry declared'))
        const before = isPlainObject(structural.analysis) ? structural.analysis : null
        const newBlockers = (before && Array.isArray(before.issueIds))
          ? result.issues.filter((issue) => (issue.severity === 'BLOCKER' || issue.severity === 'CRITICAL') && !before.issueIds.includes(issue.id + '@' + String(issue.file || '')))
          : result.issues.filter((issue) => issue.severity === 'BLOCKER' || issue.severity === 'CRITICAL')
        add('static', 'ANALYSIS_BLOCKERS', newBlockers.length > 0 ? 'FAIL' : 'PASS', newBlockers.slice(0, 20).map((issue) => issue.id + '@' + String(issue.file || '')))
        if (result.official.client.declared) {
          add('static', 'CLIENT_BUNDLE', model.clientBundleExists ? 'PASS' : 'FAIL', String(model.clientBundlePath))
          add('static', 'CLIENT_FORMAT', result.official.client.factoryForm ? 'PASS' : 'FAIL', 'factory-form=' + String(result.official.client.factoryForm))
          add('static', 'CLIENT_EXPORTS', result.official.client.applyPresent ? 'PASS' : 'FAIL', 'apply=' + String(result.official.client.applyPresent) + ' inject=' + String(result.official.client.injectPresent))
          add('hint', 'CLIENT_BUILD_FRESHNESS', 'UNKNOWN', 'mtime-only hint, not proof the bundle is current: ' + String(result.official.client.buildStale))
        }
        const designMetaRaw = await readTargetText(service, join(pluginRoot, '.dsh-plugin-design', 'design.meta.json'), exec.signal).catch(() => ({ exists: false, text: null }))
        let designMeta = null
        if (designMetaRaw.text) {
          try { designMeta = JSON.parse(designMetaRaw.text) } catch (error) { designMeta = null }
        }
        if (designMeta && isPlainObject(designMeta.ui) && designMeta.ui.expected === true) {
          add('static', 'UI_EXPECTED', result.official.client.declared ? 'PASS' : 'FAIL', result.official.client.declared ? 'design expects UI and the Client half exists' : 'design expects UI but no Client half is declared')
        }
        if (result.official.runtimeVerification.required) {
          add('static', 'RUNTIME_RISK', 'NOT_RUN', result.official.runtimeVerification.reasons)
        }

        // authorization layer
        const authorization = structural.authorization || null
        if (authorization === null) {
          add('authorization', 'APPROVAL_BASIS', 'UNKNOWN', 'the snapshot records no authorization basis')
        } else {
          add('authorization', 'APPROVAL_BASIS', 'PASS', {
            basis: authorization.basis, approvalOutcome: authorization.approvalOutcome,
            channel: authorization.channel, planHash: authorization.planHash,
          })
          add('authorization', 'PLAN_HASH_BOUND', typeof authorization.planHash === 'string' ? 'PASS' : 'FAIL', String(authorization.planHash))
          add('authorization', 'DESIGN_HASH_BOUND', typeof structural.design?.sha256 === 'string' ? 'PASS' : 'FAIL', String(structural.design?.sha256))
        }

        // deployment layer
        let deployment = null
        if (intent === 'deployment') {
          const name = isPlainObject(model.pkg) ? nonEmpty(model.pkg.name) : null
          deployment = name === null ? null : deploymentStates(name, { dshHome, profile: nonEmpty(args.targetProfile) })
          if (name === null) {
            add('deployment', 'PACKAGE_IDENTITY', 'FAIL', 'package name is unknown')
          } else if (nonEmpty(args.targetProfile) === null) {
            add('deployment', 'TARGET_PROFILE', 'UNKNOWN', 'deployment intent requires an explicit targetProfile')
          } else {
            const profile = deployment.profile
            add('deployment', 'PROFILE_EXISTS', profile === null ? 'FAIL' : 'PASS', String(args.targetProfile))
            add('deployment', 'PACKAGE_RESOLVABLE', profile && profile.packageResolvable ? 'PASS' : 'FAIL', profile ? profile.patchPath : null)
            add('deployment', 'PROFILE_SELECTED', profile && profile.selected ? 'PASS' : 'FAIL', profile ? profile.row : null)
            add('deployment', 'PROFILE_ENABLED', profile && profile.enabled ? 'PASS' : 'FAIL', profile ? profile.enabled : null)
          }
          const ui = name === null ? null : uiStatus(name)
          if (result.official.client.declared) {
            add('deployment', 'CLIENT_GRAPH', ui && ui.inGraph ? 'PASS' : 'FAIL',
              ui && ui.available === false
                ? ui.reason
                : 'inGraph=' + String(ui && ui.inGraph)
                  + (ui && ui.inGraph === false ? '; a changed Client declaration needs a full Host/Desktop restart (rc.3 metadata cache keeps negative results)' : ''))
            const healthStatus = healthFor(name)
            add('deployment', 'CLIENT_HEALTH', healthStatus.present === true && healthStatus.fresh === true && healthStatus.rendered === true ? 'PASS' : 'UNKNOWN',
              healthStatus.present === true ? healthStatus : 'no activation/render receipt from the loaded Client half')
          } else {
            add('deployment', 'CLIENT_GRAPH', 'NOT_APPLICABLE', 'no Client half declared')
            add('deployment', 'CLIENT_HEALTH', 'NOT_APPLICABLE', 'no Client half declared')
          }
        } else {
          add('deployment', 'SCOPE', 'NOT_APPLICABLE', 'intent=local-modification: profile/client-graph/health evidence is not required')
        }
        const verifiedPackageName = isPlainObject(model.pkg) ? nonEmpty(model.pkg.name) : null
        const validation = validationSummaryFor(verifiedPackageName)
        let runtimeGate = { status: 'NOT_RUN', detail: 'no isolated runtime smoke was recorded for this change; static preflight cannot prove process safety' }
        if (intent === 'deployment' && validation !== null) {
          if (validation.verified === true && validation.mode === 'dsh-host') {
            runtimeGate = { status: 'PASS', detail: { mode: 'dsh-host', evidencePath: validation.evidencePath || null } }
          } else if (validation.verified === true) {
            runtimeGate = {
              status: 'UNKNOWN',
              detail: 'only package-load evidence exists; a real DSH host run is still required for deployment intent',
            }
          } else {
            runtimeGate = { status: 'FAIL', detail: validation.gates || validation }
          }
        }
        add('runtime', 'RUNTIME_SMOKE', runtimeGate.status, runtimeGate.detail)

        const requiredLayers = intent === 'deployment'
          ? ['snapshot', 'static', 'authorization', 'deployment', 'runtime']
          : ['snapshot', 'static', 'authorization']
        const status = statusOfChecks(checks, requiredLayers)
        const ok = status === 'PASS'
        let journalWarning = null
        try {
          await appendJournal(stateDir, {
            operationId: 'verify-' + randomUUID(),
            phase: 'commit',
            kind: 'verify',
            backupId,
            pluginRoot,
            ok,
            status,
            intent,
            checks: checks.map((check) => ({ layer: check.layer, id: check.id, status: check.status })),
          })
        } catch (error) {
          journalWarning = messageOf(error)
        }
        return {
          ok,
          status,
          intent,
          verifiedScope: intent === 'deployment' ? 'deployment' : 'local-modification',
          pluginPath: pluginRoot,
          backupId,
          checks,
          gates: Object.fromEntries(requiredLayers.map((layer) => [layer, statusOfChecks(checks, [layer])])),
          analysis: analysisSummary(result),
          official: result.official,
          deployment,
          designMeta,
          runtime: analyzed.runtime.running,
          journalWarning,
          claims: {
            compile: 'NOT_A_CLAIM',
            runtimeSafe: 'NOT_PROVEN',
            independentDistribution: 'NOT_VALIDATED',
          },
        }
      })

    reg('dshpd_rollback',
      'Restore a recorded snapshot after verifying every payload hash. Files that changed after the last applied revision are reported as conflicts and left untouched (their content is preserved). Returns ROLLED_BACK only when every required file was written and re-hashed; otherwise ROLLBACK_PARTIAL / ROLLBACK_CONFLICT. Requires confirmBackupId as an explicit confirmation and works without the Host process for offline recovery.',
      {
        backupId: { type: 'string', description: 'backupId from dshpd_backup.' },
        pluginPath: { type: 'string', description: 'Plugin root (required when the task is no longer in memory).' },
        confirmBackupId: { type: 'string', description: 'Must equal backupId: explicit confirmation of the snapshot being restored.' },
      },
      ['backupId', 'confirmBackupId'],
      async (args, exec) => {
        if (args.confirmBackupId !== args.backupId) {
          return { ok: false, error: 'CONFIRMATION_MISMATCH', detail: 'confirmBackupId must equal backupId' }
        }
        const pluginRoot = nonEmpty(args.pluginPath) ? canonicalPath(args.pluginPath) : (backups.get(args.backupId)?.pluginRoot || null)
        if (pluginRoot === null) return { ok: false, error: 'PLUGIN_PATH_REQUIRED' }
        const found = await resolveBackup(pluginRoot, args.backupId)
        if (!found.ok) return { ok: false, status: 'ROLLBACK_ABORTED', error: found.error, detail: found.detail }
        const backup = found.backup
        const integrity = await verifySnapshotPayloads(backup.stateDir, backup.manifest)
        if (!integrity.ok) {
          return {
            ok: false,
            status: 'ROLLBACK_ABORTED',
            error: 'SNAPSHOT_INTEGRITY_FAILED',
            detail: 'no file was written because the snapshot payload does not match its manifest',
            integrity,
          }
        }
        const journal = await readJournal(backup.stateDir, 5000)
        const lastAppliedHashes = new Map()
        for (const record of journal) {
          if (record && record.backupId === args.backupId && (record.kind === 'apply' || record.kind === 'write' || record.kind === 'migrate')
            && typeof record.filePath === 'string' && typeof record.afterHash === 'string') {
            lastAppliedHashes.set(pathKey(record.filePath), record.afterHash)
          }
        }
        const service = requireFs(exec)
        const preview = await previewRestore({
          service,
          manifest: backup.manifest,
          stateDir: backup.stateDir,
          lastAppliedHashes,
          signal: exec.signal,
        })
        const operationId = 'rollback-' + randomUUID()
        await appendJournal(backup.stateDir, {
          operationId, phase: 'prepare', kind: 'rollback', backupId: args.backupId, pluginRoot,
          planned: preview.checks.map((check) => ({ path: check.path, action: check.action })),
        })
        const result = await restoreSnapshot({
          service,
          manifest: backup.manifest,
          stateDir: backup.stateDir,
          preview,
          policy: policyFor(exec),
          signal: exec.signal,
        })
        await appendJournal(backup.stateDir, {
          operationId,
          phase: 'rollback',
          kind: 'rollback',
          backupId: args.backupId,
          pluginRoot,
          result: result.state,
          restored: result.files.map((file) => file.path),
          conflicts: result.conflicts.map((conflict) => conflict.path),
          errors: result.failures,
        })
        return {
          ok: result.state === 'ROLLED_BACK',
          status: result.state,
          backupId: args.backupId,
          restored: result.files,
          conflicts: result.conflicts,
          failures: result.failures,
          preview: preview.checks,
          note: result.state === 'ROLLED_BACK'
            ? 'every required file was restored and re-hashed'
            : 'the restore did not fully succeed; review conflicts and failures before retrying',
        }
      })

    reg('dshpd_status',
      'Read task state: in-memory approvals/backups, durable operations with RECOVERY_REQUIRED detection, snapshots in the state root, client health receipts, and untrusted legacy .dsh-plugin-design state. Read-only.',
      {
        approvalToken: { type: 'string', description: 'Optional approval token.' },
        pluginPath: { type: 'string', description: 'Optional plugin root for durable state.' },
        journalLimit: { type: 'integer', description: 'Max journal records (default 50).' },
      },
      [],
      async (args, exec) => {
        const base = {
          stateRoot,
          dshHome,
          runtime: planRuntime(exec),
          services: {
            pluginManager: detectDeploymentAdapter(ctx),
            approval: Boolean(ctx && typeof ctx.get === 'function' && ctx.get('approval')),
          },
        }
        if (nonEmpty(args.approvalToken) !== null) {
          const receipt = receipts.get(String(args.approvalToken))
          if (!receipt) return { ok: false, ...base, error: 'APPROVAL_UNKNOWN' }
          return {
            ok: true,
            ...base,
            approval: {
              planHash: receipt.planHash,
              pluginRoot: receipt.pluginRoot,
              operations: receipt.operations,
              files: receipt.files.length,
              basis: receipt.basis,
              expiresAt: receipt.expiresAt,
              mutations: receipt.mutations + '/' + receipt.maxMutations,
              agentId: receipt.agentId,
              sessionId: receipt.sessionId,
            },
          }
        }
        if (nonEmpty(args.pluginPath) !== null) {
          const pluginRoot = canonicalPath(args.pluginPath)
          const stateDir = pluginStateDir(pluginRoot)
          const limit = args.journalLimit === undefined ? 50 : Math.max(1, Math.min(500, Number(args.journalLimit) || 50))
          const journal = await readJournal(stateDir, limit)
          const pending = recoveryRequired(await readJournal(stateDir, 5000))
          const snapshots = await listSnapshotIds(stateDir)
          const legacyDir = join(pluginRoot, '.dsh-plugin-design')
          const legacy = existsSync(legacyDir)
            ? { present: true, path: legacyDir, trusted: false, note: 'legacy in-plugin state is read-only import material; it is never auto-restored' }
            : { present: false }
          return {
            ok: pending.length === 0,
            ...base,
            pluginPath: pluginRoot,
            stateDir,
            snapshots,
            journal,
            operations: [...operationStates(journal).values()].map((operation) => ({
              operationId: operation.operationId, kind: operation.kind, state: operation.state, backupId: operation.backupId, startedAt: operation.startedAt,
            })),
            recoveryRequired: pending.map((operation) => ({ operationId: operation.operationId, kind: operation.kind, backupId: operation.backupId })),
            health: [...health.values()],
            legacy,
          }
        }
        return {
          ok: true,
          ...base,
          approvals: [...receipts.values()].map((receipt) => ({
            planHash: receipt.planHash, pluginRoot: receipt.pluginRoot, expiresAt: receipt.expiresAt,
            mutations: receipt.mutations + '/' + receipt.maxMutations, basis: receipt.basis,
          })),
          backups: [...backups.values()].map((backup) => ({
            backupId: backup.backupId, pluginRoot: backup.pluginRoot, files: backup.manifest.files.length,
            createdAt: backup.manifest.createdAt,
          })),
          note: 'pass pluginPath to read durable snapshots/journal from earlier processes',
        }
      },
      { concurrencySafe: true })

    reg('dshpd_report',
      'Produce a report for one backupId: exact plan/design hashes, backed-up files, journal edits, latest verification, analysis before/after, distribution status, and remaining risks. Separates local modification, independent-distribution validation and publication state.',
      {
        backupId: { type: 'string', description: 'backupId from dshpd_backup.' },
        pluginPath: { type: 'string', description: 'Plugin root (required when no in-memory task exists).' },
      },
      ['backupId'],
      async (args, exec) => {
        const pluginRoot = nonEmpty(args.pluginPath) ? canonicalPath(args.pluginPath) : (backups.get(args.backupId)?.pluginRoot || null)
        if (pluginRoot === null) return { ok: false, error: 'PLUGIN_PATH_REQUIRED' }
        const found = await resolveBackup(pluginRoot, args.backupId)
        if (!found.ok) return { ok: false, error: found.error, detail: found.detail }
        const backup = found.backup
        const journal = await readJournal(backup.stateDir, 5000)
        const entries = journal.filter((entry) => entry && entry.backupId === args.backupId)
        const verification = entries.filter((entry) => entry.kind === 'verify').slice(-1)[0] || null
        const current = await analyzePlugin(pluginRoot, null, exec).then((value) => analysisSummary(value.result)).catch((error) => ({ error: messageOf(error) }))
        const distributionReportPath = join(backup.stateDir, 'distribution-report.json')
        let distribution = null
        if (existsSync(distributionReportPath)) {
          try {
            const report = JSON.parse(readFileSync(distributionReportPath, 'utf8'))
            distribution = {
              releaseDir: report.artifacts?.releaseDir || null,
              tgzSha256: report.artifacts?.tgzSha256 || null,
              gates: report.gates || null,
              status: report.status || null,
            }
          } catch (error) {
            distribution = { error: messageOf(error) }
          }
        }
        return {
          ok: true,
          backupId: args.backupId,
          pluginPath: pluginRoot,
          plan: backup.receipt ? { planHash: backup.receipt.planHash, operations: backup.receipt.operations } : null,
          design: backup.manifest.design,
          authorization: backup.manifest.authorization,
          createdAt: backup.manifest.createdAt,
          files: backup.manifest.files.map((file) => ({ path: file.path, exists: file.exists, bytes: file.bytes, sha256: file.sha256 })),
          analysisBefore: backup.manifest.analysis,
          analysisAfter: current,
          edits: entries.filter((entry) => ['apply', 'write', 'migrate'].includes(entry.kind)),
          verification: verification === null ? null : { ok: verification.ok, status: verification.status, checks: verification.checks, time: verification.time },
          localModification: verification ? verification.status : 'UNVERIFIED',
          distribution,
          status: {
            localModification: verification ? verification.status : 'UNVERIFIED',
            distributionValidated: distribution !== null && Boolean(distribution.status && distribution.status.distributionValidated),
            releasePrepared: distribution !== null && Boolean(distribution.status && distribution.status.releasePrepared),
            published: distribution !== null && Boolean(distribution.status && distribution.status.published),
          },
          remainingRisks: [
            'static preflight is not proof of runtime safety; synchronous loops/OOM/process.exit require an isolated run',
            'approval receipts are process-local; durable snapshots and journal are not',
            'distribution validation requires a clean-environment install of the exact artifact',
          ],
          note: 'DH-TP-SDK certification levels are engineering levels, not DeepSeek official certification.',
        }
      },
      { concurrencySafe: true })

    // =====================================================================
    // Distribution
    // =====================================================================

    reg('dshpd_distribute',
      'Audit and/or export a distributable package for a target plugin: package completeness (entries/chunks/assets/worker), portability (no author paths/links/local services), dependency closure, maintenance-private data, public install docs, deterministic .tgz, SHA-256, file list and support matrix. mode=export writes a release directory outside the plugin tree; it never uploads anything.',
      {
        pluginPath: { type: 'string', description: 'Target plugin root.' },
        mode: { type: 'string', enum: ['audit', 'export'], description: 'audit (read-only) or export (write a release directory).' },
        outputDir: { type: 'string', description: 'Export root outside the plugin tree (required for mode=export).' },
        targetProfile: { type: 'string', description: 'Optional profile this release is prepared for.' },
        supportMatrix: { type: 'array', items: { type: 'object' }, description: 'Optional support-matrix rows (dsh/carrier/os/status/evidence).' },
        buildCommand: { type: 'string', description: 'Optional build command used to produce the committed artifacts (documented, not executed).' },
      },
      ['pluginPath'],
      async (args, exec) => {
        const pluginRoot = canonicalPath(args.pluginPath)
        const audit = await auditPackageDirectory(pluginRoot, {})
        const classification = classifyTarget(audit.model, analyzeModel(audit.model))
        const hostClientNecessity = classification.halves
        const stateDir = await ensurePluginState(pluginRoot)
        if (args.mode !== 'export') {
          return {
            ok: audit.ok,
            mode: 'audit',
            pluginPath: pluginRoot,
            package: audit.package,
            gates: audit.gates,
            findings: audit.findings,
            hostClientNecessity,
            coverage: audit.coverage,
            status: { localModification: 'UNKNOWN', distributionValidated: false, releasePrepared: false, published: false },
            next: 'fix FAIL gates, then mode=export with an outputDir outside the plugin tree',
          }
        }
        const outputDir = nonEmpty(args.outputDir)
        if (outputDir === null) return { ok: false, error: 'OUTPUT_DIR_REQUIRED' }
        const exported = await exportDistribution({
          pluginPath: pluginRoot,
          outputDir,
          supportMatrix: Array.isArray(args.supportMatrix) ? args.supportMatrix : undefined,
          runtime: planRuntime(exec),
          hostClientNecessity,
          toolVersion,
          ruleset: RULESET.version,
          buildCommand: nonEmpty(args.buildCommand),
          localModification: 'UNVERIFIED',
        })
        if (!exported.ok) return { ok: false, error: exported.error, detail: exported.detail, audit: exported.audit }
        const verified = await verifyRelease(exported.releaseDir)
        try {
          writeFileSync(join(stateDir, 'distribution-report.json'), JSON.stringify({ ...exported.report, releaseVerified: verified }, null, 2) + '\n', 'utf8')
        } catch (error) {
          // state copy is advisory
        }
        return {
          ok: exported.ok && verified.ok,
          mode: 'export',
          pluginPath: pluginRoot,
          releaseDir: exported.releaseDir,
          artifacts: exported.report.artifacts,
          gates: exported.report.gates,
          supportMatrix: exported.report.supportMatrix,
          hostClientNecessity,
          releaseVerified: verified,
          status: exported.report.status,
          note: 'materials are prepared locally; publish only with explicit authorization and then re-verify the uploaded artifact',
        }
      })

    reg('dshpd_validate',
      'Run the exact delivered .tgz in an isolated environment. mode=package-load extracts the archive into a throwaway consumer tree that cannot resolve the author source or dsh-plugin-design, imports/applies the Host half, calls a representative tool and loads the Client factory/component in a VM. mode=dsh-host installs into a fresh DSH_HOME through an explicit CLI command, boots a real host, probes it and uninstalls. Missing prerequisites return NOT_RUN.',
      {
        tgzPath: { type: 'string', description: 'Exact .tgz to validate.' },
        mode: { type: 'string', enum: ['package-load', 'dsh-host'], description: 'package-load (default) or dsh-host.' },
        expectedName: { type: 'string', description: 'Expected package name.' },
        expectedVersion: { type: 'string', description: 'Expected package version.' },
        toolName: { type: 'string', description: 'Representative tool to call in package-load mode.' },
        toolArgs: { type: 'object', description: 'Arguments for that tool.', additionalProperties: true },
        cliCommand: { type: 'array', items: { type: 'string' }, description: 'Explicit DSH CLI argv for dsh-host mode (never guessed).' },
        probePath: { type: 'string', description: 'HTTP path to probe after boot in dsh-host mode.' },
        timeoutMs: { type: 'integer', description: 'Deadline per step (default 60s package-load / 300s dsh-host).' },
      },
      ['tgzPath'],
      async (args, exec) => {
        const mode = args.mode === 'dsh-host' ? 'dsh-host' : 'package-load'
        const evidence = mode === 'dsh-host'
          ? await runDshHost({
            tgzPath: args.tgzPath,
            expectedName: args.expectedName,
            stateDir: stateRoot,
            cliCommand: Array.isArray(args.cliCommand) ? args.cliCommand : null,
            probePath: nonEmpty(args.probePath),
            timeoutMs: Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : undefined,
          })
          : await runPackageLoad({
            tgzPath: args.tgzPath,
            expectedName: args.expectedName,
            expectedVersion: args.expectedVersion,
            stateDir: stateRoot,
            toolName: nonEmpty(args.toolName),
            toolArgs: isPlainObject(args.toolArgs) ? args.toolArgs : {},
            timeoutMs: Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : undefined,
          })
        const gates = evidence.gates || {}
        const requiredGates = mode === 'dsh-host'
          ? ['cleanInstall', 'distributionLifecycle']
          : ['packageCompleteness', 'independentRuntime', 'cleanInstall', 'portability']
        const ok = requiredGates.every((key) => gates[key] && gates[key].status === 'PASS')
          && Object.values(gates).every((gate) => gate.status !== 'FAIL')
        const summary = {
          schema: 1,
          mode,
          status: evidence.status || (ok ? 'PASS' : 'FAIL'),
          verified: ok,
          gates,
          artifact: { path: args.tgzPath, expectedName: args.expectedName || null, expectedVersion: args.expectedVersion || null },
          evidencePath: evidence.evidencePath || null,
          finishedAt: new Date().toISOString(),
          limitations: evidence.limitations || [],
        }
        const packageName = nonEmpty(args.expectedName) || (evidence.package && evidence.package.name) || null
        if (packageName !== null) {
          try {
            const dir = join(stateRoot, 'validation')
            mkdirSync(dir, { recursive: true })
            writeFileSync(join(dir, packageName.replace(/[^A-Za-z0-9._@-]/g, '_') + '.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
          } catch (error) {
            // summary persistence is advisory
          }
        }
        return {
          ok,
          mode,
          status: summary.status,
          gates,
          requiredGates,
          evidencePath: evidence.evidencePath || null,
          evidence,
          limitations: summary.limitations,
          note: mode === 'package-load'
            ? 'package-level evidence only: the result does not prove a real DSH Host/renderer run'
            : 'real host evidence; review steps and logs before claiming distribution support',
        }
      })

    // =====================================================================
    // Settings-page routes (read-only + client health receipt)
    // =====================================================================

    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer
      if (!webServer || typeof webServer.register !== 'function') return

      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-plugin-design/info',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'GET only' })
          const runtime = runtimeFingerprint({ ctx })
          sendJson(res, 200, {
            ok: true,
            name: PLUGIN.name,
            version: PLUGIN.version,
            ruleset: RULESET,
            tools: TOOL_NAMES,
            compatibility: PLUGIN.engines,
            runtime: { running: runtime.running, effectiveVersion: runtime.effectiveVersion, capabilities: await runtime.capabilities() },
            stateRoot,
            deploymentAdapter: detectDeploymentAdapter(ctx),
          })
        },
      }))

      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-plugin-design/discover',
        handler: async (req, res) => {
          try {
            const parsed = await readRequestInput(req)
            const root = nonEmpty(parsed.root)
            if (root === null) return sendJson(res, 400, { ok: false, error: 'root path required', plugins: [], count: 0 })
            const depth = parsed.maxDepth === undefined ? 5 : Math.max(0, Math.min(12, Number(parsed.maxDepth) || 0))
            const message = await scan.request('discover', {
              rootPath: root, maxResults: 500, budget: { maxDepth: depth, deadlineMs: 30_000 },
            }, {})
            const coverage = message.coverage || {}
            sendJson(res, 200, {
              ok: coverage.incomplete !== true,
              root: message.root,
              count: (message.results || []).length,
              plugins: message.results || [],
              coverage,
              scan: { status: coverage.incomplete === true ? 'INCOMPLETE' : 'COMPLETE' },
            })
          } catch (error) {
            sendJson(res, 503, { ok: false, error: messageOf(error), code: error && error.code, plugins: [], count: 0, scan: { status: 'INCOMPLETE' } })
          }
        },
      }))

      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-plugin-design/analyze',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
          try {
            const parsed = await readRequestInput(req)
            const pluginPath = nonEmpty(parsed.pluginPath)
            if (pluginPath === null) return sendJson(res, 400, { ok: false, error: 'pluginPath required' })
            const harnessVersion = nonEmpty(parsed.harnessVersion)
            const analyzed = await analyzePlugin(pluginPath, harnessVersion, null)
            const pkg = isPlainObject(analyzed.model.pkg) ? analyzed.model.pkg : null
            sendJson(res, 200, {
              ok: !analyzed.incomplete,
              pluginPath: analyzed.model.pluginPath,
              ui: pkg && typeof pkg.name === 'string' ? uiStatus(pkg.name) : null,
              deployment: pkg && typeof pkg.name === 'string' ? deploymentFor(pkg.name) : null,
              ruleset: RULESET,
              runtime: { running: analyzed.runtime.running, effectiveVersion: analyzed.runtime.effectiveVersion },
              official: analyzed.result.official,
              issueCount: analyzed.result.issues.length,
              counts: countBySeverity(analyzed.result.issues),
              scores: analyzed.result.scores,
              overall: analyzed.result.overall,
              scan: { status: analyzed.incomplete ? 'INCOMPLETE' : 'COMPLETE', coverage: analyzed.coverage },
              issues: analyzed.result.issues.slice(0, 200),
              issuesTruncated: analyzed.result.issues.length > 200,
              migrations: analyzed.result.migrations,
            })
          } catch (error) {
            sendJson(res, 503, { ok: false, error: messageOf(error), code: error && error.code, scan: { status: 'INCOMPLETE' } })
          }
        },
      }))

      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-plugin-design/client-health',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
          try {
            const parsed = await readRequestInput(req)
            const packageName = nonEmpty(parsed.packageName)
            if (packageName === null) return sendJson(res, 400, { ok: false, error: 'packageName required' })
            const entry = {
              packageName,
              version: nonEmpty(parsed.version),
              buildRev: nonEmpty(parsed.buildRev),
              activated: parsed.activated === true,
              rendered: parsed.rendered === true,
              error: nonEmpty(parsed.error),
              receivedAt: new Date().toISOString(),
            }
            recordHealth(entry)
            sendJson(res, 200, { ok: true, recorded: true })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: messageOf(error) })
          }
        },
      }))

      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-plugin-design/health',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'GET only' })
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const packageName = nonEmpty(url.searchParams.get('packageName'))
          sendJson(res, 200, {
            ok: true,
            health: packageName === null ? [...health.values()] : healthFor(packageName),
          })
        },
      }))
    })

    // Stop our own worker/queue when the plugin unloads.
    ctx.effect(() => () => {
      scan.dispose().catch(() => {})
    })

    async function listSnapshotIds(stateDir) {
      const { promises: fsp } = await import('node:fs')
      try {
        const entries = await fsp.readdir(join(stateDir, 'backup'), { withFileTypes: true })
        const ids = entries.filter((entry) => entry.isDirectory() && isSafeBackupId(entry.name)).map((entry) => entry.name)
        const withTimes = []
        for (const id of ids) {
          const loaded = await loadSnapshot(stateDir, id)
          withTimes.push({ id, createdAt: loaded.ok ? loaded.manifest.createdAt : '' })
        }
        return withTimes.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).map((item) => item.id)
      } catch (error) {
        return []
      }
    }
  },
}

/** Manifest-only migrations; never widens a compatibility range silently. */
function applyManifestMigration(pkg, migrationId, options, pluginPath) {
  if (!isPlainObject(pkg.dsh)) pkg.dsh = {}
  const dsh = pkg.dsh
  if (migrationId === 'manifest-version') {
    if (dsh.manifestVersion === 1) return { changed: false, detail: 'already 1' }
    dsh.manifestVersion = 1
    return { changed: true, detail: 'dsh.manifestVersion = 1' }
  }
  if (migrationId === 'engines-dsh') {
    const candidate = nonEmpty(options.dshRange)
    if (candidate === null) {
      return { changed: false, detail: 'engines-dsh requires an explicit options.dshRange; this tool never invents or widens a supported range' }
    }
    if (/^workspace:/.test(candidate) || !isValidRange(candidate)) {
      return { changed: false, detail: 'refusing invalid SemVer range: ' + candidate }
    }
    if (!isPlainObject(pkg.engines)) pkg.engines = {}
    if (pkg.engines.dsh === candidate) return { changed: false, detail: 'already ' + candidate }
    pkg.engines.dsh = candidate
    return { changed: true, detail: 'engines.dsh = ' + candidate + ' (declared only; not a tested-compatibility claim)' }
  }
  if (migrationId === 'bundle-patch') {
    if (isPlainObject(dsh.bundle) && (typeof dsh.bundle.patch === 'string' || Array.isArray(dsh.bundle.patch))) {
      return { changed: false, detail: 'dsh.bundle.patch already declared' }
    }
    let hasPatch = false
    try { hasPatch = existsSync(join(pluginPath, 'cordis.patch.yml')) } catch (error) { hasPatch = false }
    if (!hasPatch) return { changed: false, detail: 'no cordis.patch.yml at the package root' }
    dsh.bundle = { ...(isPlainObject(dsh.bundle) ? dsh.bundle : {}), patch: './cordis.patch.yml' }
    return { changed: true, detail: 'dsh.bundle.patch = ./cordis.patch.yml' }
  }
  if (migrationId === 'client-meta') {
    let hasBundle = false
    try { hasBundle = existsSync(join(pluginPath, 'lib', 'client.js')) } catch (error) { hasBundle = false }
    if (!hasBundle) return { changed: false, detail: 'no lib/client.js build artifact' }
    dsh.client = { ...(isPlainObject(dsh.client) ? dsh.client : {}), platform: 'web' }
    if (!isPlainObject(pkg.exports)) pkg.exports = {}
    if (pkg.exports['./client'] === undefined) pkg.exports['./client'] = './lib/client.js'
    if (pkg.exports['./package.json'] === undefined) pkg.exports['./package.json'] = './package.json'
    return { changed: true, detail: 'dsh.client.platform = web; exports["./client"] and ["./package.json"] ensured' }
  }
  if (migrationId === 'remove-invariants-dep') {
    let changed = false
    const detail = []
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (isPlainObject(pkg[section]) && Object.hasOwn(pkg[section], '@deepseek-ai/dsh-invariants')) {
        delete pkg[section]['@deepseek-ai/dsh-invariants']
        changed = true
        detail.push(section)
      }
    }
    return { changed, detail: changed ? 'removed from ' + detail.join(', ') : 'dependency not present' }
  }
  return { changed: false, detail: 'unknown migration' }
}

async function readRequestInput(req) {
  if (req.method === 'GET') {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    return Object.fromEntries(url.searchParams.entries())
  }
  let body = ''
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new Error('request body too large')
    body += chunk
  }
  if (body.trim() === '') return {}
  const parsed = JSON.parse(body)
  return isPlainObject(parsed) ? parsed : {}
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}
