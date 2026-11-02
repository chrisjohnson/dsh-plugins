// dsh-kanban: the "Start planning" decision (KAN-16).
//
// A Backlog ticket plans when a human drags it into Working — that is what
// `planTiming: 'at_pickup'` means. `startPlanning` is the one deliberate
// exception a human can make from the board itself: *plan this ticket here, in
// Backlog, now.* It moves no column and no phase. It flips `planTiming` to
// 'now' and nudges the engine, which already knows how to plan a Backlog
// plan-now ticket and stop at Build until it is dragged over (see engine.mjs
// `tick` / `advance`). So this module is a guard plus two writes, nothing more.
//
// It doubles as the retry for a parked plan ticket: a plan that ended without
// submitting leaves the ticket red in Backlog with its plan session still
// open, and pressing the button again is the human saying "go again".
//
// The store, driver and engine arrive as parameters. host.mjs is wiring and
// cannot be imported without the dsh peer packages, so keeping the decision
// here is what makes it testable on its own.

/** A park is only a park if it carries a reason. */
function isParked(ticket) {
  const reason = ticket.needsAttentionReason;
  return reason !== undefined && reason !== null && String(reason).trim() !== '';
}

/**
 * Ask the engine to plan one Backlog ticket now.
 *
 * @param {object} deps
 * @param {object} deps.store    KanbanStore
 * @param {object} deps.driver   SessionDriver (isTicketBusy / liveTicketSession)
 * @param {object} deps.engine   Engine (tick)
 * @param {object} deps.ticket   the ticket the human pressed the button on
 * @returns {{ok: true, ticket: object} | {ok: false, code: string, message: string}}
 */
export function startPlanning({ store, driver, engine, ticket }) {
  if (ticket.column !== 'backlog' || ticket.phase !== 'plan') {
    return {
      ok: false,
      code: 'bad_request',
      message: `start planning needs a Backlog ticket at the plan phase, not ${ticket.column}/${ticket.phase}`,
    };
  }
  // Planning is already under way when a turn of this ticket is in flight, or
  // when a plan session is still open on it — an unanswered grilling question
  // looks exactly like that, and the answer there is to reply to the session,
  // not to launch a second plan. A parked ticket is the exception the button
  // exists for: its plan session ended without a plan and stays open on
  // purpose, so pressing again means retry.
  const parked = isParked(ticket);
  const running = driver?.isTicketBusy?.(ticket.id) === true;
  const livePlan = driver?.liveTicketSession?.(ticket.id, 'plan');
  if (running || (!parked && livePlan !== undefined)) {
    return { ok: false, code: 'bad_request', message: 'a plan session is already running for this ticket' };
  }
  if (parked) {
    store.clearNeedsAttention(ticket.id, { actor: 'human', reason: 'start planning' });
  }
  let updated = store.getTicket(ticket.id);
  if (updated.planTiming !== 'now') {
    updated = store.updateTicket(ticket.id, { planTiming: 'now' }, { actor: 'human', reason: 'start planning' });
  }
  // Fire-and-forget, like every other human mutation on this endpoint: the tick
  // launches the planner if a slot is free, and the board's poll shows it.
  if (typeof engine?.tick === 'function') void engine.tick();
  return { ok: true, ticket: updated };
}

/**
 * The client's mirror of the guards above, so a card never offers a button the
 * host would refuse. `status` is the card-level visual status and
 * `awaitingQuestion` the host's "the planner is waiting on you" answer; both
 * ride on the ticket the board sends, so the rule reads one object. A parked
 * ticket keeps its button — pressing it again is the retry.
 */
export function canStartPlanning(ticket) {
  if (ticket === undefined || ticket === null) return false;
  if (ticket.column !== 'backlog' || ticket.phase !== 'plan') return false;
  if (ticket.planTiming === 'now') return false;
  if ((ticket.status ?? 'idle') === 'active' || ticket.awaitingQuestion === true) return false;
  return true;
}
