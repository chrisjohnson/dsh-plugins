// KAN-103: an open ask is answerable, a continued one still is, and the audit
// trail only ever describes an answer that happened.
//
// The bug this exists for: `POST /api/kanban/answerQuestion` wrote its
// `question_answered_by_api` event and *then* called `userQuestions.answer`,
// whose first line looks the call up among the session's *continued* questions.
// A session paused on a fresh ask has no continued question — while the tool call
// is in flight the only answer path core offers is the `user-questions/request`
// waterfall the ask is itself waiting on — so the common case refused with "the
// question is no longer pending" while the board was visibly showing the
// question. Reproduced on KAN-75, eleven seconds after the ask was raised.
//
// The driver is real here, and so is the store: what is faked is the harness
// around them, and the `userQuestions` service — faithfully. The fake switches
// its `answer()` result on the call's state, `open` or `continued`, the way core
// does (`continued(agent).find((item) => item.callId === callId)` returns nothing
// for an open call), and it refuses a second reply with `REPLY_QUEUED` the way
// core does. A fake that always answered would have passed the old code, which is
// exactly how the bug shipped.
//
// Needs the dsh peer packages (dispatch.mjs imports them); on a bare clone
// without a dsh installation these tests skip rather than fail, same convention
// as the other driver suites.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { resolveConfig } from '../src/config.mjs'
import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import { validateQuestionAnswers } from '../src/questions.mjs'

let Driver
try {
  await import('@deepseek-ai/dsh-llm')
  Driver = (await import('../src/dispatch.mjs')).SessionDriver
} catch {
  Driver = undefined
}
const skip = Driver === undefined ? 'no @deepseek-ai/dsh-llm installed' : false

const ARGS = JSON.stringify({
  questions: [
    { id: 'restart', question: 'Is the restart owed now?', header: 'Restart', options: [{ label: 'Yes (Recommended)' }, { label: 'No' }] },
  ],
})
const ANSWER = [{ id: 'restart', selected: ['Yes (Recommended)'] }]

/**
 * The faithful `userQuestions` stand-in.
 *
 * A call lives in one of two states, and the answer path core exposes only knows
 * the second one:
 *
 *   - `open`: the `ask_user_question` tool call is still in flight. Its answer
 *     path is the waterfall request it is waiting on, and `answer()` refuses it
 *     — `continued(agent).find(callId)` finds nothing, so it returns false.
 *   - `continued`: the call returned pending (the unattended foreground timeout)
 *     or the process that owned it ended. `answer()` steers the reply in as a
 *     user message and says true, once: a second reply is `REPLY_QUEUED`.
 */
function makeQuestionService() {
  const calls = new Map()
  const error = (text, code) => Object.assign(new Error(text), { code })
  return {
    calls,
    /**
     * Present so the driver registers its tolerant ask tool on a plan/build
     * session; this suite drives the ask straight onto the waterfall seam, which
     * is the half under test.
     */
    ask: async () => {
      throw new Error('the suite drives the waterfall, not the tool')
    },
    open(callId, questions) {
      calls.set(callId, { state: 'open', questions, queued: false })
    },
    /** The unattended foreground timeout: the call returns pending. */
    toContinued(callId) {
      const call = calls.get(callId)
      if (call !== undefined) call.state = 'continued'
    },
    answer(agent, callId, answer) {
      const call = calls.get(callId)
      // The line that made the bug: an open call is not a continued one.
      if (call === undefined || call.state !== 'continued') return false;
      if (call.queued) throw error('a reply is already queued for this question', 'REPLY_QUEUED')
      const asked = call.questions.map((item) => item.id)
      const named = new Set(answer.answers.map((item) => item.id))
      if (
        named.size !== answer.answers.length
        || asked.length !== answer.answers.length
        || !asked.every((id) => named.has(id))
      ) {
        throw error(`the answer batch for ${callId} must name each of its ${String(asked.length)} questions exactly once`, 'BAD_ANSWER')
      }
      call.queued = true
      return true
    },
  }
}

/** A cordis-shaped waterfall: one listener, its `next()` guarded against a second call. */
function runWaterfall(listener, request, inner) {
  let called = false
  const next = () => {
    if (called) throw new Error('next() called multiple times')
    called = true
    return inner()
  }
  return listener(request, next)
}

