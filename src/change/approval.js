// dsh-plugin-design — approval receipts bound to one exact plan.
//
// 1.3.2 issued a random token after "the model said the user agreed". That is
// not an authorization: it was not bound to a design, a file set, a root, an
// operation set, an identity or an expiry, and it could be replayed.
//
// This module issues a receipt only when:
//   1. the caller echoes the exact `planHash` of the plan it is asking to run
//      (so a token can never cover a plan the caller did not see), and
//   2. authorization is established by one of the deployment's real channels:
//        - the official approval service (`ctx.get('approval').request`) with
//          the agent, call id and a precise reason; only `allowed-once` grants,
//        - a deployment that already runs under `danger-full-access`, where the
//          permission preset itself grants the capability and asking for a
//          wider mode is not an escalation (the same rule the official
//          `approveEscalation` helper applies).
// A policy of `never` combined with a narrower sandbox results in a refusal —
// the plan/diff is still returned, but no mutating token is issued.
//
// Receipts are intentionally process-local: a raw token is never persisted. The
// durable audit record stores only its hash plus the plan digest.

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { appendJournal } from './journal.js'
import { canonicalJson, designStillMatches } from './plan.js'
import { pathKey, resolveInside } from './paths.js'

export const RECEIPT_TTL_MS = 2 * 60 * 60 * 1000
export const DEFAULT_MAX_MUTATIONS = 200

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function tokenHash(token) {
  return sha256(String(token))
}

/** Identity of the calling agent/session, used to bind receipts. */
export function callerIdentity(exec) {
  const agent = exec && exec.agent ? exec.agent : null
  const agentId = agent && typeof agent.id === 'string' && agent.id !== ''
    ? agent.id
    : (agent && agent.id !== undefined && agent.id !== null ? String(agent.id) : null)
  const session = agent && agent.session ? agent.session : null
  const sessionId = session && typeof session.id === 'string'
    ? session.id
    : session && session.header && typeof session.header.id === 'string'
      ? session.header.id
      : typeof exec?.sessionId === 'string'
        ? exec.sessionId
        : null
  return { agentId, sessionId }
}

/** Effective sandbox mode for this call, or null when unknown. */
export function effectiveSandboxMode(ctx, exec) {
  try {
    const policyService = ctx && typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined
    if (!policyService || typeof policyService.resolve !== 'function') return null
    const session = exec && exec.agent ? exec.agent.session : undefined
    const policy = policyService.resolve(session ? { session } : undefined)
    if (policy && typeof policy.mode === 'string') return policy.mode
    return null
  } catch (error) {
    return null
  }
}

/**
 * Ask the official approval seam. Returns `{outcome, channel}`.
 * Never invents a grant: anything but `allowed-once` is a refusal.
 */
export async function requestOfficialApproval(ctx, exec, request) {
  const approval = ctx && typeof ctx.get === 'function' ? ctx.get('approval') : undefined
  if (!approval || typeof approval.request !== 'function') {
    return { outcome: 'unavailable', channel: 'none', detail: 'no approval service is composed in this profile' }
  }
  if (!exec || !exec.agent) {
    return { outcome: 'unavailable', channel: 'approval', detail: 'the call has no agent to route an approval through' }
  }
  try {
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: request.toolName || 'dshpd_approve',
      callId: exec.callId,
      reason: request.reason,
      displayReason: request.displayReason,
      signal: exec.signal,
    })
    return { outcome: typeof outcome === 'string' ? outcome : 'unavailable', channel: 'approval' }
  } catch (error) {
    return {
      outcome: 'unavailable',
      channel: 'approval',
      detail: String(error && error.message ? error.message : error),
    }
  }
}

/**
 * Establish authorization and issue a receipt.
 * @returns {{ok: true, receipt: object, token: string} | {ok: false, error: string, detail: object}}
 */
