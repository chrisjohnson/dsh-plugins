// dsh-kanban: the Work-In-Progress cap, as a pure decision.
//
// The board-owner instruction behind this (KAN-72) is that a cap nobody can
// enforce is a convention, not a limit: a human drag, a plan approval or an
// orchestrator call could always put another ticket into Working, and the
// engine's `wipCap` only throttled how many turns it drove at once. So the cap
// here is an admission rule on the *column*, and the overflow waits in Backlog
// wearing a park that says why and where it stands.
//
// Definitions, stated once because every layer reads them the same way:
//
//   occupancy  — tickets in Working that are NOT parked. A parked Working
//                ticket (awaiting approval, a question, a failed round) is
//                waiting on a person, not consuming a worker, so it does not
//                count. This is the definition the board owner chose.
//   the queue  — Backlog tickets whose park reason is a WIP-queue notice. The
//                queue order is the board's queue order (priority desc, then
//                the human's arrangement, then creation), so the head of the
//                queue is the ticket the board would have taken next.
//   the cap    — the value a person set from the UI, else the configured
//                `wipCap`. The UI value lives in the board db, so it survives a
//                restart and does not need the patch file edited.
//
// Imports nothing from dsh and touches no SQLite: the store and config answers
// are handed in, which is what makes every branch here testable on a bare clone.

import { compareQueue } from './lifecycle.mjs';

/**
 * Every WIP-queue park starts with this, and it is the only thing that marks a
 * Backlog ticket as "queued for a Working slot" rather than parked for some
 * other reason. Keep it in sync with `wipQueueReason` below.
 */
export const WIP_QUEUE_PREFIX = 'WIP cap ';

/** The floor a cap can never go below: one ticket at a time. */
export const MIN_WIP_CAP = 1;

/**
 * The sentence a queued card shows. `occupancy`/`cap` says the slot situation,
 * `position` says where this ticket stands in line, and the last clause says
 * what happens next, because a park that does not say how it clears is a ticket
 * a human has to go and re-drag by hand.
 */
export function wipQueueReason({ cap, occupancy, position }) {
  return `${WIP_QUEUE_PREFIX}${occupancy}/${cap} — queued at position ${position}. It starts automatically when a Working slot frees.`;
}

/** True when a park reason is a WIP-queue notice (and not some other park). */
export function isWipQueuePark(reason) {
  return typeof reason === 'string' && reason.startsWith(WIP_QUEUE_PREFIX);
}

/**
 * Read the numbers back out of a queue reason. `{}` when the text is not a
 * queue notice or has lost its numbers — callers treat that as "no opinion",
 * never as zero, so a hand-written reason that happens to start with the
 * prefix is not mistaken for a counted position.
 */
export function parseWipQueueReason(reason) {
  if (!isWipQueuePark(reason)) return {};
  const match = /^WIP cap (\d+)\/(\d+) — queued at position (\d+)/.exec(reason);
  if (match === null) return {};
  return {
    occupancy: Number(match[1]),
    cap: Number(match[2]),
    position: Number(match[3]),
  };
}

/** A cap is only a cap if it is a whole number of at least one. */
export function validCap(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_WIP_CAP ? n : null;
}

/**
 * The cap that is in force right now: the board db's value once a person has
 * set one, otherwise the configured `wipCap`. The db wins because the point of
 * the UI control is that changing it takes effect without editing config and
 * restarting the service.
 *
 * @returns {{cap: number, source: 'db' | 'config'}}
 */
export function effectiveCap({ dbValue, configCap } = {}) {
  const fromDb = validCap(dbValue);
  if (fromDb !== null) return { cap: fromDb, source: 'db' };
  const fromConfig = validCap(configCap);
  if (fromConfig !== null) return { cap: fromConfig, source: 'config' };
  // Unreachable through the config validator (it rejects a wipCap < 1), but a
  // cap must never resolve to "no limit": one at a time is the safe reading of
  // a board whose limit cannot be worked out.
  return { cap: MIN_WIP_CAP, source: 'config' };
}

