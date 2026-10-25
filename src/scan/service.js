// dsh-plugin-design — bounded scan scheduler.
//
// All directory walking, file reading and rule evaluation runs in a worker
// thread, one job at a time. The Host event loop therefore keeps answering
// tools, HTTP and WebSocket traffic while a large tree is scanned, and a
// timeout or caller cancellation terminates the worker instead of pretending
// the work stopped.

import { Worker } from 'node:worker_threads'

const WORKER_URL = new URL('./worker.js', import.meta.url)
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_QUEUE = 4

export class ScanUnavailableError extends Error {
  constructor(message, code = 'SCAN_UNAVAILABLE') {
    super(message)
    this.name = 'ScanUnavailableError'
    this.code = code
  }
}

export class ScanBusyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ScanBusyError'
    this.code = 'SCAN_QUEUE_FULL'
  }
}

/**
 * Serial scan scheduler. A single worker per request keeps cancellation simple
 * (terminate) and bounds memory (V8 heap limit); the queue is finite so a
 * burst of Settings-page clicks cannot accumulate unbounded work.
 */
export class ScanScheduler {
  constructor(options = {}) {
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
    this.maxQueue = Number.isFinite(options.maxQueue) ? options.maxQueue : MAX_QUEUE
    this.heapMb = Number.isFinite(options.heapMb) ? options.heapMb : 256
    this.queue = []
    this.running = null
    this.closed = false
    this.stats = { started: 0, completed: 0, failed: 0, timedOut: 0, cancelled: 0, terminated: 0 }
  }

  get pending() {
    return this.queue.length + (this.running === null ? 0 : 1)
  }

  /**
   * Run one scan request.
   * @param {'analyze'|'collect'|'discover'} kind
   * @param {object} args
   * @param {{signal?: AbortSignal, timeoutMs?: number, jobKey?: string}} [options]
   */
  async request(kind, args, options = {}) {
    if (this.closed) throw new ScanUnavailableError('the scan scheduler is closed')
    const job = { kind, args, options, resolve: null, reject: null }
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve
      job.reject = reject
    })
    if (this.queue.length >= this.maxQueue) {
      throw new ScanBusyError('scan queue is full (' + this.maxQueue + ' pending); wait for the running scan or cancel it')
    }
    this.queue.push(job)
    this.pump()
    return promise
  }

  pump() {
    if (this.running !== null || this.queue.length === 0 || this.closed) return
    const job = this.queue.shift()
    this.running = job
    this.execute(job).then(
      (value) => {
        this.running = null
        job.resolve(value)
        this.pump()
      },
      (error) => {
        this.running = null
        job.reject(error)
        this.pump()
      },
    )
  }

  execute(job) {
    return new Promise((resolve, reject) => {
      this.stats.started += 1
      const id = 'scan-' + this.stats.started
      const timeoutMs = Number.isFinite(job.options.timeoutMs) ? job.options.timeoutMs : this.timeoutMs
      let worker
      try {
        worker = new Worker(WORKER_URL, {
          resourceLimits: {
            maxOldGenerationSizeMb: this.heapMb,
            maxYoungGenerationSizeMb: 32,
            maxOldGenerationSizeMb: this.heapMb,
          },
        })
      } catch (error) {
        reject(new ScanUnavailableError('cannot start the scan worker: ' + (error && error.message ? error.message : error), 'SCAN_WORKER_FAILED'))
        return
      }
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        worker.terminate().catch(() => {}).finally(() => {
          this.stats.terminated += 1
          fn(value)
        })
      }
      const failJob = (code, message) => {
        this.stats.failed += 1
        finish(reject, new ScanUnavailableError(message, code))
      }
      const timer = setTimeout(() => {
        this.stats.timedOut += 1
        finish(reject, new ScanUnavailableError(
          'scan exceeded its ' + timeoutMs + ' ms budget and was terminated; the result is INCOMPLETE',
          'SCAN_TIMEOUT',
        ))
      }, timeoutMs)
      const signal = job.options.signal
      const onAbort = () => {
        this.stats.cancelled += 1
        finish(reject, new ScanUnavailableError('scan was cancelled by the caller', 'SCAN_CANCELLED'))
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      worker.on('message', (message) => {
        if (!message || message.id !== id) return
        if (message.ok === true) {
          this.stats.completed += 1
          finish(resolve, message)
          return
        }
        failJob('SCAN_WORKER_ERROR', message.error || 'scan worker failed')
      })
      worker.on('error', (error) => {
        failJob('SCAN_WORKER_ERROR', 'scan worker crashed: ' + (error && error.message ? error.message : error))
      })
      worker.on('exit', (code) => {
        if (settled) return
        failJob('SCAN_WORKER_EXITED', 'scan worker exited before answering (code ' + code + ')')
      })
      worker.postMessage({ id, kind: job.kind, args: job.args })
    })
  }

  async dispose() {
    this.closed = true
    const error = new ScanUnavailableError('the scan scheduler was disposed', 'SCAN_DISPOSED')
    for (const job of this.queue.splice(0)) job.reject(error)
    if (this.running !== null) {
      // execute()'s finish path terminates the worker when the rejection lands
      this.running.options.signal?.dispatchEvent?.(new Event('abort'))
    }
  }
}
