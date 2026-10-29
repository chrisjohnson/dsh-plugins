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
export function assertTransition(from, to, { actor = 'engine', reason = '' } = {}) {
  const phaseMove = from.phase !== to.phase;
  const columnMove = from.column !== to.column;
  if (!phaseMove && !columnMove) return { ok: true };
  if (TERMINAL_COLUMNS.includes(from.column) && from.column !== to.column) {
    return { ok: false, reason: `${from.column} is terminal; a human must create a new ticket` };
  }
  if (!canTransitionColumn(from.column, to.column)) {
    return { ok: false, reason: `column ${from.column} -> ${to.column} is not allowed` };
  }
  if (!canTransitionPhase(from.phase, to.phase)) {
    return { ok: false, reason: `phase ${from.phase} -> ${to.phase} is not allowed` };
  }
  if (columnMove && TERMINAL_COLUMNS.includes(to.column) && actor !== 'engine' && actor !== 'human') {
    return { ok: false, reason: `only the engine or a human may close a ticket (actor=${actor})` };
  }
  return { ok: true };
}

/** Queue order: priority desc, then creation order. */
export function compareQueue(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return String(a.createdAt).localeCompare(String(b.createdAt));
}

/**
 * The card-level visual status, computed from live facts — never a column.
 *
 * - `attention`: the engine parked the ticket (a reason is set) or a plan
 *   session is waiting on a human answer. Red glow on the board.
 * - `active`: the engine is driving the ticket right now (a workflow turn is in
 *   flight, engine- or human-initiated). Blue pulse.
 * - `idle`: nothing is running and nothing is asked of anyone. Plain card.
 */
export function cardStatus(ticket, { active = false, awaitingUser = false } = {}) {
  if (ticket === undefined || ticket === null) return 'idle';
  const reason = ticket.needsAttentionReason;
  if (awaitingUser || (reason !== undefined && reason !== null && String(reason).trim() !== '')) {
    return 'attention';
  }
  if (active) return 'active';
  return 'idle';
}
