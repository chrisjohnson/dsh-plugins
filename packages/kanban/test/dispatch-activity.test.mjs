// The driver's turn bookkeeping has to agree with the waiter it releases.
//
// Needs @deepseek-ai/dsh-llm and @deepseek-ai/dsh-sandbox-policy (the dispatch
// half imports them); on a bare clone without a dsh installation these tests skip
// rather than fail, same convention as the worktree package's host tests.
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

function harness() {
  const { config } = resolveConfig({
    autoPromote: false,
    roles: { implementer: { provider: 'local', model: 'm', allowTools: ['read'] } },
    providers: [{ name: 'local' }],
  })
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const ticket = store.createTicket({
    title: 'settle activity',
    acceptance: ['x'],
    workspaceCwd: mkdtempSync(join(tmpdir(), 'kb-dispatch-')),
    planTiming: 'now',
    planQuestions: 'autonomous',
  })

  const handlers = []
  const sessionId = 'session-settle-1'
  const agent = {
    id: sessionId,
    status: 'running',
    session: { id: sessionId, header: {}, snapshotEvents: () => [] },
    ctx: { on: () => () => {}, tools: { guard: () => {} } },
    followup: () => {},
  }
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
  const emit = (event) => {
    for (const fn of [...handlers]) fn({ id: sessionId }, event)
  }
  return { driver, store, ticket, sessionId, agent, emit }
}

test('a turn settled by reconcileTurns clears the ticket busy flag', async (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, sessionId, agent, emit } = harness()

  emit({ type: 'turn/start', data: { turn: 1 } })
  assert.equal(driver.isTicketBusy(ticket.id), true, 'a turn in flight makes the ticket busy')

  const waiting = driver.waitTurn({ sessionId, stallTimeoutMs: 60_000 })
  // The turn ends without its `turn/end` ever reaching the driver (a listener
  // attached after the fact, a publish that was missed): the agent is idle and
  // the session log already carries the end, so reconcile settles from there.
  agent.status = 'idle'
  agent.session.snapshotEvents = () => [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } }]
  driver.waiters.get(sessionId).lastEventAt = Date.now() - 5_000
  driver.reconcileTurns()

  const settled = await waiting
  assert.equal(settled.status, 'failed')
  assert.equal(settled.error, 'max-tokens')
  assert.equal(driver.waiters.has(sessionId), false)
  assert.equal(driver.isTicketBusy(ticket.id), false, 'the settled turn must not leave the ticket busy')
})

test('a turn settled from the live turn/end clears the ticket busy flag', async (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, ticket, sessionId, agent, emit } = harness()

  emit({ type: 'turn/start', data: { turn: 1 } })
  const waiting = driver.waitTurn({ sessionId, stallTimeoutMs: 60_000 })
  agent.session.snapshotEvents = () => [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }]
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  const settled = await waiting
  assert.equal(settled.status, 'ok')
  assert.equal(driver.isTicketBusy(ticket.id), false)
})

// The case the recovery loop actually hits: a waiter armed right after a halt,
// reconciled before the turn it waits for has begun. Settling it from the
// previous turn's end hands the caller a failure for a turn that never ran.
test('reconcile will not settle a waiter on a turn that ended before it was armed', async (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, sessionId, agent, emit } = harness()

  // Turn 1 runs and ends halted.
  emit({ type: 'turn/start', data: { turn: 1 } })
  const first = driver.waitTurn({ sessionId, stallTimeoutMs: 60_000 })
  agent.session.snapshotEvents = () => [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } },
  ]
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } })
  assert.equal((await first).status, 'failed')

  // Someone else is asked to start turn 2. Until it begins, the agent is idle and
  // turn 1's end is the newest thing in the log.
  agent.status = 'idle'
  const second = driver.waitTurn({ sessionId, stallTimeoutMs: 60_000 })
  let settled = false
  void second.then(() => { settled = true })
  driver.waiters.get(sessionId).lastEventAt = Date.now() - 5_000
  driver.reconcileTurns()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false, 'the stale turn/end must not settle the new waiter')
  assert.equal(driver.waiters.has(sessionId), true, 'the waiter stays armed for the real turn')

  // Turn 2 starts and ends: that is the end this waiter belongs to.
  agent.status = 'running'
  emit({ type: 'turn/start', data: { turn: 2 } })
  agent.session.snapshotEvents = () => [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  const out = await second
  assert.equal(out.status, 'ok')
  assert.equal(out.turn, 2)
})

// The recovery loop's real situation: the session's snapshot has not caught up
// with the turn that just ended, so the caller says which turn it already
// watched. A `turn/end` for that turn must not settle the new waiter.
test('afterTurn pins the waiter to a turn newer than the one the caller saw', async (t) => {
  if (skip) { t.skip(skip); return }
  const { driver, sessionId, agent, emit } = harness()

  // The log only knows turn 1 (a lagging snapshot); the caller saw turn 2 end.
  agent.session.snapshotEvents = () => [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } }]
  agent.status = 'idle'
  const waiting = driver.waitTurn({ sessionId, stallTimeoutMs: 60_000, afterTurn: 2 })
  let settled = false
  void waiting.then(() => { settled = true })

  driver.waiters.get(sessionId).lastEventAt = Date.now() - 5_000
  driver.reconcileTurns()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false, 'a turn/end older than afterTurn must not settle the waiter')
  assert.equal(driver.waiters.has(sessionId), true, 'the waiter stays armed for the real turn')

  // Turn 3 is the kicked turn: its end belongs to this waiter.
  agent.session.snapshotEvents = () => [
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } },
    { type: 'turn/end', data: { turn: 3, reason: { kind: 'max-tokens' } } },
  ]
  emit({ type: 'turn/end', data: { turn: 3, reason: { kind: 'max-tokens' } } })
  const result = await waiting
  assert.equal(result.status, 'failed')
  assert.equal(result.turn, 3)
})
