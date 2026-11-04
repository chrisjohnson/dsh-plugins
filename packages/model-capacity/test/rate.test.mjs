import test from 'node:test'
import assert from 'node:assert/strict'

import { RateBook, RateMeter, estimateChunkTokens, leaseRate, observeChunk, reconcileUsage } from '../src/rate.mjs'

const T0 = 1_700_000_000_000

function meter(startMs = T0) {
  let now = startMs
  const m = new RateMeter({ now: () => now })
  return { m, at: (ms) => { now = ms }, advance: (ms) => { now += ms } }
}

test('a steady stream reads as its rate over every window once the windows are full', () => {
  const { m, at } = meter()
  // 50 tokens every second for 4000 s.
  for (let s = 0; s < 4000; s += 1) m.add(50, T0 + s * 1000 + 500)
  const now = T0 + 3999 * 1000 + 900
  at(now)
  const summary = m.summary(now)
  assert.equal(summary.avg1m, 50)
  assert.equal(summary.avg5m, 50)
  assert.equal(summary.avg1h, 50)
  assert.equal(summary.totalTokens, 200000)
})

test('a fresh meter is not diluted by time it never saw', () => {
  const { m } = meter()
  m.add(100, T0 + 100)
  m.add(100, T0 + 1100)
  // 200 tokens over the 2.0 s this meter has existed, not over 60 s or 1 h.
  const summary = m.summary(T0 + 2000)
  assert.equal(summary.avg1m, 100)
  assert.equal(summary.avg1h, 100)
})

test('idle time inside a window lowers the average and the instant rate drops to zero', () => {
  const { m } = meter()
  for (let s = 0; s < 30; s += 1) m.add(100, T0 + s * 1000)
  const at = T0 + 90 * 1000
  // 3000 tokens in the trailing 60 s window that holds 30 s of traffic... the traffic ended 60 s ago.
  assert.equal(m.rate(3, at), 0)
  assert.equal(Math.round(m.rate(120, at) * 10) / 10, Math.round((3000 / 90) * 10) / 10)
})

test('buckets older than the horizon are overwritten, not summed', () => {
  const { m } = meter()
  m.add(1000, T0)
  // Exactly one horizon later the same ring slot is reused by a new second.
  m.add(5, T0 + 3600 * 1000)
  assert.equal(m.counts[Math.floor(T0 / 1000) % 3600], 5)
  // The 1000 tokens from a full horizon ago are gone; only the 5 remain.
  assert.equal(m.rate(3600, T0 + 3601 * 1000 + 100), 5 / 3600)
})

test('memory is fixed: recording a million events never grows the ring', () => {
  const { m } = meter()
  const bytes = m.counts.byteLength + m.stamps.byteLength
  for (let i = 0; i < 1_000_000; i += 1) m.add(1, T0 + (i % 7200) * 1000)
  assert.equal(m.counts.byteLength + m.stamps.byteLength, bytes)
  assert.equal(m.counts.length, 3600)
})

test('recording is constant work: a million adds finish well inside a second of CPU', () => {
  const { m } = meter()
  const started = process.hrtime.bigint()
  for (let i = 0; i < 1_000_000; i += 1) m.add(1, T0 + i)
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  assert.ok(ms < 1000, `1e6 adds took ${ms} ms`)
})

test('a negative correction cannot push a reported rate below zero', () => {
  const { m } = meter()
  m.add(10, T0 + 100)
  m.add(-50, T0 + 200)
  assert.equal(m.rate(3, T0 + 900), 0)
})

test('non-finite and zero amounts are ignored', () => {
  const { m } = meter()
  m.add(Number.NaN, T0)
  m.add(Infinity, T0)
  m.add(0, T0)
  assert.equal(m.total, 0)
})

test('the book keeps one global and one per-provider meter, created on first use', () => {
  let now = T0
  const book = new RateBook({ now: () => now })
  book.add('a', 40, T0 + 100)
  book.add('b', 60, T0 + 200)
  now = T0 + 1000
  assert.equal(book.summary(now).totalTokens, 100)
  assert.equal(book.providerSummary('a', now).totalTokens, 40)
  assert.equal(book.providerSummary('b', now).totalTokens, 60)
  assert.equal(book.providerSummary('never-used', now), null)
})

test('history is oldest-first, one value per second, with idle seconds read as zero', () => {
  const { m } = meter()
  m.add(40, T0 + 100)
  m.add(30, T0 + 2100)
  // Seconds 0..4 of this meter: traffic in 0 and 2, nothing in 1, 3 and 4.
  assert.deepEqual(m.history(5, T0 + 4500), [40, 0, 30, 0, 0])
})

