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
  acceptance_coverage: [{ condition: 'notes', acceptance: 'note exists' }],
}
const REVIEW_FAIL = {
  verdict: 'fail',
  reasons: ['the file is missing'],
  instruction: 'create notes.txt',
  scope_drift: 'none',
  acceptance_coverage: [],
}
const VERIFY_PASS = {
  summary: 'checked',
  done_when: [{ id: 'notes', met: true, confidence: 0.95, evidence: 'test -f notes.txt: exit 0' }],
  residual_risks: [],
}
const PROMPTS = {
  bodies: {
    'plan-human': 'plan {{ticket_state}}',
    'plan-self': 'plan self {{ticket_state}}',
    implement: 'implement {{plan}} {{done_when}}',
    rework: 'rework {{review}}',
    review: 'review {{diff}}',
    verify: 'verify {{done_when}}',
  },
  hashes: { plan: 'h' },
}

function setup(queues = {}) {
  const { config } = resolveConfig({
    autoPromote: false,
    roles: {
      planner: { provider: 'local', model: 'm', allowTools: ['read'] },
      implementer: { provider: 'local', model: 'm', allowTools: ['read', 'write', 'edit'] },
      reviewer: { provider: 'local', model: 'm', allowTools: ['read'] },
      verifier: { provider: 'local', model: 'm', allowTools: ['read'] },
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
    queues: {
      planner: [...(queues.plan ?? [{ type: 'plan', value: PLAN }])],
      implementer: [...(queues.implement ?? [{ type: 'implementation', value: IMPLEMENTATION }])],
      reviewer: [...(queues.review ?? [{ type: 'review', value: REVIEW_PASS }])],
      verifier: [...(queues.verify ?? [{ type: 'verification', value: VERIFY_PASS }])],
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
      const session = this.sessions.get(sessionId)
      const next = this.queues[session.role]?.shift()
      return { status: 'ok', action: next ?? null, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
    },
    async closeSession() {},
    async closeTicketSessions() {},
    liveTicketSession(ticketId, purpose) { return this.ticketSessions.get(`${ticketId}:${purpose}`) },
    isLive(id) { return this.sessions.has(id) },
    start() {},
    stop() {},
    reconcileTurns() {},
  }
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  const engine = new Engine({ ctx: { get: () => undefined }, store, driver, getConfig: () => config, getPrompts: () => PROMPTS, log })
  return { store, driver, engine, config }
}

function pickedUp(store, extra = {}) {
  const ticket = store.createTicket({ title: 'demo', acceptance: ['note exists'], workspaceCwd: CWD, planTiming: 'at_pickup', planQuestions: 'autonomous', ...extra })
  store.transitionTicket(ticket.id, { column: 'now' }, { actor: 'human' })
  return store.getTicket(ticket.id)
}

test('flat plan -> implement -> review -> verify -> done', async () => {
  const { store, engine } = setup()
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  const done = store.getTicket(ticket.id)
  assert.equal(done.column, 'done')
  assert.equal(done.phase, 'closed')
  assert.equal(store.listConditions(ticket.id).length, 1)
  assert.ok(store.listSessions(ticket.id).some((s) => s.purpose === 'plan'))
  assert.ok(store.listSessions(ticket.id).some((s) => s.purpose === 'build'))
  assert.ok(store.listSessions(ticket.id).some((s) => s.purpose === 'verify'))
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
  assert.equal(store.getTicket(ticket.id).column, 'done')
  assert.equal(store.getTicket(ticket.id).attemptCount, 2)
  assert.equal([...driver.ticketSessions.keys()].filter((key) => key.includes(':build')).length, 1)
})

test('verify failure returns to a fresh build session', async () => {
  const { store, engine, driver } = setup({
    implement: [
      { type: 'implementation', value: IMPLEMENTATION },
      { type: 'implementation', value: IMPLEMENTATION },
    ],
    review: [
      { type: 'review', value: REVIEW_PASS },
      { type: 'review', value: REVIEW_PASS },
    ],
    verify: [
      { type: 'verification', value: { ...VERIFY_PASS, done_when: [{ id: 'notes', met: false, confidence: 0.2, evidence: 'missing' }] } },
      { type: 'verification', value: VERIFY_PASS },
    ],
  })
  const ticket = pickedUp(store)
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).column, 'done')
  assert.ok([...driver.ticketSessions.keys()].filter((key) => key.includes(':build')).length >= 1)
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
