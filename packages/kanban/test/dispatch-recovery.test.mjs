// The driver and the engine together, against a stubbed dsh context:
//
//   - reopening a ticket's earlier session (live, already loaded by dsh, resumed
//     through the session controller, or not recoverable at all);
//   - a turn paused on a permission prompt is never called stalled, and the
//     ticket is plain working again the moment the prompt is answered, in the
//     build, review and approval phases and for a parked ticket a person drives;
//   - a question the person must answer reads as attention on the card.
//
// Needs the dsh peer packages (dispatch.mjs imports them); on a bare clone the
// suites skip, same as the other driver suites.

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
import { attentionFacts } from '../src/attention.mjs'
import { normalizePlan } from '../src/result.mjs'
import { IMPLEMENTATION, PLAN, PROMPTS, REVIEW_PASS } from './support/engine-harness.mjs'

let Driver
try {
  await import('@deepseek-ai/dsh-llm')
  await import('@deepseek-ai/dsh-tools')
  await import('@deepseek-ai/dsh-sandbox-policy')
  Driver = (await import('../src/dispatch.mjs')).SessionDriver
} catch {
  Driver = undefined
}
const skip = Driver === undefined ? 'dsh peer packages are not installed' : false

const CWD = mkdtempSync(join(tmpdir(), 'kanban-dispatch-recovery-'))
const ROUTE = { provider: 'local', model: 'm', reasoningEffort: null }
const LOG = { info() {}, warn() {}, error() {}, debug() {} }

function makeConfig(extra = {}) {
  return resolveConfig({
    roles: {
      planner: { provider: 'local', model: 'm' },
      implementer: { provider: 'local', model: 'm' },
      reviewer: { provider: 'local', model: 'm' },
      approver: { provider: 'local', model: 'm' },
    },
    providers: [{ name: 'local' }],
    confidenceThreshold: 0.7,
    stallTimeoutMs: 1000,
    defaultWorkspaceCwd: CWD,
    ...extra,
  }).config
}

/**
 * A stub dsh context. `loaded` agents answer `agents.get`; `resumable` ids are
 * brought to life by `sessionController.resolveAgent`, the way dsh reopens a persisted
 * session. Every `session/event` listener the driver registers is kept so a test
 * can emit the events a real session would.
 */
function world({ loaded = [], resumable = [], resumeError = null, archived = [], noResume = false } = {}) {
  const listeners = []
  const agentsById = new Map()
  const resumed = []
  const makeAgent = (sessionId) => {
    const session = {
      id: sessionId,
      header: { id: sessionId },
      events: [],
      append() {},
      snapshotEvents: () => session.events,
    }
    const agent = {
      id: sessionId,
      status: 'idle',
      session,
      prompts: [],
      ctx: {
        on: () => () => {},
        tools: { register: () => () => {}, guard: () => {} },
      },
      followup: (message) => {
        agent.prompts.push(message)
        agent.onFollowup?.(message)
      },
      cancel() {},
    }
    agentsById.set(sessionId, agent)
    return agent
  }
  for (const id of loaded) makeAgent(id)
  const agents = {
    get: (id) => agentsById.get(id),
    create: async (spec) => {
      const agent = makeAgent(spec.sessionId)
      if (typeof spec.setup === 'function') await spec.setup(agent.ctx)
      return { agent, dispose: async () => {} }
    },
  }
  const sessionController = noResume
    ? { selectForNextRequest() {} }
    : {
      selectForNextRequest() {},
      // The real service's public resolver: a live or resumed agent, or a
      // stable error value (a thrown failure is also possible).
      async resolveAgent(sessionId) {
        resumed.push(sessionId)
        if (agentsById.has(sessionId)) return { agent: agentsById.get(sessionId) }
        if (resumeError !== null) throw new Error(resumeError)
        if (!resumable.includes(sessionId)) return { error: new Error(`session "${sessionId}" not found`) }
        return { agent: makeAgent(sessionId) }
      },
    }
  const ctx = {
    get(name) {
      if (name === 'agents') return agents
      if (name === 'agentPresets') return { defaultId: 'standard', async mount() { return { id: 'standard' } } }
      if (name === 'sessionController') return sessionController
      if (name === 'workspaceRegistry') {
        return { get archivedSessionIds() { return archived.slice() }, list: () => [{ path: CWD, attachSession: async () => {} }] }
      }
      return undefined
    },
    on(name, fn) {
      if (name === 'session/event') listeners.push(fn)
      return () => {}
    },
  }
  return { ctx, agentsById, makeAgent, resumed, listeners, archived }
}

