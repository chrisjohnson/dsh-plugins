// Recovery: what the engine does when the conversation that held a ticket's work
// is gone, when a human retries, closes or re-reviews a parked ticket, and when a
// turn ends on a question. The fake driver keeps real session bookkeeping so a
// test can lose a session and watch the consequences.

import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizePlan } from '../src/result.mjs'
import {
  IMPLEMENTATION,
  PLAN,
  REVIEW_FAIL,
  REVIEW_FAIL_ROW,
  REVIEW_PASS,
  eventKinds,
  gitRepo,
  lastPrompt,
  liveSession,
  pickedUp,
  promptCounts,
  setup,
} from './support/engine-harness.mjs'

/** Wait for the launch the engine started on its own (retry and the review/revise actions tick). */
async function settle(engine, ticketId) {
  await new Promise((resolve) => setTimeout(resolve, 20))
  while (engine.active.has(ticketId)) await engine.active.get(ticketId)
}

function engineFor(queues, options) {
  const made = setup(queues, options)
  made.engine.recovered = true
  return made
}

/** A ticket parked because its one-attempt budget ran out after a failed review. */
async function exhausted(extra = {}) {
  const made = engineFor(
    {
      implement: [{ type: 'implementation', value: IMPLEMENTATION }],
      review: [{ type: 'review', value: REVIEW_FAIL_ROW }],
    },
    { config: { maxAttempts: 1 } },
  )
  const ticket = pickedUp(made.store, extra)
  await made.engine.advance(made.store.getTicket(ticket.id))
  const parked = made.store.getTicket(ticket.id)
  assert.match(parked.needsAttentionReason, /attempt budget exhausted/)
  return { ...made, ticket: parked }
}

// ---------------------------------------------------------- retry: the session

