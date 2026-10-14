// The conversation prefix a continuation session starts from. Pure: it reads a
// session's event list (format V4: `{ type, seq, time, data }`) and decides what
// can be handed to a new session.

/**
 * Balanced completed-turn prefix of a session log, safe to hand to a new session
 * as its seed: everything through the last `turn/end`, or nothing when no turn
 * has completed (an open turn would leave the new session with an unclosed one).
 *
 * @param {{snapshotEvents?: () => readonly {type: string}[]}} session
 */
export function forkSeed(session) {
  try {
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    if (!Array.isArray(events) || events.length === 0) return []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === 'turn/end') return events.slice(0, index + 1)
    }
    return []
  } catch {
    return []
  }
}
