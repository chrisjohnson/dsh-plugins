// dsh-kanban: what the board shows about a ticket beyond its row.
//
// Pure derivations over the ticket's recorded history - phase transitions,
// spans, attention events and attached sessions. Nothing here imports dsh or
// touches SQLite, so every rule is testable on its own; the host reads the
// rows and hands them in.

import { NEXT_PHASE, PHASES } from './lifecycle.mjs';

const ORDINALS = [
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth',
];

/**
 * The attempt badge: nothing on the first attempt, then "second attempt",
 * "third attempt" and so on. Past the twelfth the ordinal is numeric.
 */
export function attemptLabel(count) {
  const n = Math.trunc(Number(count));
  if (!Number.isFinite(n) || n <= 1) return null;
  if (n <= ORDINALS.length) return `${ORDINALS[n - 1]} attempt`;
  const mod100 = n % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th';
  return `${n}${suffix} attempt`;
}

/**
 * The progress segments of a card: the phases the ticket has walked through,
 * then the ones it still has to walk on the happy path. A ticket that went
 * implement -> review -> implement carries two build and two review segments,
 * so a second round shows seven segments, not five.
 *
 * `transitions` are the ticket's phase changes in order, `{from, to}`. Each
 * segment is `{phase, state, round}`: state is `done` (walked, filled),
 * `current` (where the ticket is now, filled) or `todo` (known to be required
 * and not yet reached, the lighter grey); round counts the repeats of that
 * phase on the path (1 for the first).
 */
export function phaseSegments({ transitions = [], phase, column }) {
  const current = PHASES.includes(phase) ? phase : 'plan';
  let path = ['plan'];
  for (const step of transitions) {
    if (!PHASES.includes(step?.to) || step.to === step.from) continue;
    path.push(step.to);
  }
  // A history that does not end where the ticket is (an imported row, a pruned
  // log) cannot be trusted past its phase: fall back to the straight path.
  if (path[path.length - 1] !== current) path = PHASES.slice(0, PHASES.indexOf(current) + 1);
  const ahead = [];
  for (let next = current; next !== 'closed';) {
    next = NEXT_PHASE[next];
    ahead.push(next);
  }
  const closed = current === 'closed' || column === 'done';
  const seen = {};
  const round = (name) => { seen[name] = (seen[name] ?? 0) + 1; return seen[name]; };
  const segments = path.map((name, index) => ({
    phase: name,
    state: index === path.length - 1 && !closed ? 'current' : 'done',
    round: round(name),
  }));
  if (!closed) for (const name of ahead) segments.push({ phase: name, state: 'todo', round: round(name) });
  return segments;
}

const WORK_SPAN_KINDS = new Set(['agent', 'judge', 'tool', 'workflow']);
const ATTENTION_OPEN = new Set(['needs_attention', 'human_wait_started']);
const ATTENTION_CLOSE = new Set(['attention_cleared', 'session_reactivated', 'human_wait_ended', 'column_changed']);

