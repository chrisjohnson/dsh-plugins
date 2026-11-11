// A human pause for the orchestrator: while it is on, nothing flows between the
// engine and the orchestrator session. Digests are dropped (no backlog is kept),
// every tool call is refused, the stored switch survives a reopen, and resuming
// restores both directions with one fresh snapshot.
//
// The store and the tool guard run on a bare clone. The KanbanOrchestrator
// class imports the dsh peers, so those tests skip when they are not installed.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { migrate, openDatabase } from '../src/db.mjs'
import { ORCHESTRATOR_PAUSED_MESSAGE, runOrchestratorTool } from '../src/orchestrator.mjs'
import { createBoardSnapshots, compactBoard } from '../src/board-snapshot.mjs'
import { KanbanStore } from '../src/store.mjs'

let KanbanOrchestrator
try {
  await import('@deepseek-ai/dsh-llm')
  await import('@deepseek-ai/dsh-tools')
  await import('@deepseek-ai/dsh-sandbox-policy')
  KanbanOrchestrator = (await import('../src/orchestrator-host.mjs')).KanbanOrchestrator
} catch {
  KanbanOrchestrator = undefined
}
const skip = KanbanOrchestrator === undefined ? 'dsh peer packages are not installed' : false

const LOG = { info() {}, warn() {}, error() {}, debug() {} }

function memoryStore() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return new KanbanStore(db)
}

// ------------------------------------------------------------------ storage --

test('the pause defaults to off and round-trips through the store', () => {
  const store = memoryStore()
  assert.equal(store.isOrchestratorPaused(), false)
  assert.equal(store.setOrchestratorPaused(true), true)
  assert.equal(store.isOrchestratorPaused(), true)
  assert.equal(store.setOrchestratorPaused(false), false)
  assert.equal(store.isOrchestratorPaused(), false)
})

test('the pause survives closing and reopening the database file', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'kanban-pause-')), 'kanban.db')
  const first = new KanbanStore(openDatabase(path))
  first.setOrchestratorPaused(true)
  first.close()
  const second = new KanbanStore(openDatabase(path))
  assert.equal(second.isOrchestratorPaused(), true)
  second.setOrchestratorPaused(false)
  second.close()
  const third = new KanbanStore(openDatabase(path))
  assert.equal(third.isOrchestratorPaused(), false)
  third.close()
})

test('flipping the pause moves the store change token and the board payload', () => {
  const store = memoryStore()
  const driver = { isTicketBusy: () => false, isAwaitingQuestion: () => false, isAwaitingApproval: () => false, liveTicketSession: () => null, activeSessionIds: () => [] }
  const engine = { active: new Set() }
  const snapshots = createBoardSnapshots({ store, driver, engine, orchestratorPaused: () => store.isOrchestratorPaused() })
  const before = snapshots.build()
  assert.equal(before.board.orchestratorPaused, false)
  store.setOrchestratorPaused(true)
  const after = snapshots.build()
  assert.notEqual(after.token, before.token, 'the change token moves, so the push stream sends it')
  assert.notEqual(after.signature, before.signature, 'the content differs, so a frame is sent')
  assert.equal(after.board.orchestratorPaused, true)
  assert.equal(compactBoard(after.board).orchestratorPaused, true, 'the compact board the page reads carries it')
})

// -------------------------------------------------------------------- tools --

test('a paused orchestrator is refused every tool, before any guard or write', async () => {
  let touched = false
  const api = {
    paused: () => true,
    resolveTicket: () => { touched = true; return null },
    board: () => { touched = true; return {} },
    move: () => { touched = true; return {} },
  }
  for (const name of ['kanban_board', 'kanban_move', 'kanban_ticket']) {
    await assert.rejects(() => runOrchestratorTool(name, { ticket: 'KAN-1', to: 'working' }, api), { message: ORCHESTRATOR_PAUSED_MESSAGE })
  }
  assert.equal(touched, false)
  assert.match(ORCHESTRATOR_PAUSED_MESSAGE, /paused by a human; do not change the board/)
})

test('an orchestrator that is not paused still runs its tools', async () => {
  const api = { paused: () => false, board: () => ({ counts: {}, tickets: [] }) }
  const result = await runOrchestratorTool('kanban_board', {}, api)
  assert.ok(result)
})

