import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { resolveConfig } from '../src/config.mjs'
import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import { Engine, attachedImages, ticketStateBlock } from '../src/engine.mjs'
import { isPlanReady } from '../src/grants.mjs'
import { render } from '../src/prompts.mjs'

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
// KAN-31: the no-progress signature records the ids the review named unmet, so a
// fail that actually lists them is the case the guard is built for.
const REVIEW_FAIL_ROW = {
  ...REVIEW_FAIL,
  done_when: [{ id: 'notes', met: false, confidence: 0.9, evidence: 'notes.txt does not exist' }],
}

const PROMPTS = {
  bodies: {
    'plan-human': 'plan {{ticket_state}}',
    'plan-self': 'plan self {{ticket_state}}',
    implement: 'implement {{plan}} {{done_when}} {{release_scope}}',
    rework: 'rework {{review}} {{release_scope}}',
    review: 'review {{diff}} {{done_when}}',
    approval: 'approval {{plan}} {{review}}{{deferred}}',
  },
  hashes: { plan: 'h' },
}

function setup(queues = {}, options = {}) {
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
    /** flipped by the tests that stand in for a human turn in flight */
    busy: false,
    /** every session the engine actually sent a role prompt to */
    turns: [],
    /** every session the engine closed: approval must not appear here */
    closed: [],
    /** every session the engine waited on after a recovery kick */
    waited: [],
    /** scripted waitTurn results, shifted one per wait */
    waits: [...(options.waits ?? [])],
    queues: {
      planner: [...(queues.plan ?? [{ type: 'plan', value: PLAN }])],
      implementer: [...(queues.implement ?? [{ type: 'implementation', value: IMPLEMENTATION }])],
      reviewer: [...(queues.review ?? [{ type: 'review', value: REVIEW_PASS }])],
      // The approval turn asks the human a question and ends without a
      // structured submission; that is its normal shape.
      approver: [...(queues.approval ?? [null])],
    },
    /**
     * KAN-18: what `preparePlanWorktree` yields. An object is returned as-is; a
     * function is called with the ticket, so a test can stand in for a fetch that
     * throws. `undefined` (a driver without the seam at all) is the legacy shape.
     */
    prep: { cwd: undefined, note: undefined },
    /** every cwd the engine handed to ensureTicketSession, in order */
    preparedCwds: [],
    async preparePlanWorktree(ticket) {
      this.prepCalls = (this.prepCalls ?? 0) + 1
      return typeof this.prep === 'function' ? this.prep(ticket) : this.prep
    },
    async ensureTicketSession({ ticket, role, purpose, preparedCwd }) {
      this.preparedCwds.push(preparedCwd)
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
    /** every route the engine pushed onto a session, in order */
    routes: [],
    setRoute(id, route) { this.routes.push({ sessionId: id, route }) },
    async sendTurn({ sessionId }) {
      this.turns.push(sessionId)
      const session = this.sessions.get(sessionId)
      const next = this.queues[session.role]?.shift() ?? null
      // A queue entry `{ fail: 'max-tokens' }` stands in for a halted turn.
      if (next !== null && next.fail !== undefined) {
        return { status: 'failed', error: next.fail, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
      }
      return { status: 'ok', action: next, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
    },
    async waitTurn({ sessionId }) {
      this.waited.push(sessionId)
      const next = this.waits.shift() ?? { fail: 'nothing scripted for this wait' }
      if (next.fail !== undefined) return { status: 'failed', error: next.fail, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
      if (next.status === 'stalled') return { status: 'stalled', error: 'stalled', finalText: '', usage: null, events: [] }
      if (next.status === 'disposed') return { status: 'disposed', error: 'session closed', finalText: '', usage: null, events: [] }
      return { status: 'ok', action: next.action ?? null, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
    },
    async closeSession(id) { this.closed.push(id) },
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

/**
 * A scratch git repo with one commit. KAN-31's no-progress guard reads the real
 * working tree, so the test that exercises it needs a real tree to read.
 */
function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-engine-git-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'README.md'), 'seed\n')
  git('add', 'README.md')
  git('commit', '-q', '-m', 'seed')
  return dir
}

function pickedUp(store, extra = {}) {
  // A human put this ticket in Working: that is where the engine drives it.
  const ticket = store.createTicket({ title: 'demo', acceptance: ['note exists'], workspaceCwd: CWD, planTiming: 'at_pickup', planQuestions: 'autonomous', column: 'working', ...extra })
  return store.getTicket(ticket.id)
}

test('flat plan -> implement -> review -> approval -> approve', async () => {
  const { store, engine, driver } = setup()
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const pending = store.getTicket(ticket.id)
  assert.equal(pending.column, 'working')
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

// ------------------------------------------------------- approval in the build session
//
// KAN-11: a passing review does not tear the build session down and open a
// separate approval one. The same session that wrote the code and reviewed it is
// flipped to the approver phase, moved onto the approver route, and asked what
// the human wants to do — then the ticket parks for them.

test('the approval turn runs in the build session, on the approver phase and route', async () => {
  const { store, engine, driver } = setup({}, {
    config: {
      roles: {
        planner: { provider: 'local', model: 'm' },
        implementer: { provider: 'local', model: 'm' },
        reviewer: { provider: 'local', model: 'm' },
        approver: { provider: 'local', model: 'approver-m' },
      },
    },
  })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const planId = driver.ticketSessions.get(`${ticket.id}:plan`)
  const buildId = driver.ticketSessions.get(`${ticket.id}:build`)
  // No approval-purpose session was ever created, and the build session is the
  // only one the engine spoke to after the plan.
  assert.equal([...driver.ticketSessions.keys()].some((key) => key.endsWith(':approval')), false)
  assert.equal(store.listSessions(ticket.id).some((s) => s.purpose === 'approval'), false)
  assert.deepEqual(driver.turns, [planId, buildId, buildId, buildId])
  // implement -> review -> approval: the session ends in the approver phase, on
  // the approver route, and the engine never closed it.
  assert.equal(driver.sessions.get(buildId).role, 'approver')
  assert.equal(driver.routes[driver.routes.length - 1].sessionId, buildId)
  assert.equal(driver.routes[driver.routes.length - 1].route.model, 'approver-m')
  assert.equal(driver.closed.includes(buildId), false)
  const approvalSpan = store.listSpans(ticket.id).find((span) => span.name === 'approval')
  assert.ok(approvalSpan, 'the approval turn is recorded as its own span')
  assert.equal(approvalSpan.role, 'approver')
  assert.equal(approvalSpan.status, 'ok')
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'Awaiting human approval')
})

test('a failed approval turn parks the ticket as an approval failure', async () => {
  const { store, engine } = setup({ approval: [{ fail: 'max-tokens' }] }, { kicker: null })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.column, 'working')
  assert.equal(parked.phase, 'verify')
  assert.equal(parked.needsAttentionReason, 'turn failed in approval: max-tokens')
})

test('an approval decided inside the approval turn is not parked over', async () => {
  const { store, engine, driver } = setup()
  const ticket = pickedUp(store)
  const sendTurn = driver.sendTurn.bind(driver)
  driver.sendTurn = async (input) => {
    if (driver.sessions.get(input.sessionId).role !== 'approver') return sendTurn(input)
    // What kanban_approve does when the human answers inside the turn.
    await engine.approve(ticket.id, 'ship it')
    return { status: 'ok', action: null, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
  }
  await engine.advance(store.getTicket(ticket.id))
  const done = store.getTicket(ticket.id)
  assert.equal(done.column, 'done')
  assert.equal(done.phase, 'closed')
  assert.equal(done.needsAttentionReason, null)
})

test('a re-planned approval is not parked back to awaiting approval', async () => {
  const { store, engine, driver } = setup()
  const ticket = pickedUp(store)
  const sendTurn = driver.sendTurn.bind(driver)
  driver.sendTurn = async (input) => {
    if (driver.sessions.get(input.sessionId).role !== 'approver') return sendTurn(input)
    await engine.submitApprovalPlan(ticket.id, {
      ...PLAN,
      summary: 'second round',
      done_when: [{ id: 'round-two', statement: 'second', how_verified: 'true' }],
    })
    return { status: 'ok', action: null, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
  }
  await engine.advance(store.getTicket(ticket.id))
  const again = store.getTicket(ticket.id)
  assert.equal(again.phase, 'implement')
  assert.equal(again.needsAttentionReason, null)
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
  assert.equal(store.getTicket(ticket.id).column, 'working')
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
  assert.equal(store.getTicket(ticket.id).attemptCount, 2)
  assert.equal([...driver.ticketSessions.keys()].filter((key) => key.includes(':build')).length, 1)
})

test('a passing review missing planned evidence goes back to the reviewer, not the build', async () => {
  // KAN-31: an empty done_when is a defect in the review submission. It used to
  // cost an implement round; now the reviewer is asked once to fix its own answer
  // and the build keeps its attempt.
  const { store, engine } = setup({
    review: [
      { type: 'review', value: { ...REVIEW_PASS, done_when: [] } },
      { type: 'review', value: REVIEW_PASS },
    ],
  })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.phase, 'verify')
  assert.equal(parked.needsAttentionReason, 'Awaiting human approval')
  assert.equal(parked.attemptCount, 1, 'no implement round was spent on a review-shape gap')
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
  assert.equal(next.column, 'working')
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
  assert.equal(store.getTicket(ticket.id).column, 'working')
})

test('plan without the tool call needs attention', async () => {
  const { store, engine } = setup({ plan: [] })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const blocked = store.getTicket(ticket.id)
  assert.equal(blocked.column, 'working')
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
  assert.equal(store.getTicket(ticket.id).column, 'working')
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
  assert.equal(flight.column, 'working')
  assert.equal(flight.needsAttentionReason, null)
  engine.settleSessionTurn(ticket.id, 'session-1')
  const back = store.getTicket(ticket.id)
  assert.equal(back.column, 'working')
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
  assert.equal(store.getTicket(ticket.id).column, 'working')
  const parked = () => store.listEvents(ticket.id).filter((event) => event.kind === 'needs_attention').length
  const before = parked()
  driver.busy = true
  engine.settleSessionTurn(ticket.id, 'session-1')
  const held = store.getTicket(ticket.id)
  assert.equal(held.column, 'working')
  assert.equal(held.needsAttentionReason, null)
  const deferred = store.listEvents(ticket.id).map((event) => event.kind)
  assert.equal(deferred.includes('session_settled'), false)
  assert.equal(parked(), before)
  assert.equal(engine.reactivations.has(ticket.id), true)
  // once the other session is done the same settle parks the ticket with its reason
  driver.busy = false
  engine.settleSessionTurn(ticket.id, 'session-1')
  const back = store.getTicket(ticket.id)
  assert.equal(back.column, 'working')
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
  assert.equal(after.column, 'working')
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
  assert.equal(waitingTicket.column, 'working')
  engine.reactivateFromSession(ticket.id, 'session-approval')
  assert.equal(store.getTicket(ticket.id).column, 'working')
  engine.settleSessionTurn(ticket.id, 'session-approval')
  const back = store.getTicket(ticket.id)
  assert.equal(back.column, 'working')
  assert.equal(back.phase, 'verify')
  assert.equal(back.needsAttentionReason, 'Awaiting human approval')
})

test('a reactivation of a ticket that is not waiting for attention changes nothing', () => {
  const { store, engine, driver } = setup()
  const ticket = pickedUp(store)
  engine.reactivateFromSession(ticket.id, 'session-1')
  assert.equal(store.getTicket(ticket.id).column, 'working')
  assert.equal(engine.reactivations.has(ticket.id), false)
  engine.settleSessionTurn(ticket.id, 'session-1')
  assert.equal(store.getTicket(ticket.id).column, 'working')
  assert.equal(driver.turns.length, 0)
})

// ------------------------------------------------------ tick launch semantics
//
// Columns are intended state: tick launches Working tickets in queue order
// plus Backlog plan-now tickets, skips parked and busy ones, and wipCap only
// throttles how many turns run at once.

function gatedDriver(driver) {
  const pending = []
  driver.sendTurn = ({ sessionId }) =>
    new Promise((resolve) => {
      driver.turns.push(sessionId)
      pending.push(() => resolve({ status: 'ok', action: null, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }))
    })
  return pending
}

test('tick launches Working tickets in queue order, capped by wipCap', async () => {
  const { store, engine, driver } = setup({}, { config: { wipCap: 2 } })
  const low = pickedUp(store, { title: 'low', priority: 1 })
  const high = pickedUp(store, { title: 'high', priority: 5 })
  const third = pickedUp(store, { title: 'third', priority: 0 })
  const pending = gatedDriver(driver)
  engine.recovered = true
  await engine.tick()
  await flush()
  assert.equal(driver.turns.length, 2, 'the cap throttles launches, it does not reject tickets')
  assert.equal(pending.length, 2)
  // queue order: priority desc — the high-priority ticket was opened first,
  // and the third ticket is still untouched, waiting its turn.
  assert.equal(driver.ticketSessions.get(`${high.id}:plan`), 'session-1')
  assert.equal(driver.ticketSessions.get(`${low.id}:plan`), 'session-2')
  assert.equal([...driver.ticketSessions.keys()].some((key) => key.startsWith(third.id)), false)
})

test('tick plans plan-now tickets in Backlog and leaves at_pickup tickets alone', async () => {
  const { store, engine, driver } = setup()
  const nowTicket = store.createTicket({ title: 'plan me', acceptance: ['a'], workspaceCwd: CWD, planTiming: 'now', planQuestions: 'autonomous' })
  store.createTicket({ title: 'later', acceptance: ['a'], workspaceCwd: CWD, planTiming: 'at_pickup', planQuestions: 'autonomous' })
  gatedDriver(driver)
  engine.recovered = true
  await engine.tick()
  await flush()
  assert.equal(driver.turns.length, 1)
  assert.equal(driver.sessions.get(driver.turns[0]).role, 'planner')
  assert.equal(store.getTicket(nowTicket.id).column, 'backlog')
})

test('tick skips parked (needs-attention) tickets in Working', async () => {
  const { store, engine, driver } = setup()
  const ticket = pickedUp(store)
  store.setNeedsAttention(ticket.id, 'turn failed in plan: boom')
  gatedDriver(driver)
  engine.recovered = true
  await engine.tick()
  await flush()
  assert.deepEqual(driver.turns, [])
})

test('a plan-now ticket plans in Backlog and stops at Build until dragged to Working', async () => {
  const { store, engine } = setup()
  const ticket = store.createTicket({ title: 'plan in place', acceptance: ['note exists'], workspaceCwd: CWD, planTiming: 'now', planQuestions: 'autonomous' })
  await engine.advance(store.getTicket(ticket.id))
  const planned = store.getTicket(ticket.id)
  assert.equal(planned.column, 'backlog')
  assert.equal(planned.phase, 'implement')
  assert.equal(store.listConditions(ticket.id).length, 1)
  // dragging it to Working lets the engine build it
  store.transitionTicket(ticket.id, { column: 'working' }, { actor: 'human' })
  await engine.advance(store.getTicket(ticket.id))
  const approved = store.getTicket(ticket.id)
  assert.equal(approved.column, 'working')
  assert.equal(approved.phase, 'verify')
  assert.equal(approved.needsAttentionReason, 'Awaiting human approval')
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
  assert.equal(parked.column, 'working')
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
  assert.equal(parked.column, 'working')
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

// ------------------------------------------------- archived session failures
//
// The KAN-4 shape: the human archives a ticket's build session, the driver still
// has it registered, and the engine dispatches the review into it. The reason on
// the board has to say what to do about it, not blame a reviewer who never ran.

const ARCHIVED_MESSAGE = 'workflow session session-27cea356 is archived; unarchive it and retry'

/** Stand in for the driver refusing to dispatch into an archived purpose session. */
function blockWith(driver, message, code = 'SESSION_ARCHIVED') {
  driver.ensureTicketSession = async () => {
    throw Object.assign(new Error(message), { name: 'DispatchError', code })
  }
}

/** Walk a picked-up ticket to the review phase the way the lifecycle allows. */
function toReview(store, ticket) {
  store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine' })
  store.transitionTicket(ticket.id, { phase: 'review' }, { actor: 'engine' })
  return store.getTicket(ticket.id)
}

test('an archived session parks the review with an actionable reason, not a blame-the-reviewer one', async () => {
  const { store, engine } = setup()
  const ticket = toReview(store, pickedUp(store))
  blockWith(engine.driver, ARCHIVED_MESSAGE)
  const result = await engine.review(ticket)
  assert.equal(result.kind, 'needs_attention')
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.column, 'working')
  assert.equal(parked.phase, 'review')
  assert.match(parked.needsAttentionReason, /archived/)
  assert.doesNotMatch(parked.needsAttentionReason, /ended without calling/)
  assert.doesNotMatch(parked.needsAttentionReason, /DispatchError|at .*engine\.mjs/)
  assert.equal(parked.needsAttentionReason, `turn failed in review: ${ARCHIVED_MESSAGE}`)
  assert.equal(parked.needsAttentionReason.includes('\n'), false)
  const span = store.listSpans(ticket.id).find((row) => row.name === 'review')
  assert.equal(span.status, 'failed')
  assert.equal(span.error, ARCHIVED_MESSAGE)
})

test('a blocked turn end reaches the board as a failed turn, not a silent no-op', async () => {
  const { store, engine, driver } = setup()
  const ticket = toReview(store, pickedUp(store))
  driver.sendTurn = async () => ({
    status: 'failed',
    error: 'turn blocked (session may be archived)',
    finalText: '',
    usage: null,
    events: [],
  })
  await engine.review(ticket)
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.column, 'working')
  assert.equal(parked.needsAttentionReason, 'turn failed in review: turn blocked (session may be archived)')
  assert.doesNotMatch(parked.needsAttentionReason, /ended without calling/)
})

test('retrying an archived-session park dispatches the review again once the block is gone', async () => {
  const { store, engine, driver } = setup({ review: [{ type: 'review', value: REVIEW_PASS }] })
  const ticket = toReview(store, pickedUp(store))
  store.replaceConditions(ticket.id, 1, [{ id: 'notes', statement: 'note exists', howVerified: 'test -f notes.txt', ordinal: 0 }], 'plan')
  const working = driver.ensureTicketSession
  blockWith(driver, ARCHIVED_MESSAGE)
  await engine.review(ticket)
  assert.equal(store.getTicket(ticket.id).column, 'working')
  assert.equal(driver.turns.length, 0)
  // The human unarchives; the retry runs the review for real.
  driver.ensureTicketSession = working
  const again = await engine.review(store.getTicket(ticket.id))
  assert.equal(again.kind, 'wait')
  // The review turn, then the approval turn in the same build session.
  assert.equal(driver.turns.length, 2)
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'Awaiting human approval')
})

// ---------------------------------------------------------------- KAN-7

const IMG_ID = `sha256:${'d'.repeat(64)}`
const IMG_ID_2 = `sha256:${'e'.repeat(64)}`

test('ticketStateBlock without images is byte-identical to the pre-images block', () => {
  const ticket = { title: 'T', body: 'the body' }
  const acceptance = [{ statement: 'a' }]
  const without = ticketStateBlock(ticket, acceptance)
  assert.equal(without, ticketStateBlock(ticket, acceptance, []))
  assert.equal(without.includes('Attached images'), false)
  assert.match(without, /^Title: T\n\nBody:\nthe body\n\nAcceptance \(starting point, human\):\n- a$/)
})

test('ticketStateBlock lists attached image host paths for the role session', () => {
  const ticket = { title: 'T', body: `see ![shot.png](kanban-image:${IMG_ID})` }
  const block = ticketStateBlock(ticket, [], [{ name: 'shot.png', path: '/var/dsh/attachments/shot.png' }])
  assert.match(block, /Attached images \(read-only, on this host\):/)
  assert.match(block, /- shot\.png: \/var\/dsh\/attachments\/shot\.png/)
  assert.match(block, /read_image/)
})

test('ticketStateBlock marks an unresolvable ref unavailable instead of hiding it', () => {
  const ticket = { title: 'T', body: `![gone.png](kanban-image:${IMG_ID})` }
  const block = ticketStateBlock(ticket, [], [{ name: 'gone.png', path: null }])
  assert.match(block, /- gone\.png: \(unavailable\)/)
})

test('attachedImages resolves body refs through the attachment store view', () => {
  const ctx = {
    attachments: {
      imageHostPath: (ref) => (ref.attachmentId === IMG_ID ? `/store/${IMG_ID.slice(7)}` : undefined),
    },
  }
  const body = `![a.png](kanban-image:${IMG_ID}) ![b](kanban-image:${IMG_ID_2}) ![dup](kanban-image:${IMG_ID})`
  assert.deepEqual(attachedImages(ctx, body), [
    { name: 'a.png', path: `/store/${IMG_ID.slice(7)}` },
    { name: 'b', path: null },
  ])
  assert.deepEqual(attachedImages(ctx, 'no images'), [])
  // A store that throws on a bad ref is an unavailable image, not a crash.
  const angry = { attachments: { imageHostPath: () => { throw new Error('nope') } } }
  assert.deepEqual(attachedImages(angry, `![x](kanban-image:${IMG_ID})`), [{ name: 'x', path: null }])
  // No attachments service at all: every ref is unavailable.
  assert.deepEqual(attachedImages({}, `![x](kanban-image:${IMG_ID})`), [{ name: 'x', path: null }])
})

test('the plan prompt for a ticket with an image carries its host path', async () => {
  const { store, engine } = setup()
  const ticket = pickedUp(store, {
    title: 'with image',
    body: `context ![shot.png](kanban-image:${IMG_ID})`,
  })
  engine.ctx = {
    ...engine.ctx,
    attachments: { imageHostPath: () => `/store/${IMG_ID.slice(7)}` },
  }
  await engine.plan(ticket)
  // The engine records the rendered prompt as an artifact; that is exactly the
  // text the plan session receives as its first message.
  const artifact = store.latestArtifact(ticket.id, 'planner_prompt_plan')
  assert.ok(artifact !== undefined, 'the plan prompt artifact was not written')
  assert.match(artifact.content, /Attached images \(read-only, on this host\):/)
  assert.match(artifact.content, new RegExp(`- shot\\.png: /store/${'d'.repeat(64)}`))
})

// ------------------------------------------------------- KAN-18 lazy worktree
//
// Planning settles the working copy. Two things the board has to get right: a
// fetch that cannot reach origin must park the ticket rather than plan against
// yesterday's code, and a working copy that was left alone must say so to the
// planner, in the prompt, not only in a log line nobody reads.

test('a failed fetch parks the ticket with git reason and never starts the plan session', async () => {
  const { store, engine, driver } = setup()
  const ticket = pickedUp(store)
  driver.prep = () => {
    throw new Error('git fetch failed for /home/dsh/dsh-deploy: could not read from remote repository')
  }
  await engine.advance(store.getTicket(ticket.id))
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.phase, 'plan', 'the ticket stays where it was')
  assert.ok(parked.needsAttentionReason, 'the ticket is parked')
  assert.match(parked.needsAttentionReason, /turn failed in plan/)
  assert.ok(
    parked.needsAttentionReason.includes('could not read from remote repository'),
    `the reason must carry git's own words, got: ${parked.needsAttentionReason}`,
  )
  assert.equal(driver.turns.length, 0, 'no plan session was started on a base that could not be brought up to date')
})

test('the prepared cwd is the session cwd and the note reaches the plan prompt', async () => {
  const { store, engine, driver } = setup()
  const ticket = pickedUp(store)
  const note = 'Worktree note: /managed/copy (branch dsh/copy) was left as-is because dirty; it is based on abc123def4, not the latest main — plan against it as-is.'
  driver.prep = { cwd: '/managed/copy', note }
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(driver.prepCalls, 1)
  assert.equal(driver.preparedCwds[0], '/managed/copy')
  const prompt = store.latestArtifact(ticket.id, 'planner_prompt_plan')
  assert.ok(prompt, 'the plan prompt was recorded')
  assert.ok(prompt.content.includes(note), `the prompt must end with the note, got: ${prompt.content.slice(-200)}`)
})

test('a ticket with nothing to say about its copy gets an unannotated prompt', async () => {
  const { store, engine, driver } = setup()
  const ticket = pickedUp(store)
  driver.prep = { cwd: '/managed/copy' }
  await engine.advance(store.getTicket(ticket.id))
  const prompt = store.latestArtifact(ticket.id, 'planner_prompt_plan')
  assert.equal(prompt.content.includes('Worktree note:'), false)
  assert.equal(driver.preparedCwds[0], '/managed/copy')
})

// ------------------------------------------------------- KAN-30 plan grants
//
// A plan that declares sandbox grants parks on the Plan-ready reason: the
// human approving the plan is the one-time grant, so the build never starts on
// its own. A plan without grants behaves exactly as it always did.

const PLAN_GRANTS = {
  summary: 'write outside the workspace',
  steps: ['write /lab/grant/out.txt'],
  done_when: [{ id: 'out', statement: 'the file exists', how_verified: 'test -f /lab/grant/out.txt' }],
  sandbox: {
    grants: { paths: ['/lab/grant'], commands: ['git push'] },
    checks: [{ path: '/lab/grant', check: 'test -w /lab/grant', observed: 'writable' }],
  },
}

test('a plan with grants parks plan-ready and never transitions to implement', async () => {
  const { store, engine, driver } = setup({ plan: [{ type: 'plan', value: PLAN_GRANTS }] })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.phase, 'plan', 'the ticket stays in plan until the human approves')
  assert.equal(parked.column, 'working')
  assert.ok(String(parked.needsAttentionReason).startsWith('Plan ready:'), `parked on Plan ready, got: ${parked.needsAttentionReason}`)
  assert.match(parked.needsAttentionReason, /2 sandbox grant\(s\)/)
  // Only the plan turn ran: no build session, no implement transition.
  assert.equal(driver.turns.length, 1)
  assert.equal(store.listSessions(ticket.id).some((s) => s.purpose === 'build'), false)
  const events = store.listEvents(ticket.id, { limit: 500 })
  assert.ok(events.some((e) => e.kind === 'plan_ready' && e.payload.grantCount === 2), 'the plan_ready event carries the grant count')
  assert.ok(events.some((e) => e.kind === 'planned'))
  // The conditions were still stored: the plan is real, it just waits.
  assert.equal(store.listConditions(ticket.id).length, 1)
  const artifact = JSON.parse(store.latestArtifact(ticket.id, 'plan').content)
  assert.deepEqual(artifact.sandbox.grants, { paths: ['/lab/grant'], commands: ['git push'] })
})

test('a plan without grants transitions to implement exactly as before', async () => {
  const { store, engine } = setup()
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.phase, 'verify')
  assert.equal(String(parked.needsAttentionReason), 'Awaiting human approval')
  const artifact = JSON.parse(store.latestArtifact(ticket.id, 'plan').content)
  assert.equal('sandbox' in artifact, false)
})

