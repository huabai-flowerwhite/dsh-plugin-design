// dsh-plugin-design — SemVer range engine.
//
// Why this exists: `engines.dsh` gating in DSH uses node-semver with
// `{ includePrerelease: true }` (packages/boot/app-boot/src/plugin-compatibility.ts).
// A hand-written approximation disagrees with it on legal input (`^0`,
// `>= 0.2.0`, hyphen ranges, partial ranges, build metadata), which produced
// false "incompatible" and false "compatible" verdicts in 1.3.2.
//
// This module implements node-semver's range grammar for the operations DSH
// needs. It is verified against a differential fixture generated with
// semver@7.8.5 (tests/fixtures/semver-cases.json); the fixture is data, so the
// shipped package still has zero runtime dependencies.
//
// Supported: exact, partial, x/* ranges, `^`, `~`, `>`, `>=`, `<`, `<=`, `=`,
// hyphen ranges, `||` unions, directive whitespace, build metadata, the
// documented prerelease gate, and `includePrerelease`.

const NUMERIC = /^\d+$/

/** SemVer parse; returns null for invalid input. */
export function parseVersion(value, options = {}) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  const loose = options.loose === true
  const pattern = loose
    ? /^[v=\s]*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/
    : /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/
  const match = pattern.exec(raw)
  if (match === null) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null
  const pre = match[4] === undefined ? [] : match[4].split('.')
  for (const part of pre) {
    if (part === '') return null
    if (NUMERIC.test(part) && part.length > 1 && part[0] === '0') return null
  }
  return {
    raw,
    major,
    minor,
    patch,
    pre,
    build: match[5] === undefined ? [] : match[5].split('.'),
  }
}

/** node-semver `valid()`; returns the normalized version or null. */
export function validVersion(value, options) {
  const parsed = parseVersion(value, options)
  if (parsed === null) return null
  return formatVersion(parsed)
}

export function formatVersion(version) {
  const base = version.major + '.' + version.minor + '.' + version.patch
  return version.pre.length > 0 ? base + '-' + version.pre.join('.') : base
}

function compareIdentifiers(left, right) {
  const leftNumeric = NUMERIC.test(left)
  const rightNumeric = NUMERIC.test(right)
  if (leftNumeric && rightNumeric) {
    const a = Number(left)
    const b = Number(right)
    return a === b ? 0 : a < b ? -1 : 1
  }
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left === right ? 0 : left < right ? -1 : 1
}

function comparePre(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const order = compareIdentifiers(a, b)
    if (order !== 0) return order
  }
  return 0
}

/** Compare two parsed versions (build metadata ignored). */
export function compareVersions(left, right) {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePre(left.pre, right.pre)
}

export function compare(left, right, options) {
  const a = parseVersion(left, options)
  const b = parseVersion(right, options)
  if (a === null || b === null) return null
  return compareVersions(a, b)
}

// ---------------------------------------------------------------------------
// Range grammar
// ---------------------------------------------------------------------------

