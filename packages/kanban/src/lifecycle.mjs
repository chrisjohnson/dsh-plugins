// dsh-kanban: the pure lifecycle/state machine.
//
// Nothing here imports dsh or touches SQLite. The engine, the HTTP surface and
// the tests all call these same decisions, which is what makes an illegal move
// unrepresentable rather than "blocked in the UI".
//
// Columns are *intended state* — where a human wants the ticket to live.
// Whether the engine is running it or it needs a human is a card-level status
// computed from live facts (see cardStatus), never a column.

export const COLUMNS = ['backlog', 'working', 'done', 'discarded'];
export const PHASES = ['plan', 'implement', 'review', 'verify', 'closed'];
export const TERMINAL_COLUMNS = ['done', 'discarded'];

export const PLAN_TIMINGS = ['now', 'at_pickup'];
export const PLAN_QUESTIONS = ['interactive', 'autonomous'];

/** Validate the two independent ticket choices. */
export function validateTicketModes(planTiming, planQuestions) {
  if (!PLAN_TIMINGS.includes(planTiming)) {
    return { ok: false, reason: `planTiming must be one of ${PLAN_TIMINGS.join(', ')}` };
  }
  if (!PLAN_QUESTIONS.includes(planQuestions)) {
    return { ok: false, reason: `planQuestions must be one of ${PLAN_QUESTIONS.join(', ')}` };
  }
  return { ok: true };
}

/** The next deterministic phase on the happy path. */
export const NEXT_PHASE = {
  plan: 'implement',
  implement: 'review',
  review: 'verify',
  verify: 'closed',
  closed: 'closed',
};

const COLUMN_EDGES = {
  backlog: ['working', 'done', 'discarded'],
  working: ['backlog', 'done', 'discarded'],
  done: [],
  discarded: [],
};

const PHASE_EDGES = {
  plan: ['implement'],
  implement: ['review', 'plan'],
  review: ['verify', 'implement'],
  verify: ['closed', 'implement', 'plan'],
  closed: [],
};

export function canTransitionColumn(from, to) {
  if (!COLUMNS.includes(from) || !COLUMNS.includes(to)) return false;
  if (from === to) return true;
  return (COLUMN_EDGES[from] ?? []).includes(to);
}

export function canTransitionPhase(from, to) {
  if (!PHASES.includes(from) || !PHASES.includes(to)) return false;
  if (from === to) return true;
  return (PHASE_EDGES[from] ?? []).includes(to);
}

/**
 * The one function every mutation uses. Returns `{ok:true}` or `{ok:false, reason}`.
 * A terminal ticket may never be reopened implicitly; a human must discard or
 * create a new ticket, so `done`/`discarded` are true sinks.
 */
export function assertTransition(from, to, { actor = 'engine', reason = '', outsideEngine = false } = {}) {
  const phaseMove = from.phase !== to.phase;
  const columnMove = from.column !== to.column;
  if (!phaseMove && !columnMove) return { ok: true };
  if (TERMINAL_COLUMNS.includes(from.column) && from.column !== to.column) {
    return { ok: false, reason: `${from.column} is terminal; a human must create a new ticket` };
  }
  // A human closing work that was finished outside the engine skips the phase
  // graph on purpose: the ticket may be anywhere in it, and the work it
  // describes is already done. Only a human, only into Done, only closed.
  if (outsideEngine) {
    if (actor !== 'human') return { ok: false, reason: 'only a human may close a ticket completed outside the engine' };
    if (to.column !== 'done' || to.phase !== 'closed') return { ok: false, reason: 'a ticket completed outside the engine closes as done' };
    if (!canTransitionColumn(from.column, to.column)) return { ok: false, reason: `column ${from.column} -> ${to.column} is not allowed` };
    return { ok: true };
  }
  if (!canTransitionColumn(from.column, to.column)) {
    return { ok: false, reason: `column ${from.column} -> ${to.column} is not allowed` };
  }
  if (!canTransitionPhase(from.phase, to.phase)) {
    return { ok: false, reason: `phase ${from.phase} -> ${to.phase} is not allowed` };
  }
  if (columnMove && TERMINAL_COLUMNS.includes(to.column) && actor !== 'engine' && actor !== 'human') {
    // KAN-65: the board owner moved discard to the orchestrator, so an
    // orchestrator may end an open ticket — into Discarded and nowhere else.
    // Done is still unreachable by any actor but the engine and a human: the
    // approval that puts a ticket there is the one call this plugin never hands
    // to a model.
    if (actor === 'orchestrator' && to.column === 'discarded') return { ok: true };
    return { ok: false, reason: `only the engine or a human may close a ticket (actor=${actor})` };
  }
  return { ok: true };
}

/**
 * Queue order: priority desc, then the order a human arranged (sortOrder asc;
 * new tickets are appended, so it starts out as creation order), then creation.
 * The board lists and the engine launches in this one order.
 */
export function compareQueue(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  const byOrder = Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0);
  if (byOrder !== 0) return byOrder;
  return String(a.createdAt).localeCompare(String(b.createdAt));
}

/**
 * The card-level visual status, computed from live facts — never a column.
 *
 * - `attention`: the engine parked the ticket (a reason is set), a plan
 *   session is waiting on a human answer, or — KAN-17 — a session is paused
 *   mid-turn on an unanswered approval prompt. Red glow on the board.
 * - `active`: the engine is driving the ticket right now (a workflow turn is in
 *   flight, engine- or human-initiated). Blue pulse.
 * - `idle`: nothing is running and nothing is asked of anyone. Plain card.
 *
 * A mid-turn human wait outranks `active` on purpose: the turn is in flight,
 * but the session is doing nothing until a person answers, and "running" would
 * hide the one state that actually needs eyes on it.
 */
export function cardStatus(ticket, { active = false, awaitingUser = false, awaitingApproval = false } = {}) {
  if (ticket === undefined || ticket === null) return 'idle';
  const reason = ticket.needsAttentionReason;
  if (awaitingUser || awaitingApproval || (reason !== undefined && reason !== null && String(reason).trim() !== '')) {
    return 'attention';
  }
  if (active) return 'active';
  return 'idle';
}

/**
 * Whether a human may close this ticket as done without the engine having done
 * the work: any open ticket, in any column and any phase, parked or not.
 */
export function canMarkDone(ticket) {
  if (ticket === undefined || ticket === null) return { ok: false, reason: 'no such ticket' };
  if (TERMINAL_COLUMNS.includes(ticket.column)) return { ok: false, reason: `ticket is already ${ticket.column}` };
  return { ok: true };
}

/**
 * Whether a parked ticket can resume at the review phase: its implement phase
 * has nothing left to do (the work exists), so the only thing missing is a review.
 */
export function canRerunReview(ticket, { hasConditions = true } = {}) {
  if (ticket === undefined || ticket === null) return { ok: false, reason: 'no such ticket' };
  if (TERMINAL_COLUMNS.includes(ticket.column)) return { ok: false, reason: `ticket is already ${ticket.column}` };
  if (!ticket.needsAttentionReason) return { ok: false, reason: 'ticket is not parked for attention' };
  if (ticket.phase !== 'implement' && ticket.phase !== 'review') {
    return { ok: false, reason: `re-run review applies to a ticket parked in implement or review, not ${ticket.phase}` };
  }
  if (!hasConditions) return { ok: false, reason: 'the ticket has no plan conditions to review against' };
  return { ok: true };
}
