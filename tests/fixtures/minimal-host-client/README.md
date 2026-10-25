# dshpd-demo-plugin

A minimal DeepSeek Harness plugin with a Host half (one tool + one route) and a
Client half (a Settings section), used as the independent-distribution fixture.

## Requirements

- DSH `>=0.2.0 <0.3.0` (see `SUPPORT-MATRIX.md` for what was actually tested).
- Web carrier. Desktop is not claimed by this fixture.
- No dependency on `dsh-plugin-design` or any author development environment.

## Install

```sh
dsh plugin --profile web add ./dshpd-demo-plugin-1.0.0.tgz
```

Restart the client after installing.

## Configuration

None. The plugin exposes the `demo_status` tool and a read-only
`/dshpd-demo/health` route, plus a "Demo plugin" Settings section.

## Update

Install the new `.tgz` through the official plugin manager update path; keep the
previous package for rollback.

## Uninstall

```sh
dsh plugin --profile web remove dshpd-demo-plugin
```

The plugin stores no user data.

## Verify

1. Restart the client.
2. Open Settings and confirm the "Demo plugin" section renders.
3. Call the `demo_status` tool from an agent session.