const COMPARATOR = /^(<=|>=|<|>|=|~>|~|\^)?\s*(.*)$/
const PARTIAL = /^[v=]?\s*(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function isWild(part) {
  return part === undefined || part === 'x' || part === 'X' || part === '*'
}

function parsePartial(text) {
  const match = PARTIAL.exec(String(text).trim())
  if (match === null) return null
  const wildMinor = isWild(match[2])
  const wildPatch = isWild(match[3])
  return {
    major: isWild(match[1]) ? null : Number(match[1]),
    minor: wildMinor ? null : Number(match[2]),
    patch: wildPatch ? null : Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
    wildMinor,
    wildPatch,
    xMajor: isWild(match[1]),
  }
}

function versionOf(major, minor, patch, pre) {
  return { major, minor, patch, pre: pre || [], build: [], raw: null }
}

function preZero() {
  return ['0']
}

/**
 * The `-0` lower-bound marker. node-semver (semver 7) appends it only to
 * *partial* ^/~ lower bounds and to hyphen lower bounds when
 * `includePrerelease` is on; a full `^1.2.3` keeps `>=1.2.3` and therefore
 * still rejects `1.2.3-rc.1`. This asymmetry is verified by the differential
 * fixture, so it must stay exact.
 */
function lower(version, z) {
  if (z !== true || version.pre.length > 0) return version
  return { ...version, pre: preZero() }
}

/**
 * Expand one comparator token to normalized `{op, version}` comparators.
 * Mirrors node-semver's replaceXRanges / replaceTildes / replaceCarets.
 */
function expandComparator(token, z) {
  const match = COMPARATOR.exec(String(token).trim())
  if (match === null) return null
  let operator = match[1] === undefined ? '' : match[1]
  if (operator === '~>') operator = '~'
  const partial = parsePartial(match[2])
  if (partial === null) return null
  if (operator === '=') operator = ''
  if (partial.xMajor) {
    // `*`, `x`, `X` and `>=*`-style tokens: any version.
    if (operator === '' || operator === '>=' || operator === '~' || operator === '^') return [{ op: '', version: null }]
    if (operator === '<' || operator === '>') return [{ op: '<', version: versionOf(0, 0, 0, preZero()) }]
    if (operator === '<=') return [{ op: '', version: null }]
    return null
  }
  const major = partial.major
  const hasMinor = partial.wildMinor === false
  const hasPatch = partial.wildPatch === false
  const minor = hasMinor ? partial.minor : 0
  const patch = hasPatch ? partial.patch : 0

  if (operator === '') {
    if (!hasMinor || !hasPatch) {
      // 1 / 1.2 -> x-range
      const upperMajor = major + 1
      if (!hasMinor) return [{ op: '>=', version: lower(versionOf(major, 0, 0), z) }, { op: '<', version: versionOf(upperMajor, 0, 0, preZero()) }]
      return [{ op: '>=', version: lower(versionOf(major, minor, 0), z) }, { op: '<', version: versionOf(major, minor + 1, 0, preZero()) }]
    }
    return [{ op: '', version: versionOf(major, minor, patch, partial.pre) }]
  }

  if (operator === '~') {
    if (!hasMinor) return [{ op: '>=', version: lower(versionOf(major, 0, 0), z) }, { op: '<', version: versionOf(major + 1, 0, 0, preZero()) }]
    if (!hasPatch) return [{ op: '>=', version: lower(versionOf(major, minor, 0), z) }, { op: '<', version: versionOf(major, minor + 1, 0, preZero()) }]
    return [{ op: '>=', version: versionOf(major, minor, patch, partial.pre) }, { op: '<', version: versionOf(major, minor + 1, 0, preZero()) }]
  }

  if (operator === '^') {
    if (!hasMinor) return [{ op: '>=', version: lower(versionOf(major, 0, 0), z) }, { op: '<', version: versionOf(major + 1, 0, 0, preZero()) }]
    if (!hasPatch) {
      if (major === 0) return [{ op: '>=', version: lower(versionOf(0, minor, 0), z) }, { op: '<', version: versionOf(0, minor + 1, 0, preZero()) }]
      return [{ op: '>=', version: lower(versionOf(major, minor, 0), z) }, { op: '<', version: versionOf(major + 1, 0, 0, preZero()) }]
    }
    if (major > 0) return [{ op: '>=', version: versionOf(major, minor, patch, partial.pre) }, { op: '<', version: versionOf(major + 1, 0, 0, preZero()) }]
    if (minor > 0) return [{ op: '>=', version: versionOf(0, minor, patch, partial.pre) }, { op: '<', version: versionOf(0, minor + 1, 0, preZero()) }]
    return [{ op: '>=', version: versionOf(0, 0, patch, partial.pre) }, { op: '<', version: versionOf(0, 0, patch + 1, preZero()) }]
  }

  // Plain (in)equalities with a partial version.
  if (!hasMinor || !hasPatch) {
    if (operator === '>') {
      if (!hasMinor) return [{ op: '>=', version: versionOf(major + 1, 0, 0) }]
      return [{ op: '>=', version: versionOf(major, minor + 1, 0) }]
    }
    if (operator === '>=') {
      return [{ op: '>=', version: versionOf(major, hasMinor ? minor : 0, 0) }]
    }
    if (operator === '<') {
      return [{ op: '<', version: versionOf(major, hasMinor ? minor : 0, 0, preZero()) }]
    }
    if (operator === '<=') {
      if (!hasMinor) return [{ op: '<', version: versionOf(major + 1, 0, 0, preZero()) }]
      return [{ op: '<', version: versionOf(major, minor + 1, 0, preZero()) }]
    }
    return null
  }
  return [{ op: operator, version: versionOf(major, minor, patch, partial.pre) }]
}

/** Expand a hyphen range (`a - b`) to comparators. */
function expandHyphen(from, to, z) {
  const low = parsePartial(from)
  const high = parsePartial(to)
  if (low === null || high === null) return null
  const comparators = []
  if (low.xMajor) comparators.push({ op: '', version: null })
  else comparators.push({ op: '>=', version: lower(versionOf(low.major, low.wildMinor ? 0 : low.minor, low.wildPatch ? 0 : low.patch, low.pre), z) })
  if (high.xMajor) return comparators
  if (high.wildMinor) comparators.push({ op: '<', version: versionOf(high.major + 1, 0, 0, preZero()) })
  else if (high.wildPatch) comparators.push({ op: '<', version: versionOf(high.major, high.minor + 1, 0, preZero()) })
  else comparators.push({ op: '<=', version: versionOf(high.major, high.minor, high.patch, high.pre) })
  return comparators
}

/**
 * Parse a range into a list of comparator sets.
 * Returns null when the range is invalid (node-semver throws / validRange null).
 */
export function parseRange(range, options = {}) {
  if (typeof range !== 'string') return null
  const z = options.includePrerelease === true
  const trimmed = range.trim()
  if (trimmed === '') return [[{ op: '', version: null }]]
  const sets = []
  for (const rawSet of trimmed.split('||')) {
    const setText = rawSet.trim()
    if (setText === '') return null
    const comparators = []
    // Hyphen ranges may contain surrounding whitespace.
    let remaining = setText
    const hyphen = /(^|\s)([^\s]+)\s+-\s+([^\s]+)(\s|$)/.exec(remaining)
    if (hyphen !== null) {
      const expanded = expandHyphen(hyphen[2], hyphen[3], z)
      if (expanded === null) return null
      comparators.push(...expanded)
      remaining = remaining.slice(0, hyphen.index) + ' ' + remaining.slice(hyphen.index + hyphen[0].length)
    }
    // Split on whitespace, but keep `>= 1.2.3` together.
    const tokens = remaining.split(/\s+/).filter(Boolean)
    for (let index = 0; index < tokens.length; index += 1) {
      let token = tokens[index]
      if (/^(<=|>=|<|>|=|~>|~|\^)$/.test(token) && index + 1 < tokens.length) {
        token += tokens[index + 1]
        index += 1
      }
      const expanded = expandComparator(token, z)
      if (expanded === null) return null
      comparators.push(...expanded)
    }
    if (comparators.length === 0) return null
    sets.push(comparators)
  }
  return sets.length === 0 ? null : sets
}

function testComparator(version, comparator) {
  if (comparator.version === null) return true
  const order = compareVersions(version, comparator.version)
  switch (comparator.op) {
    case '': return order === 0
    case '>': return order > 0
    case '>=': return order >= 0
    case '<': return order < 0
    case '<=': return order <= 0
    default: return false
  }
}

/**
 * node-semver `satisfies(version, range, options)`.
 * `includePrerelease` mirrors the official DSH compatibility check.
 */
export function satisfies(version, range, options = {}) {
  const parsed = parseVersion(version)
  if (parsed === null) return false
  const sets = parseRange(range, options)
  if (sets === null) return false
  const includePrerelease = options.includePrerelease === true
  return sets.some((comparators) => {
    const matched = comparators.every((comparator) => testComparator(parsed, comparator))
    if (!matched) return false
    if (!includePrerelease && parsed.pre.length > 0) {
      // A prerelease only satisfies a set that explicitly opts in for the
      // same [major, minor, patch] tuple (node-semver's prerelease gate).
      return comparators.some((comparator) => comparator.version !== null
        && comparator.version.pre.length > 0
        && comparator.version.major === parsed.major
        && comparator.version.minor === parsed.minor
        && comparator.version.patch === parsed.patch)
    }
    return true
  })
}

/**
 * node-semver `validRange(range)`: a normalized range string, or null.
 * Formatting differences from node-semver are allowed; only validity is
 * contractual. Returns '*' for an empty range, matching node-semver.
 */
export function validRange(range, options = {}) {
  const sets = parseRange(range, options)
  if (sets === null) return null
  const rendered = sets.map((comparators) => comparators
    .map((comparator) => comparator.version === null
      ? '*'
      : comparator.op + ' ' + formatVersion(comparator.version))
    .join(' ')).join(' || ')
  return rendered === '' ? '*' : rendered
}

/** Whether the range string is syntactically valid. */
export function isValidRange(range) {
  return validRange(range) !== null
}

/** Highest version in a list that satisfies the range (null when none). */
export function maxSatisfying(versions, range, options = {}) {
  let best = null
  for (const candidate of versions) {
    if (!satisfies(candidate, range, options)) continue
    if (best === null || compare(candidate, best) > 0) best = candidate
  }
  return best
}
