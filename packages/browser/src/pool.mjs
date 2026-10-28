// The browser connection pool: one shared browser per backend, one context per
// session. Pure: imports nothing from dsh or playwright; the two ways of getting
// a browser are injected, so every branch is testable with fakes.
//
// Two backends, kept as separate slots:
//   remote  one connection to Browserless, shared by every session. A connection
//           is a scarce slot on the server, and contexts on it cost none.
//   local   a Chromium launched on this host, used only while the remote cannot
//           be reached.
//
// A slot's browser is never trusted from cache: it is checked with isConnected()
// on every use, and its `disconnected` event drops it together with every context
// that lived on it. Browserless kills even active connections at its per-
// connection timeout, so a dead browser is the normal case, not an edge.

import { errorSummary } from './config.mjs'

/**
 * @param {object} options
 * @param {(() => Promise<object>) | undefined} options.connectRemote - resolves a connected remote browser; absent when remote use is switched off.
 * @param {() => Promise<object>} options.launchLocal - resolves a freshly launched local browser.
 * @param {number} [options.retryRemoteAfterMs] - after a failed remote connect, how long to go straight to local.
 * @param {() => number} [options.now]
 * @param {{ info?: Function, warn?: Function }} [options.log]
 */
export function createBrowserPool(options) {
  const { connectRemote, launchLocal, retryRemoteAfterMs = 30000, now = Date.now, log = {} } = options
  const remoteEnabled = typeof connectRemote === 'function'

  const slots = { remote: null, local: null }
  const connecting = { remote: null, local: null }
  const inflight = { remote: 0, local: 0 }
  /** sessionId -> { context, kind, browser } */
  const records = new Map()
  /** sessionId -> Promise of an acquire in progress, so concurrent first calls share one context. */
  const pendingAcquire = new Map()
  const lostListeners = new Set()
  let remoteFailure = null

  const say = (level, ...args) => log[level]?.(...args)

  function slotIsLive(kind) {
    const slot = slots[kind]
    return slot !== null && slot.browser.isConnected()
  }

  function dropSlot(kind, slot, reason) {
    if (slots[kind] !== slot) return
    slots[kind] = null
    const lost = []
    for (const [sessionId, record] of records) {
      if (record.browser === slot.browser) {
        records.delete(sessionId)
        lost.push(sessionId)
      }
    }
    say('warn', '%s browser dropped (%s); %d session context(s) discarded', kind, reason, lost.length)
    for (const listener of lostListeners) {
      try {
        listener(kind, lost)
      } catch {
        // A listener failing must not stop the pool from recovering.
      }
    }
  }

  function ensureSlot(kind) {
    if (slotIsLive(kind)) return Promise.resolve(slots[kind])
    if (slots[kind] !== null) dropSlot(kind, slots[kind], 'no longer connected')
    if (connecting[kind] !== null) return connecting[kind]
    const open = kind === 'remote' ? connectRemote : launchLocal
    const attempt = (async () => {
      const browser = await open()
      const slot = { browser }
      browser.once('disconnected', () => dropSlot(kind, slot, 'disconnected'))
      slots[kind] = slot
      return slot
    })()
    const settled = attempt.finally(() => {
      connecting[kind] = null
    })
    connecting[kind] = settled
    return settled
  }

  async function newContextOn(kind, contextOptions) {
    // The connection can die between the liveness check and the call that uses
    // it. That is a reconnect, not a reason to fall back to the local browser.
    for (let attempt = 0; ; attempt += 1) {
      const slot = await ensureSlot(kind)
      try {
        return { slot, context: await slot.browser.newContext(contextOptions) }
      } catch (error) {
        if (attempt === 0 && !slot.browser.isConnected()) continue
        throw error
      }
    }
  }

  // `inflight` keeps reapIdle from closing a browser between "connected" and
  // "its context is recorded"; the caller releases it with `done()` once the
  // record exists.
  async function openContext(contextOptions) {
    let remoteNote = null
    if (remoteEnabled) {
      const backoff = remoteFailure !== null && now() - remoteFailure.at < retryRemoteAfterMs
      if (backoff && !slotIsLive('remote')) {
        remoteNote = remoteFailure.message
      } else {
        inflight.remote += 1
        try {
          const { slot, context } = await newContextOn('remote', contextOptions)
          remoteFailure = null
          return { kind: 'remote', slot, context, remoteNote: null, done: () => (inflight.remote -= 1) }
        } catch (error) {
          inflight.remote -= 1
          remoteFailure = { at: now(), message: errorSummary(error) }
          remoteNote = remoteFailure.message
          say('warn', 'remote browser unavailable, falling back to a local browser: %s', remoteNote)
          reapIdle('remote')
        }
      }
    }
    inflight.local += 1
    try {
      const { slot, context } = await newContextOn('local', contextOptions)
      return { kind: 'local', slot, context, remoteNote, done: () => (inflight.local -= 1) }
    } catch (error) {
      inflight.local -= 1
      reapIdle('local')
      const local = errorSummary(error)
      throw new Error(
        remoteNote === null
          ? `failed to launch a local browser: ${local}`
          : `no browser available. Remote: ${remoteNote}. Local fallback: ${local}`,
      )
    }
  }

  /** Close a backend's browser once nothing uses it, so an idle remote connection frees its server slot. */
  function reapIdle(kind) {
    const slot = slots[kind]
    if (slot === null || inflight[kind] > 0) return
    for (const record of records.values()) if (record.kind === kind) return
    slots[kind] = null
    slot.browser.close().catch(() => undefined)
  }

  function isLive(sessionId, context) {
    const record = records.get(sessionId)
    return record !== undefined && record.context === context && record.browser.isConnected()
  }

  /**
   * The session's context, creating it on first use or after it was lost.
   * @returns {Promise<{ context: object, kind: 'remote' | 'local', remoteNote: string | null }>}
   */
  function acquire(sessionId, contextOptions) {
    const existing = records.get(sessionId)
    if (existing !== undefined && existing.browser.isConnected()) {
      return Promise.resolve({ context: existing.context, kind: existing.kind, remoteNote: existing.remoteNote })
    }
    if (existing !== undefined) records.delete(sessionId)
    const pending = pendingAcquire.get(sessionId)
    if (pending !== undefined) return pending
    const promise = (async () => {
      const opened = await openContext(contextOptions)
      const record = {
        context: opened.context,
        kind: opened.kind,
        browser: opened.slot.browser,
        remoteNote: opened.remoteNote,
      }
      records.set(sessionId, record)
      opened.done()
      say('info', 'opened %s context for session %s (contexts=%d)', record.kind, sessionId, records.size)
      opened.context.once('close', () => {
        // A release deletes the record first, so a record still here means the
        // browser closed the context: the connection dropped or the server killed it.
        if (records.get(sessionId) === record) {
          records.delete(sessionId)
          say('warn', 'context for session %s was closed by the browser (connection lost); the next call opens a new one', sessionId)
          reapIdle(record.kind)
        }
      })
      return { context: record.context, kind: record.kind, remoteNote: record.remoteNote }
    })()
    const settled = promise.finally(() => pendingAcquire.delete(sessionId))
    pendingAcquire.set(sessionId, settled)
    return settled
  }

  /** Close one session's context. Idempotent; a session that never opened one is a no-op. */
  async function release(sessionId) {
    const record = records.get(sessionId)
    if (record === undefined) return false
    records.delete(sessionId)
    await record.context.close().catch(() => undefined)
    say('info', 'closed context for session %s (contexts=%d)', sessionId, records.size)
    reapIdle(record.kind)
    return true
  }

  async function closeAll() {
    await Promise.all([...records.keys()].map((sessionId) => release(sessionId)))
    for (const kind of ['remote', 'local']) {
      const slot = slots[kind]
      slots[kind] = null
      if (slot !== null) await slot.browser.close().catch(() => undefined)
    }
  }

  return {
    acquire,
    release,
    closeAll,
    isLive,
    /** Subscribe to a backend losing its browser; returns an unsubscribe function. */
    onLost(listener) {
      lostListeners.add(listener)
      return () => lostListeners.delete(listener)
    },
    stats() {
      return {
        remoteConnected: slotIsLive('remote'),
        localConnected: slotIsLive('local'),
        contexts: records.size,
        sessions: [...records.keys()],
      }
    },
  }
}
