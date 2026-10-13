// Pure decisions for dsh-scheduled-queue. Nothing here imports dsh, the file
// system or a clock: the host passes `now` and ids in, so every branch is
// testable on a bare clone.
//
// A queue item is
//   { id, messageId, sessionId, text, minutes, forceSteer, dueAt, createdAt }
// and that shape is also the persisted shape. The queue file is a JSON array of
// these, and `parsePersisted` accepts whatever earlier versions wrote.

export const MIN_MINUTES = 1
export const RETRY_BASE_MS = 5000
export const RETRY_MAX_MS = 5 * 60 * 1000

/** A usable session id: a non-empty string. Everything session-scoped goes through this. */
export function isSessionId(value) {
  return typeof value === 'string' && value.length > 0
}

/** Whole minutes, at least {@link MIN_MINUTES}; `fallback` when the input is not a number. */
export function clampMinutes(value, fallback = MIN_MINUTES) {
  const n = Math.round(Number(value))
  return Math.max(MIN_MINUTES, Number.isFinite(n) ? n : fallback)
}

/**
 * The items that belong to one session, in the order given.
 *
 * Strict on purpose: without a session id nothing is returned, never the whole
 * queue. The dock this feeds is mounted once per session window, and showing it
 * another session's scheduled messages (which it could then edit, remove or
 * send) was the defect this function exists to prevent.
 */
export function itemsForSession(items, sessionId) {
  if (!Array.isArray(items) || !isSessionId(sessionId)) return []
  return items.filter((item) => item !== null && typeof item === 'object' && item.sessionId === sessionId)
}

/** The fields a client may see. `messageId` and `createdAt` stay on the host. */
export function publicItem(item) {
  return {
    id: item.id,
    sessionId: item.sessionId,
    text: item.text,
    minutes: item.minutes,
    forceSteer: item.forceSteer,
    dueAt: item.dueAt,
  }
}

/** The queue as one session's client may see it. */
export function publicQueue(items, sessionId) {
  return itemsForSession(items, sessionId).map(publicItem)
}

/**
 * Build a new item from a client's `schedule` payload.
 * @returns `{ item }`, or `{ error }` when the payload cannot be scheduled.
 */
export function createItem(payload, now, ids) {
  const p = payload !== null && typeof payload === 'object' ? payload : {}
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : ''
  const text = typeof p.text === 'string' ? p.text : String(p.text ?? '')
  if (!isSessionId(sessionId) || text.trim().length === 0) {
    return { error: 'schedule needs a sessionId and non-empty message text' }
  }
  const minutes = clampMinutes(p.minutes)
  return {
    item: {
      id: ids.id,
      messageId: ids.messageId,
      sessionId,
      text,
      minutes,
      forceSteer: p.forceSteer === true || p.forceSteer === 'true',
      dueAt: now + minutes * 60000,
      createdAt: now,
    },
  }
}

/**
 * Apply an `edit` payload to an item, returning the edited copy. Editing restarts
 * the countdown from `now`, as the dock's countdown implies.
 */
export function editItem(item, payload, now) {
  const p = payload !== null && typeof payload === 'object' ? payload : {}
  const minutes = p.minutes !== undefined ? clampMinutes(p.minutes, item.minutes) : item.minutes
  const text = p.text !== undefined ? String(p.text) : item.text
  return {
    ...item,
    text,
    minutes,
    forceSteer: p.forceSteer !== undefined ? p.forceSteer === true || p.forceSteer === 'true' : item.forceSteer,
    dueAt: now + minutes * 60000,
  }
}

/**
 * Whether an item addressed with `sessionId` by a client may be acted on. A client
 * that names its session may only touch that session's items; a call that names no
 * session (a shell probe) keeps the item's own id as the only key.
 */
export function ownedBy(item, sessionId) {
  if (sessionId === undefined || sessionId === null || sessionId === '') return true
  return item.sessionId === sessionId
}

/**
 * Items to deliver now: due, and not waiting out a retry back-off.
 * @param retryAt Map of item id -> earliest next attempt (epoch ms).
 */
export function dueItems(items, now, retryAt = new Map()) {
  return items.filter((item) => item.dueAt <= now && (retryAt.get(item.id) ?? 0) <= now)
}

/** Back-off after the nth consecutive failed delivery (n >= 1), capped. */
export function retryDelayMs(attempts) {
  const n = Math.max(1, Math.floor(attempts))
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (n - 1))
}

/**
 * The request that delivers an item: the same `sessionController.prompt` call the
 * composer's send button makes, so a live session takes it as a follow-up (or
 * steering, when `forceSteer`) and a stopped session is resumed first. `requestId`
 * is the item's `messageId`, which `prompt` dedupes on, so retrying after a
 * half-failed admission cannot deliver twice.
 */
export function promptRequest(item) {
  return {
    requestId: item.messageId,
    sessionId: item.sessionId,
    mode: item.forceSteer ? 'steer' : 'queue',
    content: [{ type: 'text', text: item.text }],
  }
}

/** A delivery failure that no retry will fix: the session is gone. */
export function isPermanentFailure(error) {
  return error !== null && typeof error === 'object' && error.code === 'session/not-found'
}

/**
 * Read the persisted queue file.
 * @returns `{ items, corrupt }`. `corrupt` is true when the text was not a JSON
 *   array, so the host can set the file aside instead of overwriting it.
 */
export function parsePersisted(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { items: [], corrupt: text.trim().length > 0 }
  }
  if (!Array.isArray(parsed)) return { items: [], corrupt: true }
  const items = []
  for (const raw of parsed) {
    if (raw === null || typeof raw !== 'object' || !raw.id || !isSessionId(raw.sessionId)) continue
    const dueAt = Number(raw.dueAt)
    items.push({
      ...raw,
      messageId: typeof raw.messageId === 'string' && raw.messageId ? raw.messageId : raw.id,
      text: typeof raw.text === 'string' ? raw.text : String(raw.text ?? ''),
      minutes: clampMinutes(raw.minutes),
      forceSteer: raw.forceSteer === true,
      dueAt: Number.isFinite(dueAt) ? dueAt : 0,
    })
  }
  return { items, corrupt: false }
}
