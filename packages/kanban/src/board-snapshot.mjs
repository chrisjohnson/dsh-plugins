// dsh-kanban: the board as the browser reads it, built cheaply and comparably.
//
// The Host answers "what does the board look like" for every open page, and a
// board that is quiet should cost almost nothing to answer. Three things make
// that so, none of which change what a card says:
//
//   - one change token that is cheap to read and differs whenever anything the
//     board shows could differ (stored rows, or the driver's in-memory waits),
//     so a caller that holds the last token can be told "unchanged" without a
//     rebuild;
//   - a build that reads each table once for the whole board (no query per
//     card) and remembers the history-derived facts of closed tickets, which
//     cannot change after they close;
//   - a signature of the content that leaves out what only the clock moves
//     (a growing working time), so a rebuild that found nothing new can be
//     recognised and not sent.
//
// Imports nothing from dsh: the store, driver and engine are handed in.

import { createHash, randomUUID } from 'node:crypto';

import { attentionFacts } from './attention.mjs';
import { attemptLabel, closedNewestFirst, isAccruing, jumpSession, phaseSegments, workingMs } from './board-view.mjs';
import { TERMINAL_COLUMNS } from './lifecycle.mjs';
import { isQuestionPark } from './recovery.mjs';
import { queueSummary, wipQueue, workingOccupancy } from './wip.mjs';

const NO_FACTS = { transitions: [], events: [], spans: [], sessions: [] };

/** The card's own columns, before anything derived is added. */
export function summary(ticket, editable = false, nowMs = Date.now()) {
  return {
    id: ticket.id,
    key: ticket.key,
    title: ticket.title,
    column: ticket.column,
    phase: ticket.phase,
    editable,
    priority: ticket.priority,
    sortOrder: ticket.sortOrder,
    attemptCount: ticket.attemptCount,
    planTiming: ticket.planTiming,
    planQuestions: ticket.planQuestions,
    spentUsd: ticket.spentUsd,
    budgetUsd: ticket.budgetUsd,
    allowPaid: ticket.allowPaid,
    needsAttentionReason: ticket.needsAttentionReason,
    updatedAt: ticket.updatedAt,
    createdAt: ticket.createdAt,
    closedAt: ticket.closedAt ?? null,
    totalMs: (() => {
      const created = Date.parse(ticket.createdAt);
      const closed = ticket.closedAt === null || ticket.closedAt === undefined ? nowMs : Date.parse(ticket.closedAt);
      return Number.isFinite(created) && Number.isFinite(closed) ? Math.max(0, closed - created) : 0;
    })(),
  };
}

/**
 * The facts a card shows that no ticket column holds: phase path, working time,
 * attempt wording, jump target.
 *
 * @param {object} ticket
 * @param {{transitions: object[], events: object[], spans: object[], sessions: object[]}|undefined} telemetry
 * @param {number} nowMs
 * @param {{driver: object, precomputed?: {segments: object[], workingMs: number}}} owners
 */
export function derivedFacts(ticket, telemetry, nowMs, { driver, precomputed = null }) {
  const facts = telemetry ?? NO_FACTS;
  const closedAt = ticket.closedAt === null || ticket.closedAt === undefined ? null : Date.parse(ticket.closedAt);
  const out = {
    attemptLabel: attemptLabel(ticket.attemptCount),
    segments: precomputed !== null
      ? precomputed.segments
      : phaseSegments({ transitions: facts.transitions, phase: ticket.phase, column: ticket.column }),
    workingMs: precomputed !== null
      ? precomputed.workingMs
      : workingMs({ spans: facts.spans, events: facts.events, now: nowMs, endAt: Number.isFinite(closedAt) ? closedAt : null }),
  };
  out.accruing = precomputed === null && !Number.isFinite(closedAt) && isAccruing(facts, nowMs);
  out.sessionId = jumpSession(facts.sessions, driver.activeSessionIds(ticket.id));
  return out;
}

/**
 * JSON for comparison: everything the content says, minus what only the clock
 * moves. A growing working time is excluded because the browser carries it
 * forward itself (see `accruing`); a ticket's age is not shown from the server.
 */
export function stableJson(value) {
  return JSON.stringify(value, function replacer(key, item) {
    if (key === 'totalMs') return undefined;
    if (key === 'workingMs' && this.accruing === true) return undefined;
    if ((key === 'endedAt' || key === 'durationMs') && this.status === 'running') return undefined;
    return item;
  });
}