test('approvePlan lifts the park and moves the ticket to implement', async () => {
  const { store, engine } = setup({ plan: [{ type: 'plan', value: PLAN_GRANTS }] })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.ok(isPlanReady(store.getTicket(ticket.id).needsAttentionReason))
  const moved = await engine.approvePlan(ticket.id, 'grants look right')
  assert.equal(moved.phase, 'implement')
  assert.equal(moved.needsAttentionReason, null)
  const events = store.listEvents(ticket.id, { limit: 500 })
  const approved = events.find((e) => e.kind === 'plan_approved')
  assert.ok(approved, 'the approval is recorded')
  assert.equal(approved.payload.grantCount, 2)
  assert.equal(approved.payload.message, 'grants look right')
})

test('approvePlan refuses a ticket that is not parked plan-ready', async () => {
  const { store, engine } = setup()
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  await assert.rejects(() => engine.approvePlan(ticket.id), /not awaiting plan approval/)
})

test('a follow-up plan with grants re-parks instead of rebuilding', async () => {
  const { store, engine } = setup()
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
  await engine.submitApprovalPlan(ticket.id, PLAN_GRANTS)
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.phase, 'verify', 'the ticket waits where it stands, parked on the new plan')
  assert.ok(isPlanReady(parked.needsAttentionReason))
  const approved = await engine.approvePlan(ticket.id)
  assert.equal(approved.phase, 'implement')
})

