// Differential test against node-semver 7.8.5 semantics (the options DSH uses).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { satisfies, validRange, validVersion, compare, parseVersion } from '../src/semver.js'
import { semverRangeIsValid, semverSatisfies } from '../src/rules.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/semver-cases.json', import.meta.url), 'utf8'))

test('matches semver 7.8.5 on every generated satisfies case', () => {
  const mismatches = []
  for (const item of fixture.cases) {
    const actual = satisfies(item.version, item.range, { includePrerelease: true })
    if (actual !== item.satisfied) mismatches.push({ ...item, actual })
  }
  assert.deepEqual(mismatches, [])
})

test('range validity agrees with node-semver on the generated corpus', () => {
  for (const [range, expected] of Object.entries(fixture.validRanges)) {
    const actual = validRange(range) === null ? null : true
    const want = expected === null ? null : true
    assert.equal(actual, want, 'range ' + JSON.stringify(range))
  }
})

test('version validity agrees with node-semver on the generated corpus', () => {
  for (const [version, expected] of Object.entries(fixture.validVersions)) {
    assert.equal(validVersion(version), expected, version)
  }
})

test('the ruleset treats an empty engines range as unmet, like the official helper', () => {
  assert.equal(semverSatisfies('0.2.1', ''), false)
  assert.equal(semverRangeIsValid(''), false)
  assert.equal(semverRangeIsValid('*'), true)
  assert.equal(semverRangeIsValid('latest'), false)
})

test('known 1.3.2 misclassifications are fixed', () => {
  assert.equal(semverSatisfies('0.2.1', '^0'), true)
  assert.equal(semverSatisfies('0.2.1', '>= 0.2.0'), true)
  assert.equal(semverSatisfies('0.2.5', '0.2.0 - 0.2.9'), true)
  assert.equal(semverSatisfies('0.2.1', '*'), true)
  assert.equal(semverSatisfies('0.2.1-rc.2', '>=0.1.5-rc.1 <0.3.0'), true)
  assert.equal(semverSatisfies('0.2.1-rc.2', '^0.2.1'), false)
  assert.equal(semverSatisfies('0.2.0-alpha.1', '^0.2'), true)
})

test('build metadata is ignored and prerelease ordering is correct', () => {
  assert.equal(compare('1.2.3+build.5', '1.2.3+build.9'), 0)
  assert.equal(compare('1.2.3-rc.1', '1.2.3'), -1)
  assert.equal(compare('1.2.3-rc.2', '1.2.3-rc.10'), -1)
  assert.equal(parseVersion('nonsense'), null)
})