test('a retry continues in the live build session and adds no summary', async () => {
  const { store, driver, engine, ticket } = await exhausted()
  const sessionsBefore = driver.counter
  driver.queues.implementer.push({ type: 'implementation', value: IMPLEMENTATION })
  driver.queues.reviewer.push({ type: 'review', value: REVIEW_PASS })
  engine.retry(store.getTicket(ticket.id), { instruction: 'create it under docs/' })
  await settle(engine, ticket.id)
  assert.equal(driver.counter, sessionsBefore, 'no new session was created')
  const prompt = lastPrompt(store, ticket.id, 'implementer')
  assert.match(prompt, /^rework /)
  assert.match(prompt, /Human instruction for the next attempt:\ncreate it under docs\//, 'the instruction reaches the model')
  assert.equal(/new session for/.test(prompt), false, 'a live session needs no summary')
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
})

test('a retry reactivates the previous build session when it is only on disk', async () => {
  const { store, driver, engine, ticket } = await exhausted()
  const lost = driver.dropSession(ticket.id, 'build', store)
  driver.reactivations.length = 0
  driver.reactivation = { ok: true }
  driver.queues.implementer.push({ type: 'implementation', value: IMPLEMENTATION })
  driver.queues.reviewer.push({ type: 'review', value: REVIEW_PASS })
  engine.retry(store.getTicket(ticket.id), { instruction: 'try again' })
  await settle(engine, ticket.id)
  assert.deepEqual(driver.reactivations.map((r) => r.purpose), ['build'], 'asked for the earlier build session back')
  assert.equal(driver.liveTicketSession(ticket.id, 'build'), lost, 'the earlier session is the one that worked')
  assert.equal(driver.turns.at(-3), lost)
  const prompt = lastPrompt(store, ticket.id, 'implementer')
  assert.equal(/new session for/.test(prompt), false, 'a reopened session already holds the work')
  assert.ok(eventKinds(store, ticket.id).includes('session_resumed'))
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
})

test('a retry that cannot get the session back starts one from a summary and the human instruction', async () => {
  const { store, driver, engine, ticket } = await exhausted()
  const lost = driver.dropSession(ticket.id, 'build', store)
  // reactivation stays "none": nothing can be reopened
  driver.queues.implementer.push({ type: 'implementation', value: IMPLEMENTATION })
  driver.queues.reviewer.push({ type: 'review', value: REVIEW_PASS })
  engine.retry(store.getTicket(ticket.id), { instruction: 'the file belongs in docs/' })
  await settle(engine, ticket.id)
  const fresh = driver.liveTicketSession(ticket.id, 'build')
  assert.notEqual(fresh, lost, 'a new session was created')
  const prompt = lastPrompt(store, ticket.id, 'implementer')
  assert.match(prompt, /^This is a new session for /)
  assert.match(prompt, /has NOT passed review/, 'it says whether the work passed review')
  assert.match(prompt, /Implementation rounds so far: 1/)
  assert.match(prompt, /implementation submitted \(attempt 1\)/)
  assert.match(prompt, /Last review: verdict fail/)
  assert.match(prompt, /the file is missing/, 'the last verdict\'s reasons')
  assert.match(prompt, /Reviewer's instruction: create notes\.txt/)
  assert.match(prompt, /Last implementation \(complete\): created notes\.txt/, 'what shipped')
  assert.match(prompt, /`notes` — note exists/, 'what is left')
  assert.match(prompt, /Human instruction for the next attempt:\nthe file belongs in docs\//, 'and the latest instruction')
  assert.match(prompt, /\nrework /, 'followed by the ordinary rework prompt')
})

test('a cold session for work that already passed review says so', async () => {
  const { store, driver, engine } = setup({ implement: [{ type: 'implementation', value: IMPLEMENTATION }], review: [{ type: 'review', value: REVIEW_PASS }] })
  engine.recovered = true
  const ticket = pickedUp(store)
  // The state an approval follow-up leaves behind: a plan, an implementation and a
  // passing review on record, the ticket back in implement and parked, no session.
  const plan = normalizePlan(PLAN)
  store.replaceConditions(ticket.id, 1, plan.conditions, 'plan')
  store.addArtifact(ticket.id, 'plan', JSON.stringify({ ...plan, planVersion: 1 }))
  store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: 'seed' })
  store.setAttempt(ticket.id, 1, 0)
  store.addArtifact(ticket.id, 'implement_result', JSON.stringify(IMPLEMENTATION))
  store.addArtifact(ticket.id, 'review', JSON.stringify(REVIEW_PASS))
  store.setNeedsAttention(ticket.id, 'parked for the test')
  engine.retry(store.getTicket(ticket.id), { instruction: 'also add a trailing newline' })
  await settle(engine, ticket.id)
  const prompt = lastPrompt(store, ticket.id, 'implementer')
  assert.match(prompt, /ALREADY PASSED REVIEW/)
  assert.match(prompt, /Do not redo or restructure it/)
  assert.match(prompt, /also add a trailing newline/)
  assert.equal(driver.reactivations.length > 0, true, 'the engine tried to reopen a session first')
})

test('a human instruction reaches the model once, not on every later round', async () => {
  const { store, engine, ticket } = await exhausted()
  engine.retry(store.getTicket(ticket.id), { instruction: 'only once please' })
  assert.match(engine.pendingInstruction(store.getTicket(ticket.id), 'implementer'), /only once please/)
  engine.driver.queues.implementer.push({ type: 'implementation', value: IMPLEMENTATION })
  engine.driver.queues.reviewer.push({ type: 'review', value: REVIEW_PASS })
  await settle(engine, ticket.id)
  assert.match(lastPrompt(store, ticket.id, 'implementer'), /only once please/)
  assert.equal(engine.pendingInstruction(store.getTicket(ticket.id), 'implementer'), '', 'delivered, so no longer pending')
})

test('a retry instruction at the review phase goes to the reviewer', async () => {
  const { store, driver, engine } = engineFor({ review: [{ type: 'review', value: REVIEW_PASS }] })
  const ticket = pickedUp(store)
  const plan = normalizePlan(PLAN)
  store.replaceConditions(ticket.id, 1, plan.conditions, 'plan')
  store.addArtifact(ticket.id, 'plan', JSON.stringify({ ...plan, planVersion: 1 }))
  store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: 'seed' })
  store.transitionTicket(ticket.id, { phase: 'review' }, { actor: 'engine', reason: 'seed' })
  store.setAttempt(ticket.id, 1, 0)
  store.setNeedsAttention(ticket.id, 'reviewer ended without calling kanban_submit_review')
  engine.retry(store.getTicket(ticket.id), { instruction: 'check the docs/ path too' })
  await settle(engine, ticket.id)
  assert.match(lastPrompt(store, ticket.id, 'reviewer'), /check the docs\/ path too/)
  assert.equal(driver.turns.length > 0, true)
})

