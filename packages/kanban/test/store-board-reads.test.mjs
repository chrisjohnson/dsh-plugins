// The store reads the board and the scheduler lean on: a change token, a
// runnable-only ticket list, scoped telemetry, row-in-hand editability and
// one-read artifact bodies. Each is checked against the plain read it replaces.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { migrate, openDatabase } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), 'kanban-store-reads-')), 'k.db')
  const db = new DatabaseSync(path)
  migrate(db)
  return { db, path, store: new KanbanStore(db) }
}

test('the change token moves on any write and holds still across reads', () => {
  const { store } = setup()
  const first = store.changeToken()
  assert.equal(store.changeToken(), first, 'two reads, same token')
  store.listTickets()
  store.counts()
  assert.equal(store.changeToken(), first, 'reading changes nothing')
  const ticket = store.createTicket({ title: 'a' })
  const second = store.changeToken()
  assert.notEqual(second, first, 'a write moves it')
  store.addArtifact(ticket.id, 'plan', 'x')
  assert.notEqual(store.changeToken(), second, 'so does a write the event log never hears of')
})

test('the change token also moves when another connection writes', () => {
  const { path, store } = setup()
  const first = store.changeToken()
  const other = new KanbanStore(openDatabase(path))
  other.createTicket({ title: 'from elsewhere' })
  assert.notEqual(store.changeToken(), first)
})

test('listRunnable is exactly the working tickets and plan-now backlog tickets that are not parked, in launch order', () => {
  const { store } = setup()
  const make = (title, extra = {}) => store.createTicket({ title, ...extra })
  const w1 = make('w1', { column: 'working' })
  const w2 = make('w2', { column: 'working', priority: 5 })
  const parked = make('parked', { column: 'working' })
  store.setNeedsAttention(parked.id, 'stuck')
  const later = make('backlog at pickup')
  const now1 = make('plan now', { planTiming: 'now' })
  const now2 = make('plan now parked', { planTiming: 'now' })
  store.setNeedsAttention(now2.id, 'stuck')
  const planned = make('plan now but already planned', { planTiming: 'now' })
  store.transitionTicket(planned.id, { phase: 'implement' }, { actor: 'engine', reason: 'seed' })
  const done = make('done', { column: 'working' })
  store.db.prepare("UPDATE tickets SET col = 'done', phase = 'closed' WHERE id = ?").run(done.id)

  // The scheduler's previous selection, written out.
  const working = store.listTickets({ columns: ['working'] })
  const planNow = store.listTickets({ columns: ['backlog'] }).filter((t) => t.phase === 'plan' && t.planTiming === 'now')
  const expected = [...working, ...planNow].filter((t) => !t.needsAttentionReason).map((t) => t.id)

  const got = store.listRunnable().map((t) => t.id)
  assert.deepEqual(got, expected)
  assert.deepEqual(got, [w2.id, w1.id, now1.id], 'priority first, then queue order, plan-now last')
  assert.equal(got.includes(later.id), false)
  assert.equal(got.includes(parked.id), false)
  assert.equal(got.includes(now2.id), false)
  assert.equal(got.includes(planned.id), false)
})

test('an empty park reason is no park, while a blank one still is', () => {
  const { store, db } = setup()
  const t = store.createTicket({ title: 'x', column: 'working' })
  db.prepare("UPDATE tickets SET needs_attention_reason = '' WHERE id = ?").run(t.id)
  assert.deepEqual(store.listRunnable().map((r) => r.id), [t.id], 'an empty reason is no park')
  db.prepare("UPDATE tickets SET needs_attention_reason = ' ' WHERE id = ?").run(t.id)
  assert.deepEqual(store.listRunnable(), [], 'a blank one still is, as it always was')
})

test('listTickets without bodies is the same ticket list, minus the body', () => {
  const { store } = setup()
  store.createTicket({ title: 'a', body: 'long '.repeat(200), column: 'working', acceptance: ['x'], worktree: true, preset: 'p' })
  store.createTicket({ title: 'b', body: 'other', priority: 3 })
  const full = store.listTickets()
  const lean = store.listTickets({ withBody: false })
  assert.equal(lean.length, full.length)
  full.forEach((ticket, i) => {
    const { body, ...rest } = ticket
    assert.ok(body.length > 0)
    const { body: leanBody, ...leanRest } = lean[i]
    assert.equal(leanBody, undefined, 'no body is read')
    assert.deepEqual(leanRest, rest, 'every other field is identical')
  })
  assert.deepEqual(store.listTickets({ columns: ['working'], withBody: false }).map((t) => t.key), ['KAN-1'])
})

