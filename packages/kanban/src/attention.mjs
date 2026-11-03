// dsh-kanban: what a ticket is waiting on, read from live facts.
//
// One place answers "does this ticket need a person, and for what", so the board
// card, the detail header and the tests all read the same answer. The facts come
// from two owners: the driver knows which sessions are paused mid-turn on an
// approval prompt or a question, and the ticket row knows whether the engine
// parked it. Nothing here is stored: an answered prompt stops being a fact the
// moment the driver sees the decision, and the ticket is plain working again.

import { cardStatus } from './lifecycle.mjs';
import { isQuestionPark } from './recovery.mjs';

/**
 * @param {object} ticket the ticket row
 * @param {{engine: {active: Map}, driver: object}} owners
 * @returns {{
 *   status: 'attention'|'active'|'idle',
 *   awaitingQuestion: boolean,
 *   parkedOnQuestion: boolean,
 *   awaitingApproval: boolean,
 *   reason: string|null,
 * }}
 */
export function attentionFacts(ticket, { engine, driver }) {
  const awaitingQuestion = driver.isAwaitingQuestion(ticket.id);
  const awaitingApproval = driver.isAwaitingApproval(ticket.id);
  const parkedOnQuestion = isQuestionPark(ticket.needsAttentionReason);
  const status = cardStatus(ticket, {
    active: engine.active.has(ticket.id) || driver.isTicketBusy(ticket.id),
    awaitingUser: awaitingQuestion,
    awaitingApproval,
  });
  // A mid-turn wait has no engine park to explain it; say which ask is pending
  // the way a park explains itself.
  let reason = ticket.needsAttentionReason ?? null;
  if (status === 'attention' && !reason) reason = awaitingApproval ? 'Awaiting your approval' : 'Waiting on your answer';
  return { status, awaitingQuestion, parkedOnQuestion, awaitingApproval, reason };
}
