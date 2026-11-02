import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'

function setup() {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'kanban-store-')), 'k.db'))
  migrate(db)
  return { db, store: new KanbanStore(db) }
}

test('createTicket starts in plan and stores the two mode choices', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't', planTiming: 'now', planQuestions: 'autonomous', acceptance: ['a'] })
  assert.equal(ticket.phase, 'plan')
  assert.equal(ticket.column, 'backlog')
  assert.equal(ticket.planTiming, 'now')
  assert.equal(ticket.planQuestions, 'autonomous')
  assert.equal(ticket.key, 'KAN-1')
  assert.equal(store.listAcceptance(ticket.id)[0].statement, 'a')
})

test('a ticket may be created straight into Working', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't', column: 'working' })
  assert.equal(ticket.column, 'working')
  assert.equal(store.counts().working, 1)
  assert.equal(store.counts().backlog, 0)
})

test('invalid modes are rejected by the store', () => {
  const { store } = setup()
  assert.throws(() => store.createTicket({ title: 't', planTiming: 'later' }), /planTiming/)
  assert.throws(() => store.createTicket({ title: 't', planQuestions: 'maybe' }), /planQuestions/)
})

test('transitions and conditions are stored', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't', acceptance: ['a'] })
  const planned = store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: 'plan' })
  assert.equal(planned.phase, 'implement')
  const conditions = store.replaceConditions(ticket.id, 1, [
    { id: 'exists', statement: 'file exists', howVerified: 'test -f x' },
  ], 'plan')
  assert.equal(conditions.length, 1)
  assert.equal(store.listConditions(ticket.id)[0].source, 'plan')
  assert.throws(() => store.transitionTicket(ticket.id, { phase: 'verify' }, { actor: 'engine' }), /not allowed/)
})

test('sessions keep their purpose', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't' })
  store.attachSession({ ticketId: ticket.id, dshSessionId: 's1', role: 'plan', purpose: 'plan' })
  const sessions = store.listSessions(ticket.id)
  assert.equal(sessions[0].purpose, 'plan')
  assert.equal(sessions[0].role, 'plan')
})

test('needs-attention parks the ticket in place; a column move lifts the park', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't', acceptance: ['a'] })
  store.transitionTicket(ticket.id, { column: 'working' }, { actor: 'human' })
  store.setNeedsAttention(ticket.id, 'turn failed in plan: boom')
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.column, 'working')
  assert.equal(parked.needsAttentionReason, 'turn failed in plan: boom')
  // A phase move keeps the park; a column move clears it.
  const phaseMove = store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine' })
  assert.equal(phaseMove.needsAttentionReason, 'turn failed in plan: boom')
  const back = store.transitionTicket(ticket.id, { column: 'backlog' }, { actor: 'human', reason: 'dragged back' })
  assert.equal(back.column, 'backlog')
  assert.equal(back.needsAttentionReason, null)
})

test('clearNeedsAttention lifts the park in place', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't', column: 'working' })
  store.setNeedsAttention(ticket.id, 'awaiting')
  const cleared = store.clearNeedsAttention(ticket.id)
  assert.equal(cleared.needsAttentionReason, null)
  assert.equal(cleared.column, 'working')
})

// ---------------------------------------------------------------- KAN-14 edit

test('isEditable: a pristine ticket is editable, in backlog or working', () => {
  const { store } = setup()
  const inBacklog = store.createTicket({ title: 't', acceptance: ['a'] })
  assert.equal(store.isEditable(inBacklog.id), true)
  const inWorking = store.createTicket({ title: 'u', column: 'working' })
  assert.equal(store.isEditable(inWorking.id), true)
  assert.equal(store.isEditable(inWorking.key), true, 'a key resolves like an id')
  assert.equal(store.isEditable('KAN-404'), false, 'an unknown ticket is not editable')
})

test('isEditable: a plan session attaching is a start, even with nothing else', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't' })
  assert.equal(store.isEditable(ticket.id), true)
  store.attachSession({ ticketId: ticket.id, dshSessionId: 's1', role: 'plan', purpose: 'plan' })
  assert.equal(store.isEditable(ticket.id), false)
})

