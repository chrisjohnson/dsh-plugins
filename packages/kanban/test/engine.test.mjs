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

const CWD = mkdtempSync(join(tmpdir(), 'kanban-engine-'))

const PLAN = {
  summary: 'write the file',
  steps: ['create notes.txt'],
  done_when: [{ id: 'notes', statement: 'note exists', how_verified: 'test -f notes.txt' }],
}
const IMPLEMENTATION = {
  status: 'complete',
  summary: 'created notes.txt',
  changed_files: ['notes.txt'],
  done_when: [{ id: 'notes', met: true, confidence: 0.95, evidence: 'notes.txt:1 hello' }],
  questions: [],
  residual_risks: [],
}
const REVIEW_PASS = {
  verdict: 'pass',
  reasons: ['matches plan'],
  scope_drift: 'none',
  done_when: [{ id: 'notes', met: true, confidence: 0.95, evidence: 'notes.txt:1 hello' }],
  acceptance_coverage: [{ condition: 'notes', acceptance: 'note exists' }],
}
const REVIEW_FAIL = {
  verdict: 'fail',
  reasons: ['the file is missing'],
  instruction: 'create notes.txt',
  scope_drift: 'none',
  acceptance_coverage: [],
}

const PROMPTS = {
  bodies: {
    'plan-human': 'plan {{ticket_state}}',
    'plan-self': 'plan self {{ticket_state}}',
    implement: 'implement {{plan}} {{done_when}}',
    rework: 'rework {{review}}',
    review: 'review {{diff}}',
  },
  hashes: { plan: 'h' },
}