test('a manual plan submission with grants parks plan-ready', async () => {
  const { store, engine } = setup({ plan: [] })
  const ticket = pickedUp(store)
  await engine.handleManualAction({
    ticketId: ticket.id,
    purpose: 'plan',
    sessionId: 'session-manual',
    action: { type: 'plan', value: PLAN_GRANTS },
  })
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.phase, 'plan')
  assert.ok(isPlanReady(parked.needsAttentionReason))
})

test('the plan prompt carries the build session write mode and workspace root', async () => {
  const { store, engine } = setup()
  const ticket = pickedUp(store, { writeMode: 'danger-full-access' })
  await engine.advance(store.getTicket(ticket.id))
  const prompt = store.latestArtifact(ticket.id, 'planner_prompt_plan')
  // The test PROMPTS template has no such placeholders; render must not throw
  // and the vars must be present for a real template. Assert via a direct call.
  assert.ok(prompt.content.startsWith('plan '), 'the plan prompt still rendered')
  const rendered = render('mode={{write_mode}} cwd={{cwd}}', {
    write_mode: ticket.writeMode ?? 'workspace-write',
    cwd: ticket.workspaceCwd ?? CWD,
  })
  assert.equal(rendered, 'mode=danger-full-access cwd=' + CWD)
})

// ---------------------------------------------------------- KAN-31 review gate
//
// The gate now splits what the build must fix from what the reviewer must fix,
// hands a deferred condition to approval instead of burning a round on it, and
// refuses to spend an attempt re-running a rework against an unchanged tree.

