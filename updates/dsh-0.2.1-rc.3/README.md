# DSH Desktop 0.2.1-rc.3 — incremental compatibility delivery

This directory is the rc.3 increment of `dsh-plugin-design`. It lives in the DSH
plugin workspace: `E:/creat/DSH/rule/dsh-plugin-design/updates/dsh-0.2.1-rc.3`.
It does **not** rewrite the rc.2 delivery kept in the original analysis
workspace (`E:/creat/Codex/dsh设计插件优化建议/outputs`); those logs, tarballs,
manifests and hashes remain historical.

- Plugin: **1.4.4** (1.4.0 → 1.4.1 → 1.4.2 → 1.4.3 → 1.4.4)
- Installation exercised: `E:/运行包/DSHpc` = **DSH Desktop 0.2.1-rc.3**
  (Electron 44.7.0, Chrome 152.0.7977.130, Node 24.21.0, win32-x64,
  `app.asar` SHA-256 `04b32e3a…eff1f0`)
- Release contract tag: `dsh-v0.2.1-rc.3` @ `1f81c04`; research branch
  `22ddee3` is **not** the same API surface.

## Status

| Check | Status |
|---|---|
| Release identity (installed rc.3 Desktop/CLI/app-boot) | **PASS** |
| rc.3 source/contract difference review | **STATIC_REVIEWED** |
| Plugin adaptation (deployment capability probe, rc.3 cache guidance) | **PASS** |
| rc.3 Host (headless web Host via rc.3 companion runtime) | **PASS** |
| Real Chromium renderer on the rc.3 Web Host (settings/scan/analyze/error/health) | **PASS** |
| `node --test` and `npm test` | **PASS** (103 / 103 each) |
| Real Desktop window / Electron preload / native picker | **NOT_RUN** (single-instance lock; real profile untouched) |
| rc.2 historical evidence | unchanged |
| Remote publication | **not performed by this task** |

## The three real bugs found and fixed

1. **1.4.2 — analysis rendering crash.** `FindingList` called
   `h(...).concat(...)`; a React element has no `.concat`, so any analysis with
   findings threw `TypeError: h(...).concat is not a function` and the whole
   `settings.section` slot went blank. Scan-only views worked, which is why
   source/artifact/stub tests missed it. Fixed by building a children array
   first; a regression test forbids the pattern.
2. **1.4.3 — unreadable scan error.** A missing/unreadable directory returned
   `ok:false` without `error`, so the UI showed `HTTP 200`. It now prefers
   `error`, then `scan.reasons`, then `scan.status` (observed:
   `扫描状态：INCOMPLETE`).
3. **1.4.4 — npm test fingerprint.** `npm` sets
   `npm_package_name=dsh-plugin-design` and `npm_package_version=1.4.3`; the
   old fingerprint treated the latter as the running DSH version, flipping
   compatibility from `UNKNOWN` to `false` and failing the unknown-runtime test
   only under `npm test`. Now `npm_package_version` is accepted only when
   `npm_package_name` is a known DSH package, and only as a last resort after
   `DSH_VERSION` / `DSH_RUNTIME_VERSION` / the asar manifest.

## Answers

1. **Did the plugin need code changes?** Yes: the rc.3 adapter required
   `updateBundle` (absent in the release manager) in 1.4.1; the real renderer
   then exposed the `FindingList` crash (1.4.2) and the `HTTP 200` error text
   (1.4.3); GitHub/npm testing exposed the npm fingerprint source (1.4.4). All
   are fixed without adding profile writes or widening `engines.dsh`.
2. **Is the rc.3 Host verified?** Yes, for the headless `web` Host carrier using
   the rc.3 companion CLI: maintenance plugin 1.4.4 and the minimal Host+Client
   target package completed install → cold start → probe → restart → uninstall
   → boot again in fresh `DSH_HOME`s; `/info` reports runtime `0.2.1-rc.3`.
3. **Is the real Desktop window/renderer verified?** The **Desktop window is
   NOT_RUN** (second instance refused by the process-lifetime single-instance
   lock; the live Desktop was not restarted or modified). A **real Chromium
   renderer of the rc.3 Web Host is PASS**: settings tab renders v1.4.4, scan
   lists 5 fixtures, analyze shows `BLOCKED` with findings, bad path shows a
   readable error, and `/dsh-plugin-design/health` reports
   `activated=true, rendered=true`. This is not the Desktop preload/native
   picker.
