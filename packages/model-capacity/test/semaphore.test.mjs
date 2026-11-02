import test from 'node:test'
import assert from 'node:assert/strict'

import { CapacityError, CapacityManager } from '../src/semaphore.mjs'

function manager(overrides = {}) {
  return new CapacityManager({
    defaultLimit: 1,
    limits: [{ provider: 'gpu', maxConcurrent: 2 }],
    queueLimitPerProvider: 10,
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

test('a queued lease records how long it waited', async () => {
  let clock = 1000
  const m = manager({ now: () => clock })
  const a = await m.acquire({ provider: 'gpu', sessionId: 'a' })
  const b = await m.acquire({ provider: 'gpu', sessionId: 'b' })
  const waiting = m.acquire({ provider: 'gpu', sessionId: 'c' })
  clock = 1750
  a.release()
  const c = await waiting
  assert.equal(c.waitedMs, 750)
  b.release(); c.release()
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

test('a session that never calls holds nothing', async () => {
  // The old reservation path let a dispatch hold a slot before its first call.
  // Nothing does now: capacity is only ever held by a live lease, so a child
  // that never starts a request costs nothing and needs no cleanup timer.
  const m = manager()
  const a = await m.acquire({ provider: 'gpu', sessionId: 'a' })
  assert.equal(m.used('gpu'), 1)
  assert.equal(m.freeSlots('gpu'), 1)
  a.release()
  assert.equal(m.used('gpu'), 0)
  assert.equal(m.freeSlots('gpu'), 2)
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

test('an unlimited provider never queues', async () => {
  const m = manager({ limits: [{ provider: 'cloud', unlimited: true }] })
  const leases = await Promise.all(Array.from({ length: 20 }, (_, i) => m.acquire({ provider: 'cloud', sessionId: 's' + i })))
  assert.equal(leases.length, 20)
  assert.equal(m.snapshot().providers.find((p) => p.name === 'cloud').unlimited, true)
  assert.equal(m.snapshot().providers.find((p) => p.name === 'cloud').limit, null)
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
