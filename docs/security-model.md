# Security model

This document states what the plugin enforces and what it cannot enforce. It is
deliberately narrower than “safe plugin runtime”.

## Trust boundaries

| Boundary | Reality |
|---|---|
| DSH Loader / Host process | Third-party Host halves run in the same process. A synchronous infinite loop, OOM or `process.exit` can still take the host down. This plugin cannot prevent that. |
| DSH approval service | `ctx.get('approval').request()` is the official one-shot grant. Only `allowed-once` is a grant. Under policy `never` it returns `rejected`; the plugin then refuses mutations unless the deployment already runs at `danger-full-access`. |
| `danger-full-access` preset | The preset itself grants the capability; requesting a “wider” mode would not be an escalation. Receipts issued on this basis are recorded as `deployment-full-access` and are still bound to the exact plan. |
| `ctx.fs` sandbox policy | Every mutation passes an explicit `sandboxPolicy` resolved from the agent session. A denial is reported; there is **no** fallback to raw `node:fs` for target files. |
| Plugin-design state root | `<DSH_HOME>/plugin-design-state` is outside the reviewed plugin tree, so a target plugin cannot ship, delete or self-authorize its own backups. It is **not** a tamper-proof vault: same-user code can still modify it. Hashes detect corruption, not malice. |
| Snapshot payloads | Raw bytes + SHA-256. Restore verifies every payload before writing. Binary restore uses an atomic `node:fs` write (the public `ctx.fs` has no binary write) and is reported as `RESTORED_BINARY`. |
| Profile files | Never written by this plugin. Deployment is delegated to `ctx.get('pluginManager')`; absent that service, only a dry-run plan is returned. |
| Scan worker | A `worker_threads` worker with a V8 heap limit, deadline, file/dir/byte budget and a finite queue. This protects the event loop; it does **not** isolate untrusted code, because the scanner never executes the audited plugin. |
| Validation runner | Package-load mode runs the audited Host half in a child Node process inside a throwaway consumer tree. That is a process boundary with the user's permissions — not an OS sandbox, container or VM. |

## Approval receipt

A receipt exists only for one exact plan:

- `planHash` over canonical plugin root, design SHA-256, every file's baseline
  hash/presence/version, sorted operation set, target profile, runtime identity
  and tool/ruleset identity;
- caller identity (`agentId`, `sessionId`) and an expiry;
- a mutation counter and a maximum use count.

The caller must echo the same `planHash` back to `dshpd_approve`. Editing the
design, replacing a planned file, changing the operation set or the target
profile changes the hash, so the old receipt no longer matches. There is no
`allowStale` escape: a stale file is refused and the caller must re-plan.

## Journal and recovery

Every mutation writes a durable `prepare` record before touching a file and a
terminal `commit`/`abort` record afterwards. A prepare without a terminal record
is surfaced as `RECOVERY_REQUIRED` by `dshpd_status` and
`dshpd-recover --operations`. Multi-file writes are not one atomic transaction;
the journal is what makes an interrupted run recoverable.

Restore outcomes:

| Outcome | Meaning |
|---|---|
| `ROLLED_BACK` | Every required file was restored and re-hashed. |
| `ROLLBACK_CONFLICT` | At least one file changed after the last applied revision (or was created by this change set). It was left untouched. |
| `ROLLBACK_PARTIAL` | A write failed after preflight; details and preserved copies are listed. |
| `ROLLBACK_ABORTED` | Manifest/payload integrity failed; nothing was written. |

## What the plugin claims

- `READY_TO_MODIFY` is a **static preflight** result. It is not a runtime safety
  proof and not a DeepSeek certification.
- `verification.claims.runtimeSafe` is `NOT_PROVEN` unless a `dsh-host`
  validation ran for this artifact.
- Distribution materials are `releasePrepared`, not `published`; the tool never
  uploads anything.

## What would need upstream support

- A real renderer/client health channel (today the plugin defines its own
  receipt route; there is no official downloaded/registered/activated/rendered
  signal).
- A supervised isolation backend for executing untrusted plugin code (container,
  restricted account or VM). Until then, dynamic code execution stays `NOT_RUN`.
- A supported API to add an arbitrary Loader row for an already-installed
  package; only bundle install/remove/update are official.
