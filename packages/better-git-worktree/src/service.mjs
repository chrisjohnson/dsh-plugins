// The plugin's behaviour, without the dsh wiring: the status pipeline, creating
// and removing working copies, converting a session, and the endpoints the
// browser half calls. host.mjs hands this its few dsh-owned collaborators (the
// live agents, the workspace registry, the session factory) and mounts the
// result on a route and a tool; tests hand it fakes and real temp repositories.
//
// Why the Host owns a registry
// ----------------------------
// The harness fixes a session's cwd at creation (`session.header.cwd` is
// immutable creation metadata), so no one can move a running session. The
// closest faithful conversion is: create the working copy, move the session's
// uncommitted work into it, then continue the conversation in a *new* session
// rooted there. The registry is what makes "which sessions are worktree
// sessions" answerable at all; the sidebar badge and the tool's
// already-in-a-worktree guard both read it.
//
// Performance contract
// --------------------
// Every git read goes through the TTL cache in git-runner.mjs, a background timer
// keeps working-copy status warm, and `git fetch` is throttled per repository. A
// sidebar poll therefore costs no git process in the steady state.

import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'

import { TtlCache, gitFetch } from './git-runner.mjs'
import { baseRefFor, currentBranch, defaultBranch, readWorktreeStatus, repoRoot } from './repository.mjs'
import {
  branchReview,
  createWorktree,
  ensureWorktreesIgnored,
  moveWorkingTreeChanges,
  worktreeExists,
  worktreesIgnored,
} from './working-copy.mjs'
import { assertRemovable } from './removal.mjs'
import { archivePlan, decorationOf, statusSummary } from './status.mjs'
import { findOpener as defaultFindOpener, openFolder as defaultOpenFolder } from './open-folder.mjs'

export const STATUS_TTL_MS = 4000
export const BACKGROUND_REFRESH_MS = 15000
export const FETCH_INTERVAL_MS = 90000

const message = (error) => (error instanceof Error ? error.message : String(error))

const fail = (code, text) => ({ ok: false, error: { code, message: text, details: {} } })

/**
 * @param {object} deps
 * @param {import('./registry.mjs').WorktreeRegistry} deps.registry
 * @param {{info: Function, warn: Function}} deps.log
 * @param {(sessionId: string) => ({session?: {header?: {cwd?: string}}} | undefined)} deps.getAgent - live agent lookup.
 * @param {() => ({resolveByPath?: Function, delete?: Function} | undefined)} [deps.workspaceRegistry]
 * @param {(source: object, record: object) => Promise<{sessionId: string, carried: boolean}>} deps.createSession
 *   - creates the session that continues `source`'s conversation inside the working copy.
 * @param {TtlCache} [deps.cache]
 * @param {string} [deps.home] - the OS home directory (the fallback root and a removal root).
 * @param {object} [deps.overrides] - replaceable collaborators for tests.
 */