// ------------------------------------------- retry at the approval gate (KAN-64)
//
// The state KAN-62 was left in: the work passed review, only the approval
// hand-over died with the service, and the ticket parked with a promise that a
// retry starts a fresh session from a summary of the work so far. A retry keeps
// that promise: it re-runs the hand-over, not the plan and the build behind it.

const APPROVAL_PARK = 'approval session could not be reopened after a restart (the session file is gone); a human Retry starts a fresh session from a summary of the work so far'

/**
 * A ticket parked at the approval gate after a passing review. `live` keeps its
 * build session on the driver; otherwise the session is gone and reactivation
 * answers however the test sets `driver.reactivation`.
 */
function approvalParked({ live = false } = {}) {
  const made = engineFor({ approval: [null] })
  const { store, driver } = made
  const ticket = pickedUp(store)
  const plan = normalizePlan(PLAN)
  store.replaceConditions(ticket.id, 1, plan.conditions, 'plan')
  store.addArtifact(ticket.id, 'plan', JSON.stringify({ ...plan, planVersion: 1 }))
  store.addArtifact(ticket.id, 'implement_result', JSON.stringify(IMPLEMENTATION))
  store.addArtifact(ticket.id, 'review', JSON.stringify(REVIEW_PASS))
  for (const step of ['implement', 'review', 'verify']) {
    store.transitionTicket(ticket.id, { phase: step }, { actor: 'engine', reason: 'seed' })
  }
  store.setAttempt(ticket.id, 1, 0)
  liveSession(driver, ticket.id)
  const lost = live ? undefined : driver.dropSession(ticket.id, 'build', store)
  store.setNeedsAttention(ticket.id, APPROVAL_PARK)
  return { ...made, ticket: store.getTicket(ticket.id), lost }
}

test('a retry of an approval park goes back to the approval gate, not to plan', async () => {
  const { store, driver, engine, ticket } = approvalParked({ live: true })
  engine.retry(store.getTicket(ticket.id), { instruction: 'the release step never ran: push the tag, then hand the work over' })
  await settle(engine, ticket.id)
  const after = store.getTicket(ticket.id)
  assert.equal(after.phase, 'verify', 'the ticket stays at the approval gate')
  assert.equal(after.needsAttentionReason, 'Awaiting human approval', 'one retry lands it back on the human')
  assert.equal(after.attemptCount, 0, 'the hand-over spends no attempt')
  assert.deepEqual(promptCounts(store, ticket.id), { planner: 0, implementer: 0, reviewer: 0, approver: 1 }, 'no plan, build or review round ran')
  assert.equal(driver.turns.length, 1, 'exactly one turn was sent')
  const prompt = lastPrompt(store, ticket.id, 'approver')
  assert.match(prompt, /give the hand-over now/)
  assert.match(prompt, /Human instruction for the next attempt:\nthe release step never ran: push the tag, then hand the work over/)
  assert.equal(/This is a new session for/.test(prompt), false, 'the live session already holds the work')
})

