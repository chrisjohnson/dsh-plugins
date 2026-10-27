// dsh-kanban: the pure lifecycle/state machine.
//
// Nothing here imports dsh or touches SQLite. The engine, the HTTP surface and
// the tests all call these same decisions, which is what makes an illegal move
// unrepresentable rather than "blocked in the UI".

export const COLUMNS = ['backlog', 'now', 'blocked', 'needs_attention', 'done', 'discarded'];
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
  backlog: ['now', 'blocked', 'discarded', 'needs_attention'],
  now: ['backlog', 'blocked', 'needs_attention', 'done', 'discarded'],
  blocked: ['now', 'needs_attention', 'discarded'],
  needs_attention: ['now', 'discarded', 'backlog'],
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

/** Narrow UI grouping for a ticket in the Now column. */
export function nowGroup(ticket, { active = false, waiting = false } = {}) {
  if (waiting) return 'waiting';
  if (active) return 'active';
  if (ticket?.column === 'blocked') return 'blocked';
  return 'active';
}