export function createService(deps) {
  const { registry, log, getAgent, createSession } = deps
  const cache = deps.cache ?? new TtlCache()
  const home = deps.home ?? homedir()
  const o = deps.overrides ?? {}
  const workspaceRegistry = deps.workspaceRegistry ?? (() => undefined)
  const exists = o.existsSync ?? existsSync
  const removeTree = o.rmSync ?? rmSync
  const findOpener = o.findOpener ?? defaultFindOpener
  const openFolder = o.openFolder ?? defaultOpenFolder
  const fetchRemote = o.gitFetch ?? gitFetch

  /** repoRoot -> timestamp of the last fetch we kicked. */
  const lastFetchAt = new Map()

  // -- the checkout a session works in ------------------------------------------

  /**
   * The directory a session works in: its managed working copy when it has one,
   * otherwise the session's own cwd. Every status surface works off this, so a
   * plain checkout session gets the same pill, menu and statuses as a worktree
   * session: it is the same question about a different directory.
   */
  function checkoutForSession(sessionId) {
    const record = registry.get(sessionId)
    if (record !== undefined) {
      return (o.worktreeExists ?? worktreeExists)(record)
        ? { path: record.managedRoot, record, baseBranch: record.baseBranch }
        : { path: undefined, record, baseBranch: record.baseBranch, missing: true }
    }
    const cwd = getAgent(sessionId)?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return undefined
    return { path: cwd, record: undefined, baseBranch: undefined }
  }

  /** Repository root for a session's checkout, or undefined when there is none. */
  async function repoRootForSession(sessionId) {
    const checkout = checkoutForSession(sessionId)
    if (checkout === undefined || checkout.path === undefined) return undefined
    return (await repoRoot(checkout.path)) ?? undefined
  }

  // -- status pipeline ----------------------------------------------------------

  function withDerived(merged) {
    return { ...merged, decoration: decorationOf(merged), archive: archivePlan(merged) }
  }

  async function statusFor(sessionId, options = {}) {
    const checkout = checkoutForSession(sessionId)
    if (checkout === undefined) return undefined
    if (checkout.missing === true) {
      return withDerived({
        ...checkout.record,
        missing: true,
        state: 'unknown',
        needsRebase: false,
        tooltip: `The managed worktree ${checkout.record.managedRoot} no longer exists on disk.`,
      })
    }
    // Cache by directory: sessions sharing a checkout share one status read.
    const key = `status:${checkout.path}`
    let status
    try {
      status = await cache.get(
        key,
        () => readWorktreeStatus(checkout.path, { baseBranch: checkout.baseBranch }),
        { ttlMs: STATUS_TTL_MS, force: options.force === true },
      )
    } catch (error) {
      return withDerived({
        sessionId,
        path: checkout.path,
        missing: false,
        state: 'unknown',
        needsRebase: false,
        tooltip: `${checkout.path} could not be inspected: ${message(error)}`,
      })
    }
    return withDerived({
      ...(checkout.record ?? { sessionId }),
      sessionId,
      path: checkout.path,
      ...status,
      missing: false,
      tooltip: statusSummary(status, { managedRoot: checkout.record?.managedRoot, petName: checkout.record?.petName }),
    })
  }

  /** Fire-and-forget refresh of every registered working copy; never awaited by a caller. */
  function warmAll() {
    for (const record of registry.list()) {
      void statusFor(record.sessionId).catch(() => {})
    }
  }

  /** Throttled, non-blocking `git fetch` for one repository. */
  function kickFetch(root, force = false) {
    const previous = lastFetchAt.get(root) ?? 0
    if (!force && Date.now() - previous < FETCH_INTERVAL_MS) return
    lastFetchAt.set(root, Date.now())
    void fetchRemote(root).then((result) => {
      if (!result.ok) {
        lastFetchAt.set(root, previous)
        return
      }
      cache.invalidatePrefix('status:')
      warmAll()
    })
  }

  // -- creating and converting --------------------------------------------------

  /**
   * Resolve the repository a session is currently working in.
   * @throws when the session cwd is not inside a git repository, or is already a managed copy.
   */
  async function repoForSession(sessionId) {
    const cwd = getAgent(sessionId)?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error(`session ${sessionId} has no working directory to build a worktree from`)
    }
    // A worktree of a worktree helps nobody: the session already has its own
    // isolated working copy, and nesting just buries the real project.
    const managedRoots = new Set(registry.list().map((record) => record.managedRoot))
    if (managedRoots.has(cwd)) {
      throw new Error(`this session already works in a git worktree (${cwd})`)
    }
    const root = await repoRoot(cwd)
    if (root === undefined) throw new Error(`${cwd} is not inside a git repository`)
    if (managedRoots.has(root)) {
      throw new Error(`this session's repository is already a managed git worktree (${root})`)
    }
    return { cwd, repoRoot: root }
  }

  /** Create a managed working copy for a session and register it. */
  async function createForSession(sessionId, options = {}) {
    const registerAs = options.registerAs ?? sessionId
    const existing = registry.get(registerAs)
    if (existing !== undefined) return { record: existing, reused: true }
    if (!registry.writable) {
      // A working copy nobody can find again is worse than none.
      throw new Error(`the worktree registry cannot be written (${registry.problem}); not creating a working copy it could not record`)
    }
    const { repoRoot: root } = await repoForSession(sessionId)
    const branchName = await currentBranch(root)
    const base = (await defaultBranch(root)) ?? branchName
    const baseRef = await baseRefFor(root, base)
    const created = await (o.createWorktree ?? createWorktree)({ repoRoot: root, home })
    const record = registry.put({
      sessionId: registerAs,
      sourceSessionId: registerAs === sessionId ? undefined : sessionId,
      origin: options.origin ?? 'pre-session',
      repoRoot: created.repoRoot,
      managedRoot: created.managedRoot,
      branch: created.branch,
      petName: created.petName,
      baseBranch: base,
      baseRef,
      activated: options.activated ?? false,
      createdAt: Date.now(),
    })
    lastFetchAt.set(created.repoRoot, Date.now())
    void fetchRemote(root).then((result) => {
      if (result.ok) {
        cache.invalidatePrefix('status:')
        warmAll()
      }
    })
    return { record, reused: false }
  }

  /**
   * Move a session's uncommitted work into a fresh working copy and continue the
   * conversation in a new session rooted there.
   */
  async function convertSession(sessionId, options = {}) {
    const existing = registry.get(sessionId)
    if (existing !== undefined) {
      throw new Error(`session ${sessionId} is already a worktree session at ${existing.managedRoot}`)
    }
    const source = getAgent(sessionId)
    if (source === undefined) throw new Error(`session ${sessionId} is not live`)

    const { record } = await createForSession(sessionId, { origin: options.origin ?? 'converted' })
    let move = { moved: false, files: 0 }
    if (options.moveChanges !== false) {
      move = await (o.moveWorkingTreeChanges ?? moveWorkingTreeChanges)(
        record.repoRoot,
        record.managedRoot,
        `dsh-better-git-worktree ${record.branch}`,
      )
      if (move.moved) registry.patch(sessionId, { stashRef: move.stashRef, stashEntry: move.stashEntry })
    }

    let targetSessionId
    let conversationCarried = false
    try {
      const created = await createSession(source, record)
      targetSessionId = created.sessionId
      conversationCarried = created.carried
      // The client watches the snapshot and performs the Workspace + Session
      // activation for this target, then clears `activated`.
      registry.patch(sessionId, { targetSessionId, conversationCarried, activated: false })
    } catch (error) {
      // The working copy and the moved work stay: they are the user's, and the
      // client can still open a fresh session there.
      return { ok: false, record, move, error: message(error) }
    }
    return { ok: true, record, move, targetSessionId, conversationCarried }
  }

  // -- removing -----------------------------------------------------------------

  /**
   * Remove one managed working copy from disk.
   *
   * Only paths this plugin created are accepted: the registry's own record is
   * the authority, and the path must still sit under a managed root, so a
   * corrupted record can never turn this into an arbitrary `rm -rf`.
   */
  async function removeWorkingCopy(record) {
    const forget = () => {
      registry.remove(record.sessionId)
      cache.invalidatePrefix('status:')
    }
    // A copy whose directory is already gone (removed by hand, or left by an
    // older layout) has nothing to delete: drop the record and move on.
    if (!exists(record.managedRoot)) {
      forget()
      return { removed: false, managedRoot: record.managedRoot, reason: 'the working copy was already gone' }
    }
    const resolved = assertRemovable(record.managedRoot, record.repoRoot, home)
    // Resolve the Workspace registration *before* deleting the directory:
    // resolveByPath canonicalizes the path and rejects once it is gone.
    let workspace
    const workspaces = workspaceRegistry()
    if (workspaces !== undefined && typeof workspaces.resolveByPath === 'function') {
      try {
        workspace = await workspaces.resolveByPath(resolved)
      } catch {
        workspace = undefined
      }
    }
    // The copy owns its git database and its branch, so removing it is just
    // deleting the directory: nothing is registered in the source repository and
    // it holds no branch of ours.
    removeTree(resolved, { recursive: true, force: true })
    forget()
    // Retire the now-dead Workspace registration as well, or it resurfaces in
    // the sidebar as an ordinary project once the record is gone.
    let workspaceRemoved = false
    if (workspace !== undefined && typeof workspaces.delete === 'function') {
      try {
        await workspaces.delete(workspace.id)
        workspaceRemoved = true
      } catch (error) {
        log.warn(`could not retire workspace for ${resolved}: ${message(error)}`)
      }
    }
    return { removed: true, managedRoot: resolved, workspaceRemoved }
  }

  // -- RPC surface (client -> host) ---------------------------------------------

  async function handleRpc(endpoint, payload) {
    const p = payload !== null && typeof payload === 'object' ? payload : {}
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : undefined
    switch (endpoint) {
      case 'snapshot': {
        const entries = []
        for (const record of registry.list()) {
          entries.push(await statusFor(record.sessionId))
        }
        return {
          ok: true,
          value: {
            worktrees: entries.map((entry) => ({
              ...entry,
              // `ignored` only matters for a copy nested inside the checkout; one
              // that lives outside it (an older layout, or the home fallback) has
              // nothing to ignore.
              nested: typeof entry.repoRoot === 'string' && typeof entry.managedRoot === 'string'
                && entry.managedRoot.startsWith(`${entry.repoRoot}/`),
              ignored: typeof entry.repoRoot === 'string' ? worktreesIgnored(entry.repoRoot) : true,
            })),
            at: Date.now(),
            // What this host can actually do, so the client can offer only the
            // actions that would work.
            capabilities: { folderOpener: findOpener()?.command ?? null },
            registry: { writable: registry.writable, problem: registry.problem ?? null },
          },
        }
      }
      case 'status': {
        if (sessionId === undefined) return fail('bad-request', 'status needs a sessionId')
        const status = await statusFor(sessionId, { force: p.force === true })
        return { ok: true, value: { status: status ?? null } }
      }
      case 'fetch': {
        if (sessionId === undefined) return fail('bad-request', 'fetch needs a sessionId')
        const root = (await repoRootForSession(sessionId)) ?? registry.get(sessionId)?.repoRoot
        if (root === undefined) return fail('no-repository', `session ${sessionId} has no git repository to fetch`)
        kickFetch(root, true)
        const status = await statusFor(sessionId, { force: true })
        return { ok: true, value: { status: status ?? null } }
      }
      case 'create': {
        if (sessionId === undefined) return fail('bad-request', 'create needs a sessionId')
        const created = await createForSession(sessionId)
        return { ok: true, value: { worktree: await statusFor(sessionId), reused: created.reused } }
      }
      // Pre-session flow: the composer's Worktree switch has already picked the
      // id the worktree-rooted session will use, so the working copy is created
      // for the *source* session's repository but registered under that target id.
      case 'prepare': {
        const sourceSessionId = typeof p.sourceSessionId === 'string' ? p.sourceSessionId : undefined
        const targetSessionId = typeof p.targetSessionId === 'string' ? p.targetSessionId : undefined
        if (sourceSessionId === undefined || targetSessionId === undefined) {
          return fail('bad-request', 'prepare needs sourceSessionId and targetSessionId')
        }
        const already = registry.get(targetSessionId)
        if (already !== undefined) return { ok: true, value: { worktree: await statusFor(targetSessionId), reused: true } }
        const existing = registry.get(sourceSessionId)
        if (existing !== undefined) {
          return fail('already-a-worktree-session', `session ${sourceSessionId} is already a worktree session`)
        }
        const created = await createForSession(sourceSessionId, { origin: 'pre-session', registerAs: targetSessionId })
        return { ok: true, value: { worktree: await statusFor(targetSessionId), reused: created.reused } }
      }
      // The client has opened the working-copy session; nothing more to do.
      case 'activate': {
        if (sessionId === undefined) return fail('bad-request', 'activate needs a sessionId')
        registry.patch(sessionId, { activated: true })
        return { ok: true, value: { activated: true } }
      }
      case 'convert': {
        if (sessionId === undefined) return fail('bad-request', 'convert needs a sessionId')
        // `moveChanges: false` keeps the source checkout untouched: the
        // working copy is still created and the session still continues there,
        // but whatever is uncommitted stays where it is.
        const result = await convertSession(sessionId, { moveChanges: p.moveChanges !== false })
        if (result.ok !== true) {
          return { ok: false, error: { code: 'session-handoff-failed', message: result.error, details: { managedRoot: result.record.managedRoot } } }
        }
        return {
          ok: true,
          value: {
            worktree: await statusFor(sessionId),
            targetSessionId: result.targetSessionId,
            conversationCarried: result.conversationCarried,
            moved: result.move,
          },
        }
      }
      // Removing the working copy for a session the user is retiring. The
      // branch lives in the working copy, so it goes with it unless it was
      // pushed; the client asks before calling this.
      case 'remove': {
        if (sessionId === undefined) return fail('bad-request', 'remove needs a sessionId')
        const record = registry.get(sessionId)
        if (record === undefined) return fail('not-a-worktree-session', `session ${sessionId} is not a worktree session`)
        return { ok: true, value: await removeWorkingCopy(record) }
      }
      // Hand the checkout's folder to the desktop file manager.
      case 'open': {
        if (sessionId === undefined) return fail('bad-request', 'open needs a sessionId')
        const checkout = checkoutForSession(sessionId)
        if (checkout === undefined || checkout.path === undefined) {
          return fail('no-session', `session ${sessionId} has no working directory`)
        }
        try {
          await openFolder(checkout.path)
        } catch (error) {
          return fail('no-folder-opener', message(error))
        }
        return { ok: true, value: { opened: checkout.path } }
      }
      // Add this plugin's nested copies to the checkout's own exclude file.
      case 'ignore': {
        if (sessionId === undefined) return fail('bad-request', 'ignore needs a sessionId')
        const checkout = checkoutForSession(sessionId)
        const repo = checkout?.record?.repoRoot ?? checkout?.path
        if (typeof repo !== 'string') return fail('no-session', `session ${sessionId} has no checkout`)
        const root = await repoRoot(repo)
        if (root === undefined) return fail('not-a-repo', `${repo} is not inside a git repository`)
        ensureWorktreesIgnored(root)
        return { ok: true, value: { ignored: worktreesIgnored(root), repoRoot: root } }
      }
      case 'workingTree': {
        if (sessionId === undefined) return fail('bad-request', 'workingTree needs a sessionId')
        const checkout = checkoutForSession(sessionId)
        if (checkout === undefined || checkout.path === undefined) {
          return fail('no-session', `session ${sessionId} has no working directory`)
        }
        const status = await readWorktreeStatus(checkout.path, { baseBranch: checkout.baseBranch })
        return {
          ok: true,
          value: { path: checkout.path, status, summary: statusSummary(status, { managedRoot: checkout.record?.managedRoot }) },
        }
      }
      case 'branchReview': {
        if (sessionId === undefined) return fail('bad-request', 'branchReview needs a sessionId')
        const checkout = checkoutForSession(sessionId)
        if (checkout === undefined || checkout.path === undefined) {
          return fail('no-session', `session ${sessionId} has no working directory`)
        }
        // Always re-read: this backs a panel with its own refresh action.
        const status = (await statusFor(sessionId, { force: true }))
          ?? (await readWorktreeStatus(checkout.path, { baseBranch: checkout.baseBranch }))
        const review = await branchReview(checkout.path, status)
        return { ok: true, value: { review, status } }
      }
      case 'forget': {
        if (sessionId === undefined) return fail('bad-request', 'forget needs a sessionId')
        const record = registry.get(sessionId)
        if (record !== undefined) cache.invalidatePrefix(`status:${record.managedRoot}`)
        return { ok: true, value: { removed: registry.remove(sessionId) } }
      }
      default:
        return fail('unknown-endpoint', `unknown endpoint ${endpoint}`)
    }
  }

  return {
    cache,
    registry,
    checkoutForSession,
    statusFor,
    warmAll,
    kickFetch,
    createForSession,
    convertSession,
    removeWorkingCopy,
    handleRpc,
  }
}