test('a retry of an approval park reopens the session that holds the work', async () => {
  const { store, driver, engine, ticket, lost } = approvalParked()
  driver.reactivations.length = 0
  driver.reactivation = { ok: true }
  const sessionsBefore = driver.counter
  engine.retry(store.getTicket(ticket.id), { instruction: 'hand the work over; the restart is deferred to a human' })
  await settle(engine, ticket.id)
  assert.deepEqual(driver.reactivations.map((r) => r.purpose), ['build'], 'asked for the earlier build session back')
  assert.equal(driver.counter, sessionsBefore, 'no new session was created')
  assert.equal(driver.liveTicketSession(ticket.id, 'build'), lost, 'the same session id carries the hand-over')
  assert.equal(driver.turns.at(-1), lost)
  assert.ok(eventKinds(store, ticket.id).includes('session_resumed'))
  const after = store.getTicket(ticket.id)
  assert.equal(after.phase, 'verify')
  assert.equal(after.needsAttentionReason, 'Awaiting human approval')
  assert.deepEqual(promptCounts(store, ticket.id), { planner: 0, implementer: 0, reviewer: 0, approver: 1 })
  assert.match(lastPrompt(store, ticket.id, 'approver'), /hand the work over; the restart is deferred to a human/)
})

test('a retry of an approval park with no session to reopen starts one from the summary', async () => {
  const { store, driver, engine, ticket, lost } = approvalParked()
  const sessionsBefore = driver.counter
  engine.retry(store.getTicket(ticket.id), { instruction: 'the deploy is deferred; hand the work over as it stands' })
  await settle(engine, ticket.id)
  const fresh = driver.liveTicketSession(ticket.id, 'build')
  assert.notEqual(fresh, lost, 'a new session stands in for the one that is gone')
  assert.equal(driver.counter, sessionsBefore + 1)
  const prompt = lastPrompt(store, ticket.id, 'approver')
  assert.match(prompt, /^This is a new session for /)
  assert.match(prompt, /ALREADY PASSED REVIEW/, 'the summary says the work already passed review')
  assert.match(prompt, /Do not redo or restructure it/)
  assert.match(prompt, /Last implementation \(complete\): created notes\.txt/, 'and what shipped')
  assert.match(prompt, /the deploy is deferred; hand the work over as it stands/, 'plus the retry instruction')
  const after = store.getTicket(ticket.id)
  assert.equal(after.phase, 'verify')
  assert.equal(after.needsAttentionReason, 'Awaiting human approval')
  assert.deepEqual(promptCounts(store, ticket.id), { planner: 0, implementer: 0, reviewer: 0, approver: 1 })
})

test('a retry of an approval park does not crowd out a human talking in the session', async () => {
  const { store, driver, engine, ticket } = approvalParked({ live: true })
  // The park was lifted because a human started a turn in the build session, not
  // because anyone retried: the engine keeps out of that conversation.
  engine.reactivations.set(ticket.id, { sessionId: 'session-live', reason: APPROVAL_PARK })
  engine.retry(store.getTicket(ticket.id), { instruction: 'ignore this retry' })
  await settle(engine, ticket.id)
  assert.equal(driver.turns.length, 0, "no hand-over was sent over the human's turn")
  assert.deepEqual(promptCounts(store, ticket.id), { planner: 0, implementer: 0, reviewer: 0, approver: 0 })
})

// ------------------------------------------------------- the no-progress guard

test('the unchanged-tree guard does not fire when the last failure named no condition', async () => {
  const cwd = gitRepo()
  const { store, engine } = engineFor({
    implement: [
      { type: 'implementation', value: IMPLEMENTATION },
      { type: 'implementation', value: IMPLEMENTATION },
      { type: 'implementation', value: IMPLEMENTATION },
    ],
    // A fail with no done_when rows names nothing: a bookkeeping rejection.
    review: [
      { type: 'review', value: REVIEW_FAIL },
      { type: 'review', value: REVIEW_FAIL },
      { type: 'review', value: REVIEW_PASS },
    ],
  })
  const ticket = pickedUp(store, { workspaceCwd: cwd })
  await engine.advance(store.getTicket(ticket.id))
  const done = store.getTicket(ticket.id)
  assert.equal(done.phase, 'verify', 'the third round ran against an unchanged tree because nothing said it was a repeat')
  assert.equal(done.attemptCount, 3)
  assert.equal(/no progress/.test(done.needsAttentionReason ?? ''), false)
  const signature = JSON.parse(store.latestArtifact(ticket.id, 'rework_signature').content)
  assert.deepEqual(signature.failingIds, [])
})

