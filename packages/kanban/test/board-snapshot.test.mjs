// The board snapshot: what a card says is unchanged by the way it is now built.
//
// A reference build (the straightforward per-ticket reads the board used before
// it was cached) is written out here and compared with the real one, card by
// card, on a board that has every column, parked and running tickets, sessions,
// phase history and closed tickets. Then the cache, the change token and the
// content signature are exercised on their own.

import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import { attentionFacts } from '../src/attention.mjs'
import { isQuestionPark } from '../src/recovery.mjs'
import { attemptLabel, closedNewestFirst, jumpSession, phaseSegments, workingMs } from '../src/board-view.mjs'
import { compactBoard, createBoardSnapshots, digest, stableJson } from '../src/board-snapshot.mjs'
import { wipQueueReason } from '../src/wip.mjs'

const NOW = Date.parse('2026-03-01T12:00:00.000Z')
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString()
const MIN = 60_000

function fakeDriver() {
  const driver = {
    questions: new Set(),
    approvals: new Set(),
    busy: new Set(),
    plans: new Map(),
    active: new Map(),
    isAwaitingQuestion: (id) => driver.questions.has(id),
    isAwaitingApproval: (id) => driver.approvals.has(id),
    isTicketBusy: (id) => driver.busy.has(id),
    liveTicketSession: (id, purpose) => (purpose === 'plan' ? driver.plans.get(id) : undefined),
    activeSessionIds: (id) => driver.active.get(id) ?? [],
  }
  return driver
}

function insertEvent(db, ticketId, offsetMs, kind, from = null, to = null) {
  db.prepare('INSERT INTO events (ticket_id, at, kind, phase_from, phase_to, actor, payload_json) VALUES (?,?,?,?,?,?,?)')
    .run(ticketId, at(offsetMs), kind, from, to, 'engine', '{}')
}

function insertSpan(db, ticketId, startMs, endMs, { kind = 'agent', status = 'ok' } = {}) {
  db.prepare('INSERT INTO spans (id, ticket_id, kind, name, role, started_at, ended_at, status, attempt) VALUES (?,?,?,?,?,?,?,?,0)')
    .run(`${ticketId}-${startMs}`, ticketId, kind, 'step', 'implementer', at(startMs), endMs === null ? null : at(endMs), status)
}

/** A board with every column and shape the cards come in. */
function seeded() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const driver = fakeDriver()
  const engine = { active: new Map() }
  const make = (title, extra = {}) => store.createTicket({ title, ...extra })
  const t = {}
  t.plain = make('plain backlog')
  t.later = make('second backlog', { priority: 2 })
  t.planNow = make('plans now', { planTiming: 'now' })
  t.parked = make('parked in working', { column: 'working' })
  store.setNeedsAttention(t.parked.id, 'review kept failing')
  t.asking = make('asks a question', { column: 'working' })
  t.approving = make('awaits approval', { column: 'working' })
  t.running = make('running', { column: 'working' })
  t.questionPark = make('parked on a question', { column: 'working' })
  store.setNeedsAttention(t.questionPark.id, 'Waiting on your answer in the plan session: which db?')
  t.done = make('finished', { column: 'working' })
  t.dropped = make('discarded', { column: 'working' })
  t.done2 = make('finished earlier', { column: 'working' })

  for (const [ticket, phases] of [[t.running, ['implement', 'review']], [t.done, ['implement', 'review', 'verify']], [t.done2, ['implement']]]) {
    for (const phase of phases) store.transitionTicket(ticket.id, { phase }, { actor: 'engine', reason: 'seed' })
  }
  store.attachSession({ ticketId: t.running.id, dshSessionId: 'sess-run', role: 'implementer', purpose: 'build' })
  store.attachSession({ ticketId: t.done.id, dshSessionId: 'sess-done', role: 'implementer', purpose: 'build' })
  store.attachSession({ ticketId: t.asking.id, dshSessionId: 'sess-ask', role: 'planner', purpose: 'plan' })

  // Fixed times, so working time is a number the test can read.
  db.exec('DELETE FROM events WHERE kind IN (\'phase_changed\', \'column_changed\')')
  for (const ticket of [t.running, t.done, t.done2]) {
    insertEvent(db, ticket.id, -5 * 60 * MIN, 'phase_changed', 'plan', 'implement')
  }
  insertEvent(db, t.running.id, -3 * 60 * MIN, 'phase_changed', 'implement', 'review')
  insertEvent(db, t.done.id, -3 * 60 * MIN, 'phase_changed', 'implement', 'review')
  insertEvent(db, t.done.id, -2 * 60 * MIN, 'phase_changed', 'review', 'verify')
  insertSpan(db, t.running.id, -60 * MIN, -30 * MIN)
  insertSpan(db, t.running.id, -10 * MIN, null)
  insertSpan(db, t.done.id, -4 * 60 * MIN, -3 * 60 * MIN)
  insertSpan(db, t.done.id, -2 * 60 * MIN, -90 * MIN, { kind: 'judge' })
  insertSpan(db, t.done2.id, -60 * MIN, -50 * MIN)
  insertEvent(db, t.parked.id, -20 * MIN, 'needs_attention')
  for (const [ticket, closedOffset, column] of [[t.done, -60 * MIN, 'done'], [t.dropped, -30 * MIN, 'discarded'], [t.done2, -90 * MIN, 'done']]) {
    db.prepare('UPDATE tickets SET col = ?, phase = ?, closed_at = ? WHERE id = ?').run(column, 'closed', at(closedOffset), ticket.id)
  }
  db.prepare('UPDATE tickets SET created_at = ?, updated_at = ?')
    .run(at(-8 * 60 * MIN), at(-1 * MIN))

  driver.questions.add(t.asking.id)
  driver.approvals.add(t.approving.id)
  driver.busy.add(t.running.id)
  engine.active.set(t.running.id, Promise.resolve())
  driver.active.set(t.running.id, ['sess-run'])
  driver.plans.set(t.planNow.id, 'sess-plan')
  return { db, store, driver, engine, t }
}

