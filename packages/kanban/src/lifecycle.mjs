// dsh-kanban: the pure lifecycle/state machine.
//
// Nothing here imports dsh or touches SQLite. The engine, the HTTP surface and
// the tests all call these same decisions, which is what makes an illegal move
// unrepresentable rather than "blocked in the UI".

export const COLUMNS = ['backlog', 'now', 'blocked', 'needs_attention', 'done', 'discarded'];
export const PHASES = ['intake', 'triage', 'grill', 'plan', 'implement', 'verify', 'review', 'closed'];
export const TERMINAL_COLUMNS = ['done', 'discarded'];
export const GRILL_MODES = ['now', 'at_pickup', 'judgement'];
export const PLAN_MODES = ['now', 'at_pickup', 'one_shot'];

/**
 * The intake table from the specification. A `plan` that would have to fire at
 * pick-up while `grill` is deferred to pick-up is impossible: grill always
 * precedes plan, and a plan waiting at pick-up cannot begin before its grill.
 * Rejected server-side, always.
 */
export const INVALID_COMBINATIONS = [
  { grill: 'at_pickup', plan: 'now', reason: 'plan-at-pickup cannot fire before an at-pickup grill; use plan=at_pickup or grill=now' },
];

export function validateModes(grillMode, planMode) {
  if (!GRILL_MODES.includes(grillMode)) {
    return { ok: false, reason: `grill_mode must be one of ${GRILL_MODES.join(', ')}` };
  }
  if (!PLAN_MODES.includes(planMode)) {
    return { ok: false, reason: `plan_mode must be one of ${PLAN_MODES.join(', ')}` };
  }
  const hit = INVALID_COMBINATIONS.find((row) => row.grill === grillMode && row.plan === planMode);
  if (hit !== undefined) return { ok: false, reason: hit.reason };
  return { ok: true };
}

/** Whether grill work is due in the given situation ('backlog' entry or 'pickup'). */
export function grillDue(grillMode, situation) {
  if (grillMode === 'now') return situation === 'backlog';
  if (grillMode === 'at_pickup') return situation === 'pickup';
  if (grillMode === 'judgement') return 'judge';
  return false;
}

/** Whether plan work is due in the given situation. */
export function planDue(planMode, situation) {
  if (planMode === 'now') return situation === 'backlog';
  if (planMode === 'at_pickup') return situation === 'pickup';
  return false;
}

/**
 * The ordered intake steps still owed before implementation may start.
 *
 * `grillOverride` carries a judgement result: `undefined` means not judged yet,
 * `true` means the orchestrator decided a grill is needed, `false` means it is
 * not. Triage itself is always owed first (it is deterministic bookkeeping plus
 * the one_shot checkability conversion).
 */
export function intakePlan(ticket, { atPickup, grillOverride } = {}) {
  const situation = atPickup ? 'pickup' : 'backlog';
  const steps = [];
  if (ticket.phase === 'intake') steps.push('triage');
  if (ticket.phase === 'intake' || ticket.phase === 'triage') {
    let grill = grillDue(ticket.grillMode, situation);
    if (grill === 'judge') grill = grillOverride === true;
    if (grill && ticket.phase !== 'grill') steps.push('grill');
    const plan = planDue(ticket.planMode, situation);
    if (plan) steps.push('plan');
    if (grillOverride === false && ticket.grillMode === 'judgement' && planDue(ticket.planMode, situation)) {
      // judged-no-grill, plan still owed
    }
  }
  return steps;
}

/** The next deterministic phase after `phase`, for the happy path. */
export const NEXT_PHASE = {
  intake: 'triage',
  triage: 'plan',
  grill: 'plan',
  plan: 'implement',
  implement: 'verify',
  verify: 'review',
  review: 'closed',
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
  intake: ['triage'],
  triage: ['grill', 'plan', 'implement'],
  grill: ['plan', 'triage', 'implement'],
  plan: ['implement'],
  implement: ['verify', 'implement'],
  verify: ['review', 'implement'],
  review: ['implement', 'closed'],
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
  if (!columnMove && phaseMove && from.column === 'backlog' && to.phase === 'implement' && actor !== 'human') {
    return { ok: false, reason: 'implementation starts only after pickup (column=now)' };
  }
  return { ok: true };
}

/**
 * The Now view groups. `pending_capacity` is a group, never a column; the
 * ticket stays `now` while it waits for a slot.
 */
export function nowGroup(ticket, { active = false, waiting = false } = {}) {
  if (active) return 'active';
  if (waiting || ticket.phase === 'grill' || ticket.needsAttentionReason !== null) return 'waiting';
  if (ticket.column === 'blocked') return 'blocked';
  return 'pending_capacity';
}

/** Priority ordering: higher priority first, then FIFO by creation/order. */
export function compareQueue(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return String(a.createdAt).localeCompare(String(b.createdAt));
}

/**
 * Attempt -> what the engine may do next. Pure, so the escalation ladder is
 * testable without a model or a database.
 */
export function decideAfterFailure({ attempt, maxAttempts, allowPaid, budgetUsd, spentUsd, nextEstimateUsd, ladderHasPaidRung }) {
  if (attempt >= maxAttempts) {
    return { kind: 'needs_attention', reason: `attempt ${attempt} of ${maxAttempts} exhausted` };
  }
  const nextAttempt = attempt + 1;
  if (ladderHasPaidRung && nextAttempt >= maxAttempts) {
    if (!allowPaid) return { kind: 'needs_attention', reason: 'paid escalation required but allow_paid is false' };
    if (nextEstimateUsd !== null && spentUsd + nextEstimateUsd > budgetUsd) {
      return { kind: 'needs_attention', reason: 'paid escalation refused: budget exhausted' };
    }
  }
  return { kind: 'retry', attempt: nextAttempt };
}