function setup(queues = {}, options = {}) {
  const { config } = resolveConfig({
    autoPromote: false,
    roles: {
      planner: { provider: 'local', model: 'm', allowTools: ['read'] },
      implementer: { provider: 'local', model: 'm', allowTools: ['read', 'write', 'edit'] },
      reviewer: { provider: 'local', model: 'm', allowTools: ['read'] },
    },
    providers: [{ name: 'local' }],
    confidenceThreshold: 0.7,
  })
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const driver = {
    sessions: new Map(),
    ticketSessions: new Map(),
    counter: 0,
    /** flipped by the tests that stand in for a human turn in flight */
    busy: false,
    /** every session the engine actually sent a role prompt to */
    turns: [],
    /** every session the engine waited on after a recovery kick */
    waited: [],
    /** scripted waitTurn results, shifted one per wait */
    waits: [...(options.waits ?? [])],
    queues: {
      planner: [...(queues.plan ?? [{ type: 'plan', value: PLAN }])],
      implementer: [...(queues.implement ?? [{ type: 'implementation', value: IMPLEMENTATION }])],
      reviewer: [...(queues.review ?? [{ type: 'review', value: REVIEW_PASS }])],
    },
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
    setPhase(id, role) { this.sessions.get(id).role = role },
    setRoute() {},
    async sendTurn({ sessionId }) {
      this.turns.push(sessionId)
      const session = this.sessions.get(sessionId)
      const next = this.queues[session.role]?.shift()
      // A queue entry `{ fail: 'max-tokens' }` stands in for a halted turn.
      if (next !== undefined && next.fail !== undefined) {
        return { status: 'failed', error: next.fail, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
      }
      return { status: 'ok', action: next ?? null, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
    },
    async waitTurn({ sessionId }) {
      this.waited.push(sessionId)
      const next = this.waits.shift() ?? { fail: 'nothing scripted for this wait' }
      if (next.fail !== undefined) return { status: 'failed', error: next.fail, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
      if (next.status === 'stalled') return { status: 'stalled', error: 'stalled', finalText: '', usage: null, events: [] }
      if (next.status === 'disposed') return { status: 'disposed', error: 'session closed', finalText: '', usage: null, events: [] }
      return { status: 'ok', action: next.action ?? null, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
    },
    async closeSession() {},
    async closeTicketSessions() {},
    liveTicketSession(ticketId, purpose) { return this.ticketSessions.get(`${ticketId}:${purpose}`) },
    isLive(id) { return this.sessions.has(id) },
    isTicketBusy() { return this.busy },
    start() {},
    stop() {},
    reconcileTurns() {},
  }
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  // `options.kicker` may be a service, null (not mounted), or a function called
  // per lookup so a test can stand in for a plugin that mounts later.
  const lookups = { count: 0 }
  const ctx = {
    get(name) {
      if (name !== 'continueKicker') return undefined
      lookups.count += 1
      if (typeof options.kicker === 'function') return options.kicker(lookups.count)
      return options.kicker ?? undefined
    },
  }
  const engine = new Engine({ ctx, store, driver, getConfig: () => config, getPrompts: () => PROMPTS, log })
  return { store, driver, engine, config, lookups }
}

function pickedUp(store, extra = {}) {
  const ticket = store.createTicket({ title: 'demo', acceptance: ['note exists'], workspaceCwd: CWD, planTiming: 'at_pickup', planQuestions: 'autonomous', ...extra })
  store.transitionTicket(ticket.id, { column: 'now' }, { actor: 'human' })
  return store.getTicket(ticket.id)
}

test('flat plan -> implement -> review -> approval -> approve', async () => {
  const { store, engine } = setup()
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const pending = store.getTicket(ticket.id)
  assert.equal(pending.column, 'needs_attention')
  assert.equal(pending.phase, 'verify')
  assert.equal(pending.needsAttentionReason, 'Awaiting human approval')
  assert.equal(store.listConditions(ticket.id).length, 1)
  assert.ok(store.listSessions(ticket.id).some((s) => s.purpose === 'plan'))
  assert.ok(store.listSessions(ticket.id).some((s) => s.purpose === 'build'))
  assert.equal(store.listSessions(ticket.id).some((s) => s.purpose === 'verify'), false)
  const done = await engine.approve(ticket.id)
  assert.equal(done.column, 'done')
  assert.equal(done.phase, 'closed')
})

test('review failure returns to implement in the same build session', async () => {
  const { store, engine, driver } = setup({
    implement: [
      { type: 'implementation', value: IMPLEMENTATION },
      { type: 'implementation', value: IMPLEMENTATION },
    ],
    review: [
      { type: 'review', value: REVIEW_FAIL },
      { type: 'review', value: REVIEW_PASS },
    ],
  })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).column, 'needs_attention')
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
  assert.equal(store.getTicket(ticket.id).attemptCount, 2)
  assert.equal([...driver.ticketSessions.keys()].filter((key) => key.includes(':build')).length, 1)
})

test('a passing review missing planned evidence returns to implement', async () => {
  const { store, engine } = setup({
    implement: [
      { type: 'implementation', value: IMPLEMENTATION },
      { type: 'implementation', value: IMPLEMENTATION },
    ],
    review: [
      { type: 'review', value: { ...REVIEW_PASS, done_when: [] } },
      { type: 'review', value: REVIEW_PASS },
    ],
  })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
  assert.equal(store.getTicket(ticket.id).attemptCount, 2)
})

test('approval can submit a follow-up plan for another round', async () => {
  const { store, engine } = setup()
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
  const next = await engine.submitApprovalPlan(ticket.id, {
    ...PLAN,
    summary: 'second round',
    done_when: [{ id: 'round-two', statement: 'second', how_verified: 'true' }],
  })
  assert.equal(next.column, 'now')
  assert.equal(next.phase, 'implement')
  assert.equal(store.listConditions(ticket.id)[0].id, 'round-two')
})

test('manual implementation submission advances to review', async () => {
  const { store, engine } = setup()
  const ticket = pickedUp(store)
  store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine' })
  await engine.handleManualAction({
    ticketId: ticket.id,
    purpose: 'build',
    sessionId: 'session-manual',
    action: { type: 'implementation', value: IMPLEMENTATION },
  })
  assert.equal(store.getTicket(ticket.id).phase, 'review')
  assert.equal(store.getTicket(ticket.id).column, 'now')
})

test('plan without the tool call needs attention', async () => {
  const { store, engine } = setup({ plan: [] })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const blocked = store.getTicket(ticket.id)
  assert.equal(blocked.column, 'needs_attention')
  assert.match(blocked.needsAttentionReason, /kanban_submit_plan/)
})

test('implementation without conditions goes back to plan', async () => {
  const { store, engine } = setup()
  const ticket = pickedUp(store)
  store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine' })
  const result = await engine.implement(store.getTicket(ticket.id))
  assert.equal(result.kind, 'continue')
  assert.equal(store.getTicket(ticket.id).phase, 'plan')
})

test('retryPhase uses plan before conditions and the current phase afterward', () => {
  const { store, engine } = setup()
  const ticket = pickedUp(store)
  assert.equal(engine.retryPhase(ticket), 'plan')
  store.replaceConditions(ticket.id, 1, [{ id: 'n', statement: 's', howVerified: 'v', ordinal: 0 }], 'plan')
  store.transitionTicket(ticket.id, { phase: 'implement' })
  assert.equal(engine.retryPhase(store.getTicket(ticket.id)), 'implement')
})

// --------------------------------------------------- realtime session activity

const flush = () => new Promise((resolve) => setImmediate(resolve))

/** Move a picked-up ticket into needs attention the way a failed turn would. */
function waiting(store, ticket, reason) {
  store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine' })
  store.setNeedsAttention(ticket.id, reason)
  return store.getTicket(ticket.id)
}

test('a reactivated ticket is in flight and the engine sends it no prompt while its session is busy', async () => {
  const { store, engine, driver } = setup()
  const ticket = pickedUp(store)
  waiting(store, ticket, 'turn failed in implement: boom')
  driver.busy = true
  engine.reactivateFromSession(ticket.id, 'session-1')
  assert.equal(store.getTicket(ticket.id).column, 'now')
  engine.recovered = true
  await engine.tick()
  await flush()
  assert.deepEqual(driver.turns, [])
  // once the human turn is over the engine takes the ticket back
  driver.busy = false
  await engine.tick()
  await flush()
  assert.ok(driver.turns.length > 0)
})

test('the backlog planning loop skips a busy ticket', async () => {
  const { store, engine, driver } = setup()
  store.createTicket({ title: 'later', acceptance: ['a'], workspaceCwd: CWD, planTiming: 'now', planQuestions: 'autonomous' })
  driver.busy = true
  engine.recovered = true
  await engine.tick()
  await flush()
  assert.deepEqual(driver.turns, [])
})

test('advance refuses to drive a ticket whose session has a turn in flight', async () => {
  const { store, engine, driver } = setup()
  const ticket = pickedUp(store)
  driver.busy = true
  const result = await engine.advance(store.getTicket(ticket.id))
  assert.deepEqual(result, { kind: 'wait' })
  assert.deepEqual(driver.turns, [])
})

test('a turn that ends without a submission returns the ticket to needs attention with its reason', () => {
  const { store, engine } = setup()
  const ticket = pickedUp(store)
  waiting(store, ticket, 'attempt budget exhausted (3)')
  engine.reactivateFromSession(ticket.id, 'session-1')
  const flight = store.getTicket(ticket.id)
  assert.equal(flight.column, 'now')
  assert.equal(flight.needsAttentionReason, null)
  engine.settleSessionTurn(ticket.id, 'session-1')
  const back = store.getTicket(ticket.id)
  assert.equal(back.column, 'needs_attention')
  assert.equal(back.needsAttentionReason, 'attempt budget exhausted (3)')
  assert.equal(back.phase, 'implement')
  const kinds = store.listEvents(ticket.id).map((event) => event.kind)
  assert.ok(kinds.includes('session_reactivated'))
  assert.ok(kinds.includes('session_settled'))
})

test('a settle is deferred, not claimed, while another session of the ticket is mid-turn', () => {
  const { store, engine, driver } = setup()
  const ticket = pickedUp(store)
  waiting(store, ticket, 'turn failed in implement: boom')
  engine.reactivateFromSession(ticket.id, 'session-1')
  assert.equal(store.getTicket(ticket.id).column, 'now')
  const parked = () => store.listEvents(ticket.id).filter((event) => event.kind === 'needs_attention').length
  const before = parked()
  driver.busy = true
  engine.settleSessionTurn(ticket.id, 'session-1')
  const held = store.getTicket(ticket.id)
  assert.equal(held.column, 'now')
  assert.equal(held.needsAttentionReason, null)
  const deferred = store.listEvents(ticket.id).map((event) => event.kind)
  assert.equal(deferred.includes('session_settled'), false)
  assert.equal(parked(), before)
  assert.equal(engine.reactivations.has(ticket.id), true)
  // once the other session is done the same settle parks the ticket with its reason
  driver.busy = false
  engine.settleSessionTurn(ticket.id, 'session-1')
  const back = store.getTicket(ticket.id)
  assert.equal(back.column, 'needs_attention')
  assert.equal(back.needsAttentionReason, 'turn failed in implement: boom')
  assert.ok(store.listEvents(ticket.id).map((event) => event.kind).includes('session_settled'))
})

test('a structured submission from a human-driven turn is not settled back', async () => {
  const { store, engine } = setup()
  const ticket = pickedUp(store)
  waiting(store, ticket, 'implementer ended without calling kanban_submit_implementation')
  engine.reactivateFromSession(ticket.id, 'session-1')
  await engine.handleManualAction({
    ticketId: ticket.id,
    purpose: 'build',
    sessionId: 'session-1',
    action: { type: 'implementation', value: IMPLEMENTATION },
  })
  assert.equal(store.getTicket(ticket.id).phase, 'review')
  engine.settleSessionTurn(ticket.id, 'session-1')
  const after = store.getTicket(ticket.id)
  assert.equal(after.column, 'now')
  assert.equal(after.phase, 'review')
  const attention = store.listEvents(ticket.id).filter((event) => event.kind === 'needs_attention')
  assert.equal(attention.length, 1)
})

test('an approval-waiting ticket flips with its approval session and returns to Awaiting human approval', async () => {
  const { store, engine } = setup()
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const waitingTicket = store.getTicket(ticket.id)
  assert.equal(waitingTicket.phase, 'verify')
  assert.equal(waitingTicket.column, 'needs_attention')
  engine.reactivateFromSession(ticket.id, 'session-approval')
  assert.equal(store.getTicket(ticket.id).column, 'now')
  engine.settleSessionTurn(ticket.id, 'session-approval')
  const back = store.getTicket(ticket.id)
  assert.equal(back.column, 'needs_attention')
  assert.equal(back.phase, 'verify')
  assert.equal(back.needsAttentionReason, 'Awaiting human approval')
})

test('a reactivation of a ticket that is not waiting for attention changes nothing', () => {
  const { store, engine, driver } = setup()
  const ticket = pickedUp(store)
  engine.reactivateFromSession(ticket.id, 'session-1')
  assert.equal(store.getTicket(ticket.id).column, 'now')
  assert.equal(engine.reactivations.has(ticket.id), false)
  engine.settleSessionTurn(ticket.id, 'session-1')
  assert.equal(store.getTicket(ticket.id).column, 'now')
  assert.equal(driver.turns.length, 0)
})

// ------------------------------------------------------------------ auto-recovery
//
// A halted role turn asks dsh-continue-kicker's kick service for one recovery
// kick and waits for the turn it starts. The policy (what is kickable, how many
// kicks in a row) lives in that plugin; these tests stand in for both answers,
// and for the service being absent.

/** A kick service that always says yes, counting like the real runaway guard. */
function alwaysKicks(max = 3) {
  const calls = []
  return {
    version: 1,
    calls,
    kick(sessionId, opts) {
      calls.push({ sessionId, ...opts })
      if (calls.length > max) return { kicked: false, why: `${max} consecutive plugin kicks without progress`, stopped: true }
      return { kicked: true, flavor: 'max-tokens', consecutive: calls.length }
    },
  }
}

test('a halted implement turn is recovered by a kick, in the same attempt', async () => {
  const kicker = alwaysKicks()
  const { store, engine, driver } = setup(
    { implement: [{ fail: 'max-tokens' }] },
    { kicker, waits: [{ action: { type: 'implementation', value: IMPLEMENTATION } }] },
  )
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const done = store.getTicket(ticket.id)
  // implement recovered, review passed on its own turn: the run went as far as it can.
  assert.equal(done.phase, 'verify')
  assert.equal(done.attemptCount, 1, 'a recovered turn does not burn an attempt')
  assert.equal(driver.waited.length, 1)
  assert.equal(kicker.calls.length, 1)
  assert.equal(kicker.calls[0].bypassCooldown, true)
  const events = store.listEvents(ticket.id, { limit: 500 }).filter((e) => e.kind === 'auto_recovered')
  assert.equal(events.length, 1)
  assert.equal(events[0].payload.flavor, 'max-tokens')
  assert.equal(events[0].payload.phase, 'implement')
  const spans = store.listSpans(ticket.id).map((s) => s.name)
  assert.ok(spans.includes('implement-continuation'), `continuation span missing in ${JSON.stringify(spans)}`)
})

test('a second halt is recovered again, and the guard ends it', async () => {
  const kicker = alwaysKicks(2)
  const { store, engine, driver } = setup(
    { implement: [{ fail: 'max-tokens' }] },
    { kicker, waits: [{ fail: 'max-tokens' }, { action: { type: 'implementation', value: IMPLEMENTATION } }] },
  )
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
  assert.equal(driver.waited.length, 2)
  assert.equal(store.listEvents(ticket.id, { limit: 500 }).filter((e) => e.kind === 'auto_recovered').length, 2)
})

test('when the guard declines the kick, the ticket parks with the original reason', async () => {
  const kicker = { version: 1, kick: () => ({ kicked: false, why: '3 consecutive plugin kicks without progress', stopped: true }) }
  const { store, engine, driver } = setup({ implement: [{ fail: 'max-tokens' }] }, { kicker, waits: [] })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.column, 'needs_attention')
  assert.equal(parked.needsAttentionReason, 'turn failed in implement: max-tokens')
  assert.equal(driver.waited.length, 0, 'nothing to wait for when no kick was sent')
  assert.equal(store.listEvents(ticket.id, { limit: 500 }).some((e) => e.kind === 'auto_recovered'), false)
})

test('a halt that is not kickable parks the same way', async () => {
  const kicker = { version: 1, kick: () => ({ kicked: false, why: 'last turn aborted by user' }) }
  const { store, engine } = setup({ implement: [{ fail: 'aborted' }] }, { kicker })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'turn failed in implement: aborted')
})

