import test from 'node:test'
import assert from 'node:assert/strict'

import { gatedStream } from '../src/gate.mjs'
import { CapacityManager } from '../src/semaphore.mjs'

function manager() {
  return new CapacityManager({ defaultLimit: 1, limits: [{ provider: 'gpu', maxConcurrent: 1 }] })
}

async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  await tick(5)
  const second = collect(gatedStream(m, { provider: 'gpu', sessionId: 'b' }, async function* () { order.push('b-start'); yield 'b' }, true))
  await tick(10)
  assert.deepEqual(order, ['a-start'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start'])
})

test('a subagent child queues behind an earlier waiter, with no special path', async () => {
  // The property this plugin used to break: a dispatch could take a slot before
  // its child made a request and then jump the queue. Now a child's first call
  // is an ordinary queued call, admitted strictly in arrival order.
  const m = manager()
  const order = []
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const parent = collect(gatedStream(m, { provider: 'gpu', sessionId: 'parent' }, async function* () { order.push('parent'); await firstGate; yield 'p' }, true))
  await tick(5)
  // An interactive call from another session queues first...
  const interactive = collect(gatedStream(m, { provider: 'gpu', sessionId: 'other' }, async function* () { order.push('other'); yield 'o' }, true))
  await tick(5)
  // ...then the child arrives, and it still goes behind it.
  const child = collect(gatedStream(m, { provider: 'gpu', sessionId: 'child' }, async function* () { order.push('child'); yield 'c' }, true))
  await tick(5)
  assert.deepEqual(order, ['parent'])
  const waiters = m.snapshot().providers[0].waiters
  assert.deepEqual(waiters.map((w) => w.sessionId), ['other', 'child'])
  releaseFirst()
  await Promise.all([parent, interactive, child])
  assert.deepEqual(order, ['parent', 'other', 'child'])
  assert.equal(m.used('gpu'), 0)
})

test('a title call for a child session takes the normal queue', async () => {
  // Auxiliary calls used to be excluded from consuming a reservation; with no
  // reservation they are ordinary calls, distinguishable only by their kind.
  const m = manager()
  const order = []
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const running = collect(gatedStream(m, { provider: 'gpu', sessionId: 'busy' }, async function* () { order.push('busy'); await firstGate; yield 'b' }, true))
  await tick(5)
  const titled = collect(gatedStream(m, { provider: 'gpu', sessionId: 'child', purpose: 'session-title' }, async function* () { order.push('title'); yield 't' }, true))
  await tick(5)
  assert.deepEqual(order, ['busy'])
  assert.equal(m.snapshot().providers[0].waiters[0].kind, 'session-title')
  releaseFirst()
  await Promise.all([running, titled])
  assert.deepEqual(order, ['busy', 'title'])
})

test('disabled mode passes through without acquiring', async () => {
  const m = manager()
  let called = false
  const chunks = await collect(gatedStream(m, { provider: 'gpu', sessionId: 's' }, async function* () { called = true; yield 'x' }, false))
  assert.deepEqual(chunks, ['x'])
  assert.equal(called, true)
  assert.equal(m.used('gpu'), 0)
})
