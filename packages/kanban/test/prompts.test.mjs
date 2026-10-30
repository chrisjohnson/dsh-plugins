// The real prompt files, rendered by the real engine.
//
// The phase prompts used to paste the whole plan, the acceptance list, the
// implementer's JSON and a git diff into every review turn. KAN-13 slimmed them
// to what a session cannot already see in its own transcript. These tests pin
// that shape: the review prompt must carry the plan's actual condition ids and
// the exact tool contract, and must not carry the dumps back.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { resolveConfig } from '../src/config.mjs'
import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import { Engine } from '../src/engine.mjs'
import { loadPrompts } from '../src/prompts.mjs'

const CWD = mkdtempSync(join(tmpdir(), 'kanban-prompts-'))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

const PLAN = {
  summary: 'write the file',
  steps: ['create notes.txt'],
  done_when: [
    { id: 'notes-exist', statement: 'notes.txt exists', how_verified: 'test -f notes.txt' },
    { id: 'says-hello', statement: 'the file says hello', how_verified: 'grep -q hello notes.txt' },
  ],
}
const IMPLEMENTATION = {
  status: 'complete',
  summary: 'created notes.txt',
  changed_files: ['notes.txt'],
  done_when: [
    { id: 'notes-exist', met: true, confidence: 0.95, evidence: 'notes.txt:1 hello' },
    { id: 'says-hello', met: true, confidence: 0.95, evidence: 'grep -q hello notes.txt exits 0' },
  ],
}
const REVIEW_PASS = {
  verdict: 'pass',
  reasons: ['matches plan'],
  scope_drift: 'none',
  done_when: [
    { id: 'notes-exist', met: true, confidence: 0.95, evidence: 'notes.txt:1 hello' },
    { id: 'says-hello', met: true, confidence: 0.95, evidence: 'grep -q hello notes.txt exits 0' },
  ],
  acceptance_coverage: [{ condition: 'notes-exist', acceptance: 'note exists' }],
}
const REVIEW_FAIL = {
  verdict: 'fail',
  reasons: ['the file is missing'],
  instruction: 'create notes.txt and write hello into it',
  scope_drift: 'none',
  acceptance_coverage: [],
}

