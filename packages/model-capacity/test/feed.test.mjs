import test from 'node:test'
import assert from 'node:assert/strict'

import { SnapshotFeed } from '../src/feed.mjs'

/** A manual clock and timer wheel so frame timing is exact and nothing sleeps. */
function harness(overrides = {}) {
  let now = 1_000_000
  let seq = 0
  const timers = new Map()
  const state = { n: 0, asOf: 0 }
  const feed = new SnapshotFeed({
    build: () => ({ asOf: now, value: state.n }),
    now: () => now,
    setTimer: (fn, ms) => {
      seq += 1
      timers.set(seq, { fn, at: now + ms })
      return seq
    },
    clearTimer: (id) => timers.delete(id),
    ...overrides,
  })
  const advance = (ms) => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      timers.delete(due[0])
      now = Math.max(now, due[1].at)
      due[1].fn()
    }
    now = target
  }
  return { feed, state, advance, timers, clock: () => now }
}

test('with nobody subscribed there is no timer and no frame', () => {
  const { feed, timers, advance } = harness()
  feed.notify()
  advance(60_000)
  assert.equal(timers.size, 0)
  assert.equal(feed.frames, 0)
})

test('a subscriber gets the current frame at once and a tick timer starts', () => {
  const { feed, timers } = harness()
  const lines = []
  feed.subscribe((line) => lines.push(line))
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).value, 0)
  assert.ok(lines[0].endsWith('\n'))
  assert.equal(timers.size, 1)
})

test('an unchanged snapshot is not re-sent each second, only a keep-alive every 15 s', () => {
  const { feed, advance } = harness()
  const lines = []
  feed.subscribe((line) => lines.push(line))
  advance(14_000)
  assert.equal(lines.length, 1, 'no frames while nothing changed')
  advance(2_000)
  assert.equal(lines.length, 2, 'one keep-alive after 15 s of silence')
})

test('a changed snapshot goes out on the next tick', () => {
  const { feed, state, advance } = harness()
  const lines = []
  feed.subscribe((line) => lines.push(line))
  state.n = 7
  advance(1000)
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[1]).value, 7)
})

test('a burst of events coalesces into one frame within the minimum gap', () => {
  const { feed, state, advance } = harness()
  const lines = []
  feed.subscribe((line) => lines.push(line))
  advance(500)
  state.n = 1
  for (let i = 0; i < 50; i += 1) feed.notify()
  assert.equal(lines.length, 1, 'nothing is sent synchronously')
  advance(150)
  assert.equal(lines.length, 2, 'fifty events, one frame')
  assert.equal(JSON.parse(lines[1]).value, 1)
})

test('an event is delivered no later than the minimum gap after the previous frame', () => {
  const { feed, state, advance } = harness()
  const lines = []
  feed.subscribe((line) => lines.push(line))
  state.n = 1
  feed.notify()
  advance(150)
  const afterFirst = lines.length
  state.n = 2
  feed.notify()
  advance(149)
  assert.equal(lines.length, afterFirst)
  advance(1)
  assert.equal(lines.length, afterFirst + 1)
})

test('every subscriber gets the same frame from a single build', () => {
  let builds = 0
  const { feed, state, advance } = harness({ build: () => ({ asOf: 0, builds: (builds += 1), n: 0 }) })
  const a = []
  const b = []
  feed.subscribe((line) => a.push(line))
  feed.subscribe((line) => b.push(line))
  const before = builds
  state.n = 1
  feed.notify()
  advance(150)
  assert.equal(builds - before, 1)
  assert.equal(a.at(-1), b.at(-1))
})

test('the last unsubscribe stops every timer', () => {
  const { feed, timers } = harness()
  const off1 = feed.subscribe(() => {})
  const off2 = feed.subscribe(() => {})
  feed.notify()
  off1()
  assert.ok(timers.size > 0)
  off2()
  assert.equal(timers.size, 0)
  assert.equal(feed.size, 0)
})

test('a sink that throws is dropped and the others keep receiving', () => {
  const { feed, state, advance } = harness()
  const good = []
  let calls = 0
  feed.subscribe((line) => good.push(line))
  feed.subscribe(() => {
    calls += 1
    if (calls > 1) throw new Error('closed')
  })
  state.n = 1
  advance(1000)
  state.n = 2
  advance(1000)
  assert.equal(feed.size, 1)
  assert.equal(good.length, 3)
})

test('a late subscriber does not make the earlier ones miss a pending change', () => {
  const { feed, state, advance } = harness()
  const first = []
  feed.subscribe((line) => first.push(line))
  state.n = 5
  feed.subscribe(() => {})
  advance(1000)
  assert.equal(JSON.parse(first.at(-1)).value, 5)
})
