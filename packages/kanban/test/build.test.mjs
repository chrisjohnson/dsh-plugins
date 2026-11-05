// "Start build" on a planned Backlog ticket: the same move into Working that a
// drag makes, behind a guard, with no state of its own.

import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import { canStartBuild, moveToColumn, startBuild } from '../src/build.mjs'
import { cardStatus } from '../src/lifecycle.mjs'
import { createWipGate } from '../src/wip.mjs'

function setup() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const ticks = []
  const engine = { tick: () => { ticks.push(Date.now()) } }
  // A plan-now ticket that planned in Backlog and stopped at the build phase.
  const ticket = store.createTicket({ title: 'planned', planTiming: 'now' })
  store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine' })
  return { store, engine, ticks, ticket: store.getTicket(ticket.id) }
}

test('start build makes the same move a drag into Working makes', () => {
  const dragged = setup()
  const viaDrag = moveToColumn({ store: dragged.store, engine: dragged.engine, id: dragged.ticket.id, column: 'working' })

  const pressed = setup()
  const result = startBuild({ store: pressed.store, engine: pressed.engine, ticket: pressed.ticket })

  assert.equal(result.ok, true)
  assert.equal(result.ticket.column, 'working')
  assert.equal(result.ticket.column, viaDrag.ticket.column)
  assert.equal(result.ticket.phase, viaDrag.ticket.phase)
  assert.equal(result.ticket.phase, 'implement', 'the phase is untouched; only the column moves')
  assert.equal(pressed.ticks.length, 1, 'the engine is nudged exactly as a drag nudges it')
  assert.equal(dragged.ticks.length, 1)
  const column = pressed.store.listEvents(pressed.ticket.id).find((e) => e.kind === 'column_changed')
  assert.equal(column.actor, 'human')
  assert.deepEqual([column.payload.from, column.payload.to], ['backlog', 'working'])
})

test('start build lifts a park exactly as the drag does', () => {
  const { store, engine, ticket } = setup()
  store.setNeedsAttention(ticket.id, 'plan session ended')
  const result = startBuild({ store, engine, ticket: store.getTicket(ticket.id) })
  assert.equal(result.ok, true)
  assert.equal(result.ticket.needsAttentionReason ?? null, null)
})

test('start build refuses anything that is not a planned Backlog ticket', () => {
  const { store, engine, ticket } = setup()
  const unplanned = store.createTicket({ title: 'still to plan' })
  const refused = startBuild({ store, engine, ticket: unplanned })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'bad_request')
  assert.match(refused.message, /backlog\/plan/)

  const working = startBuild({ store, engine, ticket }).ticket
  const again = startBuild({ store, engine, ticket: working })
  assert.equal(again.ok, false, 'a ticket already in Working has nothing to start')
})

test('a planned ticket waiting in Backlog is an ordinary idle card, not an attention state', () => {
  const { ticket } = setup()
  assert.equal(cardStatus(ticket, {}), 'idle')
})

test('the button is offered exactly where the host would accept it', () => {
  assert.equal(canStartBuild({ column: 'backlog', phase: 'implement' }), true)
  assert.equal(canStartBuild({ column: 'backlog', phase: 'implement', status: 'attention' }), true, 'a parked ticket keeps the button; the move lifts the park')
  assert.equal(canStartBuild({ column: 'backlog', phase: 'plan' }), false)
  assert.equal(canStartBuild({ column: 'working', phase: 'implement' }), false)
  assert.equal(canStartBuild({ column: 'backlog', phase: 'implement', status: 'active' }), false)
  assert.equal(canStartBuild({ column: 'backlog', phase: 'implement', awaitingQuestion: true }), false)
  assert.equal(canStartBuild(null), false)
})

// ------------------------------------------------------------------ KAN-72
//
// The same seam is where the Working cap is enforced: a move into Working onto
// a full board queues the ticket instead of making it, and a move out of
// Working is never refused, because taking work away cannot overflow anything.