test('without the service mounted, a halted turn parks exactly as before (degraded path)', async () => {
  const { store, engine, driver } = setup({ implement: [{ fail: 'max-tokens' }] }, { kicker: null })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.column, 'needs_attention')
  assert.equal(parked.needsAttentionReason, 'turn failed in implement: max-tokens')
  assert.equal(driver.waited.length, 0)
  assert.equal(store.listEvents(ticket.id, { limit: 500 }).some((e) => e.kind === 'auto_recovered'), false)
})

test('the service is looked up lazily, so a plugin mounted after kanban is still found', async () => {
  const kicker = alwaysKicks()
  // Absent for the first lookups, present afterwards.
  const { store, engine, driver } = setup({ implement: [{ fail: 'max-tokens' }] }, {
    kicker: (n) => (n === 1 ? undefined : kicker),
    waits: [{ action: { type: 'implementation', value: IMPLEMENTATION } }],
  })
  assert.equal(engine.kickerService(), null, 'not mounted yet')
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(driver.waited.length, 1)
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
})

test('a turn that stalls after the kick parks with that reason', async () => {
  const kicker = alwaysKicks()
  const { store, engine } = setup({ implement: [{ fail: 'max-tokens' }] }, { kicker, waits: [{ status: 'stalled' }] })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'turn failed in implement: turn stalled after auto-recovery')
})

test('a disposed session during recovery parks with the original reason', async () => {
  const kicker = alwaysKicks()
  const { store, engine } = setup({ implement: [{ fail: 'max-tokens' }] }, { kicker, waits: [{ status: 'disposed' }] })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'turn failed in implement: max-tokens')
})

test('a service that never declines is bounded by the loop backstop, not an infinite wait', async () => {
  const kicker = alwaysKicks(Number.MAX_SAFE_INTEGER)
  const waits = Array.from({ length: 20 }, () => ({ fail: 'max-tokens' }))
  const { store, engine, driver } = setup({ implement: [{ fail: 'max-tokens' }] }, { kicker, waits })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(driver.waited.length, 8, 'the backstop is 8 rounds')
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'turn failed in implement: max-tokens')
})

test('a halted plan turn is recovered too', async () => {
  const kicker = alwaysKicks()
  const { store, engine, driver } = setup(
    { plan: [{ fail: 'max-tokens' }], implement: [] },
    { kicker, waits: [{ action: { type: 'plan', value: PLAN } }] },
  )
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(driver.waited.length, 1)
  assert.equal(store.listConditions(ticket.id).length, 1, 'the recovered plan landed')
  assert.equal(store.getTicket(ticket.id).phase, 'implement')
})