test('history never reaches back before the meter started', () => {
  const { m } = meter()
  m.add(12, T0 + 100)
  // Two seconds old, asked for 60: the series is the two seconds it has lived.
  assert.deepEqual(m.history(60, T0 + 1500), [12, 0])
  assert.equal(m.history(60, T0 + 61 * 1000).length, 60)
})

test('a full window of steady traffic reads as 60 equal buckets', () => {
  const { m } = meter()
  for (let s = 0; s < 120; s += 1) m.add(10, T0 + s * 1000 + 500)
  const series = m.history(60, T0 + 119 * 1000 + 500)
  assert.equal(series.length, 60)
  assert.deepEqual(series, new Array(60).fill(10))
})

test('a correction that drives a bucket below zero is reported, not floored', () => {
  const { m } = meter()
  m.add(100, T0 + 100)
  // The usage chunk arrives a second later and says the call made only 60 tokens.
  m.add(-40, T0 + 1100)
  assert.deepEqual(m.history(3, T0 + 1200), [100, -40])
  // A bucket can be pushed under zero outright; the sign survives into the series.
  m.add(5, T0 + 2100)
  m.add(-30, T0 + 2100)
  assert.deepEqual(m.history(3, T0 + 2200), [100, -40, -25])
})

test('the history60 series the snapshot ships is providerHistory at 60 buckets', () => {
  let now = T0
  const book = new RateBook({ now: () => now })
  book.add('p1', 24, T0 + 100)
  book.add('p2', 6, T0 + 100)
  now = T0 + 1000
  assert.deepEqual(book.providerHistory('p1', 60, now), [24, 0])
  assert.deepEqual(book.providerHistory('p2', 60, now), [6, 0])
  // A provider that has never streamed has no series to draw at all.
  assert.equal(book.providerHistory('never-used', 60, now), null)
})

test('streamed fragments are estimated by length; other chunks add nothing', () => {
  assert.equal(estimateChunkTokens({ type: 'text-delta', index: 0, text: 'abcdefgh' }), 2)
  assert.equal(estimateChunkTokens({ type: 'reasoning-delta', index: 0, text: 'abcd' }), 1)
  assert.equal(estimateChunkTokens({ type: 'tool-call-delta', index: 0, id: 'x', name: 'ab', argumentsDelta: '{"a":' }), 7 / 4)
  assert.equal(estimateChunkTokens({ type: 'block-start', index: 0 }), 0)
  assert.equal(estimateChunkTokens({ type: 'finish', reason: 'stop' }), 0)
  assert.equal(estimateChunkTokens(null), 0)
  assert.equal(estimateChunkTokens({ type: 'text-delta', text: 42 }), 0)
})

test('usage reconciles the streamed estimate to the provider count, in either direction', () => {
  assert.equal(reconcileUsage({ type: 'usage', usage: { inputTokens: 10, outputTokens: 120 } }, 100), 20)
  assert.equal(reconcileUsage({ type: 'usage', usage: { inputTokens: 10, outputTokens: 80 } }, 100), -20)
  assert.equal(reconcileUsage({ type: 'usage', usage: { inputTokens: 10 } }, 100), null)
  assert.equal(reconcileUsage({ type: 'text-delta', text: 'x' }, 0), null)
})

test('a call that streams nothing but reports usage still counts its output', () => {
  const lease = {}
  assert.equal(observeChunk(lease, { type: 'usage', usage: { inputTokens: 1, outputTokens: 64 } }, T0), 64)
  assert.equal(lease.outputTokens, 64)
})

test('after usage the lease total equals the provider count exactly', () => {
  const lease = {}
  let total = 0
  for (const text of ['hello wor', 'ld, this is', ' a longer fragment']) total += observeChunk(lease, { type: 'text-delta', index: 0, text }, T0)
  total += observeChunk(lease, { type: 'usage', usage: { inputTokens: 5, outputTokens: 11 } }, T0 + 10)
  assert.equal(lease.outputTokens, 11)
  assert.ok(Math.abs(total - 11) < 1e-9)
})

test('a lease rate needs half a second of output and decays while the call stalls', () => {
  const lease = {}
  observeChunk(lease, { type: 'text-delta', index: 0, text: 'x'.repeat(40) }, T0)
  assert.equal(leaseRate(lease, T0 + 100), null)
  assert.equal(leaseRate(lease, T0 + 1000), 10)
  assert.equal(leaseRate(lease, T0 + 10000), 1)
  assert.equal(leaseRate({}, T0), null)
})