export async function issueApproval(options) {
  const { ctx, exec, stateDir, plan, planHash, requestedPlanHash, toolVersion } = options
  if (typeof requestedPlanHash !== 'string' || requestedPlanHash.trim() === '') {
    return {
      ok: false,
      error: 'PLAN_HASH_REQUIRED',
      detail: 'pass the exact planHash returned by dshpd_plan/dshpd_design so the receipt covers the plan you reviewed',
    }
  }
  if (requestedPlanHash.trim() !== planHash) {
    return { ok: false, error: 'PLAN_HASH_MISMATCH', detail: { expected: planHash, received: requestedPlanHash.trim() } }
  }
  const identity = callerIdentity(exec)
  if (identity.agentId === null) {
    return { ok: false, error: 'CALLER_IDENTITY_UNKNOWN', detail: 'this tool must be called from an agent turn' }
  }
  const mode = effectiveSandboxMode(ctx, exec)
  let basis = null
  let approvalOutcome = 'not-requested'
  let approvalChannel = 'none'
  let detail = null
  if (mode === 'danger-full-access') {
    basis = 'deployment-full-access'
    approvalChannel = 'permission-preset'
    detail = 'the deployment permission preset already grants full access; asking for a wider mode is not an escalation'
  } else {
    const requested = await requestOfficialApproval(ctx, exec, {
      toolName: 'dshpd_approve',
      reason: 'Approve dsh-plugin-design plan ' + planHash.slice(0, 16)
        + ' for ' + plan.pluginRoot
        + ' (' + plan.operations.join(',') + ', ' + plan.files.length + ' files)',
      displayReason: {
        en: 'Approve this exact dsh-plugin-design change plan (' + planHash.slice(0, 12) + ')?',
        zh: '是否批准这个精确的 dsh-plugin-design 变更计划（' + planHash.slice(0, 12) + '）？',
      },
    })
    approvalOutcome = requested.outcome
    approvalChannel = requested.channel
    detail = requested.detail || null
    if (requested.outcome !== 'allowed-once') {
      return {
        ok: false,
        error: 'APPROVAL_NOT_GRANTED',
        detail: {
          outcome: requested.outcome,
          channel: requested.channel,
          sandboxMode: mode,
          reason: detail,
          planHash,
          note: 'no mutating token was issued; the plan and its diff remain available for review',
        },
      }
    }
    basis = 'approval-service'
  }
  const token = randomUUID()
  const createdAt = Date.now()
  const receipt = {
    schema: 1,
    tokenHash: tokenHash(token),
    planHash,
    planDigest: sha256(canonicalJson(plan)),
    pluginRoot: plan.pluginRoot,
    design: plan.design,
    operations: plan.operations,
    targetProfile: plan.targetProfile,
    files: plan.files.map((file) => ({ path: file.path, relative: file.relative, exists: file.exists, sha256: file.sha256 })),
    runtime: plan.runtime,
    agentId: identity.agentId,
    sessionId: identity.sessionId,
    basis,
    approvalOutcome,
    approvalChannel,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + (options.ttlMs || RECEIPT_TTL_MS)).toISOString(),
    maxMutations: Number.isFinite(options.maxMutations) ? options.maxMutations : DEFAULT_MAX_MUTATIONS,
    mutations: 0,
    toolVersion: toolVersion || null,
  }
  await fs.mkdir(join(stateDir, 'approvals'), { recursive: true })
  await fs.writeFile(join(stateDir, 'approvals', receipt.tokenHash + '.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8')
  await appendJournal(stateDir, {
    operationId: 'approval-' + receipt.tokenHash.slice(0, 16),
    phase: 'commit',
    kind: 'approval',
    pluginRoot: plan.pluginRoot,
    planHash,
    basis,
    approvalOutcome,
    agentId: identity.agentId,
    sessionId: identity.sessionId,
    operations: plan.operations,
    files: receipt.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
  })
  return { ok: true, token, receipt }
}

/**
 * Validate a token for one mutation.
 * @param {Map<string, object>} receipts - token -> receipt (process-local)
 */
export async function authorizeMutation(options) {
  const { receipts, token, exec, service, operation, filePaths, signal } = options
  if (typeof token !== 'string' || token === '') {
    return { ok: false, error: 'APPROVAL_TOKEN_REQUIRED' }
  }
  const receipt = receipts.get(token)
  if (receipt === undefined) {
    return {
      ok: false,
      error: 'APPROVAL_UNKNOWN',
      detail: 'approval tokens are process-local; call dshpd_approve in this process and pass the token it returned',
    }
  }
  if (Date.parse(receipt.expiresAt) <= Date.now()) {
    receipts.delete(token)
    return { ok: false, error: 'APPROVAL_EXPIRED', detail: { expiresAt: receipt.expiresAt } }
  }
  const identity = callerIdentity(exec)
  if (identity.agentId !== receipt.agentId
    || (receipt.sessionId !== null && identity.sessionId !== null && identity.sessionId !== receipt.sessionId)) {
    return {
      ok: false,
      error: 'APPROVAL_IDENTITY_MISMATCH',
      detail: { approvedFor: { agentId: receipt.agentId, sessionId: receipt.sessionId }, caller: identity },
    }
  }
  if (!receipt.operations.includes(operation)) {
    return { ok: false, error: 'OPERATION_NOT_APPROVED', detail: { operation, approved: receipt.operations } }
  }
  const approved = new Set(receipt.files.map((file) => pathKey(file.path)))
  for (const filePath of filePaths) {
    const containment = resolveInside(receipt.pluginRoot, filePath, { label: 'file', rejectReparse: true })
    if (!containment.ok) return { ok: false, error: containment.error, detail: containment.detail }
    if (!approved.has(pathKey(containment.canonical))) {
      return {
        ok: false,
        error: 'FILE_NOT_IN_APPROVED_PLAN',
        detail: { file: containment.canonical, hint: 're-run dshpd_approve with the complete file set' },
      }
    }
  }
  const design = await designStillMatches(service, {
    pluginRoot: receipt.pluginRoot,
    design: receipt.design,
  }, signal)
  if (!design.ok) return { ok: false, error: design.error, detail: design.detail }
  if (receipt.mutations >= receipt.maxMutations) {
    return { ok: false, error: 'APPROVAL_USE_LIMIT_REACHED', detail: { maxMutations: receipt.maxMutations } }
  }
  receipt.mutations += 1
  return { ok: true, receipt }
}

/** Base version/hash recorded for one file in the approved plan. */
export function plannedFile(receipt, filePath) {
  return receipt.files.find((file) => pathKey(file.path) === pathKey(filePath)) || null
}
