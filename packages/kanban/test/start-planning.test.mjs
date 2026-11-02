// KAN-16: "Start planning" on a Backlog ticket.
//
// Two halves. The first drives the real decision in src/planning.mjs against a
// real store and a real Engine with a fake driver, so the claim "the button
// plans the ticket in place and nothing else moves" is checked, not asserted.
// The second is the pure client-side visibility rule.
//
// The engine-side counterpart — a plan-now ticket stops at Build until a human
// drags it to Working — is engine.test.mjs's
// 'a plan-now ticket plans in Backlog and stops at Build until dragged to Working'.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { resolveConfig } from '../src/config.mjs'
import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import { Engine } from '../src/engine.mjs'
import { startPlanning, canStartPlanning } from '../src/planning.mjs'

const CWD = mkdtempSync(join(tmpdir(), 'kanban-start-planning-'))
const flush = () => new Promise((resolve) => setImmediate(resolve))

const PLAN = {
  summary: 'write the file',
  steps: ['create notes.txt'],
  done_when: [{ id: 'notes', statement: 'note exists', how_verified: 'test -f notes.txt' }],
}

const PROMPTS = {
  bodies: {
    'plan-human': 'plan {{ticket_state}}',
    'plan-self': 'plan self {{ticket_state}}',
    implement: 'implement {{plan}} {{done_when}}',
    review: 'review {{diff}}',
    approval: 'approval {{plan}} {{review}}',
  },
  hashes: { plan: 'h' },
}

/**
 * A driver whose plan turn is left in flight. The engine has then dispatched a
 * planner and is waiting on it, which is the state the button is supposed to
 * produce — the ticket has not moved yet, so the assertions can look at both.
 */
function gateTurns(driver) {
  const pending = []
  driver.sendTurn = ({ sessionId }) => {
    driver.turns.push(sessionId)
    return new Promise((resolve) => pending.push(resolve))
  }
  return pending
}

