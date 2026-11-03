// The Host's RPC surface, driven through the routes it registers: the recovery
// actions (mark done, re-run review, revise plan), their refusals, what the
// detail payload offers the client, and how a question reads on the board.
//
// The host is booted against a stub dsh context with a real SQLite file; a
// second store connection to the same file sets up and inspects state. Needs the
// dsh peer packages (the host imports the driver); skips on a bare clone.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
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

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-host-rpc-'))
  const dbPath = join(dir, 'kanban.db')
  const routes = new Map()
  const ctx = {
    logger: () => LOG,
    get(name) {
      if (name === 'llm') {
        return { listProviders: () => [{ id: 'local' }], listModels: async () => [], resolveModelInfo: async () => null }
      }
      return undefined
    },
    effect() {},
    inject(_deps, callback) {
      callback({ connection: { fetch: { register: (definition) => routes.set(definition.path, definition.fetch) } } })
    },
  }
  await kanban(ctx, {
    dbPath,
    providers: [{ name: 'local' }],
    roles: {
      planner: { provider: 'local', model: 'm' },
      implementer: { provider: 'local', model: 'm' },
      reviewer: { provider: 'local', model: 'm' },
      approver: { provider: 'local', model: 'm' },
    },
  })
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
  return { rpc, store, create }
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
  const shown = await detail(rpc, id)
  assert.equal(shown.parkedOnQuestion, true)
  assert.equal(shown.status, 'attention')
  assert.equal(shown.ticket.needsAttentionReason, 'Waiting on your answer in the plan session: Which database?')

  const ordinary = await create({ column: 'backlog' })
  store.setNeedsAttention(ordinary, 'attempt budget exhausted (3)')
  const plain = (await rpc('board')).value.columns.backlog.find((t) => t.id === ordinary)
  assert.equal(plain.parkedOnQuestion, false)
  assert.equal(plain.awaitingQuestion, false)
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
