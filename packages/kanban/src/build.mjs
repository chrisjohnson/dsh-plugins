// dsh-kanban: the "Start build" decision.
//
// A Backlog ticket that planned in place stops at the build phase until a human
// drags it into Working. `startBuild` is that same move as a button: it makes
// exactly the transition the drag makes (`moveToColumn`, shared with the `move`
// endpoint) and adds only a guard so it is never offered for a ticket the move
// would not mean "start the build" for. It adds no state of its own - a planned
// ticket waiting in Backlog is still an ordinary idle card.
//
// `moveToColumn` is also the single seam the Work-In-Progress cap is enforced
// at (KAN-72). Every way into Working - a human drag, this button,
// `kanban_start build` - comes through here, so the limit is a property of the
// engine rather than a convention each caller agrees to keep. A caller that
// wants the cap applied passes a `wip` gate (src/wip.mjs); one that passes
// nothing gets the plain move, which is what a move OUT of Working always is.
//
// The store and engine arrive as parameters; host.mjs is wiring that cannot be
// imported without the dsh peer packages, so the decision lives here.

/**
 * Move a ticket to a column the way a human drag does: an unconditional
 * statement of intent (into Working starts the engine and lifts any park, back
 * into Backlog stops it), then a nudge to the engine.
 *
 * `actor` says who asked, and it is only ever 'human' or 'orchestrator': the
 * event log has to distinguish them, because the orchestrator's own moves are
 * not fed back to it as news (src/orchestrator.mjs skips its own events).
 *
 * `wip` is the capacity gate. When it is present and the board is full, the
 * ticket does not move: it stays where it was, parked with the queue notice
 * that names the cap and its position, and the answer carries `queued`. The
 * engine's tick promotes it the moment a slot frees.
 *
 * @returns {{ticket: object, queued?: {cap: number, occupancy: number, position: number, reason: string}}}
 */
export function moveToColumn({ store, engine, id, column, reason, actor = 'human', wip = null }) {
  if (column === 'working' && wip !== null && typeof wip.refusalFor === 'function') {
    const current = store.getTicket(id);
    const refusal = current === undefined ? null : wip.refusalFor(current);
    if (refusal !== null && refusal !== undefined) {
      // An already-parked card keeps the reason it is waiting for: a question
      // park is not a WIP queue place, and overwriting it would lose the thing
      // the human has to answer. Parked tickets are not occupancy, so the
      // refusal still stands on its own numbers.
      const parked = current.needsAttentionReason
        ? current
        : store.setNeedsAttention(id, refusal.reason, { queued: refusal, cap: refusal.cap, position: refusal.position });
      return { ticket: parked, queued: refusal };
    }
  }
  const updated = store.transitionTicket(id, { column }, { actor, reason: reason ?? `${actor} move` });
  if (typeof engine?.tick === 'function') void engine.tick();
  return { ticket: updated };
}

/**
 * Start the build of one planned Backlog ticket.
 *
 * @returns {{ok: true, ticket: object, queued?: object} | {ok: false, code: string, message: string}}
 */
export function startBuild({ store, engine, ticket, reason, wip = null }) {
  if (ticket.column !== 'backlog' || ticket.phase !== 'implement') {
    return {
      ok: false,
      code: 'bad_request',
      message: `start build needs a planned Backlog ticket at the build phase, not ${ticket.column}/${ticket.phase}`,
    };
  }
  const moved = moveToColumn({ store, engine, id: ticket.id, column: 'working', reason: reason ?? 'start build', wip });
  return moved.queued === undefined
    ? { ok: true, ticket: moved.ticket }
    : { ok: true, ticket: moved.ticket, queued: moved.queued };
}

/**
 * The client's mirror of the guard above, so a card never offers a button the
 * host would refuse. A parked ticket keeps its button: the move lifts the park.
 * A turn in flight or an unanswered question is not "waiting to be built".
 *
 * The WIP cap deliberately does not appear here. A full board does not make the
 * button wrong - it makes the move a queue place, which is a real outcome the
 * card shows as a park rather than a disabled control.
 */
export function canStartBuild(ticket) {
  if (ticket === undefined || ticket === null) return false;
  if (ticket.column !== 'backlog' || ticket.phase !== 'implement') return false;
  if ((ticket.status ?? 'idle') === 'active' || ticket.awaitingQuestion === true) return false;
  return true;
}