export function digest(text) {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * @param {{store: object, driver: object, engine: object, now?: () => number}} owners
 */
export function createBoardSnapshots({
  store,
  driver,
  engine,
  now = Date.now,
  orchestratorPaused = () => false,
  wipCap = null,
}) {
  let seq = 0;
  // Which run of the host the counter belongs to: a restart starts it over, and
  // a page must not mistake the new run's first boards for old ones.
  const boot = randomUUID();
  /** ticketId ->{ key, segments, workingMs }: history-derived facts of a closed ticket. */
  let closedFacts = new Map();
  /** the ticket id/phase list, kept for as long as the stored rows are unchanged */
  let heads = { token: null, list: [] };

  const headsFor = (storeToken) => {
    if (heads.token !== storeToken) heads = { token: storeToken, list: store.listTicketHeads() };
    return heads.list;
  };

  /**
   * What the driver and engine hold in memory that a card reads: running turns,
   * pending asks and approvals, live plan sessions. Only tickets with something
   * going on contribute, so a quiet board is an empty string.
   */
  const liveSignature = (list) => {
    const parts = [];
    for (const head of list) {
      const id = head.id;
      const bits = (engine.active.has(id) ? 1 : 0)
        | (driver.isTicketBusy(id) ? 2 : 0)
        | (driver.isAwaitingQuestion(id) ? 4 : 0)
        | (driver.isAwaitingApproval(id) ? 8 : 0);
      const plan = head.phase === 'plan' ? (driver.liveTicketSession(id, 'plan') ?? '') : '';
      const sessions = driver.activeSessionIds(id);
      if (bits === 0 && plan === '' && sessions.length === 0) continue;
      parts.push(`${id}:${bits}:${plan}:${sessions.join(',')}`);
    }
    return parts.join(';');
  };

  /** Equal tokens mean the board would be built from the same inputs (the clock aside). */
  const token = () => {
    const stored = store.changeToken();
    return `${stored}|${liveSignature(headsFor(stored))}`;
  };

  const isClosed = (ticket) => TERMINAL_COLUMNS.includes(ticket.column);
  const closedKey = (ticket) => `${ticket.closedAt}|${ticket.phase}|${ticket.column}`;

  /** Build the board. `token` is read before anything else, so a write racing the build shows up as a later token. */
  const build = () => {
    const builtToken = token();
    const nowMs = now();
    const tickets = store.listTickets({ withBody: false });
    const remembered = closedFacts;
    closedFacts = new Map();
    const needed = [];
    for (const ticket of tickets) {
      if (!isClosed(ticket)) {
        needed.push(ticket.id);
        continue;
      }
      const known = remembered.get(ticket.id);
      if (known !== undefined && known.key === closedKey(ticket)) closedFacts.set(ticket.id, known);
      else needed.push(ticket.id);
    }
    const telemetry = store.boardTelemetry(needed, { sessions: false });
    const sessions = store.boardSessions();
    const byColumn = { backlog: [], working: [], done: [], discarded: [] };
    for (const ticket of tickets) {
      const facts = telemetry.get(ticket.id);
      const attached = { ...(facts ?? NO_FACTS), sessions: sessions.get(ticket.id) ?? [] };
      const precomputed = closedFacts.get(ticket.id) ?? null;
      const derived = derivedFacts(ticket, attached, nowMs, { driver, precomputed });
      const closedAt = Date.parse(ticket.closedAt ?? '');
      if (precomputed === null && isClosed(ticket) && Number.isFinite(closedAt) && closedAt <= nowMs) {
        closedFacts.set(ticket.id, { key: closedKey(ticket), segments: derived.segments, workingMs: derived.workingMs });
      }
      const item = { ...summary(ticket, store.isEditableTicket(ticket), nowMs), ...derived };
      if (ticket.phase === 'plan') item.planSessionId = driver.liveTicketSession(ticket.id, 'plan') ?? null;
      // A ticket parked because its session ended on a question reads exactly
      // like one whose session is paused inside the question: both are waiting
      // on the person's answer, and the card, chip and next-action say so.
      item.parkedOnQuestion = isQuestionPark(ticket.needsAttentionReason);
      item.awaitingQuestion = driver.isAwaitingQuestion(ticket.id) || item.parkedOnQuestion;
      item.awaitingApproval = driver.isAwaitingApproval(ticket.id);
      item.status = attentionFacts(ticket, { engine, driver }).status;
      // Attention without an engine park is a mid-turn human wait: say which
      // one, so the red card explains itself the way a park does.
      if (item.status === 'attention' && !ticket.needsAttentionReason) {
        item.needsAttentionReason = item.awaitingApproval ? 'Awaiting your approval' : 'Waiting on your answer';
      }
      byColumn[ticket.column]?.push(item);
    }
    const board = {
      counts: store.counts(),
      columns: byColumn,
      // Done and Discarded share one column on the board, newest closed first.
      closed: closedNewestFirst([...byColumn.done, ...byColumn.discarded]),
      orchestratorPaused: orchestratorPaused() === true,
      // KAN-72: the cap the engine enforces, how much of it is taken, and who is
      // waiting — worked out from the rows already in hand, so the page's WIP
      // pill and the engine's own admission rule can never disagree.
      wip: wipBlock(tickets),
    };
    seq += 1;
    return { seq, boot, token: builtToken, asOf: nowMs, board, signature: digest(stableJson(board)) };
  };

  /** The WIP block, or null on a board built without a cap provider. */
  function wipBlock(tickets) {
    if (typeof wipCap !== 'function') return null;
    const { cap, source } = wipCap();
    return {
      cap,
      source,
      occupancy: workingOccupancy(tickets),
      queue: queueSummary(wipQueue(tickets)),
    };
  }

  return { token, build };
}

/**
 * The same board with Done and Discarded carried once, in `closed`, instead of
 * twice: the page rebuilds `columns.done` / `columns.discarded` from it. Cuts a
 * long-lived board's payload by a third.
 */
export function compactBoard(board) {
  const { done, discarded, ...open } = board.columns;
  void done;
  void discarded;
  return {
    counts: board.counts,
    columns: open,
    closed: board.closed,
    orchestratorPaused: board.orchestratorPaused === true,
    wip: board.wip ?? null,
    compact: true,
  };
}
