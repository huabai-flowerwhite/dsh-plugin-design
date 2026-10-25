# Independent distribution contract

This is the acceptance contract `dshpd_distribute` / `dshpd_validate` enforce for
a **target** plugin (and were used for `dsh-plugin-design` itself).

## Gates

| Gate | Required evidence | FAIL examples |
|---|---|---|
| `packageCompleteness` | manifest parses; Host entry exists; declared Client export exists, is factory-form and registers the package id; declared assets/worker files are inside the package; `files` publishes the entries | client bundle missing, wrong bundle id, asset/worker missing |
| `portability` | no author absolute path in runtime code; no `file:`/`link:`/`workspace:` runtime dependency; no hard-coded local service; no maintenance state packaged | `E:\creat\...` in a bundle, `link:` dependency, `.dsh-plugin-design/` in the package |
| `dependencyClosure` | every runtime import is a Node builtin, a declared dependency/peer or the package itself; client `require()` only baseline/external/self | import of an undeclared package, dev-only package imported at runtime |
| `maintenancePrivates` | no `dsh-plugin-design` runtime dependency, no `.dsh-plugin-design`, no credentials/`.env`/tokens | package depends on the maintenance plugin |
| `releaseDocumentation` | README covers install, uninstall, DSH version and carrier; LICENSE present | missing README/LICENSE (WARN) |
| `independentRuntime` | the exact archive loads in a consumer tree that cannot resolve the author source or `dsh-plugin-design`; Host apply + one tool call + Client factory/apply/render | Host import fails, maintenance plugin resolves |
| `cleanInstall` | a fresh `DSH_HOME`: official CLI install → cold start → plugin route 200 | probe fails, host does not start |
| `distributionLifecycle` | restart probe still 200; uninstall exits 0; host boots again; plugin route no longer 200 | uninstall fails, route still served, host fails to boot |
| `releaseDocumentation` + artifacts | `source/`, prebuilt `.tgz`, `SHA256SUMS`, `FILELIST.json`, `INSTALL.md`, `SUPPORT-MATRIX.*`, `BUILD-LOCK.json`, `distribution-report.json` | missing artifact, hash mismatch |

`NOT_RUN` does not pass. `NOT_APPLICABLE` is only allowed with a stated reason
(for example: no Client half declared).

## Artifacts

```
<release>/
  source/                     complete source tree (no node_modules/VCS/state)
  package/<name>-<ver>.tgz    deterministic prebuilt package
  SHA256SUMS                  hashes over the tgz and the source files
  FILELIST.json               per-file path/size/SHA-256 of the package
  INSTALL.md                  public install/update/uninstall/limits
  SUPPORT-MATRIX.md|.json     verified and NOT_RUN combinations
  BUILD-LOCK.json             build environment + documented build command
  distribution-report.json    gates, hashes, status, host/client necessity
```

The exporter **never runs package scripts**. If a target needs a build, commit
the built artifacts first and document the command in `BUILD-LOCK.json`.

## Status separation

| Field | Meaning |
|---|---|
| `localModification` | result of `dshpd_verify` for the local change |
| `distributionValidated` | clean-environment/package-load gates passed for this exact artifact |
| `releasePrepared` | release directory + hashes exist |
| `published` | a remote upload happened (this tool always reports `false`) |

## Clean-environment rules

1. Fresh `DSH_HOME`; no profile from the author.
2. `dsh-plugin-design` is **not** installed and is not resolvable from the
   consumer tree (proved by `createRequire().resolve()` failing).
3. Install only the exact `.tgz` with the public command.
4. Probe a representative Host route/tool; verify an applicable Client half.
5. Restart, then uninstall, then boot again; the plugin route must be gone and
   the host must still start.
6. Missing carrier/OS → keep the row `NOT_RUN`; do not widen the support claim.

## Publish boundary

Preparing GitHub source/Release/npm materials is part of the delivery.
Pushing a repository, creating a Release or publishing to npm requires explicit
authorisation for that account and channel. After an authorised upload, download
the artifact again and re-verify its hash before changing `published`.
