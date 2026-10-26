import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertTransition,
  canTransitionColumn,
  canTransitionPhase,
  compareQueue,
  decideAfterFailure,
  grillDue,
  intakePlan,
  nowGroup,
  planDue,
  validateModes,
} from '../src/lifecycle.mjs'

test('the intake table rejects at_pickup grill with now plan', () => {
  assert.equal(validateModes('at_pickup', 'now').ok, false)
  assert.equal(validateModes('now', 'now').ok, true)
  assert.equal(validateModes('judgement', 'at_pickup').ok, true)
})

test('grill and plan fire in the right situation', () => {
  assert.equal(grillDue('now', 'backlog'), true)
  assert.equal(grillDue('now', 'pickup'), false)
  assert.equal(grillDue('at_pickup', 'pickup'), true)
  assert.equal(grillDue('judgement', 'pickup'), 'judge')
  assert.equal(planDue('now', 'backlog'), true)
  assert.equal(planDue('now', 'pickup'), false)
  assert.equal(planDue('at_pickup', 'backlog'), false)
  assert.equal(planDue('one_shot', 'pickup'), false)
})

test('intake plan orders grill before plan', () => {
  const ticket = { phase: 'triage', grillMode: 'at_pickup', planMode: 'at_pickup' }
  assert.deepEqual(intakePlan(ticket, { atPickup: true }), ['grill', 'plan'])
  const now = { phase: 'triage', grillMode: 'now', planMode: 'now' }
  assert.deepEqual(intakePlan(now, { atPickup: false }), ['grill', 'plan'])
})

test('column and phase edges are explicit', () => {
  assert.equal(canTransitionColumn('backlog', 'now'), true)
  assert.equal(canTransitionColumn('now', 'needs_attention'), true)
  assert.equal(canTransitionColumn('done', 'now'), false)
  assert.equal(canTransitionPhase('implement', 'verify'), true)
  assert.equal(canTransitionPhase('plan', 'review'), false)
})

test('terminal columns are sinks', () => {
  const done = { column: 'done', phase: 'closed' }
  assert.equal(assertTransition(done, { column: 'now', phase: 'implement' }).ok, false)
})

test('implementation cannot start from backlog even for the engine', () => {
  const backlog = { column: 'backlog', phase: 'plan' }
  const check = assertTransition(backlog, { column: 'backlog', phase: 'implement' })
  assert.equal(check.ok, false)
  assert.match(check.reason, /pickup/)
})

test('only engine or human may close', () => {
  const now = { column: 'now', phase: 'review' }
  assert.equal(assertTransition(now, { column: 'done', phase: 'closed' }, { actor: 'model' }).ok, false)
  assert.equal(assertTransition(now, { column: 'done', phase: 'closed' }, { actor: 'engine' }).ok, true)
})

test('now groups are explicit', () => {
  assert.equal(nowGroup({ column: 'now', phase: 'implement', needsAttentionReason: null }, { active: true }), 'active')
  assert.equal(nowGroup({ column: 'now', phase: 'grill', needsAttentionReason: null }), 'waiting')
  assert.equal(nowGroup({ column: 'now', phase: 'implement', needsAttentionReason: null }), 'active')
  assert.equal(nowGroup({ column: 'blocked', phase: 'implement', needsAttentionReason: null }), 'blocked')
})

test('priority then FIFO', () => {
  const rows = [
    { priority: 1, sortOrder: 2, createdAt: '2026-01-02' },
    { priority: 2, sortOrder: 9, createdAt: '2026-01-03' },
    { priority: 1, sortOrder: 1, createdAt: '2026-01-01' },
  ]
  assert.deepEqual(rows.sort(compareQueue).map((r) => r.sortOrder), [9, 1, 2])
})

test('attempt exhaustion and paid refusal are mechanical', () => {
  assert.equal(decideAfterFailure({ attempt: 3, maxAttempts: 3, allowPaid: true, budgetUsd: 10, spentUsd: 0, nextEstimateUsd: 1, ladderHasPaidRung: true }).kind, 'needs_attention')
  const paid = decideAfterFailure({ attempt: 2, maxAttempts: 3, allowPaid: false, budgetUsd: 10, spentUsd: 0, nextEstimateUsd: 1, ladderHasPaidRung: true })
  assert.equal(paid.kind, 'needs_attention')
  assert.match(paid.reason, /allow_paid/)
  const retry = decideAfterFailure({ attempt: 1, maxAttempts: 3, allowPaid: false, budgetUsd: 0, spentUsd: 0, nextEstimateUsd: 1, ladderHasPaidRung: false })
  assert.deepEqual(retry, { kind: 'retry', attempt: 2 })
})