function toMs(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Merge intervals into disjoint ascending ones. */
function union(intervals) {
  const sorted = intervals.filter((i) => i[1] > i[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** The parts of `base` (disjoint) not covered by `cut` (disjoint). */
function subtract(base, cut) {
  const out = [];
  for (const [start, end] of base) {
    let from = start;
    for (const [cutStart, cutEnd] of cut) {
      if (cutEnd <= from || cutStart >= end) continue;
      if (cutStart > from) out.push([from, cutStart]);
      from = Math.max(from, cutEnd);
      if (from >= end) break;
    }
    if (from < end) out.push([from, end]);
  }
  return out;
}

/**
 * Attention stretches, from the ticket's events: a park (`needs_attention`) or
 * a mid-turn wait on a person (`human_wait_started`) opens one, and a cleared
 * park, a reactivation, the wait's end or a column move closes it. A stretch
 * still open runs to `until`.
 */
export function attentionIntervals(events, until) {
  const ordered = [...events].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const open = { park: null, wait: null };
  const out = [];
  const close = (key, at) => {
    if (open[key] !== null && at > open[key]) out.push([open[key], at]);
    open[key] = null;
  };
  for (const event of ordered) {
    const at = toMs(event.at);
    if (at === null) continue;
    if (event.kind === 'needs_attention') { if (open.park === null) open.park = at; }
    else if (event.kind === 'human_wait_started') { if (open.wait === null) open.wait = at; }
    else if (event.kind === 'human_wait_ended') close('wait', at);
    else if (ATTENTION_CLOSE.has(event.kind)) {
      // A reactivation or a cleared park ends the park; a column move ends both
      // (the store clears a park on any column change).
      close('park', at);
      if (event.kind === 'column_changed') close('wait', at);
    }
  }
  close('park', until);
  close('wait', until);
  return union(out);
}

/**
 * Milliseconds the ticket spent in an active working state: the engine had a
 * turn, a judge call, a tool or a workflow step running for it, and nobody was
 * being waited on - a parked ticket and a turn paused on a question or an
 * approval prompt do not count. Overlapping spans count once. `endAt` is when
 * the clock stops (a closed ticket's close time), `now` otherwise.
 */
export function workingMs({ spans = [], events = [], now = Date.now(), endAt = null }) {
  const stop = endAt === null || endAt === undefined ? now : Math.min(now, endAt);
  const active = [];
  for (const span of spans) {
    if (!WORK_SPAN_KINDS.has(span.kind)) continue;
    if (span.status === 'awaiting_human') continue;
    const start = toMs(span.startedAt);
    if (start === null) continue;
    const finish = span.endedAt === null || span.endedAt === undefined ? stop : (toMs(span.endedAt) ?? stop);
    active.push([start, Math.min(finish, stop)]);
  }
  const worked = subtract(union(active), attentionIntervals(events, stop));
  return worked.reduce((sum, [start, end]) => sum + (end - start), 0);
}

/**
 * Whether the ticket's working time is growing right now: a work span is open,
 * it is not paused on a person, and no attention stretch is covering the
 * present. The board shows a still-growing time as the figure plus the time
 * since it was read, so it needs no new request to keep moving.
 */
export function isAccruing({ spans = [], events = [] }, now = Date.now()) {
  const running = spans.some(
    (span) => WORK_SPAN_KINDS.has(span.kind)
      && span.status !== 'awaiting_human'
      && (span.endedAt === null || span.endedAt === undefined)
      && toMs(span.startedAt) !== null,
  );
  if (!running) return false;
  return workingMs({ spans, events, now: now + 1000 }) > workingMs({ spans, events, now });
}

/** The most recent session of a purpose (`plan` or `build`), by attach order. */
export function latestSessionOf(sessions, purpose) {
  let hit = null;
  for (const session of sessions) {
    if (sessionPurpose(session) === purpose) hit = session;
  }
  return hit === null ? null : hit.sessionId;
}

/** `plan` for planner sessions, `build` for everything else (approval is a phase of the build session). */
function sessionPurpose(session) {
  if (session.purpose === 'plan' || session.role === 'planner' || session.role === 'griller') return 'plan';
  return 'build';
}

/**
 * Where each progress step jumps to: plan opens the latest plan session;
 * implement, review and approval open the build session they all run in.
 * A step with no session of its kind maps to null.
 */
export function phaseSessions(sessions) {
  const plan = latestSessionOf(sessions, 'plan');
  const build = latestSessionOf(sessions, 'build');
  return { plan, implement: build, review: build, verify: build, closed: null };
}

/**
 * The card's jump-to-session target: the session with a turn in flight or a
 * pending question, else the latest one attached. `activeIds` are the sessions
 * the driver sees working or waiting, any order.
 */
export function jumpSession(sessions, activeIds = []) {
  const known = new Set(sessions.map((s) => s.sessionId));
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    if (activeIds.includes(sessions[i].sessionId)) return sessions[i].sessionId;
  }
  const stray = activeIds.find((id) => known.has(id));
  if (stray !== undefined) return stray;
  return sessions.length === 0 ? null : sessions[sessions.length - 1].sessionId;
}

/** Done and Discarded as one list, newest closed first (a missing close time sorts by last update). */
export function closedNewestFirst(items) {
  const stamp = (item) => toMs(item.closedAt) ?? toMs(item.updatedAt) ?? 0;
  return [...items].sort((a, b) => stamp(b) - stamp(a));
}

/** The title a workflow session carries: "<ticket key> · <session type> · <ticket title>". */
export function sessionTitle(ticket, purpose) {
  const title = String(ticket.title ?? '').replace(/\s+/g, ' ').trim();
  return title === '' ? `${ticket.key} · ${purpose}` : `${ticket.key} · ${purpose} · ${title}`;
}
