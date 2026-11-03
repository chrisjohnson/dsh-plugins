// dsh-kanban: the "Start build" decision.
//
// A Backlog ticket that planned in place stops at the build phase until a human
// drags it into Working. `startBuild` is that same move as a button: it makes
// exactly the transition the drag makes (`moveToColumn`, shared with the `move`
// endpoint) and adds only a guard so it is never offered for a ticket the move
// would not mean "start the build" for. It adds no state of its own - a planned
// ticket waiting in Backlog is still an ordinary idle card.
//
// The store and engine arrive as parameters; host.mjs is wiring that cannot be
// imported without the dsh peer packages, so the decision lives here.

/**
 * Move a ticket to a column the way a human drag does: an unconditional
 * statement of intent (into Working starts the engine and lifts any park, back
 * into Backlog stops it), then a nudge to the engine.
 */
export function moveToColumn({ store, engine, id, column, reason }) {
  const updated = store.transitionTicket(id, { column }, { actor: 'human', reason: reason ?? 'human move' });
  if (typeof engine?.tick === 'function') void engine.tick();
  return updated;
}

/**
 * Start the build of one planned Backlog ticket.
 *
 * @returns {{ok: true, ticket: object} | {ok: false, code: string, message: string}}
 */
export function startBuild({ store, engine, ticket, reason }) {
  if (ticket.column !== 'backlog' || ticket.phase !== 'implement') {
    return {
      ok: false,
      code: 'bad_request',
      message: `start build needs a planned Backlog ticket at the build phase, not ${ticket.column}/${ticket.phase}`,
    };
  }
  return { ok: true, ticket: moveToColumn({ store, engine, id: ticket.id, column: 'working', reason: reason ?? 'start build' }) };
}

/**
 * The client's mirror of the guard above, so a card never offers a button the
 * host would refuse. A parked ticket keeps its button: the move lifts the park.
 * A turn in flight or an unanswered question is not "waiting to be built".
 */
export function canStartBuild(ticket) {
  if (ticket === undefined || ticket === null) return false;
  if (ticket.column !== 'backlog' || ticket.phase !== 'implement') return false;
  if ((ticket.status ?? 'idle') === 'active' || ticket.awaitingQuestion === true) return false;
  return true;
}