test('isEditable: every other engine touch locks the ticket', () => {
  const { store } = setup()

  const moved = store.createTicket({ title: 'phase moved' })
  store.transitionTicket(moved.id, { phase: 'implement' }, { actor: 'engine' })
  assert.equal(store.isEditable(moved.id), false)

  const discarded = store.createTicket({ title: 'discarded at plan phase' })
  store.transitionTicket(discarded.id, { column: 'discarded' }, { actor: 'human' })
  assert.equal(store.isEditable(discarded.id), false, 'a terminal column locks even at plan phase (production KAN-3)')

  const done = store.createTicket({ title: 'done at plan phase' })
  store.transitionTicket(done.id, { column: 'done' }, { actor: 'engine' })
  assert.equal(store.isEditable(done.id), false)

  const parked = store.createTicket({ title: 'parked' })
  store.setNeedsAttention(parked.id, 'plan session was interrupted')
  assert.equal(store.isEditable(parked.id), false)

  const spent = store.createTicket({ title: 'spent' })
  store.addSpend(spent.id, 0.01)
  assert.equal(store.isEditable(spent.id), false)

  const attempted = store.createTicket({ title: 'attempted' })
  store.setAttempt(attempted.id, 1, 0)
  assert.equal(store.isEditable(attempted.id), false)

  const run = store.createTicket({ title: 'a run started' })
  store.startRun({ ticketId: run.id, configHash: 'h', promptHashes: {} })
  assert.equal(store.isEditable(run.id), false)

  const span = store.createTicket({ title: 'a span started' })
  store.startSpan({ ticketId: span.id, kind: 'workflow', name: 'tick' })
  assert.equal(store.isEditable(span.id), false)

  const planned = store.createTicket({ title: 'conditions landed' })
  store.replaceConditions(planned.id, 1, [{ id: 'c', statement: 's', howVerified: 'v' }], 'plan')
  assert.equal(store.isEditable(planned.id), false)
})

test('isEditable: a detached session does not reopen the ticket — the engine rows stay', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't' })
  // The shape a real plan round leaves: a run, a span for the turn, and the
  // session that answered it. Detaching the session (archive, recovery) clears
  // only its own row; the run and span keep the ticket started.
  const runId = store.startRun({ ticketId: ticket.id, configHash: 'h', promptHashes: {} })
  store.startSpan({ ticketId: ticket.id, runId, kind: 'agent', name: 'plan turn', role: 'planner' })
  store.attachSession({ ticketId: ticket.id, dshSessionId: 's1', role: 'plan', purpose: 'plan' })
  assert.equal(store.isEditable(ticket.id), false)
  store.detachSession('s1')
  assert.equal(store.isEditable(ticket.id), false, 'the run and span rows are the touch that stays')
})

test('setAcceptance replaces the list, renumbers ordinals and records both sides', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't', acceptance: ['first', 'second'] })
  const rows = store.setAcceptance(ticket.id, ['  edited  ', 'third', 'fourth'])
  assert.deepEqual(rows.map((r) => r.ordinal), [1, 2, 3])
  assert.deepEqual(rows.map((r) => r.statement), ['  edited  ', 'third', 'fourth'], 'statements are stored verbatim')
  assert.deepEqual(rows.map((r) => r.source), ['human', 'human', 'human'])
  const event = store.listEvents(ticket.id).filter((e) => e.kind === 'acceptance_set').pop()
  assert.ok(event, 'the replace is recorded')
  assert.deepEqual(event.payload.prior, ['first', 'second'])
  assert.deepEqual(event.payload.next, ['  edited  ', 'third', 'fourth'])
  assert.equal(event.actor, 'human')
})

test('setAcceptance can delete every statement, and says so in the event', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't', acceptance: ['a', 'b'] })
  assert.deepEqual(store.setAcceptance(ticket.id, []), [])
  assert.deepEqual(store.listAcceptance(ticket.id), [])
  const event = store.listEvents(ticket.id).filter((e) => e.kind === 'acceptance_set').pop()
  assert.deepEqual(event.payload.prior, ['a', 'b'])
  assert.deepEqual(event.payload.next, [])
})

test('setAcceptance rejects a bad list and changes nothing', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't', acceptance: ['a'] })
  assert.throws(() => store.setAcceptance(ticket.id, 'a'), /array/)
  assert.throws(() => store.setAcceptance(ticket.id, ['a', '   ']), /non-empty/)
  assert.throws(() => store.setAcceptance(ticket.id, [42]), /non-empty/)
  assert.throws(() => store.setAcceptance('KAN-404', ['a']), /no ticket/)
  assert.deepEqual(store.listAcceptance(ticket.id).map((r) => r.statement), ['a'])
})

