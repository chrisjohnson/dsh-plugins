import test from 'node:test'
import assert from 'node:assert/strict'

import { gatedStream } from '../src/gate.mjs'
import { CapacityManager } from '../src/semaphore.mjs'

function manager() {
  return new CapacityManager({ defaultLimit: 1, limits: [{ provider: 'gpu', maxConcurrent: 1 }], reservationTtlMs: 60_000 })
}

async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

test('acquires before the first chunk and releases after the stream', async () => {
  const m = manager()
  const events = []
  async function* next() {
    events.push('start:' + m.used('gpu'))
    yield 'one'
    events.push('mid:' + m.used('gpu'))
    yield 'two'
  }
  const chunks = await collect(gatedStream(m, { provider: 'gpu', model: 'm', sessionId: 's' }, next, true))
  assert.deepEqual(chunks, ['one', 'two'])
  assert.deepEqual(events, ['start:1', 'mid:1'])
  assert.equal(m.used('gpu'), 0)
})

test('releases when the consumer aborts mid-stream', async () => {
  const m = manager()
  async function* next() {
    yield 1
    yield 2
    yield 3
  }
  const iterator = gatedStream(m, { provider: 'gpu', model: 'm', sessionId: 's' }, next, true)[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value, 1)
  assert.equal(m.used('gpu'), 1)
  await iterator.return()
  assert.equal(m.used('gpu'), 0)
})

test('a queued call waits until the active one releases', async () => {
  const m = manager()
  const order = []
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const first = collect(gatedStream(m, { provider: 'gpu', sessionId: 'a' }, async function* () { order.push('a-start'); await firstGate; yield 'a'; order.push('a-end') }, true))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = collect(gatedStream(m, { provider: 'gpu', sessionId: 'b' }, async function* () { order.push('b-start'); yield 'b' }, true))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(order, ['a-start'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start'])
})

test('a subagent reservation is consumed by the child main call, not by a title call', async () => {
  const m = manager()
  const r = m.reserve({ provider: 'gpu', parentSession: 'p', tool: 'subagent' })
  m.bindChild('p', 'child')
  // Title call first: must not consume; it queues behind the reservation.
  let titleStarted = false
  const title = collect(gatedStream(m, { provider: 'gpu', sessionId: 'child', purpose: 'session-title' }, async function* () { titleStarted = true; yield 't' }, true))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(titleStarted, false)
  assert.equal(m.used('gpu'), 1)
  // Main call consumes the reservation and starts immediately.
  const main = collect(gatedStream(m, { provider: 'gpu', sessionId: 'child' }, async function* () { titleStarted = true; yield 'm' }, true))
  assert.deepEqual(await main, ['m'])
  assert.equal(titleStarted, true)
  assert.equal(m.reservations.has(r.id), false)
  // Title was queued behind the main-call lease; releasing main lets it run.
  await title
  assert.equal(m.used('gpu'), 0)
})

test('disabled mode passes through without acquiring', async () => {
  const m = manager()
  let called = false
  const chunks = await collect(gatedStream(m, { provider: 'gpu', sessionId: 's' }, async function* () { called = true; yield 'x' }, false))
  assert.deepEqual(chunks, ['x'])
  assert.equal(called, true)
  assert.equal(m.used('gpu'), 0)
})
