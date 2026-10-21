import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from '../src/db.mjs'
import { KanbanStore, StoreError } from '../src/store.mjs'

function fresh() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const events = []
  const store = new KanbanStore(db, { onEvent: (e) => events.push(e) })
  return { db, store, events }
}

test('createTicket assigns KAN keys and backlog/intake', () => {
  const { store } = fresh()
  const a = store.createTicket({ title: 'first' })
  const b = store.createTicket({ title: 'second' })
  assert.equal(a.key, 'KAN-1')
  assert.equal(b.key, 'KAN-2')
  assert.equal(a.column, 'backlog')
  assert.equal(a.phase, 'intake')
  assert.equal(a.version, 1)
  assert.ok(b.sortOrder > a.sortOrder)
})

test('illegal modes are rejected at the store, not the UI', () => {
  const { store } = fresh()
  assert.throws(() => store.createTicket({ title: 'x', grillMode: 'at_pickup', planMode: 'now' }), (e) => e.code === 'invalid_modes')
  const t = store.createTicket({ title: 'x' })
  assert.throws(() => store.updateTicket(t.id, { grillMode: 'at_pickup', planMode: 'now' }), (e) => e.code === 'invalid_modes')
})

test('allow_paid needs a positive budget', () => {
  const { store } = fresh()
  assert.throws(() => store.createTicket({ title: 'x', allowPaid: true, budgetUsd: 0 }), StoreError)
})

test('every mutation bumps version and writes an event', () => {
  const { store, events } = fresh()
  const t = store.createTicket({ title: 'x' })
  const before = store.listEvents(t.id).length
  const moved = store.transitionTicket(t.id, { column: 'now', phase: 'triage' }, { actor: 'human', reason: 'drag' })
  assert.equal(moved.version, t.version + 1)
  assert.equal(store.listEvents(t.id).length, before + 1)
  assert.ok(events.some((e) => e.kind === 'column_changed'))
})

test('invalid transitions are refused with a reason', () => {
  const { store } = fresh()
  const t = store.createTicket({ title: 'x' })
  assert.throws(() => store.transitionTicket(t.id, { phase: 'review' }), (e) => e.code === 'invalid_transition')
  store.transitionTicket(t.id, { column: 'now', phase: 'triage' })
  store.transitionTicket(t.id, { phase: 'implement' })
  store.transitionTicket(t.id, { phase: 'verify' })
  store.transitionTicket(t.id, { phase: 'review' })
  store.transitionTicket(t.id, { column: 'done', phase: 'closed' })
  assert.throws(() => store.transitionTicket(t.id, { column: 'now' }), /terminal/)
})

test('acceptance is stored verbatim and ordered', () => {
  const { store } = fresh()
  const t = store.createTicket({ title: 'x', acceptance: ['build me a video game', 'must not crash'] })
  const rows = store.listAcceptance(t.id)
  assert.deepEqual(rows.map((r) => r.statement), ['build me a video game', 'must not crash'])
  assert.equal(rows[0].source, 'human')
  store.addAcceptance(t.id, 'refined: level 1 loads', 'grill')
  assert.equal(store.listAcceptance(t.id)[2].source, 'grill')
})

test('conditions are versioned per plan', () => {
  const { store } = fresh()
  const t = store.createTicket({ title: 'x' })
  store.replaceConditions(t.id, 1, [{ id: 'a', statement: 's', howVerified: 'v' }])
  store.replaceConditions(t.id, 2, [{ id: 'b', statement: 's2', howVerified: 'v2' }])
  assert.equal(store.currentPlanVersion(t.id), 2)
  assert.deepEqual(store.listConditions(t.id).map((c) => c.id), ['b'])
  assert.deepEqual(store.listConditions(t.id, 1).map((c) => c.id), ['a'])
})

