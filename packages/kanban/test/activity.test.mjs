import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import { TurnActivity } from '../src/activity.mjs'

function setup() {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'kanban-activity-')), 'k.db'))
  migrate(db)
  const store = new KanbanStore(db)
  const calls = { reactivate: [], settle: [] }
  const actions = new Set()
  const activity = new TurnActivity({
    store,
    hasAction: (sessionId) => actions.has(sessionId),
    onReactivate: (ticketId, sessionId) => { calls.reactivate.push([ticketId, sessionId]) },
    onSettle: (ticketId, sessionId) => { calls.settle.push([ticketId, sessionId]) },
  })
  const ticket = store.createTicket({ title: 't', acceptance: ['a'] })
  store.transitionTicket(ticket.id, { column: 'now' }, { actor: 'human' })
  store.attachSession({ ticketId: ticket.id, dshSessionId: 'session-1', role: 'implementer', purpose: 'build' })
  return { store, activity, calls, actions, ticket }
}

/** Stand in for the engine transition a real reactivation performs. */
function inFlight(store, ticket) {
  store.transitionTicket(ticket.id, { column: 'now' }, { actor: 'engine', reason: 'session reactivated' })
}

test('a turn on a needs-attention ticket reactivates it and marks the session busy', () => {
  const { store, activity, calls, ticket } = setup()
  store.setNeedsAttention(ticket.id, 'turn failed in implement: boom')
  activity.turnStart('session-1')
  assert.deepEqual(calls.reactivate, [[ticket.id, 'session-1']])
  assert.equal(activity.marks.get(ticket.id).sessionId, 'session-1')
  assert.equal(activity.busy(ticket.id), true)
})

test('a turn on a ticket that is not waiting for attention does not reactivate', () => {
  const { activity, calls, ticket } = setup()
  activity.turnStart('session-1')
  assert.equal(calls.reactivate.length, 0)
  assert.equal(activity.busy(ticket.id), true)
})

test('turn/end without a structured action settles the ticket back', () => {
  const { store, activity, calls, ticket } = setup()
  store.setNeedsAttention(ticket.id, 'attempt budget exhausted (3)')
  activity.turnStart('session-1')
  inFlight(store, ticket)
  activity.turnEnd('session-1')
  assert.deepEqual(calls.settle, [[ticket.id, 'session-1']])
  assert.equal(activity.marks.has(ticket.id), false)
  assert.equal(activity.busy(ticket.id), false)
})

test('turn/end after a structured action does not settle the ticket back', () => {
  const { store, activity, calls, actions, ticket } = setup()
  store.setNeedsAttention(ticket.id, 'implementer ended without calling kanban_submit_implementation')
  activity.turnStart('session-1')
  inFlight(store, ticket)
  actions.add('session-1')
  activity.turnEnd('session-1')
  assert.equal(calls.settle.length, 0)
  assert.equal(activity.marks.has(ticket.id), false)
})

test('a turn on a session with no ticket is ignored and cached', () => {
  const { store, activity, calls } = setup()
  let lookups = 0
  const findSession = store.findSession.bind(store)
  store.findSession = (id) => { lookups += 1; return findSession(id) }
  activity.turnStart('session-stranger')
  activity.turnEnd('session-stranger')
  assert.equal(calls.reactivate.length, 0)
  assert.equal(activity.busy('ticket-stranger'), false)
  // one store lookup, then the negative answer is cached for both events
  assert.equal(lookups, 1)
})

test('a reactivation the engine did not handle keeps no mark', () => {
  const { store, activity, ticket } = setup()
  store.setNeedsAttention(ticket.id, 'no route configured for role implementer')
  const unhandled = new TurnActivity({ store, onReactivate: () => false, onSettle: () => true })
  unhandled.turnStart('session-1')
  assert.equal(unhandled.marks.has(ticket.id), false)
  assert.equal(activity.marks.has(ticket.id), false)
})

test('prune drops a turn whose end event never arrived', () => {
  const { store, activity, ticket } = setup()
  store.setNeedsAttention(ticket.id, 'turn failed in implement: boom')
  activity.turnStart('session-1')
  inFlight(store, ticket)
  assert.equal(activity.busy(ticket.id), true)
  activity.prune(() => false)
  assert.equal(activity.busy(ticket.id), false)
  assert.equal(activity.marks.has(ticket.id), false)
})

test('a live driver session resolves through the live map, not the store', () => {
  const { store, activity, ticket } = setup()
  store.detachSession('session-1')
  assert.equal(activity.ticketOf('session-1'), undefined)
  const live = new TurnActivity({ store, isLive: (id) => (id === 'session-1' ? ticket.id : undefined) })
  assert.equal(live.ticketOf('session-1'), ticket.id)
})
