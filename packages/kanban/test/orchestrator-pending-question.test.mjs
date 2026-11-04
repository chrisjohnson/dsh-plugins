// KAN-66, gap 1: the question a ticket waits on reaches the orchestrator.
//
// The standing directive says: when a ticket is parked on a worker question,
// *read the question first* and answer it yourself if it does not need a human.
// That was prose the surface could not support — `kanban_ticket` and
// `kanban_board` said `waitingOnHuman: true` and nothing about what was asked,
// so the orchestrator had to infer the question from context. These tests pin
// the three decisions that close it:
//
//   - the park reason can be read back apart (`questionFromParkReason`);
//   - the live batch from the driver wins over the park text, and the park text
//     is the fallback when there is no live turn (`pendingQuestionFacts`);
//   - every surface the orchestrator reads carries the result, including the
//     one-line snapshot form, at a width that does not cut the question off.
//
// Pure module, bare clone, no dsh imports.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_DIGEST_CHARS,
  boardSnapshotText,
  pendingQuestionFacts,
  runOrchestratorTool,
  ticketLineFacts,
} from '../src/orchestrator.mjs'
import { questionFromParkReason, questionParkReason } from '../src/recovery.mjs'

const QUESTION = 'The release step needs the tag pushed before the deploy pin — should I push dsh-kanban-v0.29.0 now, or hold until a human reviews the pin commit?'

const parkedTicket = (over = {}) => ({
  id: 't-61',
  key: 'KAN-61',
  title: 'Restart-owed wrap-up',
  column: 'working',
  phase: 'implement',
  needsAttentionReason: questionParkReason('implement', QUESTION),
  attemptCount: 1,
  spentUsd: 0.4,
  budgetUsd: 0,
  updatedAt: '2026-11-04T00:00:00.000Z',
  ...over,
})

// --------------------------------------------------- questionFromParkReason --

test('a question park gives back the question it was built from', () => {
  assert.equal(questionFromParkReason(questionParkReason('implement', QUESTION)), QUESTION)
  assert.equal(questionFromParkReason(questionParkReason('plan', 'Which preset?')), 'Which preset?')
})

test('a question containing colons and markdown survives the round trip', () => {
  const text = 'Two options: (a) pin now — see `package.json`: it is the second colon, or (b) wait?'
  assert.equal(questionFromParkReason(questionParkReason('review', text)), text)
})

test('a park that is not a question yields nothing', () => {
  assert.equal(questionFromParkReason('turn stalled in implement'), null)
  assert.equal(questionFromParkReason('Review sent back: 2 conditions unmet'), null)
  assert.equal(questionFromParkReason(null), null)
  assert.equal(questionFromParkReason(undefined), null)
  assert.equal(questionFromParkReason(42), null)
})

test('the bare wait text the board synthesises has no question to read', () => {
  // attention.mjs writes this when a mid-turn wait has no engine park behind it.
  assert.equal(questionFromParkReason('Waiting on your answer'), null)
})

// ---------------------------------------------------- pendingQuestionFacts --

test('a parked-on-question ticket exposes its question, marked as a park', () => {
  const facts = pendingQuestionFacts(parkedTicket(), null)
  assert.equal(facts.source, 'park')
  assert.equal(facts.questions.length, 1)
  assert.equal(facts.questions[0].question, QUESTION)
  assert.deepEqual(facts.questions[0].options, [])
})

test('a live batch wins over the park text, options and all', () => {
  const live = {
    kind: 'question',
    id: 'c1',
    questions: [{ question: 'Which tag should the pin name?', options: ['v0.29.0', 'v0.30.0'] }],
  }
  const facts = pendingQuestionFacts(parkedTicket(), live)
  assert.equal(facts.source, 'live')
  assert.equal(facts.questions[0].question, 'Which tag should the pin name?')
  assert.deepEqual(facts.questions[0].options, ['v0.29.0', 'v0.30.0'])
})

test('a live wait that carried no readable text falls back to the park', () => {
  const facts = pendingQuestionFacts(parkedTicket(), { kind: 'question', id: 'c1', questions: [] })
  assert.equal(facts.source, 'park')
  assert.equal(facts.questions[0].question, QUESTION)
})

test('a ticket waiting on nothing says so with null, not an empty shape', () => {
  assert.equal(pendingQuestionFacts(parkedTicket({ needsAttentionReason: null }), null), null)
  assert.equal(pendingQuestionFacts(parkedTicket({ needsAttentionReason: 'turn stalled' }), null), null)
  assert.equal(pendingQuestionFacts(null, null), null)
})

test('a live question on a ticket that was never parked still reads', () => {
  const facts = pendingQuestionFacts(parkedTicket({ needsAttentionReason: null }), {
    questions: [{ question: 'Restart now?', options: ['Yes', 'No'] }],
  })
  assert.equal(facts.source, 'live')
  assert.equal(facts.questions[0].question, 'Restart now?')
})

