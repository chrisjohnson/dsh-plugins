// What the board derives about a ticket: attempt wording, progress segments,
// working time, session jump targets and closed ordering. Pure functions, plus
// one pass through a real store to prove the telemetry reads feed them.

import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import {
  attemptLabel,
  attentionIntervals,
  closedNewestFirst,
  jumpSession,
  phaseSegments,
  phaseSessions,
  sessionTitle,
  workingMs,
} from '../src/board-view.mjs'

test('attemptLabel says nothing on the first attempt, then counts in words', () => {
  assert.equal(attemptLabel(0), null)
  assert.equal(attemptLabel(1), null)
  assert.equal(attemptLabel(undefined), null)
  assert.equal(attemptLabel(2), 'second attempt')
  assert.equal(attemptLabel(3), 'third attempt')
  assert.equal(attemptLabel(12), 'twelfth attempt')
  assert.equal(attemptLabel(13), '13th attempt')
  assert.equal(attemptLabel(21), '21st attempt')
  assert.equal(attemptLabel(112), '112th attempt')
})

const states = (segments) => segments.map((s) => `${s.phase}:${s.state}`)

test('a ticket with no rework shows the five straight-line segments', () => {
  const segments = phaseSegments({ transitions: [{ from: 'plan', to: 'implement' }], phase: 'implement', column: 'working' })
  assert.deepEqual(states(segments), ['plan:done', 'implement:current', 'review:todo', 'verify:todo', 'closed:todo'])
})

test('a second implement/review round shows seven segments, four filled and three light', () => {
  const transitions = [
    { from: 'plan', to: 'implement' },
    { from: 'implement', to: 'review' },
    { from: 'review', to: 'implement' },
  ]
  const segments = phaseSegments({ transitions, phase: 'implement', column: 'working' })
  assert.deepEqual(states(segments), [
    'plan:done', 'implement:done', 'review:done', 'implement:current', 'review:todo', 'verify:todo', 'closed:todo',
  ])
  assert.equal(segments.length, 7)
  assert.equal(segments.filter((s) => s.state !== 'todo').length, 4)
  assert.equal(segments.filter((s) => s.state === 'todo').length, 3)
  assert.deepEqual(segments.map((s) => s.round), [1, 1, 1, 2, 2, 1, 1])
})

test('a closed ticket fills every segment of the path it took', () => {
  const transitions = [
    { from: 'plan', to: 'implement' }, { from: 'implement', to: 'review' }, { from: 'review', to: 'implement' },
    { from: 'implement', to: 'review' }, { from: 'review', to: 'verify' }, { from: 'verify', to: 'closed' },
  ]
  const segments = phaseSegments({ transitions, phase: 'closed', column: 'done' })
  assert.equal(segments.length, 7)
  assert.ok(segments.every((s) => s.state === 'done'))
})

test('a follow-up plan from approval adds the rounds it will take', () => {
  const transitions = [
    { from: 'plan', to: 'implement' }, { from: 'implement', to: 'review' }, { from: 'review', to: 'verify' },
    { from: 'verify', to: 'plan' },
  ]
  const segments = phaseSegments({ transitions, phase: 'plan', column: 'working' })
  assert.deepEqual(states(segments), [
    'plan:done', 'implement:done', 'review:done', 'verify:done', 'plan:current',
    'implement:todo', 'review:todo', 'verify:todo', 'closed:todo',
  ])
})

test('a history that disagrees with the ticket falls back to the straight path', () => {
  const segments = phaseSegments({ transitions: [], phase: 'review', column: 'working' })
  assert.deepEqual(states(segments), ['plan:done', 'implement:done', 'review:current', 'verify:todo', 'closed:todo'])
  const fresh = phaseSegments({ transitions: undefined, phase: 'plan', column: 'backlog' })
  assert.deepEqual(states(fresh), ['plan:current', 'implement:todo', 'review:todo', 'verify:todo', 'closed:todo'])
})

const at = (ms) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + ms).toISOString()
const span = (kind, from, to, status = 'ok') => ({ kind, status, startedAt: at(from), endedAt: to === null ? null : at(to) })
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0) + 1_000_000

test('working time sums spans and counts overlapping ones once', () => {
  const spans = [span('agent', 0, 100_000), span('judge', 50_000, 150_000), span('tool', 300_000, 310_000), span('wait', 0, 900_000)]
  assert.equal(workingMs({ spans, events: [], now: NOW }), 160_000)
})

test('a running span counts up to now and a closed ticket stops at its close time', () => {
  assert.equal(workingMs({ spans: [span('agent', 0, null)], events: [], now: NOW }), 1_000_000)
  assert.equal(workingMs({ spans: [span('agent', 0, null)], events: [], now: NOW, endAt: Date.parse(at(250_000)) }), 250_000)
})

test('time parked for attention is not working time', () => {
  const events = [
    { id: 1, at: at(100_000), kind: 'needs_attention' },
    { id: 2, at: at(400_000), kind: 'attention_cleared' },
  ]
  // The span runs 0..600k; 300k of it sat parked.
  assert.equal(workingMs({ spans: [span('agent', 0, 600_000)], events, now: NOW }), 300_000)
})

