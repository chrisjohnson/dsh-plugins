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