// ------------------------------------------------------- the ticket's line --

test('the ticket line carries the pending question beside the park reason', () => {
  const line = ticketLineFacts(parkedTicket())
  assert.equal(line.parked, parkedTicket().needsAttentionReason)
  assert.equal(line.pendingQuestion.source, 'park')
  assert.equal(line.pendingQuestion.questions[0].question, QUESTION)
  assert.ok(line.parked.includes(QUESTION), 'the park still reads whole; the question is added, not moved')
})

test('the ticket line takes the driver live wait into the same shape', () => {
  const line = ticketLineFacts(parkedTicket({ needsAttentionReason: null }), {
    running: true,
    waitingOnHuman: true,
    liveWait: { questions: [{ question: 'Pin 0.29.0 or 0.30.0?', options: ['0.29.0'] }] },
  })
  assert.equal(line.pendingQuestion.source, 'live')
  assert.equal(line.running, true)
  assert.equal(line.waitingOnHuman, true)
})

// ------------------------------------------------- the snapshot's one-liner --

test('the board snapshot prints ASKING with the question, not just the park', () => {
  const text = boardSnapshotText({
    asOf: '2026-11-04T00:00:00Z',
    counts: { backlog: 0, working: 1, done: 0, discarded: 0 },
    tickets: [ticketLineFacts(parkedTicket())],
  })
  const line = text.split('\n')[1]
  assert.match(line, /^- KAN-61 · “Restart-owed wrap-up” · working · implement · PARKED: .*ASKING: /)
  assert.ok(line.includes('should I push dsh-kanban-v0.29.0 now'), `question was cut off: ${line}`)
  assert.equal(line.includes('\n'), false, 'one line per ticket')
})

test('the ASKING part is not clipped at the park reason’s 90 characters', () => {
  // The complaint this exists for: the park line clipped the question away.
  const long = 'x'.repeat(150) + ' — is that the restart you meant?'
  const text = boardSnapshotText({
    counts: {},
    tickets: [ticketLineFacts(parkedTicket({ needsAttentionReason: questionParkReason('implement', long) }))],
  })
  assert.ok(text.includes(long.slice(0, MAX_DIGEST_CHARS - 20)), 'the question survives at digest width')
})

test('ASKING names the options when there is a live batch to choose from', () => {
  const text = boardSnapshotText({
    counts: {},
    tickets: [ticketLineFacts(parkedTicket({ needsAttentionReason: null }), {
      liveWait: { questions: [{ question: 'Which pin?', options: ['0.29.0', '0.30.0'] }] },
    })],
  })
  assert.match(text, /ASKING: Which pin\? \[0\.29\.0 \| 0\.30\.0\]/)
})

test('a ticket with no question gets no ASKING bit', () => {
  const text = boardSnapshotText({
    counts: {},
    tickets: [ticketLineFacts(parkedTicket({ needsAttentionReason: 'turn stalled' }))],
  })
  assert.equal(text.includes('ASKING'), false)
  assert.match(text, /PARKED: turn stalled/)
})

// ------------------------------------------------------ the tool read path --

/**
 * The host's `#ticketLine` is `ticketLineFacts` plus what the live driver knows,
 * so a fake seam that composes it the same way exercises the real read path:
 * guard, run, and the facts the model ends up reading.
 */
function fakeApi({ ticket, liveWait = null }) {
  return {
    resolveTicket: (key) => (key === ticket.key ? ticket : null),
    ticket: (found) => ({
      ...ticketLineFacts(found, { liveWait }),
      id: found.id,
      body: found.body ?? '',
    }),
  }
}

test('kanban_ticket returns the question text a parked ticket waits on', async () => {
  const read = await runOrchestratorTool('kanban_ticket', { ticket: 'KAN-61' }, fakeApi({ ticket: parkedTicket() }))
  assert.equal(read.pendingQuestion.source, 'park')
  assert.equal(read.pendingQuestion.questions[0].question, QUESTION)
})

test('kanban_ticket returns the live batch with its options when a turn is mid-ask', async () => {
  const read = await runOrchestratorTool('kanban_ticket', { ticket: 'KAN-61' }, fakeApi({
    ticket: parkedTicket({ needsAttentionReason: null }),
    liveWait: { questions: [{ question: 'Answer now or wait?', options: ['Now (Recommended)', 'Wait'] }] },
  }))
  assert.equal(read.pendingQuestion.source, 'live')
  assert.deepEqual(read.pendingQuestion.questions[0].options, ['Now (Recommended)', 'Wait'])
})

test('kanban_ticket on a ticket with no open question says nothing is pending', async () => {
  const read = await runOrchestratorTool('kanban_ticket', { ticket: 'KAN-61' }, fakeApi({
    ticket: parkedTicket({ needsAttentionReason: null }),
  }))
  assert.equal(read.pendingQuestion, null)
})