test('the unchanged-tree guard still fires when the last failure named a condition', async () => {
  const cwd = gitRepo()
  const { store, engine } = engineFor({
    implement: [{ type: 'implementation', value: IMPLEMENTATION }, { type: 'implementation', value: IMPLEMENTATION }],
    review: [{ type: 'review', value: REVIEW_FAIL_ROW }, { type: 'review', value: REVIEW_FAIL_ROW }],
  })
  const ticket = pickedUp(store, { workspaceCwd: cwd })
  await engine.advance(store.getTicket(ticket.id))
  assert.match(store.getTicket(ticket.id).needsAttentionReason, /no progress: the working tree is unchanged since the round that last failed notes/)
})

test('a human retry starts the unchanged-tree guard over', async () => {
  const cwd = gitRepo()
  const { store, driver, engine } = engineFor({
    implement: [{ type: 'implementation', value: IMPLEMENTATION }, { type: 'implementation', value: IMPLEMENTATION }],
    review: [{ type: 'review', value: REVIEW_FAIL_ROW }, { type: 'review', value: REVIEW_FAIL_ROW }],
  })
  const ticket = pickedUp(store, { workspaceCwd: cwd })
  await engine.advance(store.getTicket(ticket.id))
  assert.match(store.getTicket(ticket.id).needsAttentionReason, /no progress/)
  driver.queues.implementer.push({ type: 'implementation', value: IMPLEMENTATION })
  driver.queues.reviewer.push({ type: 'review', value: REVIEW_PASS })
  engine.retry(store.getTicket(ticket.id), { instruction: 'check the path in the README' })
  await settle(engine, ticket.id)
  assert.equal(store.getTicket(ticket.id).phase, 'verify', 'the retried round ran instead of being called a repeat')
})

// ------------------------------------------------------------------- mark done

const PHASE_PATH = ['plan', 'implement', 'review', 'verify']

function ticketAt(store, { column, phase, parked }) {
  const ticket = pickedUp(store, { column })
  for (const step of PHASE_PATH.slice(1, PHASE_PATH.indexOf(phase) + 1)) {
    store.transitionTicket(ticket.id, { phase: step }, { actor: 'engine', reason: 'seed' })
  }
  if (parked) store.setNeedsAttention(ticket.id, 'parked for the test')
  return store.getTicket(ticket.id)
}

test('mark done closes a ticket from every column and phase the engine can leave it in', async () => {
  for (const column of ['backlog', 'working']) {
    for (const phase of PHASE_PATH) {
      for (const parked of [false, true]) {
        const { store, driver, engine } = engineFor()
        const ticket = ticketAt(store, { column, phase, parked })
        const label = `${column}/${phase}/${parked ? 'parked' : 'unparked'}`
        const done = await engine.markDone(ticket.id, 'landed by hand in PR 12')
        assert.equal(done.column, 'done', label)
        assert.equal(done.phase, 'closed', label)
        assert.equal(done.needsAttentionReason ?? null, null, `${label}: a closed ticket does not glow`)
        assert.deepEqual(driver.ticketsClosed, [ticket.id], `${label}: its sessions were closed`)
        const event = store.listEvents(ticket.id, { limit: 50 }).find((e) => e.kind === 'done')
        assert.ok(event, `${label}: a done event was recorded`)
        assert.equal(event.actor, 'human', label)
        assert.equal(event.payload.outsideEngine, true, label)
        assert.equal(event.payload.reason, 'landed by hand in PR 12', label)
        assert.equal(event.payload.fromColumn, column, label)
        assert.equal(event.payload.wasParked, parked, label)
        assert.equal(event.phaseFrom, phase, label)
        assert.equal(event.phaseTo, 'closed', label)
      }
    }
  }
})

test('mark done closes the ticket\'s sessions in the store as well as in the driver', async () => {
  const { store, engine } = engineFor()
  const ticket = ticketAt(store, { column: 'working', phase: 'implement', parked: true })
  store.attachSession({ ticketId: ticket.id, dshSessionId: 'session-x', role: 'build', purpose: 'build' })
  await engine.markDone(ticket.id, 'done elsewhere')
  assert.ok(store.listSessions(ticket.id).every((session) => session.closedAt !== null))
})