/** The board as it was built before the cache: one read per ticket, everything from scratch. */
function reference({ store, driver, engine }, nowMs) {
  const byColumn = { backlog: [], working: [], done: [], discarded: [] }
  const telemetry = store.boardTelemetry()
  for (const ticket of store.listTickets()) {
    const facts = telemetry.get(ticket.id) ?? { transitions: [], events: [], spans: [], sessions: [] }
    const closedAt = ticket.closedAt === null || ticket.closedAt === undefined ? null : Date.parse(ticket.closedAt)
    const created = Date.parse(ticket.createdAt)
    const closed = closedAt === null ? nowMs : closedAt
    const item = {
      id: ticket.id,
      key: ticket.key,
      title: ticket.title,
      column: ticket.column,
      phase: ticket.phase,
      editable: store.isEditable(ticket.id),
      priority: ticket.priority,
      sortOrder: ticket.sortOrder,
      attemptCount: ticket.attemptCount,
      planTiming: ticket.planTiming,
      planQuestions: ticket.planQuestions,
      spentUsd: ticket.spentUsd,
      budgetUsd: ticket.budgetUsd,
      allowPaid: ticket.allowPaid,
      needsAttentionReason: ticket.needsAttentionReason,
      updatedAt: ticket.updatedAt,
      createdAt: ticket.createdAt,
      closedAt: ticket.closedAt ?? null,
      totalMs: Number.isFinite(created) && Number.isFinite(closed) ? Math.max(0, closed - created) : 0,
      attemptLabel: attemptLabel(ticket.attemptCount),
      segments: phaseSegments({ transitions: facts.transitions, phase: ticket.phase, column: ticket.column }),
      workingMs: workingMs({ spans: facts.spans, events: facts.events, now: nowMs, endAt: Number.isFinite(closedAt) ? closedAt : null }),
      sessionId: jumpSession(facts.sessions, driver.activeSessionIds(ticket.id)),
    }
    if (ticket.phase === 'plan') item.planSessionId = driver.liveTicketSession(ticket.id, 'plan') ?? null
    item.parkedOnQuestion = isQuestionPark(ticket.needsAttentionReason)
    item.awaitingQuestion = driver.isAwaitingQuestion(ticket.id) || item.parkedOnQuestion
    item.awaitingApproval = driver.isAwaitingApproval(ticket.id)
    item.status = attentionFacts(ticket, { engine, driver }).status
    if (item.status === 'attention' && !ticket.needsAttentionReason) {
      item.needsAttentionReason = item.awaitingApproval ? 'Awaiting your approval' : 'Waiting on your answer'
    }
    byColumn[ticket.column]?.push(item)
  }
  return { counts: store.counts(), columns: byColumn, closed: closedNewestFirst([...byColumn.done, ...byColumn.discarded]) }
}