// ------------------------------------------------------------------- digest --

function liveOrchestrator() {
  const store = memoryStore()
  const sent = []
  const cancelled = []
  const agent = {
    status: 'idle',
    followup: (message) => sent.push(message),
    cancel: (cause) => cancelled.push(cause),
  }
  const ctx = {
    get: (name) => (name === 'agents' ? { get: () => agent } : undefined),
    on: () => () => {},
  }
  const orchestrator = new KanbanOrchestrator({
    ctx,
    store,
    engine: { active: new Set() },
    driver: undefined,
    getConfig: () => ({ orchestratorEnabled: true, orchestratorSessionId: 'kanban-orchestrator' }),
    getPrompts: () => ({ bodies: {} }),
    log: LOG,
  })
  orchestrator.phase = 'live'
  const ticket = store.createTicket({ title: 'demo', body: '', column: 'backlog' })
  const event = { kind: 'needs_attention', ticketId: ticket.id, actor: 'engine', payload: { reason: 'stuck' } }
  return { orchestrator, store, sent, event, cancelled, agent }
}

// KAN-73 round 4: a pause means stop, not "keep burning the turn you are in".
test('pausing cancels the running turn and clears its queued digests', { skip }, () => {
  const { orchestrator, cancelled } = liveOrchestrator()
  assert.equal(cancelled.length, 0, 'nothing is cancelled before the pause')
  orchestrator.setPaused(true)
  assert.equal(cancelled.length, 1, 'the pause stops the live session')
  assert.equal(cancelled[0].kind, 'user', 'attributed to the human who pressed pause')
  // Resuming does not cancel anything of its own, and a second pause on an
  // already-paused orchestrator is a no-op rather than a second cancellation.
  orchestrator.setPaused(false)
  orchestrator.setPaused(false)
  assert.equal(cancelled.length, 1, 'resume changes nothing about the turn')
  orchestrator.setPaused(true)
  orchestrator.setPaused(true)
  assert.equal(cancelled.length, 2, 'only a real transition cancels')
})

test('a session without a cancel verb still pauses cleanly', { skip }, () => {
  const { orchestrator, agent } = liveOrchestrator()
  delete agent.cancel
  const answer = orchestrator.setPaused(true)
  assert.equal(answer.paused, true, 'the board traffic stop is not lost with the turn stop')
})

test('while paused, board events are dropped and nothing is delivered or kept', { skip }, async () => {
  const { orchestrator, sent, event } = liveOrchestrator()
  orchestrator.setPaused(true)
  orchestrator.ingest(event)
  await orchestrator.window.flush()
  assert.equal(sent.length, 0, 'nothing reaches the session')
  orchestrator.setPaused(false)
  // Resume sends one snapshot, and the dropped event is not replayed after it.
  const afterResume = sent.length
  await orchestrator.window.flush()
  assert.equal(sent.length, afterResume, 'no backlog of dropped events')
})

test('resume restores the feed and sends a single fresh snapshot', { skip }, async () => {
  const { orchestrator, sent, event } = liveOrchestrator()
  orchestrator.setPaused(true)
  assert.equal(orchestrator.state().paused, true)
  orchestrator.setPaused(false)
  assert.equal(orchestrator.state().paused, false)
  assert.equal(sent.length, 1, 'one snapshot on resume')
  orchestrator.ingest(event)
  await orchestrator.window.flush()
  assert.equal(sent.length, 2, 'events flow again')
})

test('pausing twice or resuming twice is harmless and sends nothing extra', { skip }, () => {
  const { orchestrator, sent } = liveOrchestrator()
  orchestrator.setPaused(true)
  orchestrator.setPaused(true)
  orchestrator.setPaused(false)
  orchestrator.setPaused(false)
  assert.equal(sent.length, 1)
})

test('a paused orchestrator reports paused in its state and keeps its session', { skip }, () => {
  const { orchestrator } = liveOrchestrator()
  const answer = orchestrator.setPaused(true)
  assert.equal(answer.paused, true)
  assert.equal(answer.state, 'live', 'the session is not torn down')
})