test('mark done requires a reason and refuses a closed ticket', async () => {
  const { store, engine } = engineFor()
  const ticket = ticketAt(store, { column: 'working', phase: 'implement', parked: true })
  for (const reason of ['', '   ', undefined, null, 5]) {
    await assert.rejects(() => engine.markDone(ticket.id, reason), /a reason is required/)
  }
  assert.equal(store.getTicket(ticket.id).column, 'working', 'nothing moved')
  await engine.markDone(ticket.id, 'ok')
  await assert.rejects(() => engine.markDone(ticket.id, 'again'), /already done/)
  const discarded = ticketAt(store, { column: 'working', phase: 'plan', parked: false })
  store.transitionTicket(discarded.id, { column: 'discarded' }, { actor: 'human', reason: 'no' })
  await assert.rejects(() => engine.markDone(discarded.id, 'again'), /already discarded/)
  await assert.rejects(() => engine.markDone('no-such-ticket', 'x'), /no ticket/)
})

test('a turn that fails after a human closed the ticket does not park it again', async () => {
  const { store, engine } = engineFor()
  const ticket = ticketAt(store, { column: 'working', phase: 'implement', parked: false })
  await engine.markDone(ticket.id, 'done elsewhere')
  const result = engine.needsAttention(ticket, 'turn failed in implement: session closed')
  assert.equal(result.kind, 'stopped')
  assert.equal(store.getTicket(ticket.id).needsAttentionReason ?? null, null)
})

// ------------------------------------------------------------------ re-run review

test('re-run review resumes a parked ticket at the review phase without spending an attempt', async () => {
  const { store, driver, engine, ticket } = await exhausted()
  assert.equal(store.getTicket(ticket.id).phase, 'implement')
  driver.queues.reviewer.push({ type: 'review', value: REVIEW_PASS })
  const resumed = await engine.rerunReview(ticket.id, 'the work is on the branch now')
  assert.equal(resumed.phase, 'review')
  assert.equal(resumed.needsAttentionReason ?? null, null)
  await settle(engine, ticket.id)
  const after = store.getTicket(ticket.id)
  assert.equal(after.phase, 'verify', 'the review ran and passed')
  assert.equal(after.attemptCount, 1, 'no attempt was spent')
  const event = store.listEvents(ticket.id, { limit: 100 }).find((e) => e.kind === 'review_rerun')
  assert.equal(event.actor, 'human')
  assert.match(lastPrompt(store, ticket.id, 'reviewer'), /the work is on the branch now/)
})

test('re-run review in a session that was lost starts the reviewer from the summary', async () => {
  const { store, driver, engine, ticket } = await exhausted()
  driver.dropSession(ticket.id, 'build', store)
  driver.queues.reviewer.push({ type: 'review', value: REVIEW_PASS })
  await engine.rerunReview(ticket.id)
  await settle(engine, ticket.id)
  assert.match(lastPrompt(store, ticket.id, 'reviewer'), /^This is a new session for /)
})

test('re-run review is refused unless the ticket is parked in implement or review', async () => {
  const { store, engine } = engineFor()
  const unparked = ticketAt(store, { column: 'working', phase: 'implement', parked: false })
  await assert.rejects(() => engine.rerunReview(unparked.id), /not parked/)
  const planning = ticketAt(store, { column: 'working', phase: 'plan', parked: true })
  await assert.rejects(() => engine.rerunReview(planning.id), /not plan/)
  const approving = ticketAt(store, { column: 'working', phase: 'verify', parked: true })
  await assert.rejects(() => engine.rerunReview(approving.id), /not verify/)
  const noPlan = ticketAt(store, { column: 'working', phase: 'implement', parked: true })
  await assert.rejects(() => engine.rerunReview(noPlan.id), /no plan conditions/)
})

// ------------------------------------------------------ ending on a question

