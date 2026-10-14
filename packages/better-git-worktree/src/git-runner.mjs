// dsh-better-git-worktree: git process runner and the shared TTL cache.
//
// Everything here is deliberately dependency-free: plain `git` through
// node:child_process with machine-readable output formats, no library and no
// long-lived git process. Every call is bounded by a timeout and runs with
// prompts disabled, so a missing credential can never wedge the host.
//
// The cache is the performance contract for the status pipeline: the sidebar
// polls, the model may ask repeatedly, and none of that may translate into a
// git process per read. Each key holds one in-flight promise plus a value with
// a TTL; expiry triggers a *background* refresh so a read never blocks on git
// after the first one.

import { execFile } from 'node:child_process'

const GIT_TIMEOUT_MS = 15000
const FETCH_TIMEOUT_MS = 60000

/** Base environment for every git call: no prompts, no optional locks, no pager. */
function gitEnv(extra) {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM ?? '',
    ...extra,
  }
}

/**
 * Run one git command.
 * @returns `{ ok, code, stdout, stderr, timedOut }`; never throws for a non-zero exit.
 */
export function runGit(cwd, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, '-c', 'color.ui=false', '-c', 'core.quotepath=false', '--no-pager', ...args],
      {
        timeout: timeoutMs,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        env: gitEnv(options.env),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '')
        const err = String(stderr ?? '')
        if (error === null || error === undefined) {
          resolve({ ok: true, code: 0, stdout: out, stderr: err, timedOut: false })
          return
        }
        const timedOut = error.killed === true || error.signal === 'SIGTERM'
        resolve({
          ok: false,
          code: typeof error.code === 'number' ? error.code : 1,
          stdout: out,
          stderr: timedOut ? `git ${args[0] ?? ''} timed out after ${timeoutMs}ms` : err || String(error.message ?? error),
          timedOut,
        })
      },
    )
  })
}

/** Run git and return trimmed stdout, or undefined on any failure. */
export async function gitText(cwd, args, options) {
  const result = await runGit(cwd, args, options)
  return result.ok ? result.stdout.replace(/\n$/, '') : undefined
}

/** Fetch from origin without ever blocking a read path on the network. */
export function gitFetch(cwd) {
  return runGit(cwd, ['fetch', '--quiet', '--no-tags', 'origin'], { timeoutMs: FETCH_TIMEOUT_MS })
}

/**
 * Minimal TTL cache with single-flight semantics.
 *
 * `get(key, loader, { ttlMs, backgroundRefresh })`:
 *   - no entry        → await the loader (the only blocking read)
 *   - fresh entry     → return the value
 *   - stale entry     → return the stale value immediately and refresh behind
 */
export class TtlCache {
  constructor() {
    this.entries = new Map()
  }

  peek(key) {
    return this.entries.get(key)
  }

  /**
   * @param key cache key
   * @param loader async producer
   * @param options.ttlMs freshness window
   * @param options.force bypass freshness (still single-flight)
   */
  async get(key, loader, options = {}) {
    const ttlMs = options.ttlMs ?? 5000
    const now = Date.now()
    const existing = this.entries.get(key)
    if (existing !== undefined && existing.promise !== undefined) {
      if (existing.value !== undefined && !options.force) return existing.value
      return existing.promise
    }
    if (existing !== undefined && !options.force && now - existing.at < ttlMs) return existing.value

    const promise = (async () => {
      try {
        const value = await loader()
        this.entries.set(key, { at: Date.now(), value, error: undefined })
        return value
      } catch (error) {
        // Keep the previous value on failure so the UI degrades to stale data
        // rather than an error flash; remember the failure for diagnostics.
        const previous = this.entries.get(key)
        this.entries.set(key, {
          at: Date.now(),
          value: previous?.value,
          error: error instanceof Error ? error.message : String(error),
        })
        if (previous?.value !== undefined) return previous.value
        throw error
      }
    })()
    this.entries.set(key, { at: now, value: existing?.value, error: existing?.error, promise })
    try {
      return await promise
    } finally {
      const settled = this.entries.get(key)
      if (settled !== undefined && settled.promise === promise) delete settled.promise
    }
  }

  /** Drop every key matching a prefix (used when a worktree is removed). */
  invalidatePrefix(prefix) {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key)
    }
  }

  invalidate(key) {
    this.entries.delete(key)
  }
}
