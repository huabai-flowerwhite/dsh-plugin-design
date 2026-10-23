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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