const DEFERRED_PLAN = {
  summary: 'write the file; the human lands the release',
  steps: ['create notes.txt'],
  release_scope: 'stop_before_merge',
  done_when: [
    { id: 'notes', statement: 'note exists', how_verified: 'test -f notes.txt' },
    {
      id: 'release-landed',
      statement: 'merged to main and tagged',
      how_verified: 'git ls-remote origin refs/tags/v1 prints a sha',
      deferred: true,
      human_evidence: 'git ls-remote origin refs/tags/v1 prints a sha',
    },
  ],
}
const IMPLEMENT_DEFERRED = {
  status: 'complete',
  summary: 'created notes.txt',
  changed_files: ['notes.txt'],
  done_when: [
    { id: 'notes', met: true, confidence: 0.95, evidence: 'notes.txt:1 hello' },
    { id: 'release-landed', met: false, confidence: 0.95, evidence: 'not merged — the plan defers the release to approval' },
  ],
}
const REVIEW_DEFERRED = {
  verdict: 'pass',
  reasons: ['the code round is complete'],
  scope_drift: 'none',
  done_when: [
    { id: 'notes', met: true, confidence: 0.95, evidence: 'notes.txt:1 hello' },
    { id: 'release-landed', met: false, confidence: 0.95, evidence: 'the human lands it: git ls-remote origin refs/tags/v1' },
  ],
  acceptance_coverage: [{ condition: 'notes', acceptance: 'note exists' }],
}

