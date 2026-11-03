import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  QUESTION_PARK_PREFIX,
  endedOnQuestion,
  isQuestionPark,
  planRevisionState,
  questionParkReason,
  recoverySummary,
  restartResumeAllowed,
} from '../src/recovery.mjs'
import { assertTransition, canMarkDone, canRerunReview } from '../src/lifecycle.mjs'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

// ------------------------------------------------------------ question parks

test('a turn that ends on a question is a question; one that merely contains a question mark is not', () => {
  assert.equal(endedOnQuestion('I looked at the repo.\n\nShould the file go in docs/ or notes/?'), 'Should the file go in docs/ or notes/?')
  assert.equal(endedOnQuestion('**Which one do you want?**'), '**Which one do you want?**', 'trailing emphasis is looked through')
  assert.equal(endedOnQuestion('Done. What is "x"? It is a variable.'), null, 'a question mid-paragraph is not the end of the turn')
  assert.equal(endedOnQuestion('I changed the file.'), null)
  assert.equal(endedOnQuestion(''), null)
  assert.equal(endedOnQuestion(undefined), null)
  assert.equal(endedOnQuestion('```\nwhy?\n```'), null, 'a code fence is output, not a question')
})

test('a long question is clipped, and the park reason names the phase and the question', () => {
  const long = `${'q'.repeat(300)}?`
  assert.ok(endedOnQuestion(long).length <= 200)
  const reason = questionParkReason('plan', 'Which database?')
  assert.equal(reason, `${QUESTION_PARK_PREFIX} in the plan session: Which database?`)
  assert.equal(isQuestionPark(reason), true)
  assert.equal(isQuestionPark('plan session ended without calling kanban_submit_plan'), false)
  assert.equal(isQuestionPark(null), false)
})

// ------------------------------------------------------------ restart resume

test('a restart resumes a ticket once; a second restart before any progress does not', () => {
  assert.equal(restartResumeAllowed([]), true, 'no earlier restart')
  assert.equal(restartResumeAllowed([{ kind: 'restart_recovered', payload: { autoResume: true } }]), false, 'resumed, nothing happened since, restarted again')
  assert.equal(
    restartResumeAllowed([
      { kind: 'restart_recovered', payload: { autoResume: true } },
      { kind: 'implemented', payload: {} },
    ]),
    true,
    'the resume got somewhere, so the next restart is a fresh interruption',
  )
  assert.equal(
    restartResumeAllowed([
      { kind: 'restart_recovered', payload: { autoResume: false } },
      { kind: 'needs_attention', payload: {} },
    ]),
    true,
    'a restart that parked rather than resumed does not count as an attempt',
  )
  assert.equal(
    restartResumeAllowed([
      { kind: 'restart_recovered', payload: { autoResume: true } },
      { kind: 'session_resumed', payload: {} },
      { kind: 'needs_attention', payload: {} },
    ]),
    false,
    'a park is not progress',
  )
})

// ----------------------------------------------------------- the seed summary

const SEED_BASE = {
  ticket: { key: 'K-7', title: 'write notes' },
  attempts: 3,
  maxAttempts: 3,
  events: [
    { kind: 'implemented', payload: { attempt: 1 } },
    { kind: 'review_rejected', payload: { gaps: ['done_when.notes is unmet'] } },
    { kind: 'needs_attention_reason', payload: { reason: 'attempt budget exhausted (3)' } },
    { kind: 'budget_reset', payload: {} },
    { kind: 'run_started', payload: {} },
  ],
  implementation: { status: 'partial', summary: 'wrote half of notes.txt', changed_files: ['notes.txt'], residual_risks: ['no tests'] },
  conditions: [{ id: 'notes', statement: 'note exists' }],
}