4. **Which old conclusions stand, which evidence changed?** Kept: 1.4.0
   change-control/security/distribution conclusions and the rc.2 historical
   evidence. Updated: `E:/运行包/DSHpc` is rc.3 (rc.2 is in
   `DSHpc.new-{GUID}`); `updateBundle`/`listVersions` belong to the research
   branch, not the release; rc.3 client metadata caches negative results until
   a Host restart; “no renderer evidence” is superseded by the real Chromium
   Web renderer PASS, while the Desktop window remains NOT_RUN.

## Contents

| Path | Content |
|---|---|
| `artifacts/dsh-plugin-design-1.4.4.tgz` | final maintenance-plugin package (SHA-256 `5355cf0a…881c`, 221131 bytes) |
| `artifacts/dshpd-demo-plugin-1.0.0.tgz` | unchanged target package (SHA-256 `7bff8c3b…2972`), reused for rc.3 evidence |
| `increment.diff` / `increment.diffstat.txt` | actual 1.4.0 → 1.4.4 package diff (18 files, +584/−91) |
| `SUPPORT-MATRIX.md` | Host, real Chromium, Desktop NOT_RUN, static review, timings |
| `upgrade-report.md` | identity, contract differences, fixes, evidence, answers, limits |
| `status.json` | machine-readable status, artifact hashes, evidence map, timings |
| `evidence/runtime-identity.json` | installed manifests, Electron/Node, asar hash, plugin-manager surface |
| `evidence/running-processes.json` | running Desktop processes (window titles redacted) |
| `evidence/rc3-host-info.json` | full `/info` from an actual rc.3 host: runtime + adapter capabilities |
| `evidence/rc3-slot-probe.json` | `settings.section`, new “more” slots, `pickDirectory` presence |
| `evidence/desktop-isolated-probe.json` | isolated Desktop attempt: exit 9, no profile, no CDP, NOT_RUN |
| `evidence/browser-renderer/probe.json` | real Chromium flow result (scan/analyze/error/health, 0 console errors) |
| `evidence/browser-renderer/probe.mjs` | reproducible CDP driver, records the tested artifact SHA-256 |
| `evidence/browser-renderer/*.png` | screenshots of welcome, settings, panel, scan, analyze, error |
| `evidence/quick-regression.log` | `node --test` (103 pass) log |
| `evidence/npm-test.log` | `npm test` (103 pass) log, including the npm-injected env |
| `validation/maintenance-plugin/` | rc.3 install/cold start/restart/uninstall evidence |
| `validation/target-plugin/` | same for the Host+Client target package |
| `cli-command.json` | exact rc.3 CLI argv used (machine-specific) |
| `SHA256SUMS` | hashes of delivered artifacts and key evidence |

## Reproduce

```powershell
cd E:\creat\DSH\rule\dsh-plugin-design
node --test
npm test
node scripts/build-client.mjs --check

# rc.3 Host, maintenance plugin
node scripts/clean-env-matrix.mjs --cli-json-file <this dir>\cli-command.json `
  --tgz <this dir>\artifacts\dsh-plugin-design-1.4.4.tgz `
  --name dsh-plugin-design --probe /dsh-plugin-design/info `
  --out <this dir>\validation\maintenance-plugin

# rc.3 Host, target Host+Client package
node scripts/clean-env-matrix.mjs --cli-json-file <this dir>\cli-command.json `
  --tgz <this dir>\artifacts\dshpd-demo-plugin-1.0.0.tgz `
  --name dshpd-demo-plugin --probe /dshpd-demo/health `
  --out <this dir>\validation\target-plugin

# Real Chromium renderer flow (headless Chrome)
node <this dir>\evidence\browser-renderer\probe.mjs <this dir>\cli-command.json `
  <this dir>\artifacts\dsh-plugin-design-1.4.4.tgz `
  <this dir>\evidence\browser-renderer `
  "C:\Program Files\Google\Chrome\Application\chrome.exe"

# Isolated Desktop attempt (expected NOT_RUN while the real app is running)
node <this dir>\evidence\desktop-isolated-probe.mjs <this dir>\evidence\desktop-isolated-probe.json
```

## Boundaries

- No DSH core/main/preload changes; no `engines.dsh` widening; no compatibility
  exemption; no build-script approval.
- No real profile write, no real Desktop restart, no install/update of the DSH
  application by this task (it was already rc.3 when the task started).
- No GitHub push/Release/npm publish from this task.
- Real Desktop/renderer remains `NOT_RUN` until an isolated Windows account or
  an upstream-supported test-instance switch is available.
