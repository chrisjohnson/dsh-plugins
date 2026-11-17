// The Host's RPC surface, driven through the routes it registers: the recovery
// actions (mark done, re-run review, revise plan), their refusals, what the
// detail payload offers the client, and how a question reads on the board.
//
// The host is booted against a stub dsh context with a real SQLite file; a
// second store connection to the same file sets up and inspects state. Needs the
// dsh peer packages (the host imports the driver); skips on a bare clone.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import { normalizePlan } from '../src/result.mjs'
import { IMPLEMENTATION, PLAN, REVIEW_PASS } from './support/engine-harness.mjs'

let kanban
try {
  await import('@deepseek-ai/dsh-llm')
  await import('@deepseek-ai/dsh-tools')
  await import('@deepseek-ai/dsh-sandbox-policy')
  kanban = (await import('../src/host.mjs')).default
} catch {
  kanban = undefined
}
const skip = kanban === undefined ? 'dsh peer packages are not installed' : false

const LOG = { info() {}, warn() {}, error() {}, debug() {} }

/**
 * A default workspace to file tickets into: a real one-commit git checkout, or a
 * plain directory. The New-ticket worktree switch now follows this fact and
 * nothing else, so the test has to own it.
 */
function workspace({ git = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-host-ws-'))
  if (!git) return dir
  const run = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'test')
  writeFileSync(join(dir, 'README.md'), 'seed\n')
  run('add', 'README.md')
  run('commit', '-q', '-m', 'seed')
  return dir
}