function setup(options = {}) {
  const { config } = resolveConfig({
    roles: {
      planner: { provider: 'local', model: 'm' },
      implementer: { provider: 'local', model: 'm' },
      reviewer: { provider: 'local', model: 'm' },
      approver: { provider: 'local', model: 'm' },
    },
    providers: [{ name: 'local' }],
    confidenceThreshold: 0.7,
    ...(options.config ?? {}),
  })
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const driver = {
    sessions: new Map(),
    ticketSessions: new Map(),
    counter: 0,
    /** flipped by the tests that stand in for a turn already in flight */
    busy: false,
    /** every session the engine actually sent a role prompt to */
    turns: [],
    async ensureTicketSession({ ticket, role, purpose }) {
      const key = `${ticket.id}:${purpose}`
      let id = this.ticketSessions.get(key)
      if (id === undefined) {
        id = `session-${++this.counter}`
        this.ticketSessions.set(key, id)
        this.sessions.set(id, { role, purpose })
      }
      this.sessions.get(id).role = role
      return { sessionId: id }
    },
    setPhase(id, role) { if (this.sessions.has(id)) this.sessions.get(id).role = role },
    setRoute() {},
    async sendTurn({ sessionId }) {
      this.turns.push(sessionId)
      return { status: 'ok', action: { type: 'plan', value: PLAN }, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
    },
    async waitTurn() {
      return { status: 'ok', action: { type: 'plan', value: PLAN }, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
    },
    async closeSession(id) { this.sessions.delete(id); for (const [key, value] of this.ticketSessions) if (value === id) this.ticketSessions.delete(key) },
    async closeTicketSessions() {},
    liveTicketSession(ticketId, purpose) { return this.ticketSessions.get(`${ticketId}:${purpose}`) },
    isLive(id) { return this.sessions.has(id) },
    isTicketBusy() { return this.busy },
    start() {},
    stop() {},
    reconcileTurns() {},
  }
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  const ctx = { get() { return undefined } }
  const engine = new Engine({ ctx, store, driver, getConfig: () => config, getPrompts: () => PROMPTS, log })
  // Skip restart recovery: these tests start from a clean board, not a crash.
  engine.recovered = true
  return { store, driver, engine }
}

/** A fresh Backlog ticket at the plan phase, planning when picked up. */
function backlogTicket(store, extra = {}) {
  const created = store.createTicket({
    title: 'plan me now',
    acceptance: ['note exists'],
    workspaceCwd: CWD,
    planTiming: 'at_pickup',
    planQuestions: 'autonomous',
    ...extra,
  })
  return store.getTicket(created.id)
}

// ------------------------------------------------------------------------ the action

test('startPlanning sets plan-now, leaves the ticket in Backlog/plan, and the tick launches a planner', async () => {
  const { store, driver, engine } = setup()
  const ticket = backlogTicket(store)
  gateTurns(driver)

  const result = startPlanning({ store, driver, engine, ticket })

  assert.equal(result.ok, true)
  assert.equal(result.ticket.planTiming, 'now')
  assert.equal(result.ticket.column, 'backlog')
  assert.equal(result.ticket.phase, 'plan')

  // The action's own tick got as far as a planner turn.
  await flush()
  assert.equal(driver.turns.length, 1, 'the engine tick dispatched exactly one session')
  assert.equal(driver.sessions.get(driver.turns[0]).role, 'planner')
  assert.equal(driver.ticketSessions.get(`${ticket.id}:plan`), driver.turns[0])

  const after = store.getTicket(ticket.id)
  assert.equal(after.planTiming, 'now')
  assert.equal(after.column, 'backlog', 'the button never moves the ticket')
  assert.equal(after.phase, 'plan', 'still planning — the turn is in flight')
})

test('startPlanning lifts a park on a Backlog plan ticket, live plan session and all', async () => {
  const { store, driver, engine } = setup()
  const ticket = backlogTicket(store)
  store.setNeedsAttention(ticket.id, 'plan session ended without calling kanban_submit_plan')
  // The failed plan session stays open on purpose so the human can talk it
  // through. Retrying has to work anyway, or the button is not a retry.
  driver.ticketSessions.set(`${ticket.id}:plan`, 'session-old')
  driver.sessions.set('session-old', { role: 'planner', purpose: 'plan' })
  gateTurns(driver)

  const result = startPlanning({ store, driver, engine, ticket: store.getTicket(ticket.id) })

  assert.equal(result.ok, true)
  const after = store.getTicket(ticket.id)
  assert.equal(after.needsAttentionReason, null, 'the park is lifted')
  assert.equal(after.planTiming, 'now')
  assert.equal(after.column, 'backlog')
  await flush()
  assert.equal(driver.turns.length, 1, 'the retry launches a fresh plan turn')
})

test('startPlanning refuses a ticket that is not Backlog/plan', () => {
  const { store, driver, engine } = setup()
  const ticked = []
  const countingEngine = { tick: () => { ticked.push(1) } }

  const working = backlogTicket(store, { column: 'working' })
  const planned = backlogTicket(store)
  store.transitionTicket(planned.id, { phase: 'implement' }, { actor: 'engine', reason: 'test' })
  const shipped = backlogTicket(store)
  store.setColumn(shipped.id, 'done', { actor: 'human', reason: 'test' })
  const trashed = backlogTicket(store)
  store.setColumn(trashed.id, 'discarded', { actor: 'human', reason: 'test' })

  for (const ticket of [working, planned, shipped, trashed]) {
    const result = startPlanning({ store, driver, engine: countingEngine, ticket: store.getTicket(ticket.id) })
    assert.equal(result.ok, false, `${ticket.column}/${ticket.phase} must be refused`)
    assert.equal(result.code, 'bad_request')
    assert.equal(result.ticket, undefined)
  }
  assert.deepEqual(ticked, [], 'a refused action never nudges the engine')
})

test('startPlanning refuses while a plan session is already running', () => {
  const { store, driver, engine } = setup()
  const busyTicket = backlogTicket(store)
  driver.busy = true
  const busy = startPlanning({ store, driver, engine: { tick() {} }, ticket: busyTicket })
  assert.equal(busy.ok, false)
  assert.equal(busy.code, 'bad_request')
  driver.busy = false

  // Not busy, but a plan session is open on a ticket nobody has parked: that is
  // the grilling question waiting on an answer, not a ticket to re-launch.
  const asked = backlogTicket(store)
  driver.ticketSessions.set(`${asked.id}:plan`, 'session-ask')
  driver.sessions.set('session-ask', { role: 'planner', purpose: 'plan' })
  const live = startPlanning({ store, driver, engine: { tick() {} }, ticket: asked })
  assert.equal(live.ok, false)
  assert.equal(live.code, 'bad_request')

  assert.equal(store.getTicket(busyTicket.id).planTiming, 'at_pickup', 'a refusal writes nothing')
  assert.equal(store.getTicket(asked.id).planTiming, 'at_pickup')
})

test('startPlanning on an already-plan-now ticket is an ok no-op that still nudges the engine', () => {
  const { store, driver } = setup()
  const ticket = backlogTicket(store, { planTiming: 'now' })
  const before = store.getTicket(ticket.id)
  let ticks = 0
  const result = startPlanning({ store, driver, engine: { tick: async () => { ticks += 1 } }, ticket: before })
  assert.equal(result.ok, true)
  assert.equal(result.ticket.planTiming, 'now')
  assert.equal(result.ticket.version, before.version, 'no field changed, so no row was rewritten')
  assert.equal(ticks, 1, 'the tick still runs: a queued plan-now ticket may have a free slot now')
})

// ------------------------------------------------------------- the visibility rule

test('canStartPlanning offers the button exactly where the host accepts it', () => {
  const base = { column: 'backlog', phase: 'plan', planTiming: 'at_pickup' }
  assert.equal(canStartPlanning(base), true, 'an at_pickup Backlog plan ticket')
  assert.equal(canStartPlanning({ ...base, needsAttentionReason: 'plan rejected' }), true, 'a parked plan ticket doubles as the retry')
  assert.equal(canStartPlanning({ ...base, planTiming: 'now' }), false, 'already planning now')
  assert.equal(canStartPlanning({ ...base, status: 'active' }), false, 'a turn is in flight')
  assert.equal(canStartPlanning({ ...base, awaitingQuestion: true }), false, 'the planner is waiting on the human')
  assert.equal(canStartPlanning({ ...base, column: 'working' }), false, 'Working plans on pickup')
  assert.equal(canStartPlanning({ ...base, phase: 'implement' }), false, 'already past planning')
  assert.equal(canStartPlanning({ column: 'done', phase: 'closed', planTiming: 'at_pickup' }), false, 'terminal')
  assert.equal(canStartPlanning(null), false)
})
