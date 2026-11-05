// KAN-72: the Work-In-Progress cap, as pure decisions.
//
// Everything the engine enforces is decided here first, so the whole rule —
// what counts as occupancy, what the queue is, who overflows when the cap is
// lowered, and what a refusal says — is testable without SQLite, a driver or a
// dsh host.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createWipGate,
  effectiveCap,
  isWipQueuePark,
  overflowForLoweredCap,
  parseWipQueueReason,
  queueSummary,
  wipQueue,
  wipQueueReason,
  workingOccupancy,
  workingTickets,
} from '../src/wip.mjs'

const ticket = (over) => ({
  id: over.key,
  key: over.key,
  title: over.title ?? `the ${over.key} work`,
  column: over.column ?? 'backlog',
  phase: over.phase ?? 'implement',
  priority: over.priority ?? 0,
  sortOrder: over.sortOrder ?? 1000,
  createdAt: over.createdAt ?? '2026-01-01T00:00:00.000Z',
  needsAttentionReason: over.park ?? null,
})

// ---------------------------------------------------------------- the notice

test('the queue notice names the cap, the occupancy and the position', () => {
  const reason = wipQueueReason({ cap: 3, occupancy: 3, position: 2 })
  assert.equal(reason, 'WIP cap 3/3 — queued at position 2. It starts automatically when a Working slot frees.')
  assert.deepEqual(parseWipQueueReason(reason), { occupancy: 3, cap: 3, position: 2 })
})

test('only a queue notice parses as one', () => {
  assert.equal(isWipQueuePark('Awaiting human approval'), false)
  assert.equal(isWipQueuePark(null), false)
  assert.equal(isWipQueuePark(undefined), false)
  assert.deepEqual(parseWipQueueReason('Awaiting human approval'), {})
  // A hand-written reason that merely starts like one is not a counted place:
  // the numbers have to be there, or the caller gets no opinion, never a zero.
  assert.equal(isWipQueuePark('WIP cap is generous here'), true)
  assert.deepEqual(parseWipQueueReason('WIP cap is generous here'), {})
})

// ------------------------------------------------------------------ the cap

test('the board db value wins once a person has set one', () => {
  assert.deepEqual(effectiveCap({ dbValue: '2', configCap: 4 }), { cap: 2, source: 'db' })
  assert.deepEqual(effectiveCap({ dbValue: null, configCap: 4 }), { cap: 4, source: 'config' })
  assert.deepEqual(effectiveCap({ dbValue: 'not a number', configCap: 4 }), { cap: 4, source: 'config' })
  assert.deepEqual(effectiveCap({ dbValue: '0', configCap: 4 }), { cap: 4, source: 'config' }, 'a cap of zero is not a cap anyone meant')
  assert.deepEqual(effectiveCap({ dbValue: null, configCap: undefined }), { cap: 1, source: 'config' }, 'an unresolvable cap never means unlimited')
})

// --------------------------------------------------------------- occupancy

test('occupancy is Working minus the parked ones', () => {
  const tickets = [
    ticket({ key: 'KAN-1', column: 'working' }),
    ticket({ key: 'KAN-2', column: 'working' }),
    ticket({ key: 'KAN-3', column: 'working', park: 'Awaiting human approval' }),
    ticket({ key: 'KAN-4', column: 'backlog' }),
    ticket({ key: 'KAN-5', column: 'done' }),
  ]
  assert.equal(workingOccupancy(tickets), 2)
  assert.deepEqual(workingTickets(tickets).map((t) => t.key), ['KAN-1', 'KAN-2'])
})

test('the queue is the Backlog cards wearing a queue notice, in board order', () => {
  const tickets = [
    ticket({ key: 'KAN-1', park: wipQueueReason({ cap: 3, occupancy: 3, position: 1 }) }),
    ticket({ key: 'KAN-2', priority: 5, park: wipQueueReason({ cap: 3, occupancy: 3, position: 2 }) }),
    ticket({ key: 'KAN-3', park: 'plan session ended' }),
    ticket({ key: 'KAN-4', column: 'working' }),
  ]
  // Priority first, then the order a human arranged, then creation.
  assert.deepEqual(wipQueue(tickets).map((t) => t.key), ['KAN-2', 'KAN-1'])
  assert.deepEqual(queueSummary(wipQueue(tickets)), [
    { key: 'KAN-2', title: 'the KAN-2 work', position: 1, phase: 'implement' },
    { key: 'KAN-1', title: 'the KAN-1 work', position: 2, phase: 'implement' },
  ])
})