/** The Working tickets that occupy a slot: in Working and not parked. */
export function workingTickets(tickets) {
  return (tickets ?? [])
    .filter((ticket) => ticket.column === 'working' && !ticket.needsAttentionReason)
    .slice()
    .sort(compareQueue);
}

/** How many slots of the cap are taken. */
export function workingOccupancy(tickets) {
  return workingTickets(tickets).length;
}

/** The queued tickets, head first: Backlog cards wearing a WIP-queue park. */
export function wipQueue(tickets) {
  return (tickets ?? [])
    .filter((ticket) => ticket.column === 'backlog' && isWipQueuePark(ticket.needsAttentionReason))
    .slice()
    .sort(compareQueue);
}

/**
 * The refusal a move into Working gets when the board is full, in the shape
 * every caller passes through: the numbers, plus the sentence the card shows.
 */
export function wipQueueRefusal({ cap, occupancy, position }) {
  return { cap, occupancy, position, reason: wipQueueReason({ cap, occupancy, position }) };
}

/**
 * The queue as a board read shows it: enough to name each waiting ticket and
 * where it stands, without the whole row. Position is 1-based, head first.
 */
export function queueSummary(queue) {
  return (queue ?? []).map((ticket, index) => ({
    key: ticket.key,
    title: ticket.title,
    position: index + 1,
    phase: ticket.phase,
  }));
}

/**
 * The Working tickets to send back to the queue when a person lowers the cap
 * below what is running: the tail of the queue order, i.e. the lowest-priority
 * occupancy first, so the work the board most wants stays in flight.
 */
export function overflowForLoweredCap(tickets, cap) {
  const limit = validCap(cap) ?? MIN_WIP_CAP;
  return workingTickets(tickets).slice(limit);
}

/**
 * The gate the move/start paths ask before letting a ticket into Working.
 *
 * A collaborator object rather than a pile of arguments because three callers
 * (the human drag, `startBuild`, `kanban_start`) need the same answer, and the
 * engine is the only place that knows both the db value and the config one.
 * `store` and `getConfig` are handed in, so this file still imports nothing from
 * dsh and the whole rule is testable against a bare in-memory store.
 *
 * @param {{store: object, getConfig?: () => object}} owners
 */
export function createWipGate({ store, getConfig }) {
  const capNow = () => effectiveCap({ dbValue: store.getSetting?.('wip_cap'), configCap: getConfig?.().wipCap });
  return {
    /** The cap in force and where it came from: `'db'` once a person has set one. */
    cap: capNow,
    /** Everything a board read shows: the numbers plus the queue, in one pass. */
    state() {
      const { cap, source } = capNow();
      return { cap, source, occupancy: store.countWorkingOccupancy(), queue: store.listWipQueue() };
    },
    /**
     * Why this ticket may not enter Working right now, or `null` when there is
     * room. A ticket already in Working is never refused: it is already counted,
     * and refusing a no-op move would read as a bug to whoever dragged it.
     */
    refusalFor(ticket) {
      if (ticket === undefined || ticket === null || ticket.column === 'working') return null;
      const { cap } = capNow();
      const occupancy = store.countWorkingOccupancy();
      if (occupancy < cap) return null;
      const queue = store.listWipQueue();
      const at = queue.findIndex((queued) => queued.id === ticket.id);
      // A ticket already queued keeps its place. A new arrival is counted where
      // it will actually sort in the queue — priority first, then the order a
      // human arranged — so a high-priority card does not tell the person it is
      // last when the engine will start it before everything else in line.
      const position = at >= 0
        ? at + 1
        : [...queue, ticket].sort(compareQueue).findIndex((queued) => queued.id === ticket.id) + 1;
      return wipQueueRefusal({ cap, occupancy, position });
    },
    /**
     * The place a ticket that does not exist yet would take in the queue — what
     * "create this ticket straight into Working" is answered with when the
     * board is full.
     */
    arrivalRefusal() {
      return this.refusalFor({ column: 'backlog', id: null });
    },
  };
}