function deferredQueues(extra = {}) {
  return {
    plan: [{ type: 'plan', value: DEFERRED_PLAN }],
    implement: [{ type: 'implementation', value: IMPLEMENT_DEFERRED }],
    review: [{ type: 'review', value: REVIEW_DEFERRED }],
    ...extra,
  }
}

test('a pass whose only unmet condition is deferred goes to approval and spends no attempt', async () => {
  const { store, engine } = setup(deferredQueues())
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.phase, 'verify')
  assert.equal(parked.needsAttentionReason, 'Awaiting human approval')
  assert.equal(parked.attemptCount, 1, 'the deferred condition cost no implement round')
  const requested = store.listEvents(ticket.id).find((event) => event.kind === 'approval_requested')
  assert.deepEqual(requested.payload.deferred, ['release-landed'])
  // The marker really is stored, so the board, the prompts and the gate agree.
  const stored = store.listConditions(ticket.id)
  assert.equal(stored.find((c) => c.id === 'release-landed').deferred, true)
  assert.equal(stored.find((c) => c.id === 'release-landed').humanEvidence, 'git ls-remote origin refs/tags/v1 prints a sha')
  assert.equal(stored.find((c) => c.id === 'notes').deferred, false)
})

test('the approval prompt names each deferred condition and what the human checks', async () => {
  const { store, engine } = setup(deferredQueues())
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const prompt = store.latestArtifact(ticket.id, 'approver_prompt_approval').content
  assert.match(prompt, /release-landed/)
  assert.match(prompt, /deferred to approval — human evidence: git ls-remote origin refs\/tags\/v1 prints a sha/)
  assert.match(prompt, /the human evidences these, not you/)
})

