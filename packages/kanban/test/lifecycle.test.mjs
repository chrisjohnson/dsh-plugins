import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COLUMNS,
  PHASES,
  canTransitionColumn,
  canTransitionPhase,
  assertTransition,
  compareQueue,
  cardStatus,
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

test('columns are intended state: backlog <-> working, both close to done/discarded', () => {
  assert.deepEqual(COLUMNS, ['backlog', 'working', 'done', 'discarded'])
  assert.equal(canTransitionColumn('backlog', 'working'), true)
  assert.equal(canTransitionColumn('working', 'backlog'), true)
  assert.equal(canTransitionColumn('backlog', 'done'), true)
  assert.equal(canTransitionColumn('working', 'done'), true)
  assert.equal(canTransitionColumn('backlog', 'discarded'), true)
  assert.equal(canTransitionColumn('working', 'discarded'), true)
  assert.equal(canTransitionColumn('done', 'working'), false)
  assert.equal(canTransitionColumn('discarded', 'backlog'), false)
})

test('ticket modes are two independent choices', () => {
  assert.equal(validateTicketModes('now', 'interactive').ok, true)
  assert.equal(validateTicketModes('at_pickup', 'autonomous').ok, true)
  assert.equal(validateTicketModes('later', 'interactive').ok, false)
  assert.equal(validateTicketModes('now', 'maybe').ok, false)
})

test('column and phase moves are checked', () => {
  const from = { column: 'working', phase: 'implement' }
  assert.equal(assertTransition(from, { column: 'working', phase: 'review' }).ok, true)
  assert.equal(assertTransition(from, { column: 'working', phase: 'verify' }).ok, false)
  assert.equal(canTransitionColumn('backlog', 'working'), true)
  assert.equal(canTransitionColumn('done', 'working'), false)
  assert.equal(assertTransition({ column: 'working', phase: 'verify' }, { column: 'done', phase: 'closed' }).ok, true)
  assert.equal(assertTransition(from, { column: 'done', phase: 'closed' }).ok, false)
})

test('queue order', () => {
  const a = { priority: 1, createdAt: 'a' }
  const b = { priority: 2, createdAt: 'b' }
  assert.ok(compareQueue(b, a) < 0)
})

test('card status is computed, never a column', () => {
  const idle = { column: 'working', needsAttentionReason: null }
  assert.equal(cardStatus(idle), 'idle')
  assert.equal(cardStatus(idle, { active: true }), 'active')
  assert.equal(cardStatus({ column: 'backlog', needsAttentionReason: 'boom' }), 'attention')
  // attention outranks active: a human turn on a parked ticket is handled by
  // the engine clearing the park, not by the status helper.
  assert.equal(cardStatus({ column: 'backlog', needsAttentionReason: 'boom' }, { active: true }), 'attention')
  assert.equal(cardStatus(idle, { awaitingUser: true }), 'attention')
})
