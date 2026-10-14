// dsh-better-git-worktree: the durable session -> working-copy registry.
//
// The registry is the plugin's own source of truth for "which sessions live in
// a working copy": the harness keeps a session's cwd immutable, so nothing else
// can answer that question. It is plain JSON under the state directory.
//
// The file format (STATE_VERSION 1) is shared with every earlier release of this
// plugin, and sessions already bound to a working copy keep their binding only
// while it stays readable unchanged:
//
//   { "version": 1,
//     "worktrees": {
//       "<sessionId>": {
//         "sessionId": "<sessionId>",
//         "managedRoot": "<absolute path of the working copy>",   (required)
//         "repoRoot": "...", "branch": "dsh/<pet>", "petName": "<pet>",
//         "baseBranch": "main", "baseRef": "origin/main",
//         "origin": "pre-session" | "converted", "activated": true,
//         "createdAt": 1700000000000,
//         "sourceSessionId", "targetSessionId", "conversationCarried",
//         "stashRef", "stashEntry"                                (optional)
//       } } }
//
// Writing follows three rules, because the file is the only record of which
// sessions are bound to which copy:
//
//   1. It is written atomically (a temp file in the same directory, then rename),
//      so a crash can never leave a half file.
//   2. It is never written until it has been read. A missing file is an empty
//      registry; a file that exists but cannot be read, parsed or understood
//      (unreadable, not JSON, not an object, a version this release does not
//      know) leaves the registry in memory only and `problem` says why. The next
//      release, or the operator, can still read what is on disk.
//   3. What this release does not understand is carried through, not dropped:
//      records it cannot use and top-level fields it does not know are written
//      back as they were.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const STATE_VERSION = 1

export const REGISTRY_FILE = 'worktrees.json'

export class WorktreeRegistry {
  /**
   * @param {string} file - absolute path of the registry file.
   * @param {{read?: (file: string) => string, write?: (file: string, text: string) => void}} [fs]
   */
  constructor(file, fs = {}) {
    this.file = file
    this.records = new Map()
    /** Records in the file this release cannot use, written back untouched. */
    this.unusable = new Map()
    /** Top-level fields of the file other than `version` and `worktrees`. */
    this.extra = {}
    /** Why the file was not loaded, or undefined when it was (or did not exist). */
    this.problem = undefined
    this.read = fs.read ?? ((path) => readFileSync(path, 'utf8'))
    this.writeText = fs.write ?? defaultWrite
    this.load()
  }

  /** Whether changes are persisted: false after a file that could not be read. */
  get writable() {
    return this.problem === undefined
  }

  load() {
    let text
    try {
      text = this.read(this.file)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      this.problem = `${this.file} could not be read (${error instanceof Error ? error.message : String(error)})`
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.problem = `${this.file} is not valid JSON (${error instanceof Error ? error.message : String(error)})`
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.problem = `${this.file} does not hold a registry object`
      return
    }
    if (parsed.version !== STATE_VERSION) {
      this.problem = `${this.file} has registry version ${JSON.stringify(parsed.version)}; this release reads version ${STATE_VERSION}`
      return
    }
    const worktrees = parsed.worktrees
    if (worktrees !== undefined && (worktrees === null || typeof worktrees !== 'object' || Array.isArray(worktrees))) {
      this.problem = `${this.file} has a "worktrees" field that is not an object`
      return
    }
    for (const [sessionId, record] of Object.entries(worktrees ?? {})) {
      if (record !== null && typeof record === 'object' && typeof record.managedRoot === 'string') {
        this.records.set(sessionId, { sessionId, ...record })
      } else {
        this.unusable.set(sessionId, record)
      }
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (key !== 'version' && key !== 'worktrees') this.extra[key] = value
    }
  }

  /** Write the registry; returns false (and writes nothing) when the file was never read. */
  persist() {
    if (!this.writable) return false
    const merged = { ...Object.fromEntries(this.unusable), ...Object.fromEntries(this.records) }
    const worktrees = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)))
    const payload = { ...this.extra, version: STATE_VERSION, worktrees }
    this.writeText(this.file, `${JSON.stringify(payload, null, 2)}\n`)
    return true
  }

  get(sessionId) {
    return this.records.get(sessionId)
  }

  list() {
    return [...this.records.values()]
  }

  put(record) {
    this.records.set(record.sessionId, record)
    this.persist()
    return record
  }

  patch(sessionId, fields) {
    const current = this.records.get(sessionId)
    if (current === undefined) return undefined
    const next = { ...current, ...fields }
    this.records.set(sessionId, next)
    this.persist()
    return next
  }

  remove(sessionId) {
    const existed = this.records.delete(sessionId)
    if (existed) this.persist()
    return existed
  }

  /** Find the registry record for any session sharing a working copy root. */
  findByRoot(root) {
    return [...this.records.values()].find((record) => record.managedRoot === root)
  }
}

/** Atomic write: a unique temp file beside the target, then rename over it. */
function defaultWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = join(dirname(file), `.${REGISTRY_FILE}.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}