async function boot({ workspaceCwd = workspace(), live = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-host-rpc-'))
  const dbPath = join(dir, 'kanban.db')
  const routes = new Map()
  // KAN-98: a live boot runs the host's effects (so the engine and the driver
  // start, and the driver subscribes to the session event stream) and captures
  // those subscriptions, so a test can put a real mid-turn ask in front of the
  // read paths. A plain boot leaves both inert, which is what every other test
  // here wants: no tick, no launched session, nothing but the routes.
  const handlers = new Map()
  const cleanups = []
  const ctx = {
    logger: () => LOG,
    get(name) {
      if (name === 'llm') {
        return { listProviders: () => [{ id: 'local' }], listModels: async () => [], resolveModelInfo: async () => null }
      }
      return undefined
    },
    effect(fn) {
      if (!live) return
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    on(name, fn) {
      if (!live) return () => {}
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {
        const list = handlers.get(name) ?? []
        const at = list.indexOf(fn)
        if (at >= 0) list.splice(at, 1)
      }
    },
    inject(_deps, callback) {
      callback({ connection: { fetch: { register: (definition) => routes.set(definition.path, definition.fetch) } } })
    },
  }
  await kanban(ctx, {
    dbPath,
    defaultWorkspaceCwd: workspaceCwd,
    // The board's permanent orchestrator session is not what these tests are
    // about, and a live boot would otherwise have it trying to start one against
    // a stub host with no agents service.
    orchestratorEnabled: false,
    providers: [{ name: 'local' }],
    roles: {
      planner: { provider: 'local', model: 'm' },
      implementer: { provider: 'local', model: 'm' },
      reviewer: { provider: 'local', model: 'm' },
      approver: { provider: 'local', model: 'm' },
    },
  })
  /** Hand one session event to whatever is subscribed, exactly as the harness does. */
  const emit = (sessionId, event) => {
    for (const fn of [...(handlers.get('session/event') ?? [])]) fn({ id: sessionId }, event)
  }
  /** Undo the effects: stops the engine's tick and closes the host's store. */
  const close = () => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  }
  const rpc = async (endpoint, payload = {}) => {
    const route = routes.get(`/api/kanban/${endpoint}`)
    assert.ok(route, `no route for ${endpoint}`)
    const response = await route({ json: async () => payload })
    return response.json()
  }
  // The same file, a second connection: set up states the host reaches by itself
  // only after a model run, and read back what the host wrote.
  const store = new KanbanStore(openDatabase(dbPath))
  const create = async (fields = {}) => {
    const created = await rpc('create', { title: 'demo', body: '', column: 'working', ...fields })
    assert.equal(created.ok, true, JSON.stringify(created))
    return created.value.ticket.id
  }
  return { rpc, store, create, emit, close }
}

/** Put a ticket where the engine leaves it after planning: plan on record, phase implement. */
function planned(store, id, { phase = 'implement' } = {}) {
  const plan = normalizePlan(PLAN)
  store.replaceConditions(id, 1, plan.conditions, 'plan')
  store.addArtifact(id, 'plan', JSON.stringify({ ...plan, planVersion: 1 }))
  const path = ['implement', 'review', 'verify']
  for (const step of path.slice(0, path.indexOf(phase) + 1)) store.transitionTicket(id, { phase: step }, { actor: 'engine', reason: 'seed' })
}

const detail = async (rpc, id) => (await rpc('ticket', { id })).value

test('mark done closes a ticket on both endpoints and records that it was completed outside the engine', { skip }, async () => {
  const { rpc, store, create } = await boot()
  const viaAction = await create({ column: 'backlog' })
  const done = await rpc('action', { id: viaAction, action: 'markDone', reason: 'merged by hand' })
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(done.value.ticket.column, 'done')
  assert.equal(done.value.ticket.phase, 'closed')
  const event = store.listEvents(viaAction, { limit: 50 }).find((e) => e.kind === 'done')
  assert.equal(event.actor, 'human')
  assert.equal(event.payload.outsideEngine, true)
  assert.equal(event.payload.reason, 'merged by hand')
  const board = (await rpc('board')).value
  assert.deepEqual(board.columns.done.map((t) => t.id), [viaAction], 'it shows in the Done column')

  const viaResolve = await create()
  planned(store, viaResolve)
  store.setNeedsAttention(viaResolve, 'attempt budget exhausted (3)')
  const resolved = await rpc('resolve', { id: viaResolve, action: 'markDone', reason: 'shipped from my laptop' })
  assert.equal(resolved.ok, true, JSON.stringify(resolved))
  assert.equal(resolved.value.ticket.column, 'done')
  assert.equal(store.getTicket(viaResolve).needsAttentionReason ?? null, null)
})

test('mark done is available from every column and phase over RPC', { skip }, async () => {
  const { rpc, store, create } = await boot()
  for (const column of ['backlog', 'working']) {
    for (const phase of ['plan', 'implement', 'review', 'verify']) {
      const id = await create({ column })
      if (phase !== 'plan') planned(store, id, { phase })
      const shown = await detail(rpc, id)
      assert.equal(shown.actions.markDone, true, `${column}/${phase}: the detail offers it`)
      const done = await rpc('action', { id, action: 'markDone', reason: `closed from ${column}/${phase}` })
      assert.equal(done.ok, true, `${column}/${phase}: ${JSON.stringify(done)}`)
      assert.equal(store.getTicket(id).column, 'done')
    }
  }
})

test('mark done needs a reason, refuses a closed ticket, and dragging to Done is still refused', { skip }, async () => {
  const { rpc, store, create } = await boot()
  const id = await create()
  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 7 }]) {
    const refused = await rpc('action', { id, action: 'markDone', ...body })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'bad_request')
    assert.match(refused.error.message, /a reason is required/)
  }
  assert.equal(store.getTicket(id).column, 'working')
  await rpc('action', { id, action: 'markDone', reason: 'done' })
  const again = await rpc('action', { id, action: 'markDone', reason: 'done again' })
  assert.equal(again.ok, false)
  assert.match(again.error.message, /already done/)
  assert.equal((await detail(rpc, id)).actions.markDone, false, 'no button on a closed ticket')

  const other = await create()
  const dragged = await rpc('move', { id: other, column: 'done' })
  assert.equal(dragged.ok, false)
  assert.match(dragged.error.message, /done is set by human approval, not by dragging/)
  assert.equal(store.getTicket(other).column, 'working')
})

test('re-run review resumes a parked implement-phase ticket at review, over both endpoints', { skip }, async () => {
  const { rpc, store, create } = await boot()
  const viaResolve = await create({ column: 'backlog' })
  planned(store, viaResolve)
  store.setNeedsAttention(viaResolve, 'implementer ended without calling kanban_submit_implementation')
  assert.equal((await detail(rpc, viaResolve)).actions.rerunReview, true)
  const resumed = await rpc('resolve', { id: viaResolve, action: 'rerunReview' })
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.equal(resumed.value.ticket.phase, 'review')
  assert.equal(resumed.value.ticket.needsAttentionReason ?? null, null)
  assert.ok(store.listEvents(viaResolve, { limit: 50 }).some((e) => e.kind === 'review_rerun' && e.actor === 'human'))

  const viaAction = await create({ column: 'backlog' })
  planned(store, viaAction)
  store.setNeedsAttention(viaAction, 'budget')
  assert.equal((await rpc('action', { id: viaAction, action: 'rerunReview' })).value.ticket.phase, 'review')
})

