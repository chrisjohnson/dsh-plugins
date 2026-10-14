// Event shapes are session format V4 as dsh 0.2.0-rc.2 writes them:
// `{ type, seq, time, data }` (see SessionEventMap in @deepseek-ai/dsh-session's
// types, whose `turn/start` and `turn/end` carry `{ turn }` and `{ turn, reason }`).

import test from 'node:test'
import assert from 'node:assert/strict'

import { forkSeed } from '../src/session-fork.mjs'

let seq = 0
const event = (type, data) => ({ type, seq: seq++, time: 1700000000000 + seq, data })
const turn = (n, reason = 'completed') => [
  event('turn/start', { turn: n }),
  event('user/message', { turn: n, step: 1 }),
  event('step/start', { turn: n, step: 1 }),
  event('step/end', { turn: n, step: 1 }),
  event('turn/end', { turn: n, reason }),
]
const sessionOf = (events) => ({ snapshotEvents: () => events })

test('the seed is everything through the last completed turn', () => {
  seq = 0
  const events = [...turn(1), ...turn(2)]
  const seed = forkSeed(sessionOf(events))
  assert.equal(seed.length, events.length)
  assert.equal(seed.at(-1).type, 'turn/end')
  assert.equal(seed.at(-1).data.turn, 2)
})

test('an open turn after the last completed one is left out', () => {
  seq = 0
  const events = [...turn(1), event('turn/start', { turn: 2 }), event('user/message', { turn: 2, step: 1 })]
  const seed = forkSeed(sessionOf(events))
  assert.equal(seed.length, 5)
  assert.equal(seed.at(-1).data.turn, 1)
})

test('a session with no completed turn seeds nothing, so the new session starts empty rather than unbalanced', () => {
  seq = 0
  assert.deepEqual(forkSeed(sessionOf([event('turn/start', { turn: 1 })])), [])
  assert.deepEqual(forkSeed(sessionOf([])), [])
})

test('a failing or absent snapshot seeds nothing', () => {
  assert.deepEqual(forkSeed({}), [])
  assert.deepEqual(forkSeed({ snapshotEvents: () => { throw new Error('closed') } }), [])
  assert.deepEqual(forkSeed({ snapshotEvents: () => 'not an array' }), [])
})
