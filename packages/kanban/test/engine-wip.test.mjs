// KAN-72: the cap the engine actually enforces, end to end over the store.
//
// The pure decisions are in wip.test.mjs; this is the seam — a move that meets
// a full board, the tick that promotes the head of the queue when a slot frees,
// and the live cap change that re-queues the overflow. The scripted driver is
// held busy throughout, so what these tests observe is the column state the
// engine produced, not a workflow run.

import test from 'node:test'
import assert from 'node:assert/strict'

import { Engine } from '../src/engine.mjs'
import { moveToColumn } from '../src/build.mjs'
import { wipQueueReason } from '../src/wip.mjs'
import { PROMPTS, setup } from './support/engine-harness.mjs'

/** A board with `occupied` unparked Working tickets, the driver too busy to launch anything. */
function board(overrides = {}, { occupied = 0, config = {} } = {}) {
  const h = setup({}, { config: { wipCap: 3, ...config } })
  h.driver.busy = true
  const working = []
  for (let i = 0; i < occupied; i += 1) {
    const t = h.store.createTicket({ title: `working ${i}`, column: 'working', ...overrides })
    h.store.transitionTicket(t.id, { phase: 'implement' }, { actor: 'engine' })
    working.push(h.store.getTicket(t.id))
  }
  return { ...h, working }
}

/** A planned Backlog ticket, ready to be moved into Working. */
function planned(store, key, priority = 0) {
  const t = store.createTicket({ title: key, priority, planTiming: 'now' })
  store.transitionTicket(t.id, { phase: 'implement' }, { actor: 'engine' })
  return store.getTicket(t.id)
}

test('a move into Working onto a full board is refused by the engine gate', () => {
  const { store, engine, working } = board({}, { occupied: 3 })
  const fourth = planned(store, 'KAN-fourth')

  const moved = moveToColumn({ store, engine, id: fourth.id, column: 'working', wip: engine.wip })

  assert.equal(moved.ticket.column, 'backlog')
  assert.equal(moved.queued.cap, 3)
  assert.equal(moved.queued.occupancy, 3)
  assert.equal(moved.queued.position, 1)
  assert.equal(store.getTicket(fourth.id).needsAttentionReason, wipQueueReason({ cap: 3, occupancy: 3, position: 1 }))
  assert.equal(working.length, 3)
})

test('a slot freed by a move out promotes the queue head, highest priority first', async () => {
  const { store, engine } = board({}, { occupied: 3 })
  const low = planned(store, 'KAN-low', 0)
  const high = planned(store, 'KAN-high', 5)
  moveToColumn({ store, engine, id: low.id, column: 'working', wip: engine.wip })
  moveToColumn({ store, engine, id: high.id, column: 'working', wip: engine.wip })
  // The queue is the board's order, not the order people happened to drag: the
  // high-priority card stands first even though it arrived second.
  assert.deepEqual(engine.wip.state().queue.map((t) => t.title), ['KAN-high', 'KAN-low'])
  assert.equal(store.getTicket(high.id).needsAttentionReason.match(/position (\d+)/)[1], '1')
  assert.equal(store.getTicket(low.id).needsAttentionReason.match(/position (\d+)/)[1], '1',
    'the card keeps the place it was given at the moment it was queued; the live queue block is what says where it stands now')

  // Free a slot the way a human holding a card back to Backlog does.
  const [first] = engine.store.listWorkingOccupancy()
  moveToColumn({ store, engine, id: first.id, column: 'backlog', reason: 'put back' })
  await engine.tick()

  assert.equal(store.getTicket(high.id).column, 'working', 'the head of the queue took the freed slot')
  assert.equal(store.getTicket(high.id).needsAttentionReason, null, 'and its queue notice went away with the move')
  assert.equal(store.getTicket(low.id).column, 'backlog', 'the rest wait for the next slot')
  assert.equal(store.getTicket(low.id).needsAttentionReason.match(/position (\d+)/)[1], '1')
})

test('a slot freed by approval promotes the queue head on the next tick', async () => {
  const { store, engine } = board({}, { occupied: 3 })
  const queued = planned(store, 'KAN-next')
  moveToColumn({ store, engine, id: queued.id, column: 'working', wip: engine.wip })
  assert.equal(store.getTicket(queued.id).column, 'backlog')

  const [done] = store.listWorkingOccupancy()
  store.transitionTicket(done.id, { column: 'done' }, { actor: 'engine', reason: 'approved' })
  await engine.tick()

  assert.equal(store.getTicket(queued.id).column, 'working')
})

