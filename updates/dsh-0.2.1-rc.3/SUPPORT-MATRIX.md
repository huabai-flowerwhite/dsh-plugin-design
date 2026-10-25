# Support matrix — DSH Desktop 0.2.1-rc.3 (incremental)

Date: 2026-10-25. Runtime: **Desktop 0.2.1-rc.3**, installed at
`E:/运行包/DSHpc` (Electron 44.7.0, Chrome 152.0.7977.130, Node 24.21.0,
win32-x64; `app.asar` SHA-256 `04b32e3a…eff1f0`). The sibling
`DSHpc.new-{GUID}` directory is the **old rc.2** staging tree, not the running
installation. Identity evidence: `evidence/runtime-identity.json`.

`PASS` means the exact artifact was run; `STATIC_REVIEWED` means source/contract
inspection only; `NOT_RUN` means no evidence and it is not a support claim.

## Host / companion CLI (rc.3)

| Component | Artifact | Carrier | Checks | Result | Evidence |
|---|---|---|---|---|---|
| dsh-plugin-design 1.4.4 | `artifacts/dsh-plugin-design-1.4.4.tgz` (SHA-256 `5355cf0a…881c`) | headless `web` Host started by the rc.3 companion CLI (`ELECTRON_RUN_AS_NODE`) | install → cold start → `/dsh-plugin-design/info` 200 → restart 200 → uninstall → Host boots again → route 404 | **PASS** | `validation/maintenance-plugin/clean-env-evidence.json` |
| dshpd-demo-plugin 1.0.0 (Host+Client) | `artifacts/dshpd-demo-plugin-1.0.0.tgz` (SHA-256 `7bff8c3b…2972`, unchanged) | same, clean `DSH_HOME`, maintenance plugin **not** installed | install → cold start → `/dshpd-demo/health` 200 → restart 200 → uninstall → Host boots again → route 404 | **PASS** | `validation/target-plugin/clean-env-evidence.json` |
| rc.3 Host runtime + adapter capability | 1.4.4 tgz | rc.3 host | `/info` runtime `0.2.1-rc.3`; pluginManager present; install/remove/enable true; update/versionDiscovery false; unsupported `updateBundle`,`listVersions`,`readBundleDetail` | **PASS** | `evidence/rc3-host-info.json` |

## Real renderer — rc.3 Web Host + real Chromium

| Check | Result | Detail |
|---|---|---|
| Real Chromium opens the rc.3 Web UI, settings reachable | **PASS** | headless Chrome 155 (`--headless=new`) via CDP; welcome → 继续 → 默认工作区 → 设置 |
| Settings tab “dsh plugin design” renders | **PASS** | panel shows `v1.4.4`, usage steps, scan controls (screenshots `07-settings.png`, `08-plugin-panel.png`) |
| Scan (manual path) | **PASS** | lists 5 fixture projects (`broken-package`, `legacy-plugin`, `minimal-host-client`, `modern-plugin`, `removed-api-plugin`) |
| Analyze rendering (issues present) | **PASS** | `broken-package` shows `BLOCKED issues 9 · B1 / C0 / H0 / M2` and finding rows; 1.4.2 fixed the `h(...).concat` crash found here |
| Error display | **PASS** | non-existent path shows `扫描状态：INCOMPLETE` (since 1.4.3; before it was `HTTP 200`) |
| Client health receipt | **PASS** | `/dsh-plugin-design/health` → `activated=true, rendered=true, version 1.4.4` |
| Console exceptions during the flow | **PASS** | 0 `Runtime.exceptionThrown` / console errors in the final run |
| `npm test` (npm-injected env) | **PASS** | 103/103; plugin `npm_package_version` ignored, only known DSH package names accepted |
| Native directory picker (“选择文件夹”) | **NOT_RUN** | browser/Electron file dialog not automated |
| Explicit user cancel control | **NOT_RUN** | UI has no cancel button; in-flight requests abort on unmount/new request (code path not exercised in renderer) |
| “More” menu coexistence | **STATIC_REVIEWED** | rc.3 sidebar “更多/插件” entries and settings.section are both present in the run; no click-through of the new menu |
| Evidence | — | `evidence/browser-renderer/probe.json`, `probe.mjs`, `01-welcome.png` … `12-settings-closed.png` |

