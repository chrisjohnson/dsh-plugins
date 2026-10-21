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

const PLAN = JSON.stringify({
  summary: 'implement it',
  steps: ['write code', 'run tests'],
  done_when: [
    { id: 'compiles', statement: 'project compiles', how_verified: 'npm run build' },
    { id: 'tests', statement: 'tests pass', how_verified: 'npm test' },
  ],
})

const PASS_CLAIM = JSON.stringify({
  status: 'complete',
  summary: 'done',
  changed_files: ['src/a.mjs'],
  done_when: [
    { id: 'compiles', met: true, confidence: 0.95, evidence: 'npm run build exited 0' },
    { id: 'tests', met: true, confidence: 0.92, evidence: 'tests/run.test.mjs:12 12 passed' },
  ],
  questions: [],
  residual_risks: [],
})

const VERIFY_PASS = JSON.stringify({
  summary: 'checked both',
  done_when: [
    { id: 'compiles', met: true, confidence: 0.95, evidence: 'npm run build exited 0' },
    { id: 'tests', met: true, confidence: 0.95, evidence: 'npm test: 12 passed' },
  ],
  residual_risks: [],
})

const REVIEW_PASS = JSON.stringify({
  verdict: 'pass',
  reasons: [],
  scope_drift: 'none',
  acceptance_coverage: [{ condition: 'compiles', acceptance: 'it builds' }],
})

const prompts = {
  bodies: {
    orchestrator: 'judge',
    griller: 'grill {{key}} {{acceptance}} {{phase}}',
    planner: 'plan {{key}} {{acceptance}} {{body}}',
    implementer: 'implement {{key}} {{done_when}}',
    verifier: 'verify {{done_when}}',
    reviewer: 'review {{plan}} {{verification}} {{diff}}',
  },
  hashes: { orchestrator: 'h', griller: 'h', planner: 'h', implementer: 'h', verifier: 'h', reviewer: 'h' },
}

function setup({ implementer = [], verifier = [], reviewer = [], planner = [PLAN], griller = [], judge = {}, config = {} } = {}) {
  const baseRoles = {
    orchestrator: { provider: 'local', model: 'm' },
    griller: { provider: 'local', model: 'm' },
    planner: { provider: 'local', model: 'm' },
    implementer: { provider: 'local', model: 'm' },
    verifier: { provider: 'local', model: 'm' },
    reviewer: { provider: 'local', model: 'm' },
  }
  const { config: resolved } = resolveConfig({
    autoPromote: false,
    ...config,
    roles: { ...baseRoles, ...(config.roles ?? {}) },
    providers: config.providers ?? [{ name: 'local' }],
  })
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const driver = {
    sessions: new Map(),
    counter: 0,
    queues: { planner: planner.slice(), implementer: implementer.slice(), verifier: verifier.slice(), reviewer: reviewer.slice(), griller: griller.slice() },
    started: false,
    start() { this.started = true },
    stop() { this.started = false },
    isLive(id) { return this.sessions.has(id) },
    async createRoleSession({ role }) {
      const id = `session-${++this.counter}-${role}`
      this.sessions.set(id, { role })
      return { sessionId: id, preset: 'preset', handle: {} }
    },
    async sendTurn({ sessionId }) {
      const s = this.sessions.get(sessionId)
      const next = this.queues[s.role].shift()
      if (typeof next === 'function') return next()
      return { status: 'ok', finalText: next, usage: { inputTokens: 10, outputTokens: 5 }, reason: { kind: 'completed' }, error: null, events: [] }
    },
    async closeSession(id) { this.sessions.delete(id) },
    reconcileTurns() {},
  }
  const defaultJudge = {
    grillDecision: { grill: false },
    coverage: { covers: true },
    triage: { checkable: true, done_when: [{ id: 't1', statement: 's', how_verified: 'v' }] },
    adjudication: { verdict: 'not_done', done_when: [], instruction: 'fix it' },
    answer: { answer: 'use the plan', confidence: 0.9, escalate: false },
    ...judge,
  }
  const judgeCalls = []
  const fakeJudge = {
    async judgeJson({ task }) {
      judgeCalls.push(task)
      const value = defaultJudge[task]
      if (value === undefined) throw new Error(`no judge script for ${task}`)
      return { ok: true, value, text: JSON.stringify(value), usage: { inputTokens: 5, outputTokens: 5 }, route: { provider: 'local', model: 'm', rung: 0 }, attempts: 1 }
    },
  }
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  const engine = new Engine({ ctx: { get: () => undefined }, store, driver, judge: fakeJudge, getConfig: () => resolved, getPrompts: () => prompts, log })
  return { store, driver, engine, config: resolved, judgeCalls }
}