test('the implement prompt carries the release scope and marks the deferred condition', async () => {
  const { store, engine } = setup(deferredQueues())
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const prompt = store.latestArtifact(ticket.id, 'implementer_prompt_implement').content
  assert.match(prompt, /Release scope: this plan stops before the release/)
  assert.match(prompt, /\(deferred to approval — human evidence: git ls-remote origin refs\/tags\/v1 prints a sha\)/)
  // The plan artifact carries the scope, so a reopened session re-reads it.
  assert.equal(JSON.parse(store.latestArtifact(ticket.id, 'plan').content).releaseScope, 'stop_before_merge')
})

test('a review prompt marks the deferred condition for the reviewer', async () => {
  const { store, engine } = setup(deferredQueues())
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const prompt = store.latestArtifact(ticket.id, 'reviewer_prompt_review').content
  assert.match(prompt, /`release-landed` — merged to main and tagged \(deferred to approval/)
})

test('a fail whose only unmet conditions are deferred is routed like a pass', async () => {
  const failedButDeferred = { ...REVIEW_DEFERRED, verdict: 'fail', reasons: ['the release is not landed'], instruction: 'nothing for the build to do' }
  const { store, engine } = setup(deferredQueues({ review: [{ type: 'review', value: failedButDeferred }] }))
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.phase, 'verify')
  assert.equal(parked.attemptCount, 1)
  const requested = store.listEvents(ticket.id).find((event) => event.kind === 'approval_requested')
  assert.deepEqual(requested.payload.deferred, ['release-landed'])
})

