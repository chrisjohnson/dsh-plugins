// The model-facing action tools, against a real store and a stub agent scope.
//
// Two contracts live here that the engine cannot re-check after the fact:
// `kanban_plan` is the read-only view of the plan a session is working against,
// available in every phase with no gate; and the two submission tools refuse a
// done_when array whose ids are not the plan's, because a review that grades
// invented conditions is a review that passed nothing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

let actionsModule
try {
  await import('@deepseek-ai/dsh-tools')
  actionsModule = await import('../src/actions.mjs')
} catch {
  actionsModule = undefined
}
const skip = actionsModule === undefined ? 'dsh peer packages are not installed' : false

import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'

const { registerActionTools } = actionsModule ?? {}

const CWD = mkdtempSync(join(tmpdir(), 'kanban-actions-'))

const PLAN = {
  summary: 'write the file',
  steps: ['create notes.txt'],
  done_when: [
    { id: 'notes', statement: 'note exists', how_verified: 'test -f notes.txt' },
    { id: 'content', statement: 'note says hello', how_verified: "grep hello notes.txt" },
  ],
}

function newTicket(withPlan = true) {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const ticket = store.createTicket({ title: 'demo', acceptance: ['note exists'], workspaceCwd: CWD, column: 'working' })
  if (withPlan) {
    const conditions = store.replaceConditions(ticket.id, 1, PLAN.done_when.map((c) => ({ id: c.id, statement: c.statement, howVerified: c.how_verified })), 'plan')
    store.addArtifact(ticket.id, 'plan', JSON.stringify({ summary: PLAN.summary, steps: PLAN.steps, conditions, planVersion: 1 }, null, 2))
  }
  return { store, ticket: store.getTicket(ticket.id) }
}

/** A stub agent scope that records every registration, like the dispatch tests. */
function makeCtx() {
  const registered = []
  return {
    registered,
    tools: {
      register: (tool) => {
        registered.push(tool)
        return () => {
          const at = registered.indexOf(tool)
          if (at >= 0) registered.splice(at, 1)
        }
      },
    },
  }
}

function harness({ role = 'implementer', withPlan = true } = {}) {
  const { store, ticket } = newTicket(withPlan)
  const ctx = makeCtx()
  const liveRef = { ticketId: ticket.id, phase: { role }, role, purpose: 'build' }
  const accepted = []
  const driver = {
    log: { warn() {} },
    submitAction(sessionId, action) {
      accepted.push(action)
      return { accepted: true, action: action.type }
    },
    approval: {
      approve() {},
      discard() {},
      plan() {},
    },
  }
  const exec = { concludeTurn() {} }
  registerActionTools({ ctx, sessionId: 'session-1', liveRef, driver, store })
  const tool = (name) => ctx.registered.find((item) => item.name === name)
  return { store, ticket, ctx, liveRef, driver, accepted, exec, tool }
}

const CLAIM = (id, extra = {}) => ({ id, met: true, confidence: 0.9, evidence: `notes.txt:1 hello (${id})`, ...extra })

test('kanban_plan returns the plan, its conditions and the latest review', { skip }, async () => {
  const h = harness({ role: 'reviewer' })
  h.store.addArtifact(h.ticket.id, 'review', JSON.stringify({ verdict: 'fail', reasons: ['missing file'] }))
  const value = await h.tool('kanban_plan').execute({}, h.exec)
  assert.equal(value.plan.summary, 'write the file')
  assert.deepEqual(value.plan.steps, ['create notes.txt'])
  assert.deepEqual(value.plan.done_when.map((c) => c.id), ['notes', 'content'])
  assert.equal(value.plan.done_when[0].how_verified, 'test -f notes.txt')
  assert.deepEqual(value.conditions.map((c) => c.id), ['notes', 'content'])
  assert.equal(value.review.verdict, 'fail')
})

test('kanban_plan says so plainly when the ticket has no plan yet', { skip }, async () => {
  const h = harness({ role: 'planner', withPlan: false })
  const value = await h.tool('kanban_plan').execute({}, h.exec)
  assert.equal(value.plan, null)
  assert.deepEqual(value.conditions, [])
  assert.equal(value.review, null)
  assert.match(value.note, /no plan yet/)
})

