// KAN-66, gap 1 (driver half): the question text a mid-turn ask carries.
//
// The wait ledger already knew *that* a session sat on an unanswered
// `ask_user_question`; it threw away the only copy of what was asked, which is
// the `arguments` of the `tool/call` event. This file pins the three places that
// text now survives: the live event, the answer that clears it, and the restart
// scan that has to rebuild it from the durable log.
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

let Driver
try {
  await import('@deepseek-ai/dsh-llm')
  Driver = (await import('../src/dispatch.mjs')).SessionDriver
} catch {
  Driver = undefined
}
const skip = Driver === undefined ? 'no @deepseek-ai/dsh-llm installed' : false

const QUESTION = 'The tag has to be pushed before the deploy pin — push dsh-kanban-v0.29.0 now, or wait for the pin commit review?'
const ARGS = JSON.stringify({
  questions: [
    {
      id: 'push',
      question: QUESTION,
      header: 'Release order',
      options: [{ label: 'Push now (Recommended)' }, { label: 'Wait for review' }],
    },
  ],
})

function makeAgent(sessionId) {
  const session = {
    id: sessionId,
    header: {},
    events: [],
    append: () => {},
    snapshotEvents: () => session.events,
  }
  return {
    id: sessionId,
    status: 'running',
    session,
    ctx: { on: () => () => {}, tools: { register: () => () => {}, guard: () => {} } },
    followup: () => {},
    cancel: () => {},
  }
}

function harness() {
  const { config } = resolveConfig({
    roles: { implementer: { provider: 'local', model: 'm' } },
    providers: [{ name: 'local' }],
  })
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const ticket = store.createTicket({
    title: 'question text',
    acceptance: ['x'],
    workspaceCwd: mkdtempSync(join(tmpdir(), 'kb-question-text-')),
    planTiming: 'now',
    planQuestions: 'autonomous',
  })

  const handlers = []
  const ctx = {
    get: () => undefined,
    on: (_name, fn) => {
      handlers.push(fn)
      return () => handlers.splice(handlers.indexOf(fn), 1)
    },
  }
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  const driver = new Driver({ ctx, log, getConfig: () => config, store })
  driver.start()

  const sessionId = 'session-qtext-1'
  const agent = makeAgent(sessionId)
  store.attachSession({ ticketId: ticket.id, dshSessionId: sessionId, role: 'build', purpose: 'build', provider: 'local', model: 'm' })
  driver.live.set(sessionId, {
    handle: { agent },
    role: 'implementer',
    purpose: 'build',
    phase: { role: 'implementer' },
    ticketId: ticket.id,
    owned: true,
    actionDispose: null,
    sandboxMode: null,
    routeKey: null,
  })
  driver.ticketSessions.set(`${ticket.id}:build`, new Set([sessionId]))

  const emit = (event, at = sessionId) => {
    for (const fn of [...handlers]) fn({ id: at }, event)
  }
  return { driver, store, ticket, sessionId, agent, emit }
}

// ---------------------------------------------------------------- live wait --

test('the ask_user_question batch is kept on the wait, not just its callId', (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, emit } = harness()

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'tool/call', data: { turn: 1, step: 0, callId: 'c1', name: 'ask_user_question', arguments: ARGS } })

  const wait = driver.pendingQuestionFor(ticket.id)
  assert.ok(wait, 'the ticket has a live question')
  assert.equal(wait.kind, 'question')
  assert.equal(wait.id, 'c1')
  assert.equal(wait.questions.length, 1)
  assert.equal(wait.questions[0].question, QUESTION)
  assert.deepEqual(wait.questions[0].options, ['Push now (Recommended)', 'Wait for review'])
  assert.equal(wait.questions[0].header, 'Release order')
})

test('an arguments payload that is already an object reads the same way', (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, emit } = harness()

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({
    type: 'tool/call',
    data: { turn: 1, step: 0, callId: 'c1', name: 'ask_user_question', arguments: { questions: [{ question: 'Which pin?' }] } },
  })
  assert.equal(driver.pendingQuestionFor(ticket.id).questions[0].question, 'Which pin?')
})

test('an unreadable ask still waits, it just has no text to show', (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, emit } = harness()

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'tool/call', data: { turn: 1, step: 0, callId: 'c1', name: 'ask_user_question', arguments: '{not json' } })
  assert.equal(driver.isAwaitingQuestion(ticket.id), true, 'the wait itself does not depend on the text')
  assert.deepEqual(driver.pendingQuestionFor(ticket.id).questions, [])
})

test('the answer clears the text along with the wait', (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, emit } = harness()

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'tool/call', data: { turn: 1, step: 0, callId: 'c1', name: 'ask_user_question', arguments: ARGS } })
  assert.ok(driver.pendingQuestionFor(ticket.id))
  emit({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1' } } })
  assert.equal(driver.pendingQuestionFor(ticket.id), null, 'an answered question is not a pending one')
  assert.equal(driver.isAwaitingQuestion(ticket.id), false)
})

test('an approval wait is not a question wait', (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, emit } = harness()

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'approval/asked', data: { id: 'a1', toolName: 'bash', reason: 'escalate sandbox' } })
  assert.equal(driver.isAwaitingApproval(ticket.id), true)
  assert.equal(driver.pendingQuestionFor(ticket.id), null)
})

test('a session of no ticket records nothing', (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, emit } = harness()
  emit({ type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'ask_user_question', arguments: ARGS } }, 'session-stranger')
  assert.equal(driver.humanWaits.size, 0)
})

// ------------------------------------------------------------ restart seeding --

function reattachHarness() {
  const h = harness()
  const id = 'session-reattach-q'
  const agent = makeAgent(id)
  h.store.attachSession({ ticketId: h.ticket.id, dshSessionId: id, role: 'build', purpose: 'build', provider: 'local', model: 'm' })
  return { ...h, id, agent }
}

test('a restart recovers the question from the durable log', async (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, id, agent } = reattachHarness()

  agent.session.events.push(
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'tool/call', data: { turn: 3, step: 0, callId: 'c1', name: 'ask_user_question', arguments: ARGS } },
  )
  assert.equal(await driver.attachExistingSession(id, agent), true)
  const wait = driver.pendingQuestionFor(ticket.id)
  assert.ok(wait, 'the restart must not lose what is being asked')
  assert.equal(wait.questions[0].question, QUESTION)
  assert.deepEqual(wait.questions[0].options, ['Push now (Recommended)', 'Wait for review'])
})

test('a restart does not resurrect a question the log says was answered', async (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, id, agent } = reattachHarness()

  agent.session.events.push(
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'tool/call', data: { turn: 3, step: 0, callId: 'c1', name: 'ask_user_question', arguments: ARGS } },
    { type: 'tool/result', data: { turn: 3, step: 1, message: { role: 'tool', toolCallId: 'c1' } } },
  )
  assert.equal(await driver.attachExistingSession(id, agent), true)
  assert.equal(driver.pendingQuestionFor(ticket.id), null)
})
