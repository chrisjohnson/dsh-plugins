import test from 'node:test'
import assert from 'node:assert/strict'

import { gatedStream } from '../src/gate.mjs'
import { CapacityManager } from '../src/semaphore.mjs'
import { RateBook, observeChunk } from '../src/rate.mjs'

function manager() {
  return new CapacityManager({ defaultLimit: 1, limits: [{ provider: 'gpu', maxConcurrent: 1 }] })
}

async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

test('a tap sees every chunk with the live lease and the stream is passed through unchanged', async () => {
  const m = manager()
  const seen = []
  const tap = (lease, chunk) => seen.push([lease.provider, lease.released, chunk])
  async function* next() {
    yield 'one'
    yield 'two'
  }
  const chunks = await collect(gatedStream(m, { provider: 'gpu', sessionId: 's' }, next, true, tap))
  assert.deepEqual(chunks, ['one', 'two'])
  assert.deepEqual(seen, [['gpu', false, 'one'], ['gpu', false, 'two']])
  assert.equal(m.used('gpu'), 0)
})

test('a throwing tap never breaks the call or leaks the slot', async () => {
  const m = manager()
  async function* next() {
    yield 1
    yield 2
  }
  const chunks = await collect(gatedStream(m, { provider: 'gpu' }, next, true, () => { throw new Error('meter bug') }))
  assert.deepEqual(chunks, [1, 2])
  assert.equal(m.used('gpu'), 0)
})

test('a tapped stream still releases when the consumer stops early or the stream fails', async () => {
  const m = manager()
  async function* many() {
    yield 1
    yield 2
  }
  const iterator = gatedStream(m, { provider: 'gpu' }, many, true, () => {})[Symbol.asyncIterator]()
  await iterator.next()
  assert.equal(m.used('gpu'), 1)
  await iterator.return()
  assert.equal(m.used('gpu'), 0)
  async function* boom() {
    yield 1
    throw new Error('adapter failed')
  }
  await assert.rejects(collect(gatedStream(m, { provider: 'gpu' }, boom, true, () => {})), /adapter failed/)
  assert.equal(m.used('gpu'), 0)
})

test('an inert gate still meters the call but holds no slot', async () => {
  const m = manager()
  const seen = []
  async function* next() {
    yield 'x'
  }
  const chunks = await collect(gatedStream(m, { provider: 'gpu', model: 'm' }, next, false, (lease, chunk) => seen.push([lease.provider, lease.model, chunk])))
  assert.deepEqual(chunks, ['x'])
  assert.deepEqual(seen, [['gpu', 'm', 'x']])
  assert.equal(m.used('gpu'), 0)
})

test('the snapshot reports each active call\'s streamed tokens and live rate', async () => {
  let now = 1_000_000
  const m = new CapacityManager({ defaultLimit: 2, limits: [], now: () => now })
  const lease = await m.acquire({ provider: 'gpu', model: 'm', sessionId: 's' })
  lease.outputTokens = 50
  lease.firstOutputAt = now
  now += 2000
  const [entry] = m.snapshot().providers[0].active
  assert.equal(entry.outputTokens, 50)
  assert.equal(entry.tokensPerSec, 25)
})

test('two concurrent streams add up in the global meter and stay separate per provider', async () => {
  let now = 5_000_000
  const book = new RateBook({ now: () => now })
  const m = new CapacityManager({ defaultLimit: 2, limits: [], now: () => now })
  const tap = (lease, chunk) => {
    const delta = observeChunk(lease, chunk, now)
    if (delta !== 0) book.add(lease.provider, delta, now)
  }
  const frag = { type: 'text-delta', index: 0, text: 'x'.repeat(40) } // 10 tokens
  async function* stream() {
    for (let i = 0; i < 5; i += 1) {
      now += 1000
      yield frag
    }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 50 } }
  }
  const a = collect(gatedStream(m, { provider: 'gpu-a' }, stream, true, tap))
  const b = collect(gatedStream(m, { provider: 'gpu-b' }, stream, true, tap))
  await Promise.all([a, b])
  assert.equal(book.summary(now).totalTokens, 100)
  assert.equal(book.providerSummary('gpu-a', now).totalTokens, 50)
  assert.equal(book.providerSummary('gpu-b', now).totalTokens, 50)
})