test('a turn paused on a question or approval does not accrue working time', () => {
  const events = [
    { id: 1, at: at(200_000), kind: 'human_wait_started' },
    { id: 2, at: at(500_000), kind: 'human_wait_ended' },
  ]
  assert.equal(workingMs({ spans: [span('agent', 0, 700_000)], events, now: NOW }), 400_000)
  // Still waiting right now: the open wait runs to now.
  const open = [{ id: 1, at: at(200_000), kind: 'human_wait_started' }]
  assert.equal(workingMs({ spans: [span('agent', 0, null)], events: open, now: NOW }), 200_000)
})

test('a park still open when the ticket closed ends at the close time; a column move ends it too', () => {
  const parked = [{ id: 1, at: at(100_000), kind: 'needs_attention' }]
  assert.equal(workingMs({ spans: [span('agent', 0, 900_000)], events: parked, now: NOW, endAt: Date.parse(at(500_000)) }), 100_000)
  const moved = [{ id: 1, at: at(100_000), kind: 'needs_attention' }, { id: 2, at: at(300_000), kind: 'column_changed' }]
  assert.deepEqual(attentionIntervals(moved, Date.parse(at(900_000))), [[Date.parse(at(100_000)), Date.parse(at(300_000))]])
})

test('a ticket with no spans has no working time', () => {
  assert.equal(workingMs({ spans: [], events: [], now: NOW }), 0)
})

const S = (sessionId, purpose, role = purpose === 'plan' ? 'planner' : 'implementer') => ({ sessionId, purpose, role })

test('plan opens the second plan session; implement, review and approval open the build session', () => {
  const targets = phaseSessions([S('p1', 'plan'), S('p2', 'plan'), S('b1', 'build')])
  assert.deepEqual(targets, { plan: 'p2', implement: 'b1', review: 'b1', verify: 'b1', closed: null })
})

test('a step with no session of its kind has no target', () => {
  assert.deepEqual(phaseSessions([S('p1', 'plan')]), { plan: 'p1', implement: null, review: null, verify: null, closed: null })
  assert.deepEqual(phaseSessions([]), { plan: null, implement: null, review: null, verify: null, closed: null })
})

test('the card jumps to the active session, else the latest one', () => {
  const sessions = [S('p1', 'plan'), S('b1', 'build'), S('b2', 'build')]
  assert.equal(jumpSession(sessions, ['b1']), 'b1')
  assert.equal(jumpSession(sessions, []), 'b2')
  assert.equal(jumpSession([], []), null)
  assert.equal(jumpSession(sessions, ['elsewhere']), 'b2')
})

test('Done and Discarded interleave, newest closed first', () => {
  const items = [
    { id: 'a', closedAt: at(100) }, { id: 'b', closedAt: at(300) }, { id: 'c', closedAt: null, updatedAt: at(200) },
  ]
  assert.deepEqual(closedNewestFirst(items).map((i) => i.id), ['b', 'c', 'a'])
})

test('a workflow session title is "<ticket id> · <session type> · <ticket title>"', () => {
  assert.equal(sessionTitle({ key: 'KAN-9', title: 'Fix  the\nboard' }, 'build'), 'KAN-9 · build · Fix the board')
  assert.equal(sessionTitle({ key: 'KAN-9', title: '  ' }, 'plan'), 'KAN-9 · plan')
})

test('the store hands the board a ticket phase path, attention events, spans and sessions in one read', () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const a = store.createTicket({ title: 'a', column: 'working' })
  const b = store.createTicket({ title: 'b' })
  store.transitionTicket(a.id, { phase: 'implement' })
  store.transitionTicket(a.id, { phase: 'review' })
  store.transitionTicket(a.id, { phase: 'implement' })
  store.setNeedsAttention(a.id, 'stuck')
  store.appendEvent(a.id, 'human_wait_started', { actor: 'engine' })
  store.attachSession({ ticketId: a.id, dshSessionId: 'sess-1', role: 'planner', purpose: 'plan' })
  store.attachSession({ ticketId: a.id, dshSessionId: 'sess-2', role: 'implementer', purpose: 'build' })
  const span = store.startSpan({ ticketId: a.id, kind: 'agent', name: 'implement' })
  store.endSpan(span.id, { status: 'ok' })

  const all = store.boardTelemetry()
  const t = all.get(a.id)
  assert.deepEqual(t.transitions.map((x) => `${x.from}>${x.to}`), ['plan>implement', 'implement>review', 'review>implement'])
  assert.deepEqual(t.events.map((e) => e.kind).filter((k) => k.includes('attention') || k.includes('wait')), ['needs_attention', 'human_wait_started'])
  assert.equal(t.spans.length, 1)
  assert.deepEqual(t.sessions.map((s) => s.sessionId), ['sess-1', 'sess-2'])
  assert.equal(all.get(b.id), undefined, 'a ticket with no recorded history has no telemetry entry')
  assert.deepEqual([...store.boardTelemetry(b.id).keys()], [])
  assert.deepEqual([...store.boardTelemetry(a.id).keys()], [a.id])
  const segments = phaseSegments({ transitions: t.transitions, phase: 'implement', column: 'working' })
  assert.equal(segments.length, 7)
})