test('needs_attention stores the reason and clears on the way out', () => {
  const { store } = fresh()
  const t = store.createTicket({ title: 'x' })
  store.transitionTicket(t.id, { column: 'now', phase: 'triage' })
  store.transitionTicket(t.id, { phase: 'implement' })
  store.setNeedsAttention(t.id, 'verification deadlock')
  assert.equal(store.getTicket(t.id).column, 'needs_attention')
  assert.equal(store.getTicket(t.id).needsAttentionReason, 'verification deadlock')
  store.transitionTicket(t.id, { column: 'now', phase: 'implement' }, { actor: 'human' })
  assert.equal(store.getTicket(t.id).needsAttentionReason, null)
})

test('sessions attach, detach and retro-attach once', () => {
  const { store } = fresh()
  const t = store.createTicket({ title: 'x' })
  store.attachSession({ ticketId: t.id, dshSessionId: 's1', role: 'implementer' })
  store.attachSession({ ticketId: null, dshSessionId: 's2', role: 'reviewer' })
  assert.equal(store.listSessions(t.id).length, 1)
  assert.equal(store.orphanSessions().length, 1)
  store.attachSession({ ticketId: t.id, dshSessionId: 's2', role: 'reviewer' })
  assert.equal(store.listSessions(t.id).length, 2)
  store.detachSession('s1')
  assert.equal(store.listSessions(t.id).length, 1)
  store.attachSession({ ticketId: t.id, dshSessionId: 's1', role: 'implementer' })
  assert.equal(store.listSessions(t.id).length, 2)
})

test('usage rollup distinguishes unpriced from zero', () => {
  const { store } = fresh()
  const t = store.createTicket({ title: 'x' })
  const priced = store.startSpan({ ticketId: t.id, kind: 'agent', name: 'a', role: 'implementer', provider: 'p', model: 'm' })
  store.recordUsage({ spanId: priced.id, provider: 'p', model: 'm', inputTokens: 100, outputTokens: 20, costUsd: 0.5, priceVersion: 'v1' })
  const unpriced = store.startSpan({ ticketId: t.id, kind: 'agent', name: 'b', role: 'verifier', provider: 'q', model: 'n' })
  store.recordUsage({ spanId: unpriced.id, provider: 'q', model: 'n', inputTokens: 10, outputTokens: 5, costUsd: null })
  const rollup = store.rollup(t.id)
  assert.equal(rollup.inputTokens, 110)
  assert.equal(rollup.costUsd, 0.5)
  assert.equal(rollup.unpriced, true)
  assert.equal(rollup.byModel['q/n'].costUsd, 0)
})

test('span status is durable', () => {
  const { store } = fresh()
  const t = store.createTicket({ title: 'x' })
  const span = store.startSpan({ ticketId: t.id, kind: 'agent', name: 'a' })
  assert.equal(store.runningSpans().length, 1)
  store.endSpan(span.id, { status: 'abandoned', error: 'stalled', durationMs: 123 })
  assert.equal(store.runningSpans().length, 0)
  assert.equal(store.listSpans(t.id)[0].status, 'abandoned')
})

test('there is no config table in the schema', () => {
  const { db } = fresh()
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  for (const forbidden of ['providers', 'roles', 'prompts', 'settings', 'config', 'models', 'prices']) {
    assert.equal(names.includes(forbidden), false, `unexpected config table ${forbidden}`)
  }
  for (const required of ['tickets', 'acceptance', 'conditions', 'sessions', 'events', 'spans', 'usage', 'verifications', 'runs', 'artifacts']) {
    assert.ok(names.includes(required), `missing ${required}`)
  }
})

test('artifacts can be pruned and exports read what the tests read', () => {
  const { store } = fresh()
  const t = store.createTicket({ title: 'x' })
  store.addArtifact(t.id, 'plan', JSON.stringify({ a: 1 }))
  store.db.prepare('UPDATE artifacts SET created_at = ?').run('2000-01-01T00:00:00.000Z')
  assert.equal(store.pruneArtifacts('2001-01-01T00:00:00.000Z'), 1)
  assert.equal(store.listArtifacts(t.id).length, 0)
})