test('kanban_plan is readable in every phase, including the plan phase', { skip }, async () => {
  for (const role of ['planner', 'implementer', 'reviewer', 'approver']) {
    const h = harness({ role })
    const value = await h.tool('kanban_plan').execute({}, h.exec)
    assert.ok(value, `${role} must be able to read the plan`)
  }
})

test('a pass review whose done_when ids are not the plan is rejected by name', { skip }, async () => {
  const h = harness({ role: 'reviewer' })
  const args = {
    verdict: 'pass',
    reasons: ['looks right'],
    done_when: [CLAIM('notes'), CLAIM('contnet', { id: 'contnet' })],
    acceptance_coverage: [{ condition: 'notes', acceptance: 'note exists' }],
  }
  await assert.rejects(() => h.tool('kanban_submit_review').execute(args, h.exec), (error) => {
    assert.match(error.message, /kanban_submit_review rejected/)
    // Names both what went wrong and the full expected set, so the model can fix it.
    assert.match(error.message, /missing content/)
    assert.match(error.message, /not plan conditions: contnet/)
    assert.match(error.message, /exactly: notes, content/)
    return true
  })
  assert.equal(h.accepted.length, 0, 'a rejected review must not reach the engine')
})

test('a pass review missing a condition row is rejected with the expected ids', { skip }, async () => {
  const h = harness({ role: 'reviewer' })
  const args = {
    verdict: 'pass',
    reasons: ['looks right'],
    done_when: [CLAIM('notes')],
    acceptance_coverage: [{ condition: 'notes', acceptance: 'note exists' }],
  }
  await assert.rejects(() => h.tool('kanban_submit_review').execute(args, h.exec), /The plan's condition ids are exactly: notes, content/)
})

test('a fail review may omit rows but not invent ids', { skip }, async () => {
  const h = harness({ role: 'reviewer' })
  const fail = { verdict: 'fail', reasons: ['missing file'], instruction: 'create notes.txt' }
  const value = await h.tool('kanban_submit_review').execute(fail, h.exec)
  assert.equal(value.accepted, true, 'a fail with no done_when rows is a normal review')
  const invented = { ...fail, done_when: [CLAIM('nope')] }
  await assert.rejects(() => h.tool('kanban_submit_review').execute(invented, h.exec), /not plan conditions: nope/)
})

test('an implementation result with ids the plan never declared is rejected', { skip }, async () => {
  const h = harness({ role: 'implementer' })
  const args = {
    status: 'complete',
    summary: 'did it',
    changed_files: ['notes.txt'],
    done_when: [CLAIM('notes'), CLAIM('content'), CLAIM('extra')],
  }
  await assert.rejects(() => h.tool('kanban_submit_implementation').execute(args, h.exec), (error) => {
    assert.match(error.message, /kanban_submit_implementation rejected/)
    assert.match(error.message, /not plan conditions: extra/)
    assert.match(error.message, /exactly: notes, content/)
    return true
  })
})

test('an implementation result missing a condition row is rejected too', { skip }, async () => {
  const h = harness({ role: 'implementer' })
  const args = {
    status: 'complete',
    summary: 'did it',
    changed_files: ['notes.txt'],
    done_when: [CLAIM('notes')],
  }
  await assert.rejects(() => h.tool('kanban_submit_implementation').execute(args, h.exec), /missing content/)
})

test('a blocked implementation with no rows is not an id mismatch', { skip }, async () => {
  const h = harness({ role: 'implementer' })
  const args = { status: 'blocked', summary: 'cannot', changed_files: [], done_when: [], questions: ['which file?'] }
  const value = await h.tool('kanban_submit_implementation').execute(args, h.exec)
  assert.equal(value.accepted, true)
})

test('the submission tools still enforce their own phase before checking ids', { skip }, async () => {
  const h = harness({ role: 'implementer' })
  await assert.rejects(() => h.tool('kanban_submit_review').execute({ verdict: 'pass', reasons: [] }, h.exec), /not available in the implementer phase/)
})
