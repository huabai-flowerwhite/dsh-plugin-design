# Support matrix

This file records **what was actually run**, not what the version range claims.
`NOT_RUN` means there is no evidence for that combination and it must not be
read as supported.

## Current: DSH Desktop 0.2.1-rc.3 increment (2026-10-25)

Runtime exercised: installed `E:/运行包/DSHpc` = **0.2.1-rc.3** (Electron 44.7.0,
Node 24.21.0, win32-x64, `app.asar` SHA-256 `04b32e3a…eff1f0`; the
`DSHpc.new-{GUID}` sibling is the old rc.2 staging tree). Full evidence and
timings: [`updates/dsh-0.2.1-rc.3/`](updates/dsh-0.2.1-rc.3/README.md).

| Component | Version | Carrier | Checks | Result | Evidence |
|---|---|---|---|---|---|
| dsh-plugin-design 1.4.3 `.tgz` | 0.2.1-rc.3 | headless `web` Host via the rc.3 companion CLI | install → cold start → `/info` 200 → restart → 200 → uninstall → host boots → 404 | **PASS** | `updates/dsh-0.2.1-rc.3/validation/maintenance-plugin/clean-env-evidence.json` |
| dshpd-demo-plugin 1.0.0 `.tgz` (Host+Client) | 0.2.1-rc.3 | same, clean `DSH_HOME`, maintenance plugin absent | install → cold start → `/dshpd-demo/health` 200 → restart → uninstall → host boots → 404 | **PASS** | `updates/dsh-0.2.1-rc.3/validation/target-plugin/clean-env-evidence.json` |
| rc.3 runtime + deployment capability | 1.4.3 | rc.3 Host | `/info` runtime `0.2.1-rc.3`; manager present; install/remove/enable true; `updateBundle`/`listVersions` UNSUPPORTED | **PASS** | `updates/dsh-0.2.1-rc.3/evidence/rc3-host-info.json` |
| Real Chromium renderer on the rc.3 Web Host | 1.4.3 | real headless Chrome via CDP | settings tab renders v1.4.3; scan lists 5 fixtures; analyze shows BLOCKED + findings; bad path shows `扫描状态：INCOMPLETE`; health receipt `activated=true, rendered=true`; 0 console errors | **PASS** (Web carrier, not Desktop) | `updates/dsh-0.2.1-rc.3/evidence/browser-renderer/probe.json` |
| plugin-manager surface, client metadata negative cache, `settings.section` + new “more” slots | rc.3 | installed source | read-only inspection of installed `app.asar` | **STATIC_REVIEWED** | `updates/.../evidence/{runtime-identity,rc3-slot-probe}.json` |
| Real Desktop window / Electron preload (settings, activation, rendering, native picker, cancel, unload, “more” coexistence) | rc.3 | real Desktop | isolated second instance refused by the process-lifetime single-instance lock; real profile not touched | **NOT_RUN** | `updates/.../evidence/desktop-isolated-probe.json` |
| Native directory picker / explicit cancel control | rc.3 | renderer | not automated / no cancel button (abort on unmount) | **NOT_RUN** | — |
| Linux / macOS | — | — | no test machine | **NOT_RUN** | — |
| npm / GitHub source install | — | — | nothing published | **NOT_RUN** | — |

## Historical: rc.2 delivery (2026-10-25, unchanged)

The table below is the **historical rc.2 record**. It is not rewritten as rc.3
evidence. Current plugin source is 1.4.3 (100 tests); the rc.2 numbers/artifacts
stay in the original analysis workspace, `E:/creat/Codex/dsh设计插件优化建议/outputs/`
(read-only historical evidence, not part of this repository).

## Verified matrix (2026-10-25)

| Component | Version | Carrier | OS / arch | Checks | Result | Evidence |
|---|---|---|---|---|---|---|
| dsh-plugin-design 1.4.0 `.tgz` | 0.2.1-rc.2 | headless `web` host started from the Desktop runtime (ELECTRON_RUN_AS_NODE) | win32 / x64 | install → cold start → `/dsh-plugin-design/info` 200 → restart → 200 → uninstall → host boots → route 404 | **PASS** | `outputs/independent-validation/maintenance-plugin/clean-env-evidence.json` |
| dshpd-demo-plugin 1.0.0 `.tgz` (Host+Client fixture) | 0.2.1-rc.2 | headless `web` host, clean `DSH_HOME`, dsh-plugin-design **not** installed | win32 / x64 | install → cold start → `/dshpd-demo/health` 200 → restart → 200 → uninstall → host boots → route 404 | **PASS** | `outputs/independent-validation/target-plugin/clean-env-evidence.json` |
| dshpd-demo-plugin 1.0.0 `.tgz` | n/a (Node 24.19.0) | isolated consumer directory, no author source, no maintenance plugin | win32 / x64 | extract → import Host → apply → `demo_status` → Client factory/apply/register/render | **PASS** (package-load only) | `tests/distribution.test.mjs` + `outputs/tests/results.tap` |
| dsh-plugin-design source | Node 24.19.0 | `node --test` | win32 / x64 | 92 tests / subtests | **PASS** | `outputs/tests/results.tap` |
| recovery CLI (`bin/dshpd-recover.mjs`) | Node 24.19.0 | standalone process, no Host import | win32 / x64 | list/verify/preview/conflict/restore/tampered-refusal | **PASS** | `outputs/recovery-drill/recovery-drill.json` |
| Node built-in SemVer vs semver@7.8.5 | 7.8.5 | differential fixture (435 cases) | n/a | satisfies/validRange/valid | **PASS** | `tests/fixtures/semver-cases.json` |

Measured runtime identity (from inside the packaged host):

```json
{
  "version": "0.2.1-rc.2",
  "versionSource": "asar:dsh-app-boot/package.json",
  "carrier": "embedded-cli",
  "platform": "win32",
  "arch": "x64",
  "node": "v24.21.0"
}
```

`dsh --version` printed `0.2.1-rc.2`; the research baseline `0.2.1-rc.3`
(`22ddee3`) is the **contract** reference, not a run.

## Not verified (NOT_RUN)

| Combination | Why | What would be needed |
|---|---|---|
| DSH 0.2.1-rc.3 runtime | only the source contract copy is available | install that build and rerun the clean-env matrix |
| Desktop **window** / Electron renderer interaction | validation used the headless web host | a real Desktop test instance, Client activation + rendered receipt |
| Linux / macOS | no test machine | run `install.sh` + clean-env matrix on each OS |
| Client UI interaction (click/scan/analyze) inside the real page | only factory/apply/render with a React stub | real browser/Electron page test |
| Upgrade from 1.3.2 → 1.4.0 on a real profile | explicitly not performed (would mutate the user profile) | user-authorised profile upgrade with rollback evidence |
| npm registry install | no package was published | publish authorisation, then install from the registry |
| GitHub source install | no remote repository action was authorised | push/tag authorisation, then build from the fixed commit |
| Dynamic fault injection (infinite loop/OOM/exit) | no isolated OS sandbox was provided | supervised process/VM with resource limits |

## Compatibility claims

- `engines.dsh`: `>=0.1.5-rc.1 <0.3.0` is the **declared** range inherited from
  1.3.2. It was not widened. Only `0.2.1-rc.2` has runtime evidence.
- `engines.node`: `>=22 <25`; tested on Node 24.19.0 (host: 24.21.0).
- The package-load gate is package-level evidence; it does **not** prove a real
  DSH Host or renderer run. The `dsh-host` gate is the one that does.
