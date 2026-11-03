// Where a dragged ticket lands: sortOrder between its new neighbours, priority
// following the tier it was dropped into, and a respace when neighbours touch.

import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import { placement } from '../src/ordering.mjs'

const col = (...rows) => rows.map(([id, sortOrder, priority = 0]) => ({ id, sortOrder, priority }))

test('dropping between two tickets takes the midpoint of their orders', () => {
  const out = placement(col(['a', 1000], ['b', 2000], ['c', 3000]), 'c', 'b')
  assert.equal(out.ok, true)
  assert.equal(out.sortOrder, 1500)
  assert.equal(out.priority, 0)
  assert.deepEqual(out.renumber, [])
})

test('dropping before the first ticket goes a step ahead of it; at the end, a step behind the last', () => {
  assert.equal(placement(col(['a', 1000], ['b', 2000]), 'b', 'a').sortOrder, 0)
  assert.equal(placement(col(['a', 1000], ['b', 2000]), 'a', null).sortOrder, 3000)
  assert.equal(placement(col(['a', 1000], ['b', 2000]), 'a', undefined).sortOrder, 3000)
})

test("the dragged ticket's own old slot is not a neighbour", () => {
  const out = placement(col(['a', 1000], ['b', 2000], ['c', 3000]), 'b', 'c')
  assert.equal(out.sortOrder, 2000, 'between a (1000) and c (3000)')
  const moved = placement(col(['a', 1000], ['b', 2000], ['c', 3000]), 'a', 'c')
  assert.equal(moved.sortOrder, 2500, 'between b (2000) and c (3000)')
})

test('a drop across priority tiers adopts the tier of the ticket it lands before', () => {
  const column = col(['hi1', 1000, 5], ['hi2', 2000, 5], ['lo1', 500, 0], ['lo2', 900, 0])
  const intoHigh = placement(column, 'lo2', 'hi2')
  assert.equal(intoHigh.priority, 5)
  assert.equal(intoHigh.sortOrder, 1500)
  const toEnd = placement(column, 'hi1', null)
  assert.equal(toEnd.priority, 0, 'the end of the column is the lowest tier')
  assert.equal(toEnd.sortOrder, 1900)
  const topOfLow = placement(column, 'hi1', 'lo1')
  assert.equal(topOfLow.priority, 0)
  assert.equal(topOfLow.sortOrder, -500, 'ahead of the first ticket of the low tier')
})

test('neighbours with no room between them respace the tier', () => {
  const out = placement(col(['a', 1000], ['b', 1000.0000001], ['c', 5000]), 'c', 'b')
  assert.equal(out.ok, true)
  const all = [{ id: 'c', sortOrder: out.sortOrder }, ...out.renumber].sort((x, y) => x.sortOrder - y.sortOrder).map((x) => x.id)
  assert.deepEqual(all, ['a', 'c', 'b'])
  assert.deepEqual(out.renumber.map((r) => r.sortOrder), [1000, 3000])
})

test('unknown tickets are refused', () => {
  assert.equal(placement(col(['a', 1]), 'zzz', null).code, 'not_found')
  assert.equal(placement(col(['a', 1], ['b', 2]), 'a', 'zzz').code, 'not_found')
})

test('a reorder survives a re-read: the store lists the column in the dragged order', () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((title) => store.createTicket({ title }))
  const order = () => store.listTickets({ columns: ['backlog'] }).map((t) => t.title).join('')
  assert.equal(order(), 'abcd')
  const apply = (id, beforeId) => {
    const plan = placement(store.listTickets({ columns: ['backlog'] }), id, beforeId)
    for (const o of plan.renumber) store.updateTicket(o.id, { sortOrder: o.sortOrder })
    store.updateTicket(id, { sortOrder: plan.sortOrder, priority: plan.priority })
  }
  apply(d.id, a.id)
  assert.equal(order(), 'dabc')
  apply(d.id, null)
  assert.equal(order(), 'abcd')
  apply(c.id, b.id)
  assert.equal(order(), 'acbd')
  apply(a.id, null)
  assert.equal(order(), 'cbda')
  // Many drops into the same gap never collapse the order.
  for (let i = 0; i < 60; i += 1) apply(i % 2 === 0 ? a.id : d.id, b.id)
  assert.equal(order().length, 4)
  assert.equal(order().indexOf('b') > order().indexOf('d') || order().indexOf('b') > order().indexOf('a'), true)
})