function makeAgent(sessionId) {
  const session = {
    id: sessionId,
    header: {},
    events: [],
    append: () => {},
    snapshotEvents: () => session.events,
  }
  const listeners = new Map()
  return {
    id: sessionId,
    status: 'running',
    session,
    ctx: {
      on: (name, fn) => {
        listeners.set(name, fn)
        return () => listeners.delete(name)
      },
      tools: { register: () => () => {}, guard: () => {} },
      listeners,
    },
    followup: () => {},
    cancel: () => {},
  }
}

/**
 * A live driver with one workflow session attached, plus the browser card the
 * ask would otherwise wait on: `card.answer()` / `card.refuse()` are the person
 * at the page deciding.
 */
function harness({ purpose = 'verify', phase = 'verify', planQuestions = 'interactive' } = {}) {
  const { config } = resolveConfig({
    roles: { implementer: { provider: 'local', model: 'm' } },
    providers: [{ name: 'local' }],
  })
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const ticket = store.createTicket({
    title: 'open ask',
    acceptance: ['x'],
    workspaceCwd: mkdtempSync(join(tmpdir(), 'kb-open-ask-')),
    planTiming: 'now',
    planQuestions,
  })
  // The phase is a column on the ticket row, and the store guards the workflow
  // transitions; a test that wants to stand a session in some phase sets the
  // column directly rather than walking the engine's state machine to get there.
  store.db.prepare('UPDATE tickets SET phase = ? WHERE id = ?').run(phase, ticket.id)

  const service = makeQuestionService()
  const sessionId = `session-${purpose}-1`
  const agent = makeAgent(sessionId)
  const agents = { get: (id) => (id === sessionId ? agent : undefined), roots: () => [agent] }
  const ctx = {
    get: (name) => (name === 'userQuestions' ? service : name === 'agents' ? agents : undefined),
    on: () => () => {},
  }
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  const driver = new Driver({ ctx, log, getConfig: () => config, store })
  driver.start()
  store.attachSession({
    ticketId: ticket.id,
    dshSessionId: sessionId,
    role: purpose === 'verify' ? 'approver' : 'implementer',
    purpose,
    provider: 'local',
    model: 'm',
  })

  let answerCard
  let refuseCard
  let cardConsulted = 0
  const card = () =>
    new Promise((resolve, reject) => {
      cardConsulted += 1
      answerCard = resolve
      refuseCard = reject
    })

  /**
   * Attach the session, which is what registers the driver's listener on it.
   * Returns the captured `user-questions/request` listener.
   */
  const attach = async () => {
    const attached = await driver.attachExistingSession(sessionId, agent)
    assert.equal(attached, true, 'the session attached, so its listeners are live')
    const listener = agent.ctx.listeners.get('user-questions/request')
    assert.ok(listener, 'the driver registered the question listener on this session')
    return listener
  }

  /**
   * The session asks: the ask arriving on the seam the driver's listener is
   * registered for, with the browser card as the rest of the waterfall.
   */
  const ask = async (callId = 'c1', questions = undefined) => {
    const listener = await attach()
    service.open(callId, [{ id: 'restart' }])
    const settled = runWaterfall(
      listener,
      {
        questions: questions ?? [{ id: 'restart', question: 'Is the restart owed now?', options: [{ label: 'Yes (Recommended)' }, { label: 'No' }] }],
        agent,
        wait: { callId },
      },
      card,
    )
    return { settled, listener }
  }

  const events = () => store.listEvents(ticket.id).filter((event) => event.kind === 'question_answered_by_api')
  return {
    driver,
    store,
    service,
    ticket,
    sessionId,
    agent,
    ask,
    attach,
    events,
    get cardConsulted() {
      return cardConsulted
    },
    cardAnswer: (value) => answerCard?.(value),
    cardRefuse: (error) => refuseCard?.(error),
  }
}

// ------------------------------------------------------------------- open -----

test('an open ask is answered through the driver, and the tool call resolves with it', async (t) => {
  if (skip) { t.skip(skip); return }
  const h = await harness()
  const { settled } = await h.ask()

  // The faithful service cannot answer this: the call is open, not continued.
  // That is the whole bug, stated as a fact about the service rather than a
  // fake that hides it.
  assert.equal(h.service.answer(h.agent, 'c1', { answers: ANSWER }), false, 'core refuses an open call')
  assert.equal(h.events().length, 0, 'and the board wrote nothing for that refusal')

  const out = h.driver.settleOpenQuestion(h.sessionId, 'c1', ANSWER)
  assert.deepEqual(out, { ok: true })
  assert.deepEqual(await settled, { answers: ANSWER }, 'the ask settled with the posted answer')
  const events = h.events()
  assert.equal(events.length, 1, 'exactly one audit event for one delivered answer')
  assert.equal(events[0].actor, 'api')
  assert.deepEqual(events[0].payload, { callId: 'c1', answers: ANSWER })
  await h.driver.closeSession(h.sessionId)
})