function boot(options = {}, configExtra = {}) {
  const w = world(options)
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const config = makeConfig(configExtra)
  const driver = new Driver({ ctx: w.ctx, log: LOG, getConfig: () => config, store })
  driver.start()
  const ticket = store.createTicket({ title: 'demo', acceptance: ['note exists'], workspaceCwd: CWD, planTiming: 'at_pickup', planQuestions: 'autonomous', column: 'working' })
  const emit = (sessionId, event) => {
    const agent = w.agentsById.get(sessionId)
    agent?.session.events.push(event)
    for (const fn of w.listeners) fn(agent?.session ?? { id: sessionId, snapshotEvents: () => [] }, event)
  }
  return { ...w, store, driver, ticket, config, emit }
}

// --------------------------------------------------------- reopening a session

test('reactivateSession returns a live session untouched', { skip }, async () => {
  const { driver, ticket } = boot()
  const created = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  const result = await driver.reactivateSession(ticket.id, 'build')
  assert.deepEqual(result, { ok: true, sessionId: created.sessionId, via: 'live' })
})

test('reactivateSession re-wires a stored session dsh already holds, and reopens its store row', { skip }, async () => {
  const { driver, store, ticket, resumed } = boot({ loaded: ['session-old'] })
  store.attachSession({ ticketId: ticket.id, dshSessionId: 'session-old', role: 'build', purpose: 'build', preset: 'standard', provider: 'local', model: 'm' })
  store.markSessionClosed('session-old')
  assert.equal(store.listSessions(ticket.id)[0].closedAt === null, false)
  const result = await driver.reactivateSession(ticket.id, 'build')
  assert.deepEqual(result, { ok: true, sessionId: 'session-old', via: 'resumed' })
  assert.equal(driver.isLive('session-old'), true)
  assert.equal(driver.liveTicketSession(ticket.id, 'build'), 'session-old')
  assert.equal(store.listSessions(ticket.id)[0].closedAt, null, 'the session is open again in the store')
  assert.deepEqual(resumed, ['session-old'], 'the resolver was asked, and answered with the loaded agent')
})

test('reactivateSession resumes a persisted session through the session controller\'s resolver', { skip }, async () => {
  const { driver, store, ticket, resumed } = boot({ resumable: ['session-old'] })
  store.attachSession({ ticketId: ticket.id, dshSessionId: 'session-old', role: 'build', purpose: 'build' })
  store.markSessionClosed('session-old')
  const result = await driver.reactivateSession(ticket.id, 'build')
  assert.equal(result.ok, true)
  assert.equal(result.via, 'resumed')
  assert.deepEqual(resumed, ['session-old'])
  assert.equal(driver.isLive('session-old'), true, 'the action tools are wired back in')
})

test('reactivateSession says why a session could not be brought back', { skip }, async () => {
  const gone = boot({ resumable: [] })
  gone.store.attachSession({ ticketId: gone.ticket.id, dshSessionId: 'session-old', role: 'build', purpose: 'build' })
  const notFound = await gone.driver.reactivateSession(gone.ticket.id, 'build')
  assert.equal(notFound.ok, false)
  assert.match(notFound.reason, /not found/)
  assert.equal(gone.driver.isLive('session-old'), false)

  const broken = boot({ resumeError: 'disk unreadable' })
  broken.store.attachSession({ ticketId: broken.ticket.id, dshSessionId: 'session-old', role: 'build', purpose: 'build' })
  assert.match((await broken.driver.reactivateSession(broken.ticket.id, 'build')).reason, /disk unreadable/)

  const noController = boot({ noResume: true })
  noController.store.attachSession({ ticketId: noController.ticket.id, dshSessionId: 'session-old', role: 'build', purpose: 'build' })
  assert.match((await noController.driver.reactivateSession(noController.ticket.id, 'build')).reason, /cannot reopen/)

  const never = boot()
  const none = await never.driver.reactivateSession(never.ticket.id, 'build')
  assert.equal(none.ok, false)
  assert.equal(none.none, true, 'a ticket that never had one is told apart from one that lost it')
})

