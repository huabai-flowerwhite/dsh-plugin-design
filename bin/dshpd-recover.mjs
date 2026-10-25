#!/usr/bin/env node
// dsh-plugin-design — standalone recovery entry point.
//
// Dependency closure: this file imports only src/recovery/cli.js, which imports
// the snapshot/journal/path helpers and node builtins. It never loads the Host
// plugin, the rule engine or the audited plugin, so it keeps working when DSH
// itself cannot boot or the plugin entry is broken.

import { main } from '../src/recovery/cli.js'

const { code, body } = await main(process.argv.slice(2))
process.stdout.write(JSON.stringify(body, null, 2) + '\n')
process.exitCode = code
