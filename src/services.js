// Client-plane service catalog used by the heuristic ruleset.
//
// This list is not a protocol; it is a snapshot of the services the official
// 0.2.1 client packages actually consume or provide. Keep the provenance note
// in docs/service-catalog-0.2.1.md when updating it.
//
// The important distinction this file captures:
//   - `workspaces` is a real controller service (list/create/rename/delete).
//   - `uiWorkspace` is the UI service that exposes `pickDirectory()`.
// Passing `workspaces` where a picker is expected is valid syntax but a
// runtime no-op, so it needs a method-level rule, not an "unknown service" rule.

export const CLIENT_SERVICE_CATALOG = new Set([
  // core client services
  'slots', 'sessions', 'workspaces', 'uiWorkspace', 'uiSession', 'uiConversation',
  'conversation', 'locale', 'theme', 'settingsSchema', 'configForms',
  'clientModules', 'connection', 'commandUi', 'inputTriggers', 'modelDirectories',
  'shortcuts', 'fileUpload', 'fileUploads', 'attachments', 'chatFileMentions',
  'sidebarRightTabs', 'userQuestionPanels', 'webServer', 'directoryPicker',
  'workingDirectory', 'timer', 'pluginRegistryProbe', 'cotTranslation',
  'remoteAccess', 'jobs', 'webTerminals', 'workspaceRegistry', 'productAnalytics',
  'layout', 'remote',
])

/** Services that no longer exist in the 0.2.x client plane. */
export const LEGACY_CLIENT_SERVICES = new Map([
  ['styles', {
    replacement: null,
    reason: '0.2.x 客户端没有 styles 服务；样式由插件自己创建 <style> 或使用内联 style。',
  }],
])

/**
 * Framework services that are available when `apply` runs. Looking these up
 * once at apply time is normal; looking up a plugin-provided service there is
 * the eager-lookup hazard.
 */
export const FRAMEWORK_SERVICES = new Set([
  'slots', 'loader', 'logger', 'effect', 'on', 'inject',
  'parallel', 'serial', 'waterfall', 'bail', 'emit',
  'ctx', 'scope', 'root', 'plugin',
])

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Find the matching close brace, skipping strings and comments. */
function matchingBrace(text, openIndex) {
  let depth = 0
  let quote = null
  let lineComment = false
  let blockComment = false
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1 }
      continue
    }
    if (quote !== null) {
      if (char === '\\') { index += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Approximate function ranges; used only to avoid flagging lazy helpers. */
function functionRanges(text) {
  const ranges = []
  const patterns = [
    /\bfunction\b(?:\s+([A-Za-z_$][\w$]*))?\s*\([^)]*\)\s*\{/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>\s*\{/g,
    /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const open = match.index + match[0].lastIndexOf('{')
      const close = matchingBrace(text, open)
      if (close > open) ranges.push({ name: match[1] || null, open, close })
    }
  }
  return ranges
}

function enclosingFunction(text, index) {
  let best = null
  for (const range of functionRanges(text)) {
    if (range.open < index && index < range.close && (best === null || range.open > best.open)) best = range
  }
  return best
}

/**
 * Detect `const x = ctx.get('service')` followed by a cached capability check
 * (`x && typeof x.method ...` or `x || null`). This is the "apply-time lookup
 * freezes undefined to null" hazard.
 *
 * Scope is approximate: top-level and `apply(...)` are eager; other function
 * bodies are treated as lazy helpers and skipped.
 */
export function findEagerServiceLookups(text) {
  if (typeof text !== 'string') return []
  const hits = []
  const seen = new Set()
  const assignment = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*ctx\s*\.\s*get\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of text.matchAll(assignment)) {
    const variable = match[1]
    const service = match[2]
    if (FRAMEWORK_SERVICES.has(service)) continue
    const scope = enclosingFunction(text, match.index)
    if (scope !== null && scope.name !== 'apply') continue
    const after = text.slice(match.index, match.index + 400)
    const escaped = escapeRegExp(variable)
    const cached = new RegExp('\\b' + escaped + '\\s*&&\\s*typeof\\s+' + escaped + '\\s*\\.'
      + '|\\b' + escaped + '\\s*\\|\\|\\s*null\\b')
    if (!cached.test(after)) continue
    const key = service + ':' + variable
    if (seen.has(key)) continue
    seen.add(key)
    hits.push({ service, variable, scope: scope === null ? 'top-level' : scope.name })
  }
  return hits
}

/** Literal `ctx.get('name')` references in client source or bundle text. */
export function collectClientServiceRefs(text) {
  if (typeof text !== 'string') return []
  const refs = []
  const seen = new Set()
  const pattern = /\bctx\s*\.\s*get\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of text.matchAll(pattern)) {
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      refs.push(name)
    }
  }
  return refs
}

/**
 * Detect the classic `workspaces.pickDirectory()` mistake:
 *   ctx.get('workspaces').pickDirectory()
 *   const ws = ctx.get('workspaces'); ws.pickDirectory()
 *   ctx.workspaces?.pickDirectory()
 *
 * `workspaces` is a valid service, so this is intentionally a method-level
 * rule rather than an unknown-service rule.
 */
export function findWorkspacesPickerMisuse(text) {
  if (typeof text !== 'string') return []
  const hits = []
  const directPatterns = [
    /\bctx\s*\.\s*get\s*\(\s*['"]workspaces['"]\s*\)\s*(?:\?\.|\.)?\s*pickDirectory\b/g,
    /\bctx\s*\.\s*workspaces\s*(?:\?\.|\.)?\s*pickDirectory\b/g,
  ]
  for (const pattern of directPatterns) {
    if (pattern.test(text)) hits.push({ service: 'workspaces', method: 'pickDirectory', via: 'direct' })
  }
  const assignment = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*ctx\s*\.\s*(?:get\s*\(\s*['"]workspaces['"]\s*\)|workspaces)(?=\s|$|[.;])/g
  const seen = new Set()
  for (const match of text.matchAll(assignment)) {
    const variable = match[1]
    if (seen.has(variable)) continue
    const use = new RegExp('\\b' + escapeRegExp(variable) + '\\s*(?:\\?\\.|\\.)?\\s*pickDirectory\\b')
    if (use.test(text)) {
      seen.add(variable)
      hits.push({ service: 'workspaces', method: 'pickDirectory', via: variable })
    }
  }
  return hits
}
