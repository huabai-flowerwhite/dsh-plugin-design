// Runtime fingerprint tests: the running DSH version must never come from an
// unrelated npm script's package version.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runtimeFingerprint } from '../src/runtime/fingerprint.js'

const baseEnv = {
  DSH_VERSION: '',
  DSH_RUNTIME_VERSION: '',
  DSH_CLIENT_VERSION: '',
  npm_package_name: '',
  npm_package_version: '',
}

test('this plugin\'s npm_package_version is not treated as the DSH runtime', () => {
  const fingerprint = runtimeFingerprint({
    env: { ...baseEnv, npm_package_name: 'dsh-plugin-design', npm_package_version: '1.4.4' },
  })
  assert.equal(fingerprint.running.version, null)
  assert.equal(fingerprint.running.versionSource, 'unknown')
  assert.equal(fingerprint.effectiveSource, 'unknown')
  assert.deepEqual(fingerprint.running.candidates, [])
})

test('npm_package_version is used only for a known DSH package', () => {
  const fingerprint = runtimeFingerprint({
    env: { ...baseEnv, npm_package_name: '@deepseek-ai/dsh-desktop', npm_package_version: '0.2.1-rc.3' },
  })
  assert.equal(fingerprint.running.version, '0.2.1-rc.3')
  assert.equal(fingerprint.running.versionSource, 'env:npm_package_version')
})

test('an explicit DSH_VERSION wins over the npm fallback', () => {
  const fingerprint = runtimeFingerprint({
    env: {
      ...baseEnv,
      DSH_VERSION: '0.2.1-rc.3',
      npm_package_name: '@deepseek-ai/dsh-desktop',
      npm_package_version: '9.9.9',
    },
  })
  assert.equal(fingerprint.running.version, '0.2.1-rc.3')
  assert.equal(fingerprint.running.versionSource, 'env:DSH_VERSION')
  assert.equal(fingerprint.running.candidates.some((entry) => entry.source === 'env:npm_package_version'), false)
})