test('a plan session that ends on a question parks the ticket on the question', async () => {
  const { store, engine } = engineFor({ plan: [{ text: 'I read the repo.\n\nShould the notes live in docs/ or at the root?' }] })
  const ticket = pickedUp(store, { planQuestions: 'interactive' })
  await engine.advance(store.getTicket(ticket.id))
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.needsAttentionReason, 'Waiting on your answer in the plan session: Should the notes live in docs/ or at the root?')
  const event = store.listEvents(ticket.id, { limit: 50 }).find((e) => e.kind === 'needs_attention_reason')
  assert.equal(event.payload.awaitingAnswer, true)
  assert.equal(event.payload.phase, 'plan')
})

test('a build session that ends on a question parks the ticket on the question', async () => {
  const { store, engine } = engineFor({ implement: [{ text: 'Which test runner does this repo use?' }] })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'Waiting on your answer in the build session: Which test runner does this repo use?')
})

test('a session that ends without a question or a submission still parks on the plain reason', async () => {
  const { store, engine } = engineFor({ implement: [{ text: 'I am done.' }] })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'implementer ended without calling kanban_submit_implementation')
})

// ----------------------------------------------------------- restart recovery

function restartable(queues, options) {
  const made = setup(queues, options)
  // A fresh engine boots with `recovered` false; leave it that way.
  return made
}

test('a restart resumes a ticket the engine was driving, once, in the same session', async () => {
  const { store, driver, engine } = restartable({
    implement: [{ type: 'implementation', value: IMPLEMENTATION }],
    review: [{ type: 'review', value: REVIEW_PASS }],
  })
  const ticket = pickedUp(store)
  // The engine was building: a plan is on record and a build session was open.
  const plan = normalizePlan(PLAN)
  store.replaceConditions(ticket.id, 1, plan.conditions, 'plan')
  store.addArtifact(ticket.id, 'plan', JSON.stringify({ ...plan, planVersion: 1 }))
  store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: 'seed' })
  store.attachSession({ ticketId: ticket.id, dshSessionId: 'session-old', role: 'build', purpose: 'build' })
  driver.reactivation = { ok: true, sessionId: 'session-old' }
  await engine.recover()
  const after = store.getTicket(ticket.id)
  assert.equal(after.needsAttentionReason ?? null, null, 'a resumable ticket is not parked')
  const event = store.listEvents(ticket.id, { limit: 50 }).find((e) => e.kind === 'restart_recovered')
  assert.equal(event.payload.autoResume, true)
  await engine.advance(after)
  assert.equal(driver.turns[0], 'session-old', 'the interrupted session was continued, not replaced')
  const prompt = lastPrompt(store, ticket.id, 'implementer')
  assert.match(prompt, /^The service restarted while you were working on this ticket/)
  assert.match(prompt, /kanban_submit_implementation/)
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
  assert.equal(store.getTicket(ticket.id).attemptCount, 1, 'resuming is the same attempt, not another')
})

test('a restart parks the ticket with the reason when the session cannot be reopened', async () => {
  const { store, driver, engine } = restartable()
  const ticket = pickedUp(store)
  const plan = normalizePlan(PLAN)
  store.replaceConditions(ticket.id, 1, plan.conditions, 'plan')
  store.addArtifact(ticket.id, 'plan', JSON.stringify({ ...plan, planVersion: 1 }))
  store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: 'seed' })
  store.attachSession({ ticketId: ticket.id, dshSessionId: 'session-old', role: 'build', purpose: 'build' })
  driver.reactivation = { ok: false, reason: 'the session file is gone' }
  await engine.recover()
  await engine.advance(store.getTicket(ticket.id))
  const parked = store.getTicket(ticket.id)
  assert.match(parked.needsAttentionReason, /build session could not be reopened after a restart \(the session file is gone\)/)
  assert.equal(driver.turns.length, 0, 'no turn was sent into a session that was not there')
})