test('editability for a row in hand agrees with the lookup by id', () => {
  const { store } = setup()
  const pristine = store.createTicket({ title: 'pristine' })
  const attached = store.createTicket({ title: 'session attached' })
  store.attachSession({ ticketId: attached.id, dshSessionId: 's-1', role: 'planner', purpose: 'plan' })
  const spent = store.createTicket({ title: 'spent' })
  store.addSpend(spent.id, 1)
  const parked = store.createTicket({ title: 'parked' })
  store.setNeedsAttention(parked.id, 'why')
  const spanned = store.createTicket({ title: 'span' })
  store.startSpan({ ticketId: spanned.id, kind: 'agent', name: 'x', role: 'planner' })
  const closed = store.createTicket({ title: 'closed' })
  store.db.prepare("UPDATE tickets SET col = 'done', phase = 'closed' WHERE id = ?").run(closed.id)
  const verdicts = {}
  for (const ticket of store.listTickets()) {
    assert.equal(store.isEditableTicket(ticket), store.isEditable(ticket.id), ticket.title)
    verdicts[ticket.title] = store.isEditableTicket(ticket)
  }
  assert.deepEqual(verdicts, { pristine: true, 'session attached': false, spent: false, parked: false, span: false, closed: false })
})

test('scoped telemetry is the unscoped telemetry restricted to those tickets', () => {
  const { store } = setup()
  const ids = []
  for (let i = 0; i < 6; i += 1) {
    const t = store.createTicket({ title: `t${i}`, column: 'working' })
    ids.push(t.id)
    store.attachSession({ ticketId: t.id, dshSessionId: `s-${i}`, role: 'implementer', purpose: 'build' })
    store.transitionTicket(t.id, { phase: 'implement' }, { actor: 'engine', reason: 'seed' })
    const span = store.startSpan({ ticketId: t.id, kind: 'agent', name: 'run', role: 'implementer' })
    store.endSpan(span.id, { status: 'ok' })
    store.appendEvent(t.id, 'tool_call', { payload: { n: i } })
    if (i % 2 === 0) store.setNeedsAttention(t.id, 'stuck')
  }
  const all = store.boardTelemetry()
  const some = store.boardTelemetry([ids[1], ids[4]])
  assert.deepEqual([...some.keys()].sort(), [ids[1], ids[4]].sort())
  for (const id of [ids[1], ids[4]]) assert.deepEqual(some.get(id), all.get(id))
  assert.deepEqual(store.boardTelemetry(ids[2]).get(ids[2]), all.get(ids[2]), 'one id still works')
  assert.equal(store.boardTelemetry([]).size, 0)

  const lean = store.boardTelemetry(ids, { sessions: false })
  for (const id of ids) {
    assert.deepEqual(lean.get(id).sessions, [], 'no sessions were read')
    assert.deepEqual({ ...lean.get(id), sessions: all.get(id).sessions }, all.get(id))
  }
  const sessions = store.boardSessions()
  for (const id of ids) assert.deepEqual(sessions.get(id), all.get(id).sessions)
})

test('scoped telemetry reads a long id list in slices without losing a ticket', () => {
  const { store } = setup()
  const ids = []
  for (let i = 0; i < 450; i += 1) {
    const t = store.createTicket({ title: `t${i}` })
    store.transitionTicket(t.id, { phase: 'implement' }, { actor: 'engine', reason: 'seed' })
    ids.push(t.id)
  }
  const got = store.boardTelemetry(ids)
  assert.equal(got.size, 450, 'each ticket has its phase change, across the slice boundary')
  assert.ok(ids.every((id) => got.get(id).transitions.length === 1))
})

test('artifact bodies come back in one read, the same as one read each', () => {
  const { store } = setup()
  const t = store.createTicket({ title: 'a' })
  for (let i = 0; i < 5; i += 1) store.addArtifact(t.id, i % 2 ? 'review' : 'plan', `content ${i}`)
  const slow = store.listArtifacts(t.id, { limit: 4 }).map((a) => ({ ...a, content: store.getArtifact(a.id)?.content ?? '' }))
  assert.deepEqual(store.listArtifactsWithContent(t.id, { limit: 4 }), slow)
})

test('the ticket heads list is every id with its phase', () => {
  const { store } = setup()
  const a = store.createTicket({ title: 'a' })
  const b = store.createTicket({ title: 'b' })
  store.transitionTicket(b.id, { phase: 'implement' }, { actor: 'engine', reason: 'seed' })
  const heads = store.listTicketHeads()
  const byId = (x, y) => x.id.localeCompare(y.id)
  assert.deepEqual(heads.sort(byId), [{ id: a.id, phase: 'plan' }, { id: b.id, phase: 'implement' }].sort(byId))
})