test('re-run review is refused for a ticket that is not parked in implement or review', { skip }, async () => {
  const { rpc, store, create } = await boot()
  const unparked = await create({ column: 'backlog' })
  planned(store, unparked)
  const shown = await detail(rpc, unparked)
  assert.equal(shown.actions.rerunReview, false)
  const refused = await rpc('action', { id: unparked, action: 'rerunReview' })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /not parked/)

  const planning = await create({ column: 'backlog' })
  store.setNeedsAttention(planning, 'plan session ended without calling kanban_submit_plan')
  const wrongPhase = await rpc('resolve', { id: planning, action: 'rerunReview' })
  assert.equal(wrongPhase.ok, false)
  assert.match(wrongPhase.error.message, /not plan/)
})

test('revise plan is offered only before the build, needs an instruction, and a rejection shows on the ticket', { skip }, async () => {
  const { rpc, store, create } = await boot()
  const id = await create({ column: 'backlog' })
  assert.equal((await detail(rpc, id)).actions.revisePlan, false, 'no plan yet')
  planned(store, id)
  const before = await detail(rpc, id)
  assert.equal(before.actions.revisePlan, true)
  assert.equal(before.planRevision, null)

  const empty = await rpc('action', { id, action: 'revisePlan', instruction: '  ' })
  assert.equal(empty.ok, false)
  assert.match(empty.error.message, /an instruction is required/)

  // No agents service is mounted in this stub, so the plan session cannot run:
  // the resubmission never happens, and the ticket says so.
  const started = await rpc('action', { id, action: 'revisePlan', instruction: 'smaller scope' })
  assert.equal(started.ok, true, JSON.stringify(started))
  let shown
  for (let i = 0; i < 100; i += 1) {
    shown = await detail(rpc, id)
    if (shown.planRevision?.status === 'rejected') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(shown.planRevision.status, 'rejected')
  assert.match(shown.planRevision.reason, /the plan session's turn failed/)
  assert.equal(shown.planRevision.instruction, 'smaller scope')
  assert.ok(shown.events.some((e) => e.kind === 'plan_revision_rejected'), 'and it is on the timeline')
  assert.equal(store.currentPlanVersion(id), 1, 'the plan is untouched')

  // Once the build has started there is nothing left to revise.
  store.attachSession({ ticketId: id, dshSessionId: 'build-1', role: 'build', purpose: 'build' })
  assert.equal((await detail(rpc, id)).actions.revisePlan, false)
  const late = await rpc('action', { id, action: 'revisePlan', instruction: 'too late' })
  assert.equal(late.ok, false)
  assert.match(late.error.message, /build has already started/)
})

test('a ticket parked on a question reads as waiting on the answer on the board and in the detail', { skip }, async () => {
  const { rpc, store, create } = await boot()
  // In Backlog, so the engine's own tick has no reason to touch the reason set here.
  const id = await create({ column: 'backlog' })
  store.setNeedsAttention(id, 'Waiting on your answer in the plan session: Which database?')
  const board = (await rpc('board')).value
  const card = board.columns.backlog.find((t) => t.id === id)
  assert.equal(card.status, 'attention')
  assert.equal(card.parkedOnQuestion, true)
  assert.equal(card.awaitingQuestion, true, 'the card says Waiting on you, like a paused ask')
  // KAN-98: the HTTP read says what is being waited on, not only that something
  // is — the same object the orchestrator's tools return, unchanged in shape.
  assert.deepEqual(card.pendingQuestion, {
    source: 'park',
    questions: [{ id: null, question: 'Which database?', options: [] }],
  })
  const shown = await detail(rpc, id)
  assert.equal(shown.parkedOnQuestion, true)
  assert.equal(shown.status, 'attention')
  assert.equal(shown.ticket.needsAttentionReason, 'Waiting on your answer in the plan session: Which database?')
  assert.deepEqual(shown.pendingQuestion, card.pendingQuestion, 'the detail and the card say the same thing')

  const ordinary = await create({ column: 'backlog' })
  store.setNeedsAttention(ordinary, 'attempt budget exhausted (3)')
  const plain = (await rpc('board')).value.columns.backlog.find((t) => t.id === ordinary)
  assert.equal(plain.parkedOnQuestion, false)
  assert.equal(plain.awaitingQuestion, false)
  assert.equal(plain.pendingQuestion, null, 'a ticket waiting on nothing carries null')
  assert.equal((await detail(rpc, ordinary)).pendingQuestion, null)
})

// KAN-98: the live half of the same contract, through the real driver. The park
// above is a string the engine wrote; this is a session paused inside its turn on
// an `ask_user_question`, so the batch — ids, text, option labels — comes out of
// the call's own arguments on the event stream. It is also the case the ticket
// was filed for: a caller that sees `awaitingQuestion: true` over HTTP could read
// neither kind of question, and `answerQuestion` only accepts an answer keyed by
// ids nobody hands out.

test('a session paused mid-turn on a question reads its batch on the ticket detail and the board card', { skip }, async () => {
  const { rpc, store, create, emit, close } = await boot({ live: true })
  try {
    // Backlog, default planTiming: the engine's tick has no reason to launch it,
    // so the only thing moving here is the wait the driver is told about.
    const id = await create({ column: 'backlog' })
    store.attachSession({ ticketId: id, dshSessionId: 'sess-live-ask', role: 'planner', purpose: 'plan', provider: 'local', model: 'm' })
    emit('sess-live-ask', { type: 'turn/start', data: { turn: 1 } })

    const before = (await rpc('board')).value
    assert.equal(before.columns.backlog.find((c) => c.id === id).awaitingQuestion, false, 'nothing waits yet')
    assert.equal(before.columns.backlog.find((c) => c.id === id).pendingQuestion, null)
    assert.equal((await detail(rpc, id)).pendingQuestion, null)

    const args = JSON.stringify({
      questions: [
        { id: 'db', question: 'Which database?', header: 'Storage', options: [{ label: 'sqlite (Recommended)' }, { label: 'postgres' }] },
        { id: 'restart', question: 'Restart after the swap?', options: ['Yes', 'No'] },
      ],
    })
    emit('sess-live-ask', { type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-ask', name: 'ask_user_question', arguments: args } })

    const shown = await detail(rpc, id)
    assert.equal(shown.awaitingQuestion, true)
    assert.equal(shown.parkedOnQuestion, false, 'a live ask is not a park')
    assert.deepEqual(shown.pendingQuestion, {
      source: 'live',
      questions: [
        { id: 'db', question: 'Which database?', options: ['sqlite (Recommended)', 'postgres'], header: 'Storage' },
        { id: 'restart', question: 'Restart after the swap?', options: ['Yes', 'No'] },
      ],
    })

    const after = (await rpc('board')).value
    const card = after.columns.backlog.find((c) => c.id === id)
    assert.deepEqual(card.pendingQuestion, shown.pendingQuestion, 'the card and the detail agree')
    assert.deepEqual(card.pendingQuestion.questions.map((q) => q.id), ['db', 'restart'], 'the ids an answer must name are on the card')
    assert.deepEqual(card.pendingQuestion.questions[0].options, ['sqlite (Recommended)', 'postgres'], 'option labels too')
    assert.notEqual(after.token, before.token, 'a polling client holding the old token gets the new board')

    // Answering it clears the wait on both reads, and the token moves again.
    emit('sess-live-ask', { type: 'tool/result', data: { callId: 'call-ask', name: 'ask_user_question' } })
    const cleared = (await rpc('board')).value
    assert.equal(cleared.columns.backlog.find((c) => c.id === id).pendingQuestion, null)
    assert.equal((await detail(rpc, id)).pendingQuestion, null)
    assert.notEqual(cleared.token, after.token)
  } finally {
    close()
  }
})

test('a retry over RPC resets the budget and records the instruction for the next prompt', { skip }, async () => {
  const { rpc, store, create } = await boot()
  const id = await create({ column: 'backlog' })
  planned(store, id)
  store.addArtifact(id, 'implement_result', JSON.stringify(IMPLEMENTATION))
  store.addArtifact(id, 'review', JSON.stringify(REVIEW_PASS))
  store.setAttempt(id, 3, 0)
  store.setNeedsAttention(id, 'attempt budget exhausted (3)')
  const retried = await rpc('resolve', { id, action: 'retry', instruction: 'use docs/' })
  assert.equal(retried.ok, true, JSON.stringify(retried))
  assert.equal(store.getTicket(id).attemptCount, 0)
  assert.match(store.latestArtifact(id, 'attempt_feedback').content, /use docs\//)
  assert.ok(store.listEvents(id, { limit: 100 }).some((e) => e.kind === 'budget_reset'))
})

test('a new ticket defaults to its own worktree when the workspace is a git checkout, unless told otherwise', { skip }, async () => {
  const { rpc, store } = await boot({ workspaceCwd: workspace({ git: true }) })
  const made = async (fields) => (await rpc('create', { title: 'demo', body: '', column: 'backlog', ...fields })).value.ticket.id
  assert.equal(store.getTicket(await made({})).worktree, true, 'omitted means on')
  assert.equal(store.getTicket(await made({ worktree: null })).worktree, true, 'null means the default too')
  assert.equal(store.getTicket(await made({ worktree: false })).worktree, false, 'an explicit off is honoured')
  assert.equal(store.getTicket(await made({ worktree: true })).worktree, true)
  assert.equal((await rpc('capabilities')).value.worktree, true, 'the board shows the switch for a git workspace')
})

test('a new ticket has no worktree intent in a plain directory, and the switch stays hidden', { skip }, async () => {
  const { rpc, store } = await boot()
  const id = (await rpc('create', { title: 'demo', body: '', column: 'backlog' })).value.ticket.id
  assert.equal(store.getTicket(id).worktree, false)
  assert.equal((await rpc('capabilities')).value.worktree, false)
})

test('orchestratorSetPaused toggles the pause, validates its input, and the board and status report it', { skip }, async () => {
  const { rpc, store } = await boot()
  const before = await rpc('orchestrator')
  assert.equal(before.ok, true, JSON.stringify(before))
  assert.equal(before.value.paused, false)
  assert.equal((await rpc('board')).value.orchestratorPaused, false)

  const bad = await rpc('orchestratorSetPaused', { paused: 'yes' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'bad_request')

  const paused = await rpc('orchestratorSetPaused', { paused: true })
  assert.equal(paused.ok, true, JSON.stringify(paused))
  assert.equal(paused.value.paused, true)
  assert.equal(store.isOrchestratorPaused(), true, 'stored, so a restart keeps it')
  assert.equal((await rpc('board')).value.orchestratorPaused, true)
  assert.equal((await rpc('orchestrator')).value.paused, true)

  const resumed = await rpc('orchestratorSetPaused', { paused: false })
  assert.equal(resumed.value.paused, false)
  assert.equal((await rpc('board', { compact: true })).value.orchestratorPaused, false)
})

// ------------------------------------------------------------------ KAN-72 --
//
// The cap has to hold at the HTTP surface, not just in the pure module: this
// drives the real host over the routes it registers. The occupancy is seeded
// through the store at a closed phase on purpose — a live Working ticket would
// be launched by the engine and parked on the stub host's missing agents
// service inside the test, and a parked card is not a slot taken.

/** Three unparked Working tickets the engine will not touch. */
function fillWorking(store, n = 3) {
  const ids = []
  for (let i = 0; i < n; i += 1) {
    const t = store.createTicket({ title: `holding ${i}`, column: 'working' })
    for (const phase of ['implement', 'review', 'verify', 'closed']) {
      store.transitionTicket(t.id, { phase }, { actor: 'engine', reason: 'seed' })
    }
    ids.push(t.id)
  }
  return ids
}

test('a full Working column queues the next arrival instead of taking it', { skip }, async () => {
  const { rpc, store } = await boot()
  const held = fillWorking(store)
  const board0 = (await rpc('board')).value
  assert.equal(board0.wip.cap, 3, 'the default seed is three, not the old four')
  assert.equal(board0.wip.source, 'config')
  assert.equal(board0.wip.occupancy, 3)

  // Filed straight into Working: created in Backlog wearing the queue notice.
  const filed = await rpc('create', { title: 'fourth', body: '', column: 'working' })
  assert.equal(filed.ok, true, 'a queued filing is not an error')
  assert.equal(filed.value.ticket.column, 'backlog')
  assert.match(filed.value.ticket.needsAttentionReason, /^WIP cap 3\/3 — queued at position 1\./)
  assert.equal(filed.value.queued.position, 1)

  // Dragged into Working: same answer, next place in line.
  const fifth = await rpc('create', { title: 'fifth', body: '', column: 'backlog' })
  assert.equal(fifth.ok, true)
  const dragged = fifth.value.ticket.id
  const moved = await rpc('move', { id: dragged, column: 'working' })
  assert.equal(moved.ok, true)
  assert.equal(moved.value.ticket.column, 'backlog')
  assert.equal(moved.value.queued.position, 2)
  assert.match(moved.value.queued.reason, /WIP cap 3\/3/)

  const board = (await rpc('board')).value
  assert.deepEqual(board.wip.queue.map((q) => q.position), [1, 2])
  assert.equal(board.wip.queue.length, 2)

  // Out of Working is never refused, however full the column is.
  const back = await rpc('move', { id: held[0], column: 'backlog' })
  assert.equal(back.ok, true)
  assert.equal(back.value.ticket.column, 'backlog')
  assert.equal(back.value.queued, undefined)
})

test('setWipCap changes the cap live, re-queues the overflow, and persists', { skip }, async () => {
  const { rpc, store } = await boot()
  fillWorking(store, 3)

  const lowered = await rpc('setWipCap', { cap: 2 })
  assert.equal(lowered.ok, true, JSON.stringify(lowered))
  assert.equal(lowered.value.cap, 2)
  assert.equal(lowered.value.source, 'db')
  assert.equal(lowered.value.occupancy, 2, 'one card went back to the queue')
  assert.equal(lowered.value.requeued.length, 1)
  assert.equal(store.countWorkingOccupancy(), 2)
  assert.equal(store.getSetting('wip_cap'), '2', 'the board db holds it, so a restart keeps it')

  const config = (await rpc('config')).value
  assert.equal(config.wipCap, 2, 'the page reads the effective cap, not the YAML')
  assert.equal(config.wipCapSource, 'db')

  const bad = await rpc('setWipCap', { cap: 0 })
  assert.equal(bad.ok, false)
  assert.match(bad.error.message, /whole number of at least 1/)
  assert.equal(store.getSetting('wip_cap'), '2', 'a refused cap changed nothing')
})

// KAN-77: the New-ticket form opens its workspace box on the last workspace a
// ticket was created with. The Host remembers that in process memory only — no
// config key, no board-db row — and hands it out with `capabilities`, so a restart
// starts blank and nothing about the board changes.

test('capabilities.lastWorkspace follows the creates that name a workspace', { skip }, async () => {
  const { rpc } = await boot()

  assert.equal((await rpc('capabilities')).value.lastWorkspace, null, 'a fresh host remembers nothing')

  const first = await rpc('create', { title: 'one', body: '', column: 'backlog', workspaceCwd: '/work/first' })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal((await rpc('capabilities')).value.lastWorkspace, '/work/first')

  // A create that leaves the field empty means "engine default"; it says nothing
  // about where the last ticket went, so the remembered path survives it.
  const second = await rpc('create', { title: 'two', body: '', column: 'backlog' })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal((await rpc('capabilities')).value.lastWorkspace, '/work/first')

  const blank = await rpc('create', { title: 'three', body: '', column: 'backlog', workspaceCwd: '' })
  assert.equal(blank.ok, true, JSON.stringify(blank))
  assert.equal((await rpc('capabilities')).value.lastWorkspace, '/work/first')

  const third = await rpc('create', { title: 'four', body: '', column: 'backlog', workspaceCwd: '/work/second' })
  assert.equal(third.ok, true, JSON.stringify(third))
  assert.equal((await rpc('capabilities')).value.lastWorkspace, '/work/second')

  // Editing a ticket is not creating one: the box keeps the last create's answer.
  const edited = await rpc('update', { id: third.value.ticket.id, patch: { workspaceCwd: '/work/edited' } })
  assert.equal(edited.ok, true, JSON.stringify(edited))
  assert.equal((await rpc('capabilities')).value.lastWorkspace, '/work/second')

  // A second host — what a service restart is — starts blank again.
  const fresh = await boot()
  assert.equal((await fresh.rpc('capabilities')).value.lastWorkspace, null)
})
