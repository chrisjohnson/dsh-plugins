// "Start build" on a planned Backlog ticket: the same move into Working that a
// drag makes, behind a guard, with no state of its own.

import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import { canStartBuild, moveToColumn, startBuild } from '../src/build.mjs'
import { cardStatus } from '../src/lifecycle.mjs'

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
  assert.equal(result.ticket.column, viaDrag.column)
  assert.equal(result.ticket.phase, viaDrag.phase)
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
