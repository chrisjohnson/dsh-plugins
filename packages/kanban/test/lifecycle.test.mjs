import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PHASES,
  canTransitionColumn,
  canTransitionPhase,
  assertTransition,
  compareQueue,
  nowGroup,
  validateTicketModes,
} from '../src/lifecycle.mjs'

test('flat phase order', () => {
  assert.deepEqual(PHASES, ['plan', 'implement', 'review', 'verify', 'closed'])
  assert.equal(canTransitionPhase('plan', 'implement'), true)
  assert.equal(canTransitionPhase('implement', 'review'), true)
  assert.equal(canTransitionPhase('review', 'verify'), true)
  assert.equal(canTransitionPhase('verify', 'closed'), true)
  assert.equal(canTransitionPhase('plan', 'verify'), false)
  assert.equal(canTransitionPhase('review', 'implement'), true)
  assert.equal(canTransitionPhase('verify', 'implement'), true)
})

test('ticket modes are two independent choices', () => {
  assert.equal(validateTicketModes('now', 'interactive').ok, true)
  assert.equal(validateTicketModes('at_pickup', 'autonomous').ok, true)
  assert.equal(validateTicketModes('later', 'interactive').ok, false)
  assert.equal(validateTicketModes('now', 'maybe').ok, false)
})

test('column and phase moves are checked', () => {
  const from = { column: 'now', phase: 'implement' }
  assert.equal(assertTransition(from, { column: 'now', phase: 'review' }).ok, true)
  assert.equal(assertTransition(from, { column: 'now', phase: 'verify' }).ok, false)
  assert.equal(canTransitionColumn('backlog', 'now'), true)
  assert.equal(canTransitionColumn('done', 'now'), false)
  assert.equal(assertTransition({ column: 'now', phase: 'verify' }, { column: 'done', phase: 'closed' }).ok, true)
  assert.equal(assertTransition(from, { column: 'done', phase: 'closed' }).ok, false)
})

test('queue order and UI grouping', () => {
  const a = { priority: 1, createdAt: 'a' }
  const b = { priority: 2, createdAt: 'b' }
  assert.ok(compareQueue(b, a) < 0)
  assert.equal(nowGroup({ column: 'blocked' }), 'blocked')
  assert.equal(nowGroup({ column: 'now' }, { active: true }), 'active')
  assert.equal(nowGroup({ column: 'now' }, { waiting: true }), 'waiting')
})