test('a Working ticket parked for a human is not occupancy, so the board still has room', async () => {
  const { store, engine } = board({}, { occupied: 3 })
  const [one] = store.listWorkingOccupancy()
  store.setNeedsAttention(one.id, 'Awaiting human approval')
  assert.equal(store.countWorkingOccupancy(), 2)

  const fourth = planned(store, 'KAN-fourth')
  const moved = moveToColumn({ store, engine, id: fourth.id, column: 'working', wip: engine.wip })
  assert.equal(moved.queued, undefined, 'three cards in Working, but only two slots taken')
  assert.equal(moved.ticket.column, 'working')
})

test('lowering the cap from the board re-queues the lowest-priority overflow', () => {
  const { store, engine } = board({}, { occupied: 3 })
  // Give the three a priority order: the middle one is the one that must go.
  const [a, b, c] = store.listWorkingOccupancy()
  store.updateTicket(a.id, { priority: 9 }, { actor: 'human' })
  store.updateTicket(c.id, { priority: 5 }, { actor: 'human' })
  store.updateTicket(b.id, { priority: 1 }, { actor: 'human' })

  const answer = engine.setWipCap(2, { actor: 'human' })

  assert.equal(answer.cap, 2)
  assert.equal(answer.source, 'db')
  assert.equal(answer.occupancy, 2)
  assert.deepEqual(answer.requeued, [store.getTicket(b.id).key])
  assert.equal(store.getTicket(b.id).column, 'backlog')
  assert.match(store.getTicket(b.id).needsAttentionReason, /^WIP cap 2\/2 — queued at position 1\./)
  assert.equal(store.getTicket(a.id).column, 'working', 'the work the board most wants stays in flight')
  assert.equal(store.getTicket(c.id).column, 'working')
  assert.deepEqual(answer.queue, [{ key: b.key, title: b.title, position: 1, phase: 'implement' }])
})

test('a cap below one is refused and changes nothing', () => {
  const { store, engine } = board({}, { occupied: 2 })
  assert.throws(() => engine.setWipCap(0), /whole number of at least 1/)
  assert.throws(() => engine.setWipCap('three'), /whole number of at least 1/)
  assert.equal(store.getSetting('wip_cap'), null)
  assert.equal(engine.wip.cap().cap, 3, 'the configured seed still answers')
})

test('raising the cap again promotes what the queue holds', async () => {
  const { store, engine } = board({}, { occupied: 3 })
  const queued = planned(store, 'KAN-waiting')
  moveToColumn({ store, engine, id: queued.id, column: 'working', wip: engine.wip })
  assert.equal(store.getTicket(queued.id).column, 'backlog')

  engine.setWipCap(4, { actor: 'human' })
  await engine.tick()

  assert.equal(store.getTicket(queued.id).column, 'working')
})

test('the cap a person set is the cap a rebuilt engine reads', () => {
  const { store, driver } = board({}, { occupied: 0 })
  store.setSetting('wip_cap', '2', { actor: 'human', reason: 'WIP cap changed' })
  assert.equal(store.getSetting('wip_cap'), '2')

  // The same store, a fresh engine: what a service restart amounts to.
  const rebuilt = new Engine({
    ctx: { get() { return undefined } },
    store,
    driver,
    getConfig: () => ({ wipCap: 3, tickIntervalMs: 5000 }),
    getPrompts: () => PROMPTS,
    log: { info() {}, warn() {}, error() {}, debug() {} },
  })
  assert.deepEqual(rebuilt.wip.cap(), { cap: 2, source: 'db' })

  const first = rebuilt.store.createTicket({ title: 'one', column: 'working' })
  rebuilt.store.transitionTicket(first.id, { phase: 'implement' }, { actor: 'engine' })
  const second = rebuilt.store.createTicket({ title: 'two', column: 'working' })
  rebuilt.store.transitionTicket(second.id, { phase: 'implement' }, { actor: 'engine' })
  const third = planned(rebuilt.store, 'KAN-third')
  const moved = moveToColumn({ store: rebuilt.store, engine: rebuilt, id: third.id, column: 'working', wip: rebuilt.wip })
  assert.equal(moved.ticket.column, 'backlog', 'the rebuilt engine enforces the stored cap, not the config one')
  assert.equal(moved.queued.cap, 2)
})

test('a setting change is recorded in the event log with no ticket of its own', () => {
  const { store } = board({}, { occupied: 0 })
  store.setSetting('wip_cap', '5', { actor: 'human', reason: 'WIP cap changed' })
  const events = store.listEvents(null, { limit: 10 })
  void events
  const row = store.db.prepare("SELECT ticket_id, kind, actor, payload_json FROM events WHERE kind = 'setting_changed'").get()
  assert.equal(row.ticket_id, null, 'a board-wide setting belongs to no ticket')
  assert.equal(row.actor, 'human')
  assert.deepEqual(JSON.parse(row.payload_json), { key: 'wip_cap', value: '5', reason: 'WIP cap changed' })
})