/** A store with `n` unparked tickets already in Working, plus a planned one to move. */
function fullBoard(cap, occupied = cap) {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const ticks = []
  const engine = { tick: () => { ticks.push(Date.now()) } }
  const wip = createWipGate({ store, getConfig: () => ({ wipCap: cap }) })
  for (let i = 0; i < occupied; i += 1) {
    const t = store.createTicket({ title: `in flight ${i}`, column: 'working' })
    store.transitionTicket(t.id, { phase: 'implement' }, { actor: 'engine' })
  }
  const planned = store.createTicket({ title: 'planned', planTiming: 'now' })
  store.transitionTicket(planned.id, { phase: 'implement' }, { actor: 'engine' })
  return { store, engine, ticks, wip, planned: store.getTicket(planned.id) }
}

test('a move into Working onto a full board queues the ticket where it stands', () => {
  const { store, engine, ticks, wip, planned } = fullBoard(3, 3)
  const moved = moveToColumn({ store, engine, id: planned.id, column: 'working', reason: 'drag', wip })

  assert.equal(moved.ticket.column, 'backlog', 'the ticket did not move')
  assert.match(moved.ticket.needsAttentionReason, /^WIP cap 3\/3 — queued at position 1\./)
  assert.equal(moved.queued.cap, 3)
  assert.equal(moved.queued.occupancy, 3)
  assert.equal(moved.queued.position, 1)
  assert.equal(ticks.length, 0, 'a refused move is not a move; the engine is not nudged')
  assert.equal(store.getTicket(planned.id).column, 'backlog', 'the refusal is the stored state, not just the answer')
})

test('start build at the cap queues instead of starting', () => {
  const { store, engine, wip, planned } = fullBoard(3, 3)
  const result = startBuild({ store, engine, ticket: planned, wip })

  assert.equal(result.ok, true, 'the request was understood: the ticket is queued, not rejected')
  assert.equal(result.ticket.column, 'backlog')
  assert.equal(result.queued.position, 1)
  assert.match(result.queued.reason, /WIP cap 3\/3/)
})

test('a board with room moves exactly as it always did', () => {
  const { store, engine, ticks, wip, planned } = fullBoard(3, 2)
  const result = startBuild({ store, engine, ticket: planned, wip })
  assert.equal(result.ok, true)
  assert.equal(result.queued, undefined)
  assert.equal(result.ticket.column, 'working')
  assert.equal(ticks.length, 1, 'a real move still nudges the engine')
})

test('a move out of Working is never refused', () => {
  const { store, engine, wip } = fullBoard(1, 1)
  const inWorking = store.listTickets({ columns: ['working'] })[0]
  const moved = moveToColumn({ store, engine, id: inWorking.id, column: 'backlog', wip })
  assert.equal(moved.ticket.column, 'backlog')
  assert.equal(moved.queued, undefined)
})

test('a ticket already in Working is not refused by its own occupancy', () => {
  const { store, engine, wip } = fullBoard(1, 1)
  const inWorking = store.listTickets({ columns: ['working'] })[0]
  const moved = moveToColumn({ store, engine, id: inWorking.id, column: 'working', wip })
  assert.equal(moved.queued, undefined, 'a no-op move onto the column it is already in is not a capacity event')
})

test('a queued ticket keeps its place in line when dragged again', () => {
  const { store, engine, wip, planned } = fullBoard(2, 2)
  const first = moveToColumn({ store, engine, id: planned.id, column: 'working', wip })
  assert.equal(first.queued.position, 1)
  const other = store.createTicket({ title: 'second arrival', planTiming: 'now' })
  store.transitionTicket(other.id, { phase: 'implement' }, { actor: 'engine' })
  const second = moveToColumn({ store, engine, id: other.id, column: 'working', wip })
  assert.equal(second.queued.position, 2, 'a new arrival joins the tail')
  const again = moveToColumn({ store, engine, id: planned.id, column: 'working', wip })
  assert.equal(again.queued.position, 1, 'and a ticket already queued keeps the place it was given')
})

test('a refusal does not overwrite a park the ticket already had', () => {
  const { store, engine, wip, planned } = fullBoard(1, 1)
  store.setNeedsAttention(planned.id, 'plan session ended on a question')
  const moved = moveToColumn({ store, engine, id: planned.id, column: 'working', wip })
  assert.equal(moved.queued.position, 1)
  assert.equal(moved.ticket.needsAttentionReason, 'plan session ended on a question', 'the thing a person must answer survives the queue notice')
})