test('the approval phase parks the ask even though it never auto-answers', async (t) => {
  if (skip) { t.skip(skip); return }
  // The KAN-75 case: an approval-phase wrap-up ask, an option batch and all —
  // the board must not decide it, but it must be able to deliver the human's.
  const h = await harness({ purpose: 'verify', phase: 'verify', planQuestions: 'autonomous' })
  const { settled } = await h.ask()
  assert.equal(h.cardConsulted, 1, 'the browser card is still reached')
  assert.equal(h.events().length, 0, 'nothing is recorded before anyone answers')
  assert.equal(h.driver.settleOpenQuestion(h.sessionId, 'c1', ANSWER).ok, true)
  assert.deepEqual(await settled, { answers: ANSWER })
  assert.equal(h.events().length, 1)
  await h.driver.closeSession(h.sessionId)
})

test('a plan session parks the ask it is not allowed to decide', async (t) => {
  if (skip) { t.skip(skip); return }
  // An optionless question is the model saying it does not know, and the board
  // never answers one — in the plan phase or any other. It is still a human's
  // question, and since KAN-103 the human can be the one behind the endpoint.
  const h = await harness({ purpose: 'plan', phase: 'plan' })
  const sessionId = h.sessionId
  const agent = h.agent
  const listener = await h.attach()
  h.service.open('c1', [{ id: 'name' }])
  const settled = runWaterfall(
    listener,
    { questions: [{ id: 'name', question: 'What should the file be called?' }], agent, wait: { callId: 'c1' } },
    () => new Promise(() => {}),
  )
  assert.equal(h.driver.openQuestions.size, 1, 'parked for a human rather than answered')
  assert.equal(h.events().length, 0)
  assert.equal(h.driver.settleOpenQuestion(sessionId, 'c1', [{ id: 'name', selected: [], custom: 'questions.mjs' }]).ok, true)
  assert.deepEqual(await settled, { answers: [{ id: 'name', selected: [], custom: 'questions.mjs' }] })
  await h.driver.closeSession(sessionId)
})

// -------------------------------------------------------------- not open ------

test('the same call settled twice is not open the second time, and writes nothing', async (t) => {
  if (skip) { t.skip(skip); return }
  const h = await harness()
  const { settled } = await h.ask()
  assert.equal(h.driver.settleOpenQuestion(h.sessionId, 'c1', ANSWER).ok, true)
  await settled
  const again = h.driver.settleOpenQuestion(h.sessionId, 'c1', ANSWER)
  assert.deepEqual(again, { ok: false, reason: 'not-open' })
  assert.equal(h.events().length, 1, 'the refused second answer added no event')
  await h.driver.closeSession(h.sessionId)
})

test('a call id nothing is holding is not open', async (t) => {
  if (skip) { t.skip(skip); return }
  const h = await harness()
  assert.deepEqual(h.driver.settleOpenQuestion(h.sessionId, 'no-such-call', ANSWER), { ok: false, reason: 'not-open' })
  assert.deepEqual(h.driver.settleOpenQuestion('session-stranger', 'c1', ANSWER), { ok: false, reason: 'not-open' })
  assert.equal(h.events().length, 0)
  await h.driver.closeSession(h.sessionId)
})

test('the browser card answering first wins, and the board records nothing', async (t) => {
  if (skip) { t.skip(skip); return }
  const h = await harness()
  const { settled } = await h.ask()
  h.cardAnswer({ answers: [{ id: 'restart', selected: ['No'] }] })
  assert.deepEqual(await settled, { answers: [{ id: 'restart', selected: ['No'] }] })
  assert.deepEqual(h.driver.settleOpenQuestion(h.sessionId, 'c1', ANSWER), { ok: false, reason: 'not-open' })
  assert.equal(h.events().length, 0, 'an answer the board did not deliver is not the board to log')
  await h.driver.closeSession(h.sessionId)
})

test('an ask whose waterfall died is no longer answerable from the board', async (t) => {
  if (skip) { t.skip(skip); return }
  const h = await harness()
  const { settled } = await h.ask()
  h.cardRefuse(new Error('ask_user_question was aborted before the user answered'))
  await assert.rejects(() => settled, /aborted before the user answered/)
  assert.deepEqual(h.driver.settleOpenQuestion(h.sessionId, 'c1', ANSWER), { ok: false, reason: 'not-open' })
  assert.equal(h.events().length, 0)
  await h.driver.closeSession(h.sessionId)
})