test('reactivateSession never reopens an archived session, and tries the next newest', { skip }, async () => {
  const { driver, store, ticket, archived } = boot({ resumable: ['session-a', 'session-b'] })
  store.attachSession({ ticketId: ticket.id, dshSessionId: 'session-a', role: 'build', purpose: 'build' })
  store.attachSession({ ticketId: ticket.id, dshSessionId: 'session-b', role: 'build', purpose: 'build' })
  archived.push('session-b')
  const result = await driver.reactivateSession(ticket.id, 'build')
  assert.equal(result.sessionId, 'session-a')
  assert.equal(driver.isLive('session-b'), false)
})

test('reactivateSession keeps the purposes apart', { skip }, async () => {
  const { driver, store, ticket } = boot({ resumable: ['session-plan'] })
  store.attachSession({ ticketId: ticket.id, dshSessionId: 'session-plan', role: 'plan', purpose: 'plan' })
  assert.equal((await driver.reactivateSession(ticket.id, 'build')).none, true)
  assert.equal((await driver.reactivateSession(ticket.id, 'plan')).ok, true)
})

// ------------------------------------------- a prompt is not a stall

test('a turn paused on a permission prompt is not stalled; the clock restarts when it is answered', { skip }, async () => {
  const { driver, ticket, emit } = boot()
  const created = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  const sessionId = created.sessionId
  const pending = driver.sendTurn({ sessionId, prompt: 'go', stallTimeoutMs: 1000 })
  let settled = null
  pending.then((value) => { settled = value })
  emit(sessionId, { type: 'turn/start', data: { turn: 1 } })
  emit(sessionId, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', reason: 'escalate sandbox' } })
  const waiter = driver.waiters.get(sessionId)
  waiter.lastEventAt = Date.now() - 60_000
  driver.reconcileTurns()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, null, 'a person deciding for a minute is not a stalled turn')
  assert.equal(driver.waiters.has(sessionId), true)
  // The answer arrives: the event itself restarts the clock.
  emit(sessionId, { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } })
  driver.reconcileTurns()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, null, 'the turn carries on after the answer')
  // With nothing pending, genuine silence still stalls.
  driver.waiters.get(sessionId).lastEventAt = Date.now() - 60_000
  driver.reconcileTurns()
  assert.equal((await pending).status, 'stalled')
})

test('a turn paused on a question is likewise not stalled', { skip }, async () => {
  const { driver, ticket, emit } = boot()
  const { sessionId } = await driver.ensureTicketSession({ ticket, role: 'planner', route: ROUTE, purpose: 'plan' })
  const pending = driver.sendTurn({ sessionId, prompt: 'plan', stallTimeoutMs: 1000 })
  let settled = null
  pending.then((value) => { settled = value })
  emit(sessionId, { type: 'turn/start', data: { turn: 1 } })
  emit(sessionId, { type: 'tool/call', data: { name: 'ask_user_question', callId: 'q1' } })
  driver.waiters.get(sessionId).lastEventAt = Date.now() - 60_000
  driver.reconcileTurns()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, null)
  emit(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'end' } } })
  assert.equal((await pending).status, 'ok')
})

// ------------------------------- needs attention clears when the prompt is answered

/** An engine over the real driver, with the ticket moved to `phase`. */
function drivenTicket(phase, { parked = null } = {}) {
  const made = boot({}, { maxAttempts: 3 })
  const { store, driver, ticket, config } = made
  const engine = new Engine({ ctx: made.ctx, store, driver, getConfig: () => config, getPrompts: () => PROMPTS, log: LOG })
  engine.recovered = true
  const plan = normalizePlan(PLAN)
  store.replaceConditions(ticket.id, 1, plan.conditions, 'plan')
  store.addArtifact(ticket.id, 'plan', JSON.stringify({ ...plan, planVersion: 1 }))
  for (const step of ['implement', 'review', 'verify'].slice(0, ['implement', 'review', 'verify'].indexOf(phase) + 1)) {
    store.transitionTicket(ticket.id, { phase: step }, { actor: 'engine', reason: 'seed' })
  }
  store.setAttempt(ticket.id, 1, 0)
  if (parked !== null) store.setNeedsAttention(ticket.id, parked)
  return { ...made, engine }
}