async function setup(queues = {}) {
  const { config } = resolveConfig({
    roles: {
      planner: { provider: 'local', model: 'm' },
      implementer: { provider: 'local', model: 'm' },
      reviewer: { provider: 'local', model: 'm' },
      approver: { provider: 'local', model: 'm' },
    },
    providers: [{ name: 'local' }],
    confidenceThreshold: 0.7,
  })
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const prompts = await loadPrompts({}, PACKAGE_DIR)
  // session-1 is the plan session; session-2 is the build session that every
  // later phase — implement, review, approval — runs inside, in order.
  const script = {
    'session-1': [{ type: 'plan', value: PLAN }],
    'session-2': [{ type: 'implementation', value: IMPLEMENTATION }, { type: 'review', value: REVIEW_PASS }],
    ...queues,
  }
  const driver = {
    ticketSessions: new Map(),
    counter: 0,
    async ensureTicketSession({ ticket, purpose }) {
      const key = `${ticket.id}:${purpose}`
      let id = this.ticketSessions.get(key)
      if (id === undefined) {
        id = `session-${++this.counter}`
        this.ticketSessions.set(key, id)
      }
      return { sessionId: id }
    },
    setPhase() {},
    setRoute() {},
    async sendTurn({ sessionId }) {
      const queue = script[sessionId] ?? []
      return { status: 'ok', action: queue.shift() ?? null, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
    },
    async closeSession() {},
    async closeTicketSessions() {},
    liveTicketSession(ticketId, purpose) { return this.ticketSessions.get(`${ticketId}:${purpose}`) },
    isLive() { return true },
    isTicketBusy() { return false },
  }
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  const engine = new Engine({ ctx: { get: () => undefined }, store, driver, getConfig: () => config, getPrompts: () => prompts, log })
  const promptOf = (kind) => {
    const row = store.latestArtifact(store.listTickets()[0].id, kind)
    return row === undefined ? null : row.content
  }
  return { store, engine, driver, promptOf }
}

function working(store) {
  const ticket = store.createTicket({
    title: 'demo',
    body: 'make the note',
    acceptance: ['note exists'],
    workspaceCwd: CWD,
    planTiming: 'at_pickup',
    planQuestions: 'autonomous',
    column: 'working',
  })
  return store.getTicket(ticket.id)
}

test('the review prompt carries the plan ids and the tool contract, not the dumps', async () => {
  const { store, engine, promptOf } = await setup()
  const ticket = working(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  await engine.review(store.getTicket(ticket.id))

  const prompt = promptOf('reviewer_prompt_review')
  assert.ok(prompt, 'the rendered review prompt is recorded as an artifact')
  // Every condition id the reviewer must answer with, verbatim.
  assert.match(prompt, /`notes-exist`/)
  assert.match(prompt, /`says-hello`/)
  assert.match(prompt, /notes\.txt exists/)
  // Every key of kanban_submit_review, and what the engine checks.
  for (const key of ['verdict', 'reasons', 'scope_drift', 'done_when', 'acceptance_coverage', 'instruction']) {
    assert.match(prompt, new RegExp(`\`${key}\``), `review prompt must name the ${key} key`)
  }
  assert.match(prompt, /adversarial/i)
  assert.match(prompt, /same id/)
  // The dumps are gone: the session already holds all of it.
  for (const gone of ['## Plan', '## Diff', '## Implementation result', '## Acceptance', 'how_verified:']) {
    assert.equal(prompt.includes(gone), false, `review prompt still contains ${gone}`)
  }
})

test('the approval prompt is the one-line hand-over', async () => {
  const { store, engine, promptOf } = await setup({ 'session-2': [{ type: 'implementation', value: IMPLEMENTATION }, { type: 'review', value: REVIEW_PASS }] })
  const ticket = working(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  await engine.review(store.getTicket(ticket.id))

  const prompt = promptOf('approver_prompt_approval')
  assert.ok(prompt, 'the approval turn was prompted')
  assert.match(prompt, /^Without making any further changes, offer the user a selection of a few options for next steps that would enable you to wrap this work up\./)
  assert.match(prompt, /kanban_approve/)
  assert.match(prompt, /kanban_discard/)
  assert.match(prompt, /kanban_submit_plan/)
  assert.match(prompt, /only when, the human asks|only when, the human asks for one of them/)
  assert.equal(prompt.includes('{{'), false, 'the approval prompt still has an unresolved placeholder')
  assert.equal(prompt.includes('{'), false, 'the approval prompt still carries structured data')
})

test('the rework prompt is one job statement plus a short reminder at most', async () => {
  const { store, engine, promptOf } = await setup({ 'session-2': [{ type: 'implementation', value: IMPLEMENTATION }, { type: 'review', value: REVIEW_FAIL }] })
  const ticket = working(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  await engine.review(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))

  const prompt = promptOf('implementer_prompt_implement')
  assert.match(prompt, /Review requested changes to kanban ticket/)
  assert.match(prompt, /create notes\.txt and write hello into it/)
  assert.match(prompt, /kanban_submit_implementation/)
  for (const gone of ['## Plan', '## done_when', '## Acceptance', '## Review']) {
    assert.equal(prompt.includes(gone), false, `rework prompt still contains ${gone}`)
  }
})

test('a long review instruction is not repeated into the rework prompt', async () => {
  const long = { ...REVIEW_FAIL, instruction: `fix everything: ${'x'.repeat(400)}` }
  const { store, engine, promptOf } = await setup({ 'session-2': [{ type: 'implementation', value: IMPLEMENTATION }, { type: 'review', value: long }] })
  const ticket = working(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  await engine.review(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  const prompt = promptOf('implementer_prompt_implement')
  assert.equal(prompt.includes('fix everything'), false, 'the long instruction should stay in the transcript only')
  assert.match(prompt, /reviewer.s verdict and feedback are in this conversation above/)
})

test('the implement prompt is unchanged: the full plan and conditions', async () => {
  const { store, engine, promptOf } = await setup()
  const ticket = working(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  const prompt = promptOf('implementer_prompt_implement')
  assert.match(prompt, /Implement the plan for kanban ticket/)
  assert.match(prompt, /## Plan/)
  assert.match(prompt, /## done_when/)
  assert.match(prompt, /verify: test -f notes\.txt/)
})
