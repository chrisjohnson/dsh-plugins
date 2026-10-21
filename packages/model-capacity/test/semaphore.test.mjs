import test from 'node:test'
import assert from 'node:assert/strict'

import { CapacityError, CapacityManager } from '../src/semaphore.mjs'

function manager(overrides = {}) {
  return new CapacityManager({
    defaultLimit: 1,
    limits: [{ provider: 'gpu', maxConcurrent: 2 }],
    queueLimitPerProvider: 10,
    reservationTtlMs: 60_000,
    now: () => 1000,
    ...overrides,
  })
}

test('admits up to the limit, queues FIFO, and drains on release', async () => {
  const m = manager()
  const a = await m.acquire({ provider: 'gpu', sessionId: 'a' })
  const b = await m.acquire({ provider: 'gpu', sessionId: 'b' })
  let cResolved = false
  const cPromise = m.acquire({ provider: 'gpu', sessionId: 'c' }).then((lease) => { cResolved = true; return lease })
  assert.equal(cResolved, false)
  assert.equal(m.snapshot().providers[0].waiters.length, 1)
  a.release()
  const c = await cPromise
  assert.equal(cResolved, true)
  assert.equal(c.sessionId, 'c')
  assert.equal(m.used('gpu'), 2)
  b.release(); c.release()
  assert.equal(m.used('gpu'), 0)
})

test('aborting a waiter removes it without leaking a slot', async () => {
  const m = manager()
  const a = await m.acquire({ provider: 'gpu', sessionId: 'a' })
  const b = await m.acquire({ provider: 'gpu', sessionId: 'b' })
  const controller = new AbortController()
  const waiting = m.acquire({ provider: 'gpu', sessionId: 'c', signal: controller.signal })
  controller.abort()
  await assert.rejects(waiting, (error) => error instanceof CapacityError && error.code === 'CAPACITY_ABORTED')
  assert.equal(m.snapshot().providers[0].waiters.length, 0)
  a.release(); b.release()
  assert.equal(m.used('gpu'), 0)
})

test('reservations count against capacity and are consumed by the child first call', async () => {
  const m = manager()
  await m.acquire({ provider: 'gpu', sessionId: 'parent' })
  const reservation = m.reserve({ provider: 'gpu', parentSession: 'parent', tool: 'subagent' })
  assert.equal(m.used('gpu'), 2)
  assert.throws(() => m.reserve({ provider: 'gpu', parentSession: 'parent', tool: 'subagent' }), (e) => e.code === 'CAPACITY_EXCEEDED')
  const bound = m.bindChild('parent', 'child-session')
  assert.equal(bound.id, reservation.id)
  const lease = m.consumeReservation('child-session', 'gpu')
  assert.ok(lease)
  assert.equal(m.used('gpu'), 2)
  lease.release()
  assert.equal(m.used('gpu'), 1)
})

test('a mismatched child provider cancels the reservation', async () => {
  const m = manager()
  const reservation = m.reserve({ provider: 'gpu', parentSession: 'p' })
  m.bindChild('p', 'child')
  assert.equal(m.consumeReservation('child', 'other-gpu'), null)
  assert.equal(m.reservations.has(reservation.id), false)
  assert.equal(m.used('gpu'), 0)
})

test('expired reservations release their slot', async () => {
  const m = manager({ now: () => 0, reservationTtlMs: 1000 })
  m.reserve({ provider: 'gpu', parentSession: 'p' })
  assert.equal(m.used('gpu'), 1)
  assert.equal(m.expireReservations(999), 0)
  assert.equal(m.expireReservations(1000), 1)
  assert.equal(m.used('gpu'), 0)
})

test('a failed tool call can cancel its reservation by callId', () => {
  const m = manager()
  m.reserve({ provider: 'gpu', parentSession: 'p', tool: 'subagent', callId: 'call-x' })
  assert.equal(m.used('gpu'), 1)
  assert.equal(m.cancelReservationByCallId('other'), false)
  assert.equal(m.cancelReservationByCallId('call-x'), true)
  assert.equal(m.used('gpu'), 0)
})

test('force release drains the queue and is idempotent', async () => {
  const m = manager()
  const a = await m.acquire({ provider: 'gpu', sessionId: 'a' })
  await m.acquire({ provider: 'gpu', sessionId: 'b' })
  const waiting = m.acquire({ provider: 'gpu', sessionId: 'c' })
  assert.equal(m.forceRelease(a.id), true)
  const c = await waiting
  assert.equal(c.sessionId, 'c')
  assert.equal(a.release(), false)
})

test('queue limit rejects instead of growing without bound', async () => {
  const m = manager({ queueLimitPerProvider: 1 })
  await m.acquire({ provider: 'gpu', sessionId: 'a' })
  await m.acquire({ provider: 'gpu', sessionId: 'b' })
  const first = m.acquire({ provider: 'gpu', sessionId: 'c' })
  await assert.rejects(m.acquire({ provider: 'gpu', sessionId: 'd' }), (e) => e.code === 'CAPACITY_QUEUE_FULL')
  m.cancelWaiter(m.snapshot().providers[0].waiters[0].waiterId)
  await assert.rejects(first, (e) => e.code === 'CAPACITY_CANCELLED')
})

test('an unlimited provider never queues and never rejects a reservation', async () => {
  const m = manager({ limits: [{ provider: 'cloud', unlimited: true }] })
  const leases = await Promise.all(Array.from({ length: 20 }, (_, i) => m.acquire({ provider: 'cloud', sessionId: 's' + i })))
  assert.equal(leases.length, 20)
  assert.equal(m.snapshot().providers.find((p) => p.name === 'cloud').unlimited, true)
  assert.equal(m.snapshot().providers.find((p) => p.name === 'cloud').limit, null)
  const reservation = m.reserve({ provider: 'cloud', parentSession: 'p' })
  assert.ok(reservation)
  for (const lease of leases) lease.release()
})

test('raising a limit drains waiters', async () => {
  const m = manager({ limits: [{ provider: 'gpu', maxConcurrent: 1 }] })
  await m.acquire({ provider: 'gpu', sessionId: 'a' })
  const waiting = m.acquire({ provider: 'gpu', sessionId: 'b' })
  m.configure([{ provider: 'gpu', maxConcurrent: 2 }])
  const b = await waiting
  assert.equal(b.sessionId, 'b')
})

test('snapshot is detached and reports positions', async () => {
  const m = manager()
  await m.acquire({ provider: 'gpu', sessionId: 'a' })
  await m.acquire({ provider: 'gpu', sessionId: 'b' })
  const p = m.acquire({ provider: 'gpu', sessionId: 'c' })
  const snap = m.snapshot()
  assert.equal(snap.totals.active, 2)
  assert.equal(snap.totals.waiting, 1)
  assert.equal(snap.providers[0].waiters[0].position, 1)
  snap.providers[0].active.length = 0
  assert.equal(m.snapshot().totals.active, 2)
  m.cancelWaiter(snap.providers[0].waiters[0].waiterId)
  await assert.rejects(p)
})
