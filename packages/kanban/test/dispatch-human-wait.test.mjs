// KAN-17: the driver's mid-turn human-wait tracking.
//
// A harness approval prompt (`approval/asked` ... `approval/decided`, paired by
// id) and an unanswered `ask_user_question` call both pause a turn *in flight*:
// the turn stays open while the person decides, so the board used to show a
// blue "running" card for a session doing nothing but waiting on a human. The
// driver now folds those events from the global session stream into a
// per-session wait — for engine-driven and human-driven turns alike — and seeds
// the same state when a session is reattached mid-turn after a restart.
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
    ctx: {
      on: () => () => {},
      tools: { register: () => () => {}, guard: () => {} },
    },
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
    title: 'human wait',
    acceptance: ['x'],
    workspaceCwd: mkdtempSync(join(tmpdir(), 'kb-human-wait-')),
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

  const sessionId = 'session-wait-1'
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

// ------------------------------------------------------------------ approval --

test('an approval ask makes the ticket wait while its turn is still in flight', (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, sessionId, emit } = harness()

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'approval/asked', data: { id: 'a1', toolName: 'bash', reason: 'escalate sandbox' } })

  assert.equal(driver.isAwaitingApproval(ticket.id), true, 'the ask is pending')
  assert.equal(driver.isAwaitingQuestion(ticket.id), false, 'a question is not an approval')
  assert.equal(driver.isTicketBusy(ticket.id), true, 'the turn is still in flight — this is the mid-turn case')
  const wait = driver.humanWaitSession(ticket.id)
  assert.equal(wait.sessionId, sessionId)
  assert.equal(wait.kind, 'approval')
  assert.equal(wait.toolName, 'bash')
  assert.equal(wait.reason, 'escalate sandbox')
})

for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
  test(`an approval decision (${outcome}) clears the wait`, (t) => {
    if (skip) { t.skip(skip); return }
    const { driver, ticket, emit } = harness()

    emit({ type: 'turn/start', data: { turn: 1 } })
    emit({ type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } })
    assert.equal(driver.isAwaitingApproval(ticket.id), true)
    emit({ type: 'approval/decided', data: { id: 'a1', outcome } })
    assert.equal(driver.isAwaitingApproval(ticket.id), false, `${outcome} ends the wait`)
    assert.equal(driver.isTicketBusy(ticket.id), true, 'the turn continues after the answer')
  })
}

test('a decision for a different ask does not clear the pending one', (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, emit } = harness()

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } })
  emit({ type: 'approval/decided', data: { id: 'other', outcome: 'allowed-once' } })
  assert.equal(driver.isAwaitingApproval(ticket.id), true, 'paired by id: another ask cannot answer this one')
  emit({ type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } })
  assert.equal(driver.isAwaitingApproval(ticket.id), false)
})

test('a stray ask whose decision never arrives is cleared when the turn ends', (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, emit } = harness()

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } })
  assert.equal(driver.isAwaitingApproval(ticket.id), true)
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'cancelled' } } })
  assert.equal(driver.isAwaitingApproval(ticket.id), false, 'no wait survives its own turn')
})

// ------------------------------------------------------------------ question --

test('an ask_user_question call waits until the result answering it arrives', (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, emit } = harness()

  // No engine waiter is armed: this is a human-driven turn, and the old
  // plan-phase-only scan saw nothing here.
  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'tool/call', data: { turn: 1, step: 0, callId: 'c1', name: 'ask_user_question', arguments: {} } })
  assert.equal(driver.isAwaitingQuestion(ticket.id), true)
  assert.equal(driver.isAwaitingApproval(ticket.id), false)

  // A result for some other call cannot answer the question.
  emit({ type: 'tool/result', data: { turn: 1, step: 0, message: { role: 'tool', toolCallId: 'c9' } } })
  assert.equal(driver.isAwaitingQuestion(ticket.id), true, 'paired by callId')

  // The answer arrives; the turn continues.
  emit({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1' } } })
  assert.equal(driver.isAwaitingQuestion(ticket.id), false)
  assert.equal(driver.isTicketBusy(ticket.id), true)
})