test('the summary of work that did not pass review says so, names what is left, and tells the history', () => {
  const text = recoverySummary({
    ...SEED_BASE,
    review: { verdict: 'fail', reasons: ['the file is missing'], instruction: 'create notes.txt' },
    passedReview: false,
    failingIds: ['notes'],
  })
  assert.match(text, /new session for K-7/)
  assert.match(text, /has NOT passed review/)
  assert.match(text, /Implementation rounds so far: 3 \(attempt budget per retry: 3\)/)
  assert.match(text, /implementation submitted \(attempt 1\)/)
  assert.match(text, /review sent back: done_when\.notes is unmet/)
  assert.match(text, /parked: attempt budget exhausted \(3\)/)
  assert.match(text, /a human retry reset the attempt budget/)
  assert.match(text, /Last review: verdict fail/)
  assert.match(text, /Reviewer's instruction: create notes\.txt/)
  assert.match(text, /Last implementation \(partial\): wrote half of notes\.txt/)
  assert.match(text, /Changed files: notes\.txt/)
  assert.match(text, /Residual risks it reported: no tests/)
  assert.match(text, /`notes` — note exists/)
  assert.equal(/run_started/.test(text), false, 'events with nothing to say are left out')
})

test('the summary of work that already passed review says to leave it alone', () => {
  const text = recoverySummary({
    ...SEED_BASE,
    review: { verdict: 'pass', reasons: ['matches plan'] },
    passedReview: true,
    failingIds: [],
  })
  assert.match(text, /ALREADY PASSED REVIEW/)
  assert.match(text, /Do not redo or restructure it/)
  assert.match(text, /What is left: nothing that review asked for/)
  assert.equal(/has NOT passed review/.test(text), false)
})

test('the summary with no review yet and none that named a condition', () => {
  const unreviewed = recoverySummary({ ...SEED_BASE, review: null, passedReview: false, failingIds: [], implementation: null })
  assert.match(unreviewed, /has NOT been reviewed yet/)
  assert.match(unreviewed, /Nothing has been submitted as an implementation yet/)
  assert.match(unreviewed, /everything in the plan that the workspace does not already satisfy/)
  const bookkeeping = recoverySummary({ ...SEED_BASE, review: { verdict: 'fail', reasons: ['rows missing'] }, passedReview: false, failingIds: [] })
  assert.match(bookkeeping, /named no specific condition/)
})

// ------------------------------------------------------------ revision state

test('the plan revision state follows the newest revision event', () => {
  assert.equal(planRevisionState([]), null)
  assert.deepEqual(planRevisionState([{ kind: 'plan_revision_requested', at: 't1', payload: { instruction: 'smaller' } }]).status, 'pending')
  const rejected = planRevisionState([
    { kind: 'plan_revision_requested', at: 't1', payload: { instruction: 'smaller' } },
    { kind: 'plan_revision_rejected', at: 't2', payload: { reason: 'no done_when conditions', instruction: 'smaller' } },
  ])
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.reason, 'no done_when conditions')
  const applied = planRevisionState([
    { kind: 'plan_revision_requested', at: 't1', payload: {} },
    { kind: 'planned', at: 't2', payload: { revised: true, planVersion: 2 } },
  ])
  assert.equal(applied.status, 'applied')
  assert.equal(applied.planVersion, 2)
  assert.equal(planRevisionState([{ kind: 'planned', at: 't0', payload: { planVersion: 1 } }]), null, 'an ordinary first plan is not a revision')
})

// ------------------------------------------------------- lifecycle decisions

test('a human closing a ticket outside the engine skips the phase graph, and only that', () => {
  const from = { column: 'working', phase: 'plan' }
  // The ordinary rules still refuse plan -> closed ...
  assert.equal(assertTransition(from, { column: 'done', phase: 'closed' }, { actor: 'human' }).ok, false)
  // ... but a human completing it outside the engine may.
  assert.equal(assertTransition(from, { column: 'done', phase: 'closed' }, { actor: 'human', outsideEngine: true }).ok, true)
  assert.equal(assertTransition({ column: 'backlog', phase: 'implement' }, { column: 'done', phase: 'closed' }, { actor: 'human', outsideEngine: true }).ok, true)
  // Never the engine, never into another column, never leaving a terminal one.
  assert.equal(assertTransition(from, { column: 'done', phase: 'closed' }, { actor: 'engine', outsideEngine: true }).ok, false)
  assert.equal(assertTransition(from, { column: 'discarded', phase: 'closed' }, { actor: 'human', outsideEngine: true }).ok, false)
  assert.equal(assertTransition({ column: 'done', phase: 'closed' }, { column: 'working', phase: 'closed' }, { actor: 'human', outsideEngine: true }).ok, false)
})

test('mark done is open to any live ticket and re-run review only to a parked one in implement or review', () => {
  for (const column of ['backlog', 'working']) {
    for (const phase of ['plan', 'implement', 'review', 'verify']) {
      assert.equal(canMarkDone({ column, phase }).ok, true, `${column}/${phase}`)
    }
  }
  assert.equal(canMarkDone({ column: 'done', phase: 'closed' }).ok, false)
  assert.equal(canMarkDone({ column: 'discarded', phase: 'closed' }).ok, false)
  assert.equal(canMarkDone(undefined).ok, false)

  const parked = { column: 'working', phase: 'implement', needsAttentionReason: 'attempt budget exhausted' }
  assert.equal(canRerunReview(parked).ok, true)
  assert.equal(canRerunReview({ ...parked, phase: 'review' }).ok, true)
  assert.equal(canRerunReview({ ...parked, phase: 'plan' }).ok, false)
  assert.equal(canRerunReview({ ...parked, phase: 'verify' }).ok, false)
  assert.equal(canRerunReview({ ...parked, needsAttentionReason: null }).ok, false, 'not parked')
  assert.equal(canRerunReview(parked, { hasConditions: false }).ok, false, 'nothing to review against')
  assert.equal(canRerunReview({ ...parked, column: 'done' }).ok, false)
})

// ------------------------------------------------------------------- prompts

test('the implementer prompts say that ending a turn without the submit tool parks the ticket', async () => {
  for (const file of ['implement.md', 'rework.md']) {
    const text = await readFile(join(PACKAGE_DIR, 'prompts', file), 'utf8')
    assert.match(text, /Ending a turn without calling `kanban_submit_implementation` parks the ticket/, file)
  }
})