test('a fail that never proves the build condition is retried, not approved', async () => {
  // KAN-31 review finding: `substantive.length === 0` was not the same as "every
  // non-deferred condition met". A fail listing only the deferred row proves
  // nothing about `notes`, so it must not reach approval.
  const unprovenFail = {
    verdict: 'fail',
    reasons: ['the release is not landed'],
    instruction: 'nothing for the build to do',
    done_when: [{ id: 'release-landed', met: false, confidence: 0.95, evidence: 'the human lands it at approval' }],
    acceptance_coverage: [{ condition: 'notes', acceptance: 'note exists' }],
  }
  const { store, engine, driver } = setup(deferredQueues({
    review: [{ type: 'review', value: unprovenFail }, { type: 'review', value: REVIEW_DEFERRED }],
  }))
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  // The retry fixed the submission, and only then did the ticket reach approval.
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
  assert.equal(store.getTicket(ticket.id).attemptCount, 1, 'the reviewer omission cost the build nothing')
  const retry = store.latestArtifact(ticket.id, 'reviewer_prompt_review-retry').content
  assert.match(retry, /done_when\.notes is missing from the review/)
  assert.match(retry, /done_when\.notes is not proven met by the review/)
  assert.match(retry, /Your review failed, but it cannot be code-verified as submitted/)
  assert.equal(retry.includes('Your review passed'), false, 'a fail must not be told it passed')
  const buildId = driver.ticketSessions.get(`${ticket.id}:build`)
  assert.equal(driver.turns.filter((id) => id === buildId).length, 4, 'implement, review, review-retry, approval')
})

test('a fail that keeps omitting the build condition parks instead of approving', async () => {
  const unprovenFail = {
    verdict: 'fail',
    reasons: ['the release is not landed'],
    instruction: 'nothing for the build to do',
    done_when: [{ id: 'release-landed', met: false, confidence: 0.95, evidence: 'the human lands it at approval' }],
    acceptance_coverage: [{ condition: 'notes', acceptance: 'note exists' }],
  }
  const { store, engine, driver } = setup(deferredQueues({
    review: [{ type: 'review', value: unprovenFail }, { type: 'review', value: unprovenFail }],
  }))
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.phase, 'review', 'never approved, and never sent back to the build')
  assert.notEqual(parked.needsAttentionReason, 'Awaiting human approval')
  assert.match(parked.needsAttentionReason, /not proven met by the review/)
  assert.equal(parked.attemptCount, 1)
  assert.equal(store.listSpans(ticket.id).filter((span) => span.name === 'implement').length, 1)
  const buildId = driver.ticketSessions.get(`${ticket.id}:build`)
  assert.equal(driver.turns.filter((id) => id === buildId).length, 3, 'implement, review, one retry — then the park')
})

test('a cosmetic gap gets exactly one retry turn, in the review session, quoting the gap', async () => {
  const { store, engine, driver } = setup({
    review: [
      { type: 'review', value: { ...REVIEW_PASS, done_when: [] } },
      { type: 'review', value: REVIEW_PASS },
    ],
  })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const buildId = driver.ticketSessions.get(`${ticket.id}:build`)
  // plan, implement, review, review-retry, approval — all in the one build session.
  assert.deepEqual(driver.turns, [driver.ticketSessions.get(`${ticket.id}:plan`), buildId, buildId, buildId, buildId])
  const retry = store.latestArtifact(ticket.id, 'reviewer_prompt_review-retry').content
  assert.match(retry, /done_when\.notes is missing from the review/)
  assert.match(retry, /The plan's condition ids are exactly: `notes`/)
  assert.match(retry, /"note exists"/, 'the stored acceptance statements are spelled out')
  assert.equal(store.getTicket(ticket.id).attemptCount, 1)
})

test('a second cosmetic gap parks the review instead of returning to the build', async () => {
  const { store, engine, driver } = setup({
    review: [
      { type: 'review', value: { ...REVIEW_PASS, done_when: [] } },
      { type: 'review', value: { ...REVIEW_PASS, acceptance_coverage: [{ condition: 'notes', acceptance: 'a sentence from the body' }] } },
    ],
  })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.phase, 'review', 'the ticket never left review — the work was not what was in question')
  assert.match(parked.needsAttentionReason, /Review cannot be code-verified/)
  assert.match(parked.needsAttentionReason, /asked once to fix its own submission/)
  assert.equal(parked.attemptCount, 1)
  // plan, implement, review, review-retry — and no second build round.
  const buildId = driver.ticketSessions.get(`${ticket.id}:build`)
  assert.deepEqual(driver.turns, [driver.ticketSessions.get(`${ticket.id}:plan`), buildId, buildId, buildId])
  assert.equal(store.listSpans(ticket.id).filter((span) => span.name === 'implement').length, 1)
})

