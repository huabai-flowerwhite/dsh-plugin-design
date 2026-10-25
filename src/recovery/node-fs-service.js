// dsh-plugin-design — node:fs backed FileSystem adapter.
//
// Used by the standalone recovery CLI and by tests. It implements the subset of
// the public FileSystem contract this plugin relies on, including opaque
// version tokens and compare-and-swap writes, so the same snapshot/restore code
// can run with or without the DSH host.

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'

function digest(text) {
  return createHash('sha256').update(text).digest('hex')
}

function versionOf(info) {
  return digest([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')).slice(0, 32)
}

export class NodeFileSystem {
  constructor() {
    this.sandboxMode = 'node:fs'
  }

  async resolve(target, options = {}) {
    const path = typeof target === 'string' ? resolvePath(options.cwd ? resolvePath(options.cwd, target) : target) : target.displayPath
    return { targetKey: digest(path.toLowerCase()), displayPath: path }
  }

  targetPath(target) {
    return typeof target === 'string' ? resolvePath(target) : target.displayPath
  }

  async stat(target, signal) {
    if (signal && signal.aborted) throw new Error('ABORTED')
    try {
      const info = await fs.stat(this.targetPath(target))
      return {
        type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
        size: info.isFile() ? info.size : undefined,
        version: versionOf(info),
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') return undefined
      throw error
    }
  }

  async lstat(path, options = {}) {
    try {
      const info = await fs.lstat(options.cwd ? resolvePath(options.cwd, path) : path)
      return {
        type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
        version: versionOf(info),
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') return undefined
      throw error
    }
  }

  async readText(target, signal) {
    if (signal && signal.aborted) throw new Error('ABORTED')
    return fs.readFile(this.targetPath(target), 'utf8')
  }

  async readBytes(target, signal, maxBytes) {
    if (signal && signal.aborted) throw new Error('ABORTED')
    const path = this.targetPath(target)
    const info = await fs.stat(path)
    if (typeof maxBytes === 'number' && info.size > maxBytes) {
      const error = new Error('file exceeds the read budget')
      error.code = 'FS_TOO_LARGE'
      throw error
    }
    return fs.readFile(path)
  }

  async listDir(target) {
    const entries = await fs.readdir(this.targetPath(target), { withFileTypes: true })
    const base = this.targetPath(target)
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      target: { targetKey: digest((base + '/' + entry.name).toLowerCase()), displayPath: resolvePath(base, entry.name) },
    }))
  }

  async writeText(target, content, expected, signal, policy) {
    if (signal && signal.aborted) throw new Error('ABORTED')
    if (policy && policy.mode === 'read-only') {
      const error = new Error('sandbox policy denied the write')
      error.code = 'FS_SANDBOX_DENIED'
      throw error
    }
    const path = this.targetPath(target)
    let info = null
    try {
      info = await fs.stat(path)
    } catch (error) {
      info = null
    }
    if (expected && expected.kind === 'createIfAbsent' && info !== null) {
      const error = new Error('target already exists')
      error.code = 'FS_NOT_OBSERVED'
      throw error
    }
    if (expected && expected.kind === 'replaceIfVersion') {
      if (info === null || versionOf(info) !== String(expected.version)) {
        const error = new Error('stale version')
        error.code = 'FS_STALE_VERSION'
        throw error
      }
    }
    const before = info === null ? null : await fs.readFile(path, 'utf8')
    await fs.mkdir(dirname(path), { recursive: true })
    const temporary = path + '.dshpd-' + randomUUID() + '.tmp'
    const handle = await fs.open(temporary, 'wx', info === null ? 0o644 : info.mode)
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, path)
    const after = await fs.stat(path)
    return {
      operation: before === null ? 'create' : 'update',
      version: versionOf(after),
      before,
      after: content,
    }
  }

  async editText(target, edit, expected, signal) {
    if (signal && signal.aborted) throw new Error('ABORTED')
    const path = this.targetPath(target)
    const before = await fs.readFile(path, 'utf8')
    const info = await fs.stat(path)
    if (expected && expected.version && versionOf(info) !== String(expected.version)) {
      const error = new Error('stale version')
      error.code = 'FS_STALE_VERSION'
      throw error
    }
    const matches = before.split(edit.oldString).length - 1
    if (matches === 0) throw new Error('oldString not found')
    if (matches > 1 && edit.replaceAll !== true) throw new Error('oldString matched ' + matches + ' times')
    const after = edit.replaceAll === true ? before.split(edit.oldString).join(edit.newString) : before.replace(edit.oldString, edit.newString)
    await this.writeText(target, after, { kind: 'replaceIfVersion', version: versionOf(info) }, signal)
    return { version: versionOf(await fs.stat(path)), before, after }
  }
}