test('a failed audit write admits no answer and leaves the ask open', async (t) => {
  if (skip) { t.skip(skip); return }
  const h = await harness()
  const { settled } = await h.ask()
  const real = h.store.appendEvent.bind(h.store)
  h.store.appendEvent = () => {
    throw new Error('db gone')
  }
  const out = h.driver.settleOpenQuestion(h.sessionId, 'c1', ANSWER)
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'not-recorded')
  assert.match(out.error, /db gone/)
  assert.equal(h.events().length, 0)
  h.store.appendEvent = real
  // Still parked, so the retry — or the card — can still answer it.
  assert.equal(h.driver.settleOpenQuestion(h.sessionId, 'c1', ANSWER).ok, true)
  assert.deepEqual(await settled, { answers: ANSWER })
  assert.equal(h.events().length, 1)
  await h.driver.closeSession(h.sessionId)
})

// ------------------------------------------------------------ continued -----

test('a continued ask is still answerable, and only by the service', async (t) => {
  if (skip) { t.skip(skip); return }
  const h = await harness()
  const { settled } = await h.ask()
  // The unattended foreground timeout: the call returns pending and the question
  // becomes continued. The board's parked wait dies with the waterfall, so the
  // open path is gone and `userQuestions.answer` is the path that works — the
  // fallback the endpoint keeps for exactly this case.
  h.service.toContinued('c1')
  h.cardAnswer({ answers: ANSWER })
  await settled
  assert.equal(h.driver.settleOpenQuestion(h.sessionId, 'c1', ANSWER).ok, false, 'the open path is gone')
  assert.equal(h.service.answer(h.agent, 'c1', { answers: ANSWER }), true, 'the continued path takes it')
  assert.equal(h.events().length, 0, 'the driver alone writes nothing: the claim is the service’s, the event follows it')
  await h.driver.closeSession(h.sessionId)
})

test('a reply already queued is refused by the service, not answered twice', async (t) => {
  if (skip) { t.skip(skip); return }
  const h = await harness()
  const { settled } = await h.ask()
  h.service.toContinued('c1')
  h.cardAnswer({ answers: ANSWER })
  await settled
  assert.equal(h.service.answer(h.agent, 'c1', { answers: ANSWER }), true)
  let code = null
  try {
    h.service.answer(h.agent, 'c1', { answers: ANSWER })
  } catch (error) {
    code = error.code
  }
  assert.equal(code, 'REPLY_QUEUED')
  await h.driver.closeSession(h.sessionId)
})

// ------------------------------------------------------- the answer is checked --

test('a batch that names the wrong ids is refused before anything is written', async (t) => {
  if (skip) { t.skip(skip); return }
  const h = await harness()
  await h.ask()
  const pendingIds = JSON.parse(ARGS).questions.map((item) => item.id)
  // The endpoint checks the batch against the ids the ask used before it offers
  // the answer to anyone; a refusal there costs nothing, and never reaches the
  // parked wait at all.
  const invented = validateQuestionAnswers({ pendingIds, answers: [{ id: 'restart', selected: ['Yes'] }, { id: 'made-up', selected: ['x'] }] })
  assert.equal(invented.ok, false)
  assert.match(invented.reason, /not pending: made-up/)
  const missing = validateQuestionAnswers({ pendingIds, answers: [] })
  assert.equal(missing.ok, false)
  assert.equal(h.events().length, 0, 'a refusal costs no event')
  assert.equal(h.driver.openQuestions.size, 1, 'and the ask is still parked for whoever can answer it')
  assert.equal(h.driver.settleOpenQuestion(h.sessionId, 'c1', ANSWER).ok, true, 'the real batch still works')
  await h.driver.closeSession(h.sessionId)
})

test('stopping the driver drops every parked ask', async (t) => {
  if (skip) { t.skip(skip); return }
  const h = await harness()
  await h.ask()
  assert.equal(h.driver.openQuestions.size, 1)
  h.driver.stop()
  assert.equal(h.driver.openQuestions.size, 0, 'a wait from a process that is going away is not answerable')
  assert.deepEqual(h.driver.settleOpenQuestion(h.sessionId, 'c1', ANSWER), { ok: false, reason: 'not-open' })
})