/** The snapshot's board, without the field the reference never had. */
function plain(board) {
  const strip = (card) => {
    const { accruing, ...rest } = card
    void accruing
    return rest
  }
  const columns = {}
  for (const [name, list] of Object.entries(board.columns)) columns[name] = list.map(strip)
  return { counts: board.counts, columns, closed: board.closed.map(strip) }
}

test('every card says what it said before the board was cached', () => {
  const world = seeded()
  const snapshots = createBoardSnapshots({ ...world, now: () => NOW })
  const built = snapshots.build()
  assert.deepEqual(plain(built.board), reference(world, NOW))
  const titles = Object.fromEntries(Object.values(built.board.columns).flat().map((c) => [c.key, c.title]))
  assert.equal(Object.keys(titles).length, 11, 'all eleven tickets are on the board')
})

test('the facts a card shows: attention states, working time, ordering, phase path', () => {
  const world = seeded()
  const { t } = world
  const board = createBoardSnapshots({ ...world, now: () => NOW }).build().board
  const card = (ticket) => Object.values(board.columns).flat().find((c) => c.id === ticket.id)
  assert.equal(card(t.parked).status, 'attention')
  assert.equal(card(t.parked).needsAttentionReason, 'review kept failing')
  assert.equal(card(t.asking).status, 'attention', 'a paused question is attention')
  assert.equal(card(t.asking).needsAttentionReason, 'Waiting on your answer')
  assert.equal(card(t.asking).awaitingQuestion, true)
  assert.equal(card(t.approving).needsAttentionReason, 'Awaiting your approval')
  assert.equal(card(t.approving).awaitingApproval, true)
  assert.equal(card(t.questionPark).parkedOnQuestion, true)
  assert.equal(card(t.questionPark).awaitingQuestion, true)
  assert.equal(card(t.running).status, 'active')
  assert.equal(card(t.running).sessionId, 'sess-run')
  assert.equal(card(t.plain).status, 'idle')
  assert.equal(card(t.planNow).planSessionId, 'sess-plan')
  assert.equal(card(t.plain).editable, true)
  assert.equal(card(t.running).editable, false)
  // 30 minutes of finished work plus the step still open for ten.
  assert.equal(card(t.running).workingMs, 40 * MIN)
  assert.equal(card(t.running).accruing, true)
  assert.equal(card(t.done).workingMs, 60 * MIN + 30 * MIN, 'an agent hour and a judge half hour, stopped at close')
  assert.equal(card(t.done).accruing, false)
  assert.deepEqual(card(t.done).segments.map((s) => `${s.phase}:${s.state}`), ['plan:done', 'implement:done', 'review:done', 'verify:done', 'closed:done'])
  assert.deepEqual(board.columns.backlog.map((c) => c.title), ['second backlog', 'plain backlog', 'plans now'], 'priority first, then queue order')
  assert.deepEqual(board.closed.map((c) => c.title), ['discarded', 'finished', 'finished earlier'], 'newest closed first')
  assert.deepEqual(board.counts, { backlog: 3, working: 5, done: 2, discarded: 1 })
})

test('a second build is the same board and does not read closed tickets again', () => {
  const world = seeded()
  const snapshots = createBoardSnapshots({ ...world, now: () => NOW })
  snapshots.build()
  const asked = []
  const original = world.store.boardTelemetry.bind(world.store)
  world.store.boardTelemetry = (scope, options) => { asked.push(scope); return original(scope, options) }
  const again = snapshots.build()
  const reads = [...asked]
  assert.deepEqual(plain(again.board), reference(world, NOW))
  const closed = new Set([world.t.done.id, world.t.dropped.id, world.t.done2.id])
  assert.equal(reads.length, 1)
  assert.equal(reads[0].some((id) => closed.has(id)), false, 'closed tickets come from the memory of the first build')
  assert.equal(reads[0].length, 8, 'and the open ones are read afresh')
})

