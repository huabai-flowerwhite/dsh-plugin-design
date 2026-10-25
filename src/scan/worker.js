// dsh-plugin-design — scan worker entry.
//
// One worker handles exactly one request and exits. The Host terminates the
// worker on timeout/cancel, so no partially-yielding task can keep the event
// loop busy. `resourceLimits` bounds the V8 heap (an OS RSS cap is not
// available from Node; that limitation is reported).

import { parentPort } from 'node:worker_threads'

import { analyzeModel } from '../rules.js'
import { collectPluginModel, discoverPluginProjects } from './collector.js'

/** Facts the Host needs; file contents never cross the thread boundary. */
function summarizeModel(model) {
  const relativeFiles = Array.isArray(model.relativeFiles) ? model.relativeFiles : []
  return {
    pluginPath: model.pluginPath,
    pkg: model.pkg,
    pkgError: model.pkgError,
    manifestRaw: typeof model.manifestRaw === 'string' ? model.manifestRaw.slice(0, 64 * 1024) : null,
    cordisPatchRaw: typeof model.cordisPatchRaw === 'string' ? model.cordisPatchRaw.slice(0, 64 * 1024) : null,
    bundlePatches: (model.bundlePatches || []).map((entry) => ({
      path: entry.path,
      unsafe: entry.unsafe === true,
      exists: entry.exists === true,
      bytes: typeof entry.raw === 'string' ? entry.raw.length : 0,
    })),
    hostEntry: model.hostEntry === null || model.hostEntry === undefined ? null : {
      path: model.hostEntry.path || null,
      present: typeof model.hostEntry.text === 'string',
      missing: model.hostEntry.missing === true,
    },
    clientEntry: model.clientEntry === null || model.clientEntry === undefined ? null : {
      path: model.clientEntry.path || null,
      present: typeof model.clientEntry.text === 'string',
      missing: model.clientEntry.missing === true,
    },
    clientBundlePath: model.clientBundlePath,
    clientBundleExists: model.clientBundleExists === true,
    defaultClientBundlePath: model.defaultClientBundlePath,
    defaultClientBundleExists: model.defaultClientBundleExists === true,
    clientSourceFiles: (model.clientSourceFiles || []).map((file) => ({ path: file.path, relative: file.relative })),
    toolNames: model.toolNames || [],
    hasConfig: model.hasConfig === true,
    iconExists: model.iconExists,
    iconBytes: model.iconBytes,
    iconExt: model.iconExt,
    iconRelative: model.iconRelative,
    hasTests: model.hasTests === true,
    hasReadme: model.hasReadme === true,
    hasLicense: model.hasLicense === true,
    lockfiles: model.lockfiles || [],
    nodeModulesPresent: model.nodeModulesPresent === true,
    topLevel: (model.topLevel || []).slice(0, 200),
    sourceFiles: (model.sourceFiles || []).map((file) => ({ path: file.path, relative: file.relative, kind: file.kind })),
    relativeFiles: relativeFiles.slice(0, 5000),
    relativeFilesTruncated: relativeFiles.length > 5000,
    harnessVersion: model.harnessVersion,
    coverage: model.coverage,
  }
}

parentPort.on('message', async (message) => {
  const { id, kind, args } = message || {}
  try {
    if (kind === 'analyze') {
      const { model, coverage } = await collectPluginModel(args.pluginPath, {
        harnessVersion: args.harnessVersion,
        budget: args.budget,
      })
      const result = analyzeModel(model)
      parentPort.postMessage({ id, ok: true, kind, summary: summarizeModel(model), coverage, result })
      return
    }
    if (kind === 'collect') {
      const { model, coverage } = await collectPluginModel(args.pluginPath, {
        harnessVersion: args.harnessVersion,
        budget: args.budget,
      })
      parentPort.postMessage({ id, ok: true, kind, summary: summarizeModel(model), coverage })
      return
    }
    if (kind === 'discover') {
      const discovered = await discoverPluginProjects(args.rootPath, {
        budget: args.budget,
        maxResults: args.maxResults,
      })
      parentPort.postMessage({ id, ok: true, kind, root: discovered.root, results: discovered.results, coverage: discovered.coverage })
      return
    }
    parentPort.postMessage({ id, ok: false, error: 'UNKNOWN_SCAN_KIND:' + String(kind) })
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error && typeof error.message === 'string' ? error.message : String(error),
      code: error && typeof error.code === 'string' ? error.code : null,
    })
  }
})