const facts = (made) => attentionFacts(made.store.getTicket(made.ticket.id), { engine: made.engine, driver: made.driver })

for (const [phase, role] of [['implement', 'implementer'], ['review', 'reviewer'], ['verify', 'approver']]) {
  test(`${phase}: a ticket waiting on a permission prompt is plain working once it is answered`, { skip }, async () => {
    const made = drivenTicket(phase)
    const { driver, ticket, emit, store } = made
    const { sessionId } = await driver.ensureTicketSession({ ticket, role, route: ROUTE, purpose: 'build' })
    driver.setPhase(sessionId, role)
    emit(sessionId, { type: 'turn/start', data: { turn: 1 } })
    assert.equal(facts(made).status, 'active', 'running: blue')
    emit(sessionId, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', reason: 'escalate sandbox' } })
    const waiting = facts(made)
    assert.equal(waiting.status, 'attention', 'the prompt is a wait on a person')
    assert.equal(waiting.awaitingApproval, true)
    assert.equal(waiting.reason, 'Awaiting your approval')
    assert.equal(store.getTicket(ticket.id).needsAttentionReason ?? null, null, 'it is derived, not stored: nothing to clear later')
    emit(sessionId, { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } })
    const answered = facts(made)
    assert.equal(answered.status, 'active', 'answered: back to plain working')
    assert.equal(answered.awaitingApproval, false)
    assert.equal(answered.reason, null)
    emit(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'end' } } })
    assert.equal(facts(made).status, 'idle')
    assert.equal(store.getTicket(ticket.id).needsAttentionReason ?? null, null)
  })
}

test('a parked ticket a person drives through a permission prompt turns blue, not red, once it is answered', { skip }, async () => {
  const made = drivenTicket('implement', { parked: 'attempt budget exhausted (3)' })
  const { driver, ticket, emit, store } = made
  const { sessionId } = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  assert.equal(facts(made).status, 'attention', 'parked: red')
  emit(sessionId, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(store.getTicket(ticket.id).needsAttentionReason ?? null, null, 'the person\'s turn lifts the park in place')
  assert.equal(facts(made).status, 'active')
  emit(sessionId, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } })
  assert.equal(facts(made).status, 'attention')
  emit(sessionId, { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } })
  const answered = facts(made)
  assert.equal(answered.status, 'active', 'the prompt was answered: plain working')
  assert.equal(answered.reason, null)
  // The turn submits through the workflow tool: the outcome belongs to that
  // submission and the park is not restored under it.
  driver.recordAction(sessionId, { type: 'implementation', value: IMPLEMENTATION })
  emit(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'end' } } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.getTicket(ticket.id).needsAttentionReason ?? null, null)
  assert.equal(facts(made).status, 'idle')
})

test('a parked ticket whose driven turn ends without submitting goes back to its park, by design', { skip }, async () => {
  const made = drivenTicket('implement', { parked: 'attempt budget exhausted (3)' })
  const { driver, ticket, emit, store } = made
  const { sessionId } = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  emit(sessionId, { type: 'turn/start', data: { turn: 1 } })
  emit(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'end' } } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'attempt budget exhausted (3)')
  assert.equal(facts(made).status, 'attention')
})

test('a question wait clears the same way: attention while asked, plain working once answered', { skip }, async () => {
  const made = drivenTicket('implement')
  const { driver, ticket, emit } = made
  const { sessionId } = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  emit(sessionId, { type: 'turn/start', data: { turn: 1 } })
  emit(sessionId, { type: 'tool/call', data: { name: 'ask_user_question', callId: 'q1' } })
  const asking = facts(made)
  assert.equal(asking.status, 'attention')
  assert.equal(asking.awaitingQuestion, true)
  assert.equal(asking.reason, 'Waiting on your answer')
  emit(sessionId, { type: 'tool/result', data: { callId: 'q1', message: { toolCallId: 'q1' } } })
  assert.equal(facts(made).status, 'active')
})