test('what happens to a ticket after it closed does not change what its card says, except its session link', () => {
  const world = seeded()
  const snapshots = createBoardSnapshots({ ...world, now: () => NOW })
  snapshots.build()
  insertEvent(world.db, world.t.done.id, -10 * MIN, 'human_wait_started')
  insertEvent(world.db, world.t.done.id, -5 * MIN, 'human_wait_ended')
  insertEvent(world.db, world.t.done.id, -4 * MIN, 'session_reactivated')
  world.store.attachSession({ ticketId: world.t.done.id, dshSessionId: 'sess-later', role: 'implementer', purpose: 'build' })
  const after = snapshots.build()
  assert.deepEqual(plain(after.board), reference(world, NOW))
  assert.equal(Object.values(after.board.columns).flat().find((c) => c.id === world.t.done.id).sessionId, 'sess-later')
})

test('a closed ticket that is reopened is read again', () => {
  const world = seeded()
  const snapshots = createBoardSnapshots({ ...world, now: () => NOW })
  snapshots.build()
  world.db.prepare("UPDATE tickets SET col = 'working', phase = 'implement', closed_at = NULL WHERE id = ?").run(world.t.done2.id)
  insertEvent(world.db, world.t.done2.id, -1 * MIN, 'phase_changed', 'closed', 'implement')
  const after = snapshots.build()
  assert.deepEqual(plain(after.board), reference(world, NOW))
  const card = Object.values(after.board.columns).flat().find((c) => c.id === world.t.done2.id)
  assert.equal(card.column, 'working')
  assert.equal(card.closedAt, null)
})

test('the change token holds while nothing moves and moves with a write, a wait, a turn or a session', () => {
  const world = seeded()
  const snapshots = createBoardSnapshots({ ...world, now: () => NOW })
  const base = snapshots.token()
  assert.equal(snapshots.token(), base)
  world.store.appendEvent(world.t.plain.id, 'note')
  const afterWrite = snapshots.token()
  assert.notEqual(afterWrite, base, 'a stored change')
  world.driver.questions.delete(world.t.asking.id)
  const afterAnswer = snapshots.token()
  assert.notEqual(afterAnswer, afterWrite, 'an answered question')
  world.driver.approvals.add(world.t.plain.id)
  const afterApproval = snapshots.token()
  assert.notEqual(afterApproval, afterAnswer, 'a new approval prompt')
  world.driver.busy.add(world.t.later.id)
  const afterBusy = snapshots.token()
  assert.notEqual(afterBusy, afterApproval, 'a turn starting on a ticket')
  world.engine.active.delete(world.t.running.id)
  assert.notEqual(snapshots.token(), afterBusy, 'the engine letting go of a ticket')
  world.driver.active.set(world.t.later.id, ['s-x'])
  const afterSession = snapshots.token()
  world.driver.plans.set(world.t.plain.id, 'sess-plan-2')
  assert.notEqual(snapshots.token(), afterSession, 'a live plan session')
})

test('the token read before a build is the token of the board it built', () => {
  const world = seeded()
  const snapshots = createBoardSnapshots({ ...world, now: () => NOW })
  const before = snapshots.token()
  const built = snapshots.build()
  assert.equal(built.token, before)
  assert.equal(snapshots.token(), before, 'building changes nothing it reads')
})

test('a growing working time is carried by the card, not re-sent: the signature ignores the clock', () => {
  const world = seeded()
  const early = createBoardSnapshots({ ...world, now: () => NOW }).build()
  const late = createBoardSnapshots({ ...world, now: () => NOW + 5 * MIN }).build()
  const running = (snap) => Object.values(snap.board.columns).flat().find((c) => c.id === world.t.running.id)
  assert.equal(running(late).workingMs - running(early).workingMs, 5 * MIN, 'the figure itself does move')
  assert.equal(late.signature, early.signature, 'but the content did not change')
  assert.equal(stableJson(late.board), stableJson(early.board))
})

test('the signature changes when a card changes', () => {
  const world = seeded()
  const snapshots = createBoardSnapshots({ ...world, now: () => NOW })
  const before = snapshots.build().signature
  world.store.setNeedsAttention(world.t.plain.id, 'stuck')
  assert.notEqual(snapshots.build().signature, before)
  const parked = snapshots.build().signature
  world.driver.questions.add(world.t.running.id)
  assert.notEqual(snapshots.build().signature, parked, 'a card turning to attention in memory only')
})