test('a second restart before the resume made progress parks instead of resuming again', async () => {
  const { store, engine } = restartable()
  const ticket = pickedUp(store)
  store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: 'seed' })
  store.attachSession({ ticketId: ticket.id, dshSessionId: 'session-old', role: 'build', purpose: 'build' })
  store.appendEvent(ticket.id, 'restart_recovered', { actor: 'engine', payload: { autoResume: true } })
  await engine.recover()
  const parked = store.getTicket(ticket.id)
  assert.match(parked.needsAttentionReason, /interrupted by a restart again before the automatic resume made progress/)
  assert.equal(store.listEvents(ticket.id, { limit: 50 }).filter((e) => e.kind === 'restart_recovered').at(-1).payload.autoResume, false)
})

test('a ticket that was already parked keeps its reason through a restart', async () => {
  const { store, engine } = restartable()
  const ticket = pickedUp(store)
  store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: 'seed' })
  store.setNeedsAttention(ticket.id, 'attempt budget exhausted (3)')
  store.attachSession({ ticketId: ticket.id, dshSessionId: 'session-old', role: 'build', purpose: 'build' })
  await engine.recover()
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'attempt budget exhausted (3)')
})

for (const phase of ['plan', 'review']) {
  test(`a restart resumes a ${phase} session the same way`, async () => {
    const { store, driver, engine } = restartable({
      plan: [{ type: 'plan', value: PLAN }],
      implement: [{ type: 'implementation', value: IMPLEMENTATION }],
      review: [{ type: 'review', value: REVIEW_PASS }],
    })
    const ticket = pickedUp(store)
    const purpose = phase === 'plan' ? 'plan' : 'build'
    const plan = normalizePlan(PLAN)
    if (phase === 'review') {
      store.replaceConditions(ticket.id, 1, plan.conditions, 'plan')
      store.addArtifact(ticket.id, 'plan', JSON.stringify({ ...plan, planVersion: 1 }))
      store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: 'seed' })
      store.transitionTicket(ticket.id, { phase: 'review' }, { actor: 'engine', reason: 'seed' })
      store.setAttempt(ticket.id, 1, 0)
    }
    store.attachSession({ ticketId: ticket.id, dshSessionId: 'session-old', role: purpose, purpose })
    driver.reactivation = { ok: true, sessionId: 'session-old' }
    await engine.recover()
    assert.equal(store.getTicket(ticket.id).needsAttentionReason ?? null, null)
    await engine.advance(store.getTicket(ticket.id))
    assert.equal(driver.turns[0], 'session-old')
    const role = phase === 'plan' ? 'planner' : 'reviewer'
    assert.match(lastPrompt(store, ticket.id, role), /^The service restarted while you were /)
  })
}

test('a restart resumes an approval hand-over that it cut off', async () => {
  const { store, driver, engine } = restartable({ approval: [null] })
  const ticket = pickedUp(store)
  const plan = normalizePlan(PLAN)
  store.replaceConditions(ticket.id, 1, plan.conditions, 'plan')
  store.addArtifact(ticket.id, 'plan', JSON.stringify({ ...plan, planVersion: 1 }))
  for (const step of ['implement', 'review', 'verify']) store.transitionTicket(ticket.id, { phase: step }, { actor: 'engine', reason: 'seed' })
  store.addArtifact(ticket.id, 'review', JSON.stringify(REVIEW_PASS))
  store.setAttempt(ticket.id, 1, 0)
  store.attachSession({ ticketId: ticket.id, dshSessionId: 'session-old', role: 'build', purpose: 'build' })
  driver.reactivation = { ok: true, sessionId: 'session-old' }
  await engine.recover()
  assert.equal(store.getTicket(ticket.id).needsAttentionReason ?? null, null)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(driver.turns[0], 'session-old')
  assert.match(lastPrompt(store, ticket.id, 'approver'), /^The service restarted while you were handing this work over/)
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'Awaiting human approval', 'the hand-over finished and the ticket waits for the human')
})

// -------------------------------------------------------------- tree helper

test('the tree-changing helper used above really moves the fingerprint', async () => {
  const cwd = gitRepo()
  const { engine, store } = engineFor()
  const ticket = pickedUp(store, { workspaceCwd: cwd })
  const before = await engine.workingTreeHash(ticket)
  writeFileSync(join(cwd, 'notes.txt'), 'hello\n')
  assert.notEqual(await engine.workingTreeHash(ticket), before)
})