function pickedUp(store, extra = {}) {
  const ticket = store.createTicket({ title: 'demo ticket', acceptance: ['it builds and tests pass'], workspaceCwd: CWD, ...extra })
  store.transitionTicket(ticket.id, { column: 'now', phase: 'triage' }, { actor: 'human' })
  return store.getTicket(ticket.id)
}

test('happy path: plan -> implement -> verify -> review -> done', async () => {
  const { store, engine, driver } = setup({ implementer: [PASS_CLAIM], verifier: [VERIFY_PASS], reviewer: [REVIEW_PASS] })
  const ticket = pickedUp(store)
  await engine.advance(ticket)
  const done = store.getTicket(ticket.id)
  assert.equal(done.column, 'done')
  assert.equal(done.phase, 'closed')
  const spans = store.listSpans(ticket.id)
  const roles = spans.map((s) => s.role)
  assert.ok(roles.includes('planner'))
  assert.ok(roles.includes('implementer'))
  assert.ok(roles.includes('verifier'))
  assert.ok(roles.includes('reviewer'))
  // Independence: verifier and implementer never share a session.
  const sessions = store.listSessions(ticket.id)
  const impl = sessions.find((s) => s.role === 'implementer')
  const ver = sessions.find((s) => s.role === 'verifier')
  assert.ok(impl && ver && impl.sessionId !== ver.sessionId)
  assert.equal(driver.sessions.size, 0)
})

test('unmet claim -> adjudication -> second attempt -> done', async () => {
  const unmet = JSON.stringify({
    status: 'partial',
    summary: 'half',
    changed_files: ['src/a.mjs'],
    done_when: [
      { id: 'compiles', met: true, confidence: 0.95, evidence: 'npm run build exited 0' },
      { id: 'tests', met: false, confidence: 0.2, evidence: 'tests fail' },
    ],
    questions: [],
    residual_risks: [],
  })
  const { store, engine } = setup({
    implementer: [unmet, PASS_CLAIM],
    verifier: [VERIFY_PASS],
    reviewer: [REVIEW_PASS],
    judge: { adjudication: { verdict: 'not_done', done_when: [], instruction: 'make tests pass' } },
  })
  const ticket = pickedUp(store)
  await engine.advance(ticket)
  const done = store.getTicket(ticket.id)
  assert.equal(done.column, 'done')
  assert.equal(done.attemptCount, 2)
  assert.ok(store.listEvents(ticket.id).some((e) => e.kind === 'retry_scheduled'))
})

test('no JSON -> one continuation -> done', async () => {
  const { store, engine } = setup({ implementer: ['I think it is done.', PASS_CLAIM], verifier: [VERIFY_PASS], reviewer: [REVIEW_PASS] })
  const ticket = pickedUp(store)
  await engine.advance(ticket)
  assert.equal(store.getTicket(ticket.id).column, 'done')
  assert.ok(store.listSpans(ticket.id).some((s) => s.name === 'implement-continuation-1'))
})

test('blocked implementer -> needs_attention with a reason', async () => {
  const blocked = JSON.stringify({ status: 'blocked', summary: 'no access', changed_files: [], done_when: [], questions: [], residual_risks: [] })
  const { store, engine } = setup({ implementer: [blocked] })
  const ticket = pickedUp(store)
  await engine.advance(ticket)
  const t = store.getTicket(ticket.id)
  assert.equal(t.column, 'needs_attention')
  assert.match(t.needsAttentionReason, /blocked/)
})