test('a step that ends stops the clock: the card is no longer accruing and the figure is final', () => {
  const world = seeded()
  const snapshots = createBoardSnapshots({ ...world, now: () => NOW })
  world.db.prepare('UPDATE spans SET ended_at = ?, status = ? WHERE ticket_id = ? AND ended_at IS NULL').run(at(-5 * MIN), 'ok', world.t.running.id)
  const card = Object.values(snapshots.build().board.columns).flat().find((c) => c.id === world.t.running.id)
  assert.equal(card.accruing, false)
  assert.equal(card.workingMs, 35 * MIN)
})

test('a parked ticket with an open step is not accruing', () => {
  const world = seeded()
  insertEvent(world.db, world.t.running.id, -4 * MIN, 'needs_attention')
  const card = Object.values(createBoardSnapshots({ ...world, now: () => NOW }).build().board.columns).flat().find((c) => c.id === world.t.running.id)
  assert.equal(card.accruing, false, 'the open step is covered by an attention stretch')
})

test('sequence numbers rise with each build and the boot id names the run', () => {
  const world = seeded()
  const snapshots = createBoardSnapshots({ ...world, now: () => NOW })
  const a = snapshots.build()
  const b = snapshots.build()
  assert.equal(b.seq, a.seq + 1)
  assert.equal(b.boot, a.boot)
  assert.notEqual(createBoardSnapshots({ ...world, now: () => NOW }).build().boot, a.boot, 'a new run starts a new boot id')
})

test('the compact board carries Done and Discarded once, in closed', () => {
  const world = seeded()
  const { board } = createBoardSnapshots({ ...world, now: () => NOW }).build()
  const compact = compactBoard(board)
  assert.equal(compact.compact, true)
  assert.deepEqual(Object.keys(compact.columns).sort(), ['backlog', 'working'])
  assert.deepEqual(compact.closed, board.closed)
  assert.deepEqual(compact.counts, board.counts)
  assert.ok(JSON.stringify(compact).length < JSON.stringify(board).length)
  const rebuilt = [...compact.closed].map((c) => c.id).sort()
  assert.deepEqual(rebuilt, [...board.columns.done, ...board.columns.discarded].map((c) => c.id).sort())
})

test('digest is stable and content-addressed', () => {
  assert.equal(digest('a'), digest('a'))
  assert.notEqual(digest('a'), digest('b'))
  assert.match(digest('a'), /^[0-9a-f]{40}$/)
})

// ------------------------------------------------------------------ KAN-72 --
//
// The page's WIP pill and the engine's admission rule read the same numbers, so
// the board payload carries them: the cap in force, how much of it is taken, and
// who is waiting. All three come from the ticket rows the board already read.

test('the board carries the WIP block: cap, occupancy and queue', () => {
  const world = seeded()
  const { t } = world
  const snapshots = createBoardSnapshots({ ...world, now: () => NOW, wipCap: () => ({ cap: 3, source: 'config' }) })
  const board = snapshots.build().board

  assert.deepEqual(board.wip, { cap: 3, source: 'config', occupancy: 3, queue: [] })
  assert.equal(board.wip.occupancy, 3, 'the three unparked Working cards; the parked ones wait on a person, not a worker')

  storeQueueNotice(world, t.plain, { cap: 3, occupancy: 3, position: 1 })
  storeQueueNotice(world, t.later, { cap: 3, occupancy: 3, position: 2 })
  const queued = snapshots.build().board
  assert.deepEqual(queued.wip.queue, [
    { key: t.later.key, title: 'second backlog', position: 1, phase: 'plan' },
    { key: t.plain.key, title: 'plain backlog', position: 2, phase: 'plan' },
  ], 'priority order, head first, positions counted from the live queue')
  assert.deepEqual(compactBoard(queued).wip, queued.wip, 'the compact payload the page polls carries it too')
})

test('a board built without a cap provider says nothing about the cap', () => {
  const world = seeded()
  assert.equal(createBoardSnapshots({ ...world, now: () => NOW }).build().board.wip, null)
})

function storeQueueNotice({ store }, ticket, { cap, occupancy, position }) {
  store.setNeedsAttention(ticket.id, wipQueueReason({ cap, occupancy, position }))
}