test('a ticket parked because its session ended on a question reads as waiting on the answer', { skip }, async () => {
  const made = drivenTicket('implement', { parked: 'Waiting on your answer in the build session: Which test runner does this repo use?' })
  const state = facts(made)
  assert.equal(state.status, 'attention')
  assert.equal(state.parkedOnQuestion, true)
  assert.equal(state.awaitingQuestion, false, 'no turn is paused; the park carries the question')
  assert.equal(state.reason, 'Waiting on your answer in the build session: Which test runner does this repo use?')
})

// --------------------------- the whole loop: engine turns through a scripted session

/**
 * A scripted agent: each turn the engine prompts runs a permission prompt, waits
 * for the test to answer it, then submits what its role submits and ends the turn.
 * `samples` records what the card said at each beat.
 */
async function scriptedTurns(role, submit) {
  const made = drivenTicket(role === 'implementer' ? 'implement' : role === 'reviewer' ? 'review' : 'verify')
  const { driver, ticket, emit } = made
  const samples = []
  const { sessionId } = await driver.ensureTicketSession({ ticket, role, route: ROUTE, purpose: 'build' })
  const agent = made.agentsById.get(sessionId)
  let turn = 0
  agent.onFollowup = () => {
    turn += 1
    const n = turn
    setTimeout(() => {
      emit(sessionId, { type: 'turn/start', data: { turn: n } })
      emit(sessionId, { type: 'approval/asked', data: { id: `a${n}`, toolName: 'bash' } })
      samples.push(['asked', facts(made).status])
      setTimeout(() => {
        emit(sessionId, { type: 'approval/decided', data: { id: `a${n}`, outcome: 'allowed-once' } })
        samples.push(['answered', facts(made).status, made.store.getTicket(ticket.id).needsAttentionReason ?? null])
        if (submit !== undefined) driver.submitAction(sessionId, submit, { concludeTurn() {} })
        emit(sessionId, { type: 'turn/end', data: { turn: n, reason: { kind: 'end' } } })
      }, 15)
    }, 5)
  }
  return { ...made, samples }
}

test('build: an engine-driven turn that hits a permission prompt shows attention, then plain working, then moves on', { skip }, async () => {
  const made = await scriptedTurns('implementer', { type: 'implementation', value: IMPLEMENTATION })
  made.store.replaceConditions(made.ticket.id, 1, normalizePlan(PLAN).conditions, 'plan')
  const result = await made.engine.implement(made.store.getTicket(made.ticket.id))
  assert.equal(result.kind, 'continue')
  assert.deepEqual(made.samples, [['asked', 'attention'], ['answered', 'active', null]])
  const after = made.store.getTicket(made.ticket.id)
  assert.equal(after.phase, 'review')
  assert.equal(after.needsAttentionReason ?? null, null, 'nothing was parked')
})

test('review: the same, and a passing review moves the ticket to the approval hand-over', { skip }, async () => {
  const made = await scriptedTurns('reviewer', { type: 'review', value: REVIEW_PASS })
  // Once the review passes the engine prompts the same session as the approver;
  // that turn is scripted too (it submits nothing: the human decides).
  const result = await made.engine.review(made.store.getTicket(made.ticket.id))
  assert.equal(result.kind, 'wait')
  assert.deepEqual(made.samples.slice(0, 2), [['asked', 'attention'], ['answered', 'active', null]])
  assert.deepEqual(made.samples.slice(2, 4), [['asked', 'attention'], ['answered', 'active', null]], 'the approval turn too')
  const after = made.store.getTicket(made.ticket.id)
  assert.equal(after.phase, 'verify')
  assert.equal(after.needsAttentionReason, 'Awaiting human approval', 'the only park is the one that waits for the human\'s decision')
})

test('approval: a permission prompt during the hand-over clears, and only the decision park remains', { skip }, async () => {
  const made = await scriptedTurns('approver', undefined)
  made.store.addArtifact(made.ticket.id, 'review', JSON.stringify(REVIEW_PASS))
  const result = await made.engine.approvalTurn(
    made.store.getTicket(made.ticket.id),
    { provider: 'local', model: 'm', reasoningEffort: null },
    'hand over',
  )
  assert.equal(result.kind, 'wait')
  assert.deepEqual(made.samples, [['asked', 'attention'], ['answered', 'active', null]])
  assert.equal(made.store.getTicket(made.ticket.id).needsAttentionReason, 'Awaiting human approval')
})
