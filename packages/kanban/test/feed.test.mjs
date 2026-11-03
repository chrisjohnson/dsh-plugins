// The board's push feed, on a manual clock: what it sends and when, and that it
// does nothing while nobody is listening.

import test from 'node:test'
import assert from 'node:assert/strict'

import { BoardFeed } from '../src/feed.mjs'

function rig() {
  let clock = 0
  let next = 1
  const timers = new Map()
  const state = { token: 't1', signature: 's1', seq: 0 }
  const feed = new BoardFeed({
    token: () => state.token,
    build: () => {
      state.seq += 1
      return {
        seq: state.seq,
        boot: 'b',
        token: state.token,
        asOf: clock,
        signature: state.signature,
        board: { counts: {}, columns: { backlog: [], working: [], done: [], discarded: [] }, closed: [] },
      }
    },
    now: () => clock,
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, at: clock + ms }); return id },
    clearTimer: (id) => timers.delete(id),
  })
  const advance = (ms) => {
    const target = clock + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      clock = Math.max(clock, due[1].at)
      timers.delete(due[0])
      due[1].fn()
    }
    clock = target
  }
  const listen = () => {
    const frames = []
    const off = feed.subscribe((line) => frames.push(JSON.parse(line)))
    return { frames, off }
  }
  return { feed, state, timers, advance, listen }
}

test('a subscriber gets the whole board at once, in the shape the board RPC answers', () => {
  const { listen } = rig()
  const { frames } = listen()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].compact, true)
  assert.deepEqual(Object.keys(frames[0].columns).sort(), ['backlog', 'working'])
  assert.deepEqual([frames[0].seq, frames[0].boot, frames[0].token], [1, 'b', 't1'])
})

test('a quiet board sends nothing but a keep-alive, and builds nothing', () => {
  const { feed, advance, listen } = rig()
  const { frames } = listen()
  const built = feed.builds
  advance(14_000)
  assert.equal(frames.length, 1, 'no frame in fourteen quiet seconds')
  assert.equal(feed.builds, built, 'and no rebuild')
  advance(2_000)
  assert.deepEqual(frames[1], { token: 't1' }, 'then a token-only keep-alive')
})

test('a moved token with a changed board sends the board; with the same board it sends only the token', () => {
  const { state, advance, listen } = rig()
  const { frames } = listen()
  state.token = 't2'
  state.signature = 's2'
  advance(1000)
  assert.equal(frames.length, 2)
  assert.equal(frames[1].token, 't2')
  assert.ok(frames[1].columns, 'the board changed, so the board came')
  state.token = 't3'
  advance(1000)
  assert.equal(frames.length, 3)
  assert.deepEqual(frames[2], { token: 't3' }, 'nothing on the board changed: a page showing a ticket is told to look, no more')
})

test('events coalesce: a burst costs one check, soon', () => {
  const { feed, state, advance, listen } = rig()
  const { frames } = listen()
  state.token = 't2'
  state.signature = 's2'
  for (let i = 0; i < 20; i += 1) feed.notify()
  advance(200)
  assert.equal(frames.length, 2, 'one frame for twenty notifications, well inside the tick')
  assert.equal(feed.builds, 2)
})

test('with no subscriber there is no timer and no work', () => {
  const { feed, timers, advance, listen } = rig()
  feed.notify()
  assert.equal(timers.size, 0, 'a notification nobody hears schedules nothing')
  const { off } = listen()
  assert.ok(timers.size > 0)
  off()
  assert.equal(timers.size, 0, 'the last one leaving disarms everything')
  const builds = feed.builds
  advance(60_000)
  assert.equal(feed.builds, builds)
})

test('a new subscriber gets a board read just now, and the others are brought up to date first', () => {
  const { feed, state, listen } = rig()
  const first = listen()
  state.token = 't2'
  state.signature = 's2'
  const second = listen()
  assert.equal(first.frames.length, 2, 'the change the tick had not yet seen reached the first listener')
  assert.equal(second.frames.length, 1)
  assert.equal(second.frames[0].token, 't2')
  assert.equal(feed.size, 2)
})

test('a sink that throws is dropped and the rest keep receiving', () => {
  const { feed, state, advance, listen } = rig()
  let calls = 0
  feed.subscribe(() => { calls += 1; if (calls > 1) throw new Error('gone') })
  const { frames } = listen()
  assert.equal(feed.size, 2)
  state.token = 't2'
  state.signature = 's2'
  advance(1000)
  assert.equal(feed.size, 1)
  assert.equal(frames.length, 2)
})