This is a real renderer of the **Web** carrier, not the Desktop window/preload.

## Real Desktop window / Electron renderer

| Check | Result | Reason |
|---|---|---|
| Desktop window, preload, native picker, renderer activation/rendering, unload cleanup, “更多” menu coexistence | **NOT_RUN** | A second Desktop instance with its own `DSH_HOME` + `--user-data-dir` + CDP port exited immediately (code 9) without creating a profile or exposing CDP: the app holds a process-lifetime single-instance lock. The real instance uses the user's live desktop profile and was neither restarted nor modified. Evidence: `evidence/desktop-isolated-probe.json`. Prerequisites: separate Windows user account/session, or a supported isolated test-instance switch, or explicit authorisation to restart the real Desktop with CDP. |

## Static / contract review (rc.3 release build)

| Check | Result | Evidence |
|---|---|---|
| plugin-manager surface: no `updateBundle`/`listVersions`; install/remove/enable/list/inspect/registries/wait/cancel present | **STATIC_REVIEWED** (+ runtime-observed) | `evidence/runtime-identity.json`, `evidence/rc3-host-info.json` |
| client-modules caches package metadata (including negative “not a client”) per specifier+baseUrl until Host restart | **STATIC_REVIEWED** | `evidence/runtime-identity.json`; `docs/client-ui-recovery.md` |
| `settings.section` still present in rc.3 client bundles (5 settings packages); new “more” slots in `ui-entry-customization` etc. | **STATIC_REVIEWED** | `evidence/rc3-slot-probe.json` |
| `uiWorkspace.pickDirectory` still present | **STATIC_REVIEWED** | `evidence/rc3-slot-probe.json` |

## Not tested (NOT_RUN)

| Combination | Note |
|---|---|
| DSH 0.2.1-rc.2 on this machine | historical evidence only (`outputs/`), not re-run |
| Desktop window/preload interaction on rc.2 or rc.3 | NOT_RUN |
| Linux / macOS | no test machine |
| npm registry / GitHub source install | nothing published; no channel action |
| Upgrade 1.4.0 → 1.4.4 on the real desktop profile | not performed; versions exercised only in throwaway `DSH_HOME` |
| Dynamic fault injection (loop/OOM/exit) | no isolated OS sandbox |

## Time records (UTC)

| Phase | Start | End | Duration |
|---|---|---|---|
| `node --test` (103 pass) | 08:03:01.578 | 08:03:05.213 | 3.6 s |
| `npm test` (103 pass, npm env) | 08:03:05.263 | 08:03:10.016 | 4.8 s |
| Client artifact consistency (`--check`) | 08:03:10.027 | 08:03:10.092 | 0.1 s |
| rc.3 Host: maintenance plugin 1.4.4 | 08:01:23.891 | 08:01:36.506 | 12.6 s |
| rc.3 Host: target plugin | 07:11:40.207 | 07:11:57.781 | 17.6 s |
| rc.3 Host `/info` + capability probe | 08:01:36.520 | 08:01:42.686 | 6.2 s |
| Real Chromium renderer flow | 08:02:24.879 | 08:02:55.758 | 30.9 s |
| Isolated Desktop probe | 07:12:59.070 | 07:12:59.727 | 0.7 s (NOT_RUN) |

## Historical rc.2 rows

The rc.2 matrix in `E:/creat/Codex/dsh设计插件优化建议/outputs/SUPPORT-MATRIX.md`
remains the historical record and is **not** rewritten as rc.3.