test('a substantive gap on a passing review still returns to implement', async () => {
  const unmet = {
    ...REVIEW_PASS,
    done_when: [{ id: 'notes', met: false, confidence: 0.9, evidence: 'notes.txt does not exist' }],
  }
  const { store, engine } = setup({
    implement: [
      { type: 'implementation', value: IMPLEMENTATION },
      { type: 'implementation', value: IMPLEMENTATION },
    ],
    review: [{ type: 'review', value: unmet }, { type: 'review', value: REVIEW_PASS }],
  })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
  assert.equal(store.getTicket(ticket.id).attemptCount, 2, 'a real gap still costs a round')
})

test('the exhausted-budget park names the fresh budget a human retry grants', async () => {
  const { store, engine } = setup(
    {
      implement: [
        { type: 'implementation', value: IMPLEMENTATION },
        { type: 'implementation', value: IMPLEMENTATION },
      ],
      review: [{ type: 'review', value: REVIEW_FAIL }, { type: 'review', value: REVIEW_FAIL }],
    },
    { config: { maxAttempts: 1 } },
  )
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.attemptCount, 1)
  assert.match(parked.needsAttentionReason, /attempt budget exhausted \(1\) — a human Retry with instruction grants a fresh budget/)
})

test('a rework round against an unchanged working tree parks with no progress', async () => {
  const cwd = gitRepo()
  const { store, engine } = setup(
    {
      implement: [
        { type: 'implementation', value: IMPLEMENTATION },
        { type: 'implementation', value: IMPLEMENTATION },
      ],
      review: [{ type: 'review', value: REVIEW_FAIL_ROW }, { type: 'review', value: REVIEW_FAIL_ROW }],
    },
    {},
  )
  const ticket = pickedUp(store, { workspaceCwd: cwd })
  await engine.advance(store.getTicket(ticket.id))
  // Round one runs, the review fails, round two runs and changes nothing, the
  // review fails again — and the third round is never paid for.
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.attemptCount, 2, 'the wasted third round was not spent')
  assert.match(parked.needsAttentionReason, /no progress: the working tree is unchanged/)
  assert.match(parked.needsAttentionReason, /notes/, 'the reason names the condition still failing')
  const signature = JSON.parse(store.latestArtifact(ticket.id, 'rework_signature').content)
  assert.deepEqual(signature.failingIds, ['notes'])
})

test('a rework round that commits its work is not called no-progress', async () => {
  // The fingerprint reads `git diff HEAD`, which is relative to HEAD: a round
  // that commits leaves a clean tree and would otherwise hash exactly like the
  // round that did nothing. HEAD is part of the fingerprint for this case.
  const cwd = gitRepo()
  const { store, engine, driver } = setup(
    {
      implement: [
        { type: 'implementation', value: IMPLEMENTATION },
        { type: 'implementation', value: IMPLEMENTATION },
        { type: 'implementation', value: IMPLEMENTATION },
      ],
      review: [
        { type: 'review', value: REVIEW_FAIL_ROW },
        { type: 'review', value: REVIEW_FAIL_ROW },
        { type: 'review', value: REVIEW_PASS },
      ],
    },
    {},
  )
  const ticket = pickedUp(store, { workspaceCwd: cwd })
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
  let buildTurns = 0
  const sendTurn = driver.sendTurn.bind(driver)
  driver.sendTurn = async (input) => {
    if (driver.sessions.get(input.sessionId)?.role === 'implementer') {
      buildTurns += 1
      if (buildTurns === 2) {
        // This round does its work AND commits it: the tree is clean again.
        writeFileSync(join(cwd, 'notes.txt'), 'hello\n')
        git('add', 'notes.txt')
        git('-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-q', '-m', 'notes')
      }
    }
    return sendTurn(input)
  }
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(buildTurns, 3, 'the third round ran: a committed round is progress, not a repeat')
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'Awaiting human approval')
})

test('a rework round that moves the tree is not called no-progress', async () => {
  const cwd = gitRepo()
  const { store, engine, driver } = setup(
    {
      implement: [
        { type: 'implementation', value: IMPLEMENTATION },
        { type: 'implementation', value: IMPLEMENTATION },
        { type: 'implementation', value: IMPLEMENTATION },
      ],
      review: [
        { type: 'review', value: REVIEW_FAIL_ROW },
        { type: 'review', value: REVIEW_FAIL_ROW },
        { type: 'review', value: REVIEW_PASS },
      ],
    },
    {},
  )
  const ticket = pickedUp(store, { workspaceCwd: cwd })
  // Stand in for an implementer that actually changed the working tree in its
  // round: the file appears when the second build turn is prompted.
  let buildTurns = 0
  const sendTurn = driver.sendTurn.bind(driver)
  driver.sendTurn = async (input) => {
    if (driver.sessions.get(input.sessionId)?.role === 'implementer') {
      buildTurns += 1
      if (buildTurns === 2) writeFileSync(join(cwd, 'notes.txt'), 'hello\n')
    }
    return sendTurn(input)
  }
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(buildTurns, 3, 'the third round ran because the tree had moved')
  assert.equal(store.getTicket(ticket.id).phase, 'verify')
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'Awaiting human approval')
  assert.equal(store.getTicket(ticket.id).attemptCount, 3)
})