test('questions -> orchestrator answer -> same attempt continues', async () => {
  const asking = JSON.stringify({ status: 'partial', summary: 'need info', changed_files: [], done_when: [], questions: ['which database?'], residual_risks: [] })
  const { store, engine, judgeCalls } = setup({ implementer: [asking, PASS_CLAIM], verifier: [VERIFY_PASS], reviewer: [REVIEW_PASS] })
  const ticket = pickedUp(store)
  await engine.advance(ticket)
  assert.equal(store.getTicket(ticket.id).column, 'done')
  assert.ok(judgeCalls.includes('answer'))
  assert.ok(store.latestArtifact(ticket.id, 'auto_answers'))
})

test('verifier failure exhausts attempts and produces a packet', async () => {
  const verifyFail = JSON.stringify({
    summary: 'not proven',
    done_when: [
      { id: 'compiles', met: true, confidence: 0.95, evidence: 'npm run build exited 0' },
      { id: 'tests', met: false, confidence: 0.1, evidence: 'npm test failed' },
    ],
    residual_risks: [],
  })
  const { store, engine } = setup({ implementer: [PASS_CLAIM], verifier: [verifyFail], reviewer: [REVIEW_PASS], config: { maxAttempts: 1 } })
  const ticket = pickedUp(store)
  await engine.advance(ticket)
  const t = store.getTicket(ticket.id)
  assert.equal(t.column, 'needs_attention')
  assert.match(t.needsAttentionReason, /attempt 1\/1 exhausted/)
  assert.ok(store.latestArtifact(ticket.id, 'attempt_feedback'))
})

test('paid route without allow_paid refuses instead of downgrading', async () => {
  const { store, engine } = setup({
    implementer: [PASS_CLAIM],
    config: {
      providers: [
        { name: 'local' },
        { name: 'paid', tier: 'paid', priceIn: 1, priceOut: 2 },
      ],
      roles: { implementer: { provider: 'paid', model: 'big' } },
    },
  })
  const ticket = pickedUp(store)
  await engine.advance(ticket)
  const t = store.getTicket(ticket.id)
  assert.equal(t.column, 'needs_attention')
  assert.match(t.needsAttentionReason, /allow_paid/)
})

test('restart recovery abandons running spans, releases leases and requeues work', async () => {
  const { store, engine } = setup({ implementer: [PASS_CLAIM], verifier: [VERIFY_PASS], reviewer: [REVIEW_PASS] })
  const ticket = pickedUp(store)
  store.transitionTicket(ticket.id, { phase: 'plan' })
  store.transitionTicket(ticket.id, { phase: 'implement' })
  const span = store.startSpan({ ticketId: ticket.id, kind: 'agent', name: 'implement', role: 'implementer' })
  await engine.recover()
  assert.equal(store.getSpan(span.id).status, 'abandoned')
  assert.equal(store.getTicket(ticket.id).phase, 'implement')
})

test('grill now waits for human answers, merges refined acceptance, then picks up', async () => {
  const questions = JSON.stringify({ questions: ['Which output format?'], answers: [], refined_acceptance: [] })
  const refined = JSON.stringify({ questions: [], answers: ['JSON'], refined_acceptance: ['prints JSON to stdout'] })
  const { store, engine } = setup({
    griller: [questions, refined],
    implementer: [PASS_CLAIM],
    verifier: [VERIFY_PASS],
    reviewer: [REVIEW_PASS],
  })
  const ticket = store.createTicket({
    title: 'grill demo',
    acceptance: ['make it useful'],
    grillMode: 'now',
    planMode: 'at_pickup',
    workspaceCwd: CWD,
  })
  await engine.advance(store.getTicket(ticket.id))
  let t = store.getTicket(ticket.id)
  assert.equal(t.phase, 'grill')
  assert.equal(t.column, 'backlog')
  assert.ok(store.listEvents(ticket.id).some((e) => e.kind === 'awaiting_human'))
  await engine.answerGrill(ticket.id, ['JSON'])
  t = store.getTicket(ticket.id)
  assert.equal(t.phase, 'plan')
  const acceptance = store.listAcceptance(ticket.id)
  assert.ok(acceptance.some((a) => a.source === 'grill' && a.statement === 'prints JSON to stdout'))
  // Pickup: the plan-at-pickup work is owed now.
  store.transitionTicket(ticket.id, { column: 'now' }, { actor: 'human' })
  await engine.advance(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).column, 'done')
})