test('sort order breaks a priority tie the way the board lists it', () => {
  const queued = [
    { ...ticket({ key: 'KAN-late', sortOrder: 5000 }), needsAttentionReason: wipQueueReason({ cap: 0, occupancy: 0, position: 0 }) },
    { ...ticket({ key: 'KAN-early', sortOrder: 2000 }), needsAttentionReason: wipQueueReason({ cap: 0, occupancy: 0, position: 0 }) },
    { ...ticket({ key: 'KAN-high', priority: 1, sortOrder: 9000 }), needsAttentionReason: wipQueueReason({ cap: 0, occupancy: 0, position: 0 }) },
  ]
  assert.deepEqual(wipQueue(queued).map((t) => t.key), ['KAN-high', 'KAN-early', 'KAN-late'])
})

// ---------------------------------------------------------------- overflow

test('lowering the cap sends the lowest-priority occupancy back first', () => {
  const tickets = [
    ticket({ key: 'KAN-low', column: 'working', priority: 0, sortOrder: 1000 }),
    ticket({ key: 'KAN-high', column: 'working', priority: 9, sortOrder: 1000 }),
    ticket({ key: 'KAN-mid', column: 'working', priority: 5, sortOrder: 1000 }),
    ticket({ key: 'KAN-parked', column: 'working', park: 'Awaiting human approval' }),
  ]
  assert.deepEqual(overflowForLoweredCap(tickets, 2).map((t) => t.key), ['KAN-low'], 'the tail of the queue order goes; the parked card is not occupancy')
  assert.deepEqual(overflowForLoweredCap(tickets, 1).map((t) => t.key), ['KAN-mid', 'KAN-low'])
  assert.deepEqual(overflowForLoweredCap(tickets, 4), [], 'raising it overflows nothing')
})

// -------------------------------------------------------------------- gate

/** The store the gate reads, without SQLite: the same three answers it asks for. */
function fakeStore({ working, queued, cap }) {
  return {
    getSetting: (key) => (key === 'wip_cap' && cap === null ? null : String(cap)),
    countWorkingOccupancy: () => workingOccupancy(working),
    listWipQueue: () => wipQueue(queued),
  }
}

test('the gate refuses only when the slots are all taken', () => {
  const working = [ticket({ key: 'KAN-1', column: 'working' }), ticket({ key: 'KAN-2', column: 'working' })]
  const gate = createWipGate({ store: fakeStore({ working, queued: [], cap: null }), getConfig: () => ({ wipCap: 3 }) })
  assert.equal(gate.refusalFor(ticket({ key: 'KAN-new' })), null)
  assert.equal(gate.cap().cap, 3)
  assert.equal(gate.cap().source, 'config')

  const full = [...working, ticket({ key: 'KAN-3', column: 'working' })]
  const atCap = createWipGate({ store: fakeStore({ working: full, queued: [], cap: null }), getConfig: () => ({ wipCap: 3 }) })
  const refusal = atCap.refusalFor(ticket({ key: 'KAN-4' }))
  assert.deepEqual(refusal, { cap: 3, occupancy: 3, position: 1, reason: wipQueueReason({ cap: 3, occupancy: 3, position: 1 }) })
  // A ticket already in Working is never refused: it is already counted.
  assert.equal(atCap.refusalFor(ticket({ key: 'KAN-1', column: 'working' })), null)
})

test('the gate reads the db cap over the configured one', () => {
  const working = [ticket({ key: 'KAN-1', column: 'working' })]
  const gate = createWipGate({ store: fakeStore({ working, queued: [], cap: 1 }), getConfig: () => ({ wipCap: 5 }) })
  assert.deepEqual(gate.cap(), { cap: 1, source: 'db' })
  assert.equal(gate.refusalFor(ticket({ key: 'KAN-2' })).position, 1)
})

test('a new arrival takes the tail and a queued ticket keeps its place', () => {
  const working = [ticket({ key: 'KAN-1', column: 'working' })]
  const queued = [ticket({ key: 'KAN-q', park: wipQueueReason({ cap: 1, occupancy: 1, position: 1 }) })]
  const gate = createWipGate({ store: fakeStore({ working, queued, cap: null }), getConfig: () => ({ wipCap: 1 }) })
  assert.equal(gate.refusalFor(ticket({ key: 'KAN-new' })).position, 2)
  assert.equal(gate.arrivalRefusal().position, 2)
  assert.equal(gate.refusalFor(ticket({ key: 'KAN-q' })).position, 1)
})

test('the gate state is what a board read shows', () => {
  const working = [ticket({ key: 'KAN-1', column: 'working' }), ticket({ key: 'KAN-2', column: 'working', park: 'Awaiting human approval' })]
  const queued = [ticket({ key: 'KAN-3', park: wipQueueReason({ cap: 1, occupancy: 1, position: 1 }) })]
  const gate = createWipGate({ store: fakeStore({ working, queued, cap: null }), getConfig: () => ({ wipCap: 1 }) })
  const state = gate.state()
  assert.equal(state.cap, 1)
  assert.equal(state.occupancy, 1, 'the parked Working card is not a slot taken')
  assert.deepEqual(queueSummary(state.queue).map((q) => q.key), ['KAN-3'])
})
