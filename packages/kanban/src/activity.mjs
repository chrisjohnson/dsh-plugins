// dsh-kanban: realtime turn activity.
//
// The board has to mirror what is actually happening on the box. While any
// session attached to a needs-attention ticket has a turn running — a human
// answering the engine's question, driving the build by hand, or talking an
// approval through — that ticket is being worked on and belongs in In flight.
// When the turn ends, the outcome depends on whether the session spoke through
// a structured action tool: without one the ticket goes back to needs attention
// with the reason it had before.
//
// This file is pure bookkeeping with no dsh imports, so the decision is testable
// on its own. The driver feeds it `turn/start` and `turn/end` from the global
// session event stream and owns the action record; the engine owns the
// transitions it is told about.

const NO_LOG = { info() {}, warn() {}, error() {}, debug() {} };

/** How long a session known not to belong to a ticket is cached as such. */
const DEFAULT_CACHE_TTL_MS = 30_000;

export class TurnActivity {
  /**
   * @param {object} options
   * @param {object} options.store            KanbanStore (findSession / getTicket)
   * @param {(sessionId: string) => string|undefined} [options.isLive]
   *   ticketId of a session the driver already runs, if any
   * @param {(sessionId: string) => boolean} [options.hasAction]
   *   whether a structured action was recorded for this session's current turn
   * @param {(ticketId: string, sessionId: string) => any} [options.onReactivate]
   *   engine hook; returning `false` means "not handled", so no mark is kept
   * @param {(ticketId: string, sessionId: string) => any} [options.onSettle]
   *   engine hook called when a reactivating turn ends without an action
   */
  constructor({
    store,
    isLive = () => undefined,
    hasAction = () => false,
    onReactivate = null,
    onSettle = null,
    log = NO_LOG,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  } = {}) {
    this.store = store;
    this.isLive = isLive;
    this.hasAction = hasAction;
    this.onReactivate = onReactivate;
    this.onSettle = onSettle;
    this.log = log;
    this.cacheTtlMs = cacheTtlMs;
    /** sessionIds with a turn in flight, engine-driven or human-driven */
    this.active = new Set();
    /** ticketId -> { sessionId } for the turn that reactivated it */
    this.marks = new Map();
    /** sessionId -> cache expiry for sessions that are not ticket sessions */
    this.negatives = new Map();
  }

  /** The ticket a session belongs to; a "not a ticket session" answer is cached briefly. */
  ticketOf(sessionId) {
    const live = this.isLive(sessionId);
    if (live !== undefined && live !== null) return live;
    const expiry = this.negatives.get(sessionId);
    if (expiry !== undefined) {
      if (expiry > Date.now()) return undefined;
      this.negatives.delete(sessionId);
    }
    const record = this.store?.findSession?.(sessionId);
    if (record === undefined || record.ticketId === null || record.ticketId === undefined) {
      this.negatives.set(sessionId, Date.now() + this.cacheTtlMs);
      return undefined;
    }
    return record.ticketId;
  }

  turnStart(sessionId) {
    const ticketId = this.ticketOf(sessionId);
    if (ticketId === undefined) return;
    this.active.add(sessionId);
    const ticket = this.store?.getTicket?.(ticketId);
    if (ticket === undefined || ticket.column !== 'needs_attention') return;
    if (typeof this.onReactivate !== 'function') return;
    this.marks.set(ticketId, { sessionId });
    let result;
    try {
      result = this.onReactivate(ticketId, sessionId);
    } catch (error) {
      this.marks.delete(ticketId);
      this.log.warn('kanban: session reactivation failed: %s', String(error?.stack ?? error));
      return;
    }
    if (result === false) {
      this.marks.delete(ticketId);
      return;
    }
    Promise.resolve(result).catch((error) => {
      this.marks.delete(ticketId);
      this.log.warn('kanban: session reactivation failed: %s', String(error?.stack ?? error));
    });
  }

  turnEnd(sessionId) {
    const ticketId = this.ticketOf(sessionId);
    this.active.delete(sessionId);
    if (ticketId === undefined) return;
    const mark = this.marks.get(ticketId);
    if (mark === undefined || mark.sessionId !== sessionId) return;
    this.marks.delete(ticketId);
    const ticket = this.store?.getTicket?.(ticketId);
    if (ticket === undefined || ticket.column !== 'now') return;
    // A structured submission owns the outcome: handleManualAction already moved
    // the ticket, so settling here would flip it back under the submission.
    if (this.hasAction(sessionId)) return;
    if (typeof this.onSettle !== 'function') return;
    Promise.resolve(this.onSettle(ticketId, sessionId)).catch((error) =>
      this.log.warn('kanban: turn settle failed: %s', String(error?.stack ?? error)));
  }

  /** True while this ticket has a turn in flight on any of its sessions. */
  busy(ticketId, extraSessionIds = []) {
    for (const sessionId of extraSessionIds) {
      if (this.ticketOf(sessionId) === ticketId) return true;
    }
    for (const sessionId of this.active) {
      if (this.ticketOf(sessionId) === ticketId) return true;
    }
    return false;
  }

  /** A session is gone: forget its turn and any mark that turn owned. */
  forget(sessionId) {
    this.active.delete(sessionId);
    const ticketId = this.ticketOf(sessionId);
    const mark = ticketId === undefined ? undefined : this.marks.get(ticketId);
    if (mark !== undefined && mark.sessionId === sessionId) this.marks.delete(ticketId);
  }

  /** Drop activity for sessions no longer running: a turn/end that never arrived. */
  prune(isRunning) {
    for (const sessionId of [...this.active]) {
      if (isRunning(sessionId)) continue;
      this.forget(sessionId);
    }
  }

  clear() {
    this.active.clear();
    this.marks.clear();
    this.negatives.clear();
  }
}