test('setAcceptance with the same list is a no-op: no rewrite, no event', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't', acceptance: ['a', 'b'] })
  const before = store.listEvents(ticket.id).length
  const rows = store.setAcceptance(ticket.id, ['a', 'b'])
  assert.deepEqual(rows.map((r) => r.statement), ['a', 'b'])
  assert.equal(store.listEvents(ticket.id).length, before)
})

// ------------------------------------------------------------- KAN-15 options

test('createTicket persists preset and writeMode; both default to null', () => {
  const { store } = setup()
  const plain = store.createTicket({ title: 'plain' })
  assert.equal(plain.preset, null, 'no preset means the harness default')
  assert.equal(plain.writeMode, null, 'no write mode means the purpose default')
  const chosen = store.createTicket({ title: 'chosen', preset: 'ptc', writeMode: 'read-only' })
  assert.equal(chosen.preset, 'ptc')
  assert.equal(chosen.writeMode, 'read-only')
  const event = store.listEvents(chosen.id).find((e) => e.kind === 'created')
  assert.equal(event.payload.preset, 'ptc')
  assert.equal(event.payload.writeMode, 'read-only')
})

test('createTicket rejects a writeMode outside the closed vocabulary', () => {
  const { store } = setup()
  for (const bad of ['full-access', 'WRITE', 42, '']) {
    assert.throws(() => store.createTicket({ title: 't', writeMode: bad }), /writeMode/, `${String(bad)} must be rejected`)
  }
  for (const good of ['read-only', 'workspace-write', 'danger-full-access']) {
    assert.equal(store.createTicket({ title: 't', writeMode: good }).writeMode, good)
  }
})

test('createTicket rejects a blank or non-string preset; null is the harness default', () => {
  const { store } = setup()
  assert.throws(() => store.createTicket({ title: 't', preset: '   ' }), /preset/)
  assert.throws(() => store.createTicket({ title: 't', preset: 7 }), /preset/)
  assert.equal(store.createTicket({ title: 't', preset: null }).preset, null)
})

test('updateTicket accepts preset and writeMode on a pristine ticket and can clear them', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't' })
  const updated = store.updateTicket(ticket.id, { preset: 'minimal', writeMode: 'danger-full-access' })
  assert.equal(updated.preset, 'minimal')
  assert.equal(updated.writeMode, 'danger-full-access')
  const cleared = store.updateTicket(ticket.id, { preset: null, writeMode: null })
  assert.equal(cleared.preset, null)
  assert.equal(cleared.writeMode, null)
  assert.throws(() => store.updateTicket(ticket.id, { writeMode: 'nope' }), /writeMode/)
  assert.throws(() => store.updateTicket(ticket.id, { preset: '' }), /preset/)
})

// ---------------------------------------------------------------- KAN-18 worktree intent

test('the worktree flag round-trips through create and update', () => {
  const { store } = setup()
  const asked = store.createTicket({ title: 'lazy', worktree: true })
  assert.equal(asked.worktree, true)
  assert.equal(store.getTicket(asked.id).worktree, true)
  // A ticket nobody switched on records the intent as false, not "unset".
  const plain = store.createTicket({ title: 'plain' })
  assert.equal(plain.worktree, false)
  assert.equal(store.listTickets().find((t) => t.id === plain.id).worktree, false)
  // Flipping it later is an ordinary ticket update, and it is auditable.
  store.updateTicket(plain.id, { worktree: true }, { actor: 'human', reason: 'changed my mind' })
  assert.equal(store.getTicket(plain.id).worktree, true)
  store.updateTicket(plain.id, { worktree: false }, { actor: 'human', reason: 'never mind' })
  assert.equal(store.getTicket(plain.id).worktree, false)
  const events = store.listEvents(plain.id).filter((event) => event.kind === 'ticket_updated')
  assert.ok(events.some((event) => event.payload.fields.includes('worktree')))
})

test('creating a ticket with the worktree intent stores no workspace', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 'intent only', worktree: true })
  assert.equal(ticket.workspaceCwd, null, 'the switch records intent; the copy is made at plan start')
  const created = store.listEvents(ticket.id).find((event) => event.kind === 'created')
  assert.equal(created.payload.worktree, true)
})
