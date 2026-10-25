// dsh-plugin-design — deterministic tar.gz writer and bounded safe reader.
//
// A prebuilt `.tgz` is part of the distribution contract, so the archive must
// be reproducible (fixed mtime/mode/order) and readable without trusting it:
// the reader bounds entry count, total size and per-file size, rejects absolute
// paths, `..` escapes, links and duplicate names, and never writes anything
// while listing. No external tar/npm dependency is required.

import { gzipSync, gunzipSync } from 'node:zlib'

const BLOCK = 512
const MAX_ENTRIES = 4000
const MAX_TOTAL_BYTES = 128 * 1024 * 1024
const MAX_FILE_BYTES = 16 * 1024 * 1024

function octal(value, width) {
  const text = value.toString(8)
  return text.padStart(width - 1, '0') + '\u0000'
}

function writeString(buffer, offset, width, value) {
  const bytes = Buffer.from(String(value), 'utf8')
  if (bytes.length > width) throw new Error('tar field too long: ' + value)
  bytes.copy(buffer, offset)
}

function splitPath(name) {
  const bytes = Buffer.byteLength(name, 'utf8')
  if (bytes <= 100) return { prefix: '', name }
  const parts = name.split('/')
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const prefix = parts.slice(0, index).join('/')
    const rest = parts.slice(index).join('/')
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(rest, 'utf8') <= 100) {
      return { prefix, name: rest }
    }
  }
  throw new Error('tar path too long: ' + name)
}

function header(entry) {
  const buffer = Buffer.alloc(BLOCK, 0)
  const split = splitPath(entry.path)
  writeString(buffer, 0, 100, split.name)
  writeString(buffer, 100, 8, octal(entry.mode || 0o644, 8))
  writeString(buffer, 108, 8, octal(0, 8))
  writeString(buffer, 116, 8, octal(0, 8))
  writeString(buffer, 124, 12, octal(entry.bytes.length, 12))
  writeString(buffer, 136, 12, octal(0, 12))
  buffer.fill(0x20, 148, 156)
  buffer.write(entry.type || '0', 156, 1, 'latin1')
  writeString(buffer, 257, 6, 'ustar\u0000')
  writeString(buffer, 263, 2, '00')
  writeString(buffer, 265, 32, 'root')
  writeString(buffer, 297, 32, 'root')
  writeString(buffer, 345, 155, split.prefix)
  let checksum = 0
  for (const byte of buffer) checksum += byte
  writeString(buffer, 148, 8, checksum.toString(8).padStart(6, '0') + '\u0000 ')
  return buffer
}

/**
 * Build a deterministic gzip'd tar.
 * @param {{path: string, bytes: Buffer, mode?: number}[]} entries
 * @param {{prefix?: string}} [options]
 * @returns {Buffer}
 */
export function createTarGz(entries, options = {}) {
  const prefix = options.prefix === undefined ? 'package' : options.prefix
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path))
  const chunks = []
  if (prefix !== '') {
    chunks.push(header({ path: prefix.replace(/\/+$/, '') + '/', bytes: Buffer.alloc(0), mode: 0o755, type: '5' }))
  }
  for (const entry of sorted) {
    const archivePath = (prefix === '' ? '' : prefix.replace(/\/+$/, '') + '/') + entry.path.replace(/^\/+/, '')
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes)
    chunks.push(header({ path: archivePath, bytes, mode: entry.mode || 0o644 }))
    chunks.push(bytes)
    const remainder = bytes.length % BLOCK
    if (remainder !== 0) chunks.push(Buffer.alloc(BLOCK - remainder, 0))
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0))
  return gzipSync(Buffer.concat(chunks), { level: 9 })
}

function parseOctal(buffer) {
  const text = buffer.toString('latin1').replace(/\u0000/g, ' ').trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) throw new Error('invalid tar octal field: ' + JSON.stringify(text))
  return Number.parseInt(text, 8)
}

function safeEntryPath(name) {
  const normalized = String(name).replace(/\\/g, '/')
  if (normalized === '') return null
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  const parts = normalized.split('/')
  if (parts.some((part) => part === '..')) return null
  return parts.filter((part) => part !== '' && part !== '.').join('/')
}

/**
 * List entries of a gzip'd tar without extracting anything.
 * @returns {{entries: {path: string, bytes: Buffer, mode: number}[], warnings: string[]}}
 */
export function readTarGz(buffer, options = {}) {
  const limits = {
    maxEntries: options.maxEntries || MAX_ENTRIES,
    maxTotalBytes: options.maxTotalBytes || MAX_TOTAL_BYTES,
    maxFileBytes: options.maxFileBytes || MAX_FILE_BYTES,
  }
  let raw
  try {
    raw = gunzipSync(buffer, { maxOutputLength: limits.maxTotalBytes + BLOCK * 4 })
  } catch (error) {
    throw new Error('ARCHIVE_UNREADABLE: ' + (error && error.message ? error.message : error))
  }
  const entries = []
  const warnings = []
  const seen = new Set()
  let offset = 0
  let total = 0
  while (offset + BLOCK <= raw.length) {
    const block = raw.subarray(offset, offset + BLOCK)
    if (block.every((byte) => byte === 0)) break
    const name = block.subarray(0, 100).toString('utf8').replace(/\u0000.*$/, '')
    const prefix = block.subarray(345, 500).toString('utf8').replace(/\u0000.*$/, '')
    const type = block.subarray(156, 157).toString('latin1') || '0'
    const size = parseOctal(block.subarray(124, 136))
    const mode = parseOctal(block.subarray(100, 108))
    offset += BLOCK
    if (type === '5') {
      offset += Math.ceil(size / BLOCK) * BLOCK
      continue
    }
    if (type !== '0' && type !== '\u0000') {
      throw new Error('ARCHIVE_LINK_OR_SPECIAL_ENTRY_REJECTED: type=' + type + ' path=' + name)
    }
    if (size > limits.maxFileBytes) throw new Error('ARCHIVE_ENTRY_TOO_LARGE: ' + name)
    if (size > raw.length - offset) throw new Error('ARCHIVE_TRUNCATED: ' + name)
    if (entries.length >= limits.maxEntries) throw new Error('ARCHIVE_ENTRY_LIMIT_EXCEEDED')
    total += size
    if (total > limits.maxTotalBytes) throw new Error('ARCHIVE_TOTAL_BYTES_EXCEEDED')
    const full = prefix === '' ? name : prefix + '/' + name
    const safe = safeEntryPath(full)
    if (safe === null) throw new Error('ARCHIVE_PATH_ESCAPE_REJECTED: ' + full)
    if (seen.has(safe)) throw new Error('ARCHIVE_DUPLICATE_ENTRY_REJECTED: ' + safe)
    seen.add(safe)
    entries.push({ path: safe, bytes: Buffer.from(raw.subarray(offset, offset + size)), mode })
    offset += Math.ceil(size / BLOCK) * BLOCK
  }
  if (entries.length === 0) warnings.push('archive contains no regular files')
  return { entries, warnings }
}

/** Strip the npm `package/` prefix for consumers. */
export function stripPackagePrefix(entries, prefix = 'package/') {
  return entries.map((entry) => ({
    ...entry,
    path: entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path,
  })).filter((entry) => entry.path !== '')
}
