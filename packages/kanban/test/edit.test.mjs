// The human edit boundary, against a real store.
//
// The lock is the whole point of KAN-14: a ticket any engine has touched can no
// longer be edited by a person, and a ticket nobody has touched can be edited
// as often as they like. These tests call the same three functions the host
// routes call, so the guard is proven where it lives rather than asserted from
// source text.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import { appendAcceptance, editTicket, replaceAcceptance } from '../src/edit.mjs'

function setup() {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'kanban-edit-')), 'k.db'))
  migrate(db)
  return { db, store: new KanbanStore(db) }
}

/** A ticket the engine has started: the plan session attached, as in production. */
function started(store, input = { title: 'started' }) {
  const ticket = store.createTicket(input)
  store.attachSession({ ticketId: ticket.id, dshSessionId: 'plan-1', role: 'plan', purpose: 'plan' })
  return store.getTicket(ticket.id)
}

test('a pristine ticket saves title, body, modes and acceptance in one call', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 'old', acceptance: ['keep', 'drop'] })
  const result = editTicket(store, ticket.id, {
    title: 'new',
    body: 'context',
    planTiming: 'now',
    planQuestions: 'autonomous',
    priority: 7,
    allowPaid: true,
    budgetUsd: 5,
    workspaceCwd: '/tmp/work',
    acceptance: ['keep', 'changed'],
  }, { reason: 'ticket edit' })
  assert.equal(result.ok, true)
  assert.equal(result.value.ticket.title, 'new')
  assert.equal(result.value.ticket.body, 'context')
  assert.equal(result.value.ticket.planTiming, 'now')
  assert.equal(result.value.ticket.priority, 7)
  assert.equal(result.value.ticket.allowPaid, true)
  assert.equal(result.value.ticket.workspaceCwd, '/tmp/work')
  assert.deepEqual(result.value.acceptance.map((a) => a.statement), ['keep', 'changed'])
  const kinds = store.listEvents(ticket.id).map((e) => e.kind)
  assert.ok(kinds.includes('ticket_updated'), 'the field edit is recorded')
  assert.ok(kinds.includes('acceptance_set'), 'the acceptance replace is recorded')
})

test('editing a pristine ticket does not lock it: a second edit saves too', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 'first' })
  assert.equal(editTicket(store, ticket.id, { title: 'second' }).ok, true)
  const again = editTicket(store, ticket.id, { body: 'and a body' })
  assert.equal(again.ok, true)
  assert.equal(again.value.ticket.title, 'second')
  assert.equal(again.value.ticket.body, 'and a body')
})

test('a started ticket is locked: ticket_started, and nothing changed', () => {
  const { store } = setup()
  const ticket = started(store, { title: 'locked', acceptance: ['a'] })
  const result = editTicket(store, ticket.id, { title: 'rewritten', acceptance: ['b'] })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'ticket_started')
  assert.match(result.error.message, /has already started; it can no longer be edited/)
  assert.equal(result.error.details.key, ticket.key)
  assert.equal(store.getTicket(ticket.id).title, 'locked')
  assert.deepEqual(store.listAcceptance(ticket.id).map((a) => a.statement), ['a'])
})

test('an unknown ticket says not_found, not started', () => {
  const { store } = setup()
  const result = editTicket(store, 'KAN-404', { title: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'not_found')
})

test('a bad acceptance list is refused before anything is written', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't', acceptance: ['a'] })
  const notArray = editTicket(store, ticket.id, { title: 'renamed', acceptance: 'a' })
  assert.equal(notArray.ok, false)
  assert.equal(notArray.error.code, 'bad_request')
  const blankLine = editTicket(store, ticket.id, { title: 'renamed', acceptance: ['a', '  '] })
  assert.equal(blankLine.ok, false)
  assert.equal(blankLine.error.code, 'bad_request')
  assert.equal(store.getTicket(ticket.id).title, 't', 'the rejected call wrote nothing')
  assert.deepEqual(store.listAcceptance(ticket.id).map((a) => a.statement), ['a'])
})

test('the store keeps validating the patch: paid without a budget is refused', () => {
  const { store } = setup()
  const ticket = store.createTicket({ title: 't' })
  const result = editTicket(store, ticket.id, { allowPaid: true, budgetUsd: 0 })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad_request')
  assert.match(result.error.message, /budget/)
  assert.equal(store.getTicket(ticket.id).allowPaid, false)
})

test('acceptance has its own guarded paths too', () => {
  const { store } = setup()
  const pristine = store.createTicket({ title: 't', acceptance: ['a'] })
  assert.equal(appendAcceptance(store, pristine.id, 'b').ok, true)
  assert.deepEqual(store.listAcceptance(pristine.id).map((x) => x.statement), ['a', 'b'])
  const replaced = replaceAcceptance(store, pristine.id, ['only'])
  assert.equal(replaced.ok, true)
  assert.deepEqual(store.listAcceptance(pristine.id).map((x) => x.statement), ['only'])

  const ticket = started(store, { title: 'started', acceptance: ['a'] })
  const add = appendAcceptance(store, ticket.id, 'late')
  assert.equal(add.ok, false)
  assert.equal(add.error.code, 'ticket_started')
  const set = replaceAcceptance(store, ticket.id, ['late'])
  assert.equal(set.ok, false)
  assert.equal(set.error.code, 'ticket_started')
  assert.deepEqual(store.listAcceptance(ticket.id).map((x) => x.statement), ['a'])
})

test('engine-internal writes are untouched by the lock', () => {
  const { store } = setup()
  const ticket = started(store, { title: 'started', acceptance: ['a'] })
  // reorder → sortOrder, worktree → workspaceCwd, retry → any patch: these call
  // the store directly and must keep working on a started ticket.
  assert.equal(store.updateTicket(ticket.id, { sortOrder: 1234 }, { actor: 'human', reason: 'reorder' }).sortOrder, 1234)
  assert.equal(store.updateTicket(ticket.id, { workspaceCwd: '/tmp/wt' }, { actor: 'human', reason: 'worktree created' }).workspaceCwd, '/tmp/wt')
  assert.equal(store.getTicket(ticket.id).title, 'started', 'the human edit path is the locked one')
  assert.equal(editTicket(store, ticket.id, { title: 'no' }).error.code, 'ticket_started')
})