test('a question left unanswered at the turn end does not haunt the next turn', (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, emit } = harness()

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'tool/call', data: { turn: 1, step: 0, callId: 'c1', name: 'ask_user_question' } })
  assert.equal(driver.isAwaitingQuestion(ticket.id), true)
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(driver.isAwaitingQuestion(ticket.id), false)
  emit({ type: 'turn/start', data: { turn: 2 } })
  assert.equal(driver.isAwaitingQuestion(ticket.id), false)
})

// -------------------------------------------------------------- scoping ------

test('a session that belongs to no ticket is never tracked', (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, emit } = harness()

  emit({ type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } }, 'session-stranger')
  emit({ type: 'tool/call', data: { callId: 'c1', name: 'ask_user_question' } }, 'session-stranger')
  assert.equal(driver.humanWaits.size, 0, 'nothing recorded for a non-ticket session')
  assert.equal(driver.isAwaitingApproval(ticket.id), false)
  assert.equal(driver.isAwaitingQuestion(ticket.id), false)
})

test('closing a session clears its pending wait', async (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, sessionId, emit } = harness()

  emit({ type: 'turn/start', data: { turn: 1 } })
  emit({ type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } })
  assert.equal(driver.isAwaitingApproval(ticket.id), true)
  await driver.closeSession(sessionId)
  assert.equal(driver.isAwaitingApproval(ticket.id), false)
})

// ---------------------------------------------------------- reattach seeding --

function reattachHarness() {
  const h = harness()
  const id = 'session-reattach-1'
  const agent = makeAgent(id)
  h.store.attachSession({ ticketId: h.ticket.id, dshSessionId: id, role: 'build', purpose: 'build', provider: 'local', model: 'm' })
  return { ...h, id, agent }
}

test('reattach seeds an unanswered approval ask from the open turn', async (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, id, agent } = reattachHarness()

  agent.session.events.push(
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'assistant/message', data: { turn: 3, message: { content: [] } } },
    { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', reason: 'escalate' } },
  )
  assert.equal(await driver.attachExistingSession(id, agent), true)
  assert.equal(driver.isAwaitingApproval(ticket.id), true, 'the restart must not lose the pending ask')
  assert.equal(driver.humanWaitSession(ticket.id).sessionId, id)
})

test('reattach seeds an unanswered question from the open turn', async (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, id, agent } = reattachHarness()

  agent.session.events.push(
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'tool/call', data: { turn: 3, step: 0, callId: 'c1', name: 'ask_user_question' } },
  )
  assert.equal(await driver.attachExistingSession(id, agent), true)
  assert.equal(driver.isAwaitingQuestion(ticket.id), true)
})

test('reattach finds no wait when the ask was answered or the turn closed', async (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, id, agent } = reattachHarness()

  // Answered ask inside the open turn.
  agent.session.events.push(
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } },
    { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } },
  )
  assert.equal(await driver.attachExistingSession(id, agent), true)
  assert.equal(driver.isAwaitingApproval(ticket.id), false, 'a decided ask is not a pending one')
  await driver.closeSession(id)

  // An ask inside a turn that has since ended: the newest boundary is a turn/end.
  const second = reattachHarness()
  second.agent.session.events.push(
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } },
    { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  )
  assert.equal(await second.driver.attachExistingSession(second.id, second.agent), true)
  assert.equal(second.driver.isAwaitingApproval(second.ticket.id), false, 'no open turn, no wait')
})

test('an ask from an earlier turn is not mistaken for the open turn\'s', async (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, id, agent } = reattachHarness()

  agent.session.events.push(
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'approval/asked', data: { id: 'old', toolName: 'bash' } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'cancelled' } } },
    { type: 'turn/start', data: { turn: 3 } },
  )
  assert.equal(await driver.attachExistingSession(id, agent), true)
  assert.equal(driver.isAwaitingApproval(ticket.id), false, 'the open turn holds no ask')
})
