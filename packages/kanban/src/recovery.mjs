// dsh-kanban: the pure parts of recovery.
//
// What a fresh session is told when the conversation that held a ticket's work
// is gone, when an interrupted session may be resumed on its own, and when a
// turn that ended is really a question waiting for a person. No dsh imports,
// no store: the engine hands in plain values and these functions decide.

/** The reason prefix of a park whose cause is a question a person has to answer. */
export const QUESTION_PARK_PREFIX = 'Waiting on your answer';

/** True for a needs-attention reason raised because the session asked a question. */
export function isQuestionPark(reason) {
  return typeof reason === 'string' && reason.startsWith(QUESTION_PARK_PREFIX);
}

/**
 * The question a finished turn left open, or null.
 *
 * A turn that ends on a question mark in its final paragraph is the model
 * waiting for a person, whatever tool it did or did not call. Code fences and
 * trailing markdown emphasis are looked through; a question buried mid-answer
 * is not the end of the turn and does not count.
 */
export function endedOnQuestion(finalText) {
  if (typeof finalText !== 'string') return null;
  const text = finalText.trim();
  if (text === '') return null;
  const paragraphs = text.split(/\n\s*\n/).map((block) => block.trim()).filter((block) => block !== '');
  const last = paragraphs[paragraphs.length - 1];
  if (last === undefined || last.startsWith('```')) return null;
  const stripped = last.replace(/[\s*_`"'")\]]+$/u, '');
  if (!stripped.endsWith('?')) return null;
  const lines = last.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const line = lines[lines.length - 1] ?? stripped;
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/** The park reason for a turn that ended on a question. */
export function questionParkReason(phaseName, question) {
  return `${QUESTION_PARK_PREFIX} in the ${phaseName} session: ${question}`;
}

/** Event kinds that prove a ticket moved after a restart resumed it. */
const PROGRESS_KINDS = new Set([
  'planned',
  'plan_ready',
  'plan_approved',
  'implemented',
  'approval_requested',
  'review_rejected',
  'review_retry',
  'done',
  'discarded',
  'phase_changed',
  'column_changed',
]);

/**
 * Whether a restart may resume this ticket on its own. Once: a restart that
 * arrives before a previous automatic resume produced any progress is a loop,
 * and the ticket parks with the reason instead of being resumed again.
 *
 * @param {Array<{kind: string, payload?: object}>} events oldest first
 */
export function restartResumeAllowed(events) {
  let lastAuto = -1;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].kind === 'restart_recovered' && events[i].payload?.autoResume === true) lastAuto = i;
  }
  if (lastAuto < 0) return true;
  for (let i = lastAuto + 1; i < events.length; i += 1) {
    if (PROGRESS_KINDS.has(events[i].kind)) return true;
  }
  return false;
}

function clip(value, max = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function list(values) {
  return (Array.isArray(values) ? values : []).map((value) => clip(value)).filter((value) => value !== '');
}

/** One timeline line per event worth telling a fresh session about. */
function historyLine(event) {
  const payload = event.payload ?? {};
  switch (event.kind) {
    case 'implemented':
      return `implementation submitted (attempt ${payload.attempt ?? '?'})${payload.manual ? ', by a human' : ''}`;
    case 'review_rejected':
      return `review sent back: ${clip((payload.gaps ?? []).join('; ') || 'gaps in the review', 160)}`;
    case 'review_retry':
      return 'the reviewer was asked to fix its own submission';
    case 'needs_attention_reason':
      return `parked: ${clip(payload.reason, 200)}`;
    case 'budget_reset':
      return 'a human retry reset the attempt budget';
    case 'approval_requested':
      return 'review passed; approval requested';
    case 'restart_recovered':
      return `service restart interrupted the ${payload.phase ?? 'session'}`;
    default:
      return null;
  }
}

/**
 * The text a fresh session reads first when it replaces one that held the work.
 *
 * It states, in this order: whether the work already passed review (the one
 * fact that decides whether to redo anything), the attempt history, the last
 * review's verdict and reasons, what the last implementation shipped, and what
 * is left. The caller appends the human's latest instruction after it.
 *
 * @param {object} input
 * @param {{key: string, title: string}} input.ticket
 * @param {number} input.attempts implementation rounds submitted so far, across every retry
 * @param {number} input.maxAttempts
 * @param {Array<{kind: string, payload?: object}>} input.events oldest first
 * @param {object|null} input.implementation the last implement_result
 * @param {object|null} input.review the last review artifact
 * @param {boolean} input.passedReview the code gate's reading of that review
 * @param {string[]} input.failingIds condition ids the last review left unmet
 * @param {Array<{id: string, statement: string}>} input.conditions
 */
export function recoverySummary({ ticket, attempts, maxAttempts, events, implementation, review, passedReview, failingIds, conditions }) {
  const lines = [
    `This is a new session for ${ticket.key} ("${ticket.title}"). The session that held this ticket's earlier work is not available, so this note stands in for its history. Treat the files in the workspace as the ground truth for what exists.`,
    '',
  ];
  if (review === null || review === undefined) {
    lines.push('Review status: the work has NOT been reviewed yet.');
  } else if (passedReview) {
    lines.push('Review status: the work ALREADY PASSED REVIEW (verdict pass, every condition accounted for). Do not redo or restructure it; only do what the instruction below asks.');
  } else {
    lines.push('Review status: the work has NOT passed review; the last review sent it back.');
  }
  lines.push('', `Implementation rounds so far: ${attempts} (attempt budget per retry: ${maxAttempts}).`);
  const history = events.map(historyLine).filter((line) => line !== null).slice(-8);
  if (history.length > 0) {
    lines.push('', 'History (oldest first):', ...history.map((line) => `- ${line}`));
  }
  if (review !== null && review !== undefined) {
    lines.push('', `Last review: verdict ${review.verdict ?? '?'}.`);
    const reasons = list(review.reasons);
    if (reasons.length > 0) lines.push(...reasons.map((reason) => `- ${reason}`));
    if (typeof review.instruction === 'string' && review.instruction.trim() !== '') {
      lines.push(`Reviewer's instruction: ${clip(review.instruction, 600)}`);
    }
  }
  if (implementation !== null && implementation !== undefined) {
    lines.push('', `Last implementation (${implementation.status ?? '?'}): ${clip(implementation.summary, 600)}`);
    const files = list(implementation.changed_files).slice(0, 20);
    if (files.length > 0) lines.push(`Changed files: ${files.join(', ')}`);
    const risks = list(implementation.residual_risks);
    if (risks.length > 0) lines.push(`Residual risks it reported: ${risks.join('; ')}`);
  } else {
    lines.push('', 'Nothing has been submitted as an implementation yet.');
  }
  lines.push('');
  if (passedReview) {
    lines.push('What is left: nothing that review asked for. Anything outstanding is in the human instruction below.');
  } else if (failingIds.length > 0) {
    const named = failingIds.map((id) => {
      const condition = conditions.find((candidate) => candidate.id === id);
      return condition === undefined ? `- \`${id}\`` : `- \`${id}\` — ${clip(condition.statement, 200)}`;
    });
    lines.push('What is left (conditions the last review left unmet):', ...named);
  } else if (review !== null && review !== undefined) {
    lines.push('What is left: the last review named no specific condition; address its reasons above and re-verify every condition.');
  } else {
    lines.push('What is left: everything in the plan that the workspace does not already satisfy.');
  }
  return lines.join('\n');
}

/**
 * Where the latest plan revision stands, read from the ticket's own events:
 * `pending` while the plan session is working on it, `rejected` with the reason
 * when the resubmission did not take, `applied` once a revised plan replaced the
 * old one. Null when no revision was ever asked for.
 *
 * @param {Array<{kind: string, at?: string, payload?: object}>} events oldest first
 */
export function planRevisionState(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const payload = event.payload ?? {};
    if (event.kind === 'plan_revision_rejected') {
      return { status: 'rejected', reason: String(payload.reason ?? 'the revision was rejected'), instruction: payload.instruction ?? '', at: event.at ?? null };
    }
    if (event.kind === 'plan_revision_requested') {
      return { status: 'pending', reason: null, instruction: payload.instruction ?? '', at: event.at ?? null };
    }
    if (event.kind === 'planned' && payload.revised === true) {
      return { status: 'applied', reason: null, instruction: '', planVersion: payload.planVersion ?? null, at: event.at ?? null };
    }
  }
  return null;
}
