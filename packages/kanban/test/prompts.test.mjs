// The real prompt files, rendered by the real engine.
//
// The phase prompts used to paste the whole plan, the acceptance list, the
// implementer's JSON and a git diff into every review turn. KAN-13 slimmed them
// to what a session cannot already see in its own transcript. These tests pin
// that shape: the review prompt must carry the plan's actual condition ids and
// the exact tool contract, and must not carry the dumps back.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { resolveConfig } from '../src/config.mjs'
import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import { Engine } from '../src/engine.mjs'
import { loadPrompts } from '../src/prompts.mjs'

const CWD = mkdtempSync(join(tmpdir(), 'kanban-prompts-'))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

const PLAN = {
  summary: 'write the file',
  steps: ['create notes.txt'],
  done_when: [
    { id: 'notes-exist', statement: 'notes.txt exists', how_verified: 'test -f notes.txt' },
    { id: 'says-hello', statement: 'the file says hello', how_verified: 'grep -q hello notes.txt' },
  ],
}
const IMPLEMENTATION = {
  status: 'complete',
  summary: 'created notes.txt',
  changed_files: ['notes.txt'],
  done_when: [
    { id: 'notes-exist', met: true, confidence: 0.95, evidence: 'notes.txt:1 hello' },
    { id: 'says-hello', met: true, confidence: 0.95, evidence: 'grep -q hello notes.txt exits 0' },
  ],
}
const REVIEW_PASS = {
  verdict: 'pass',
  reasons: ['matches plan'],
  scope_drift: 'none',
  done_when: [
    { id: 'notes-exist', met: true, confidence: 0.95, evidence: 'notes.txt:1 hello' },
    { id: 'says-hello', met: true, confidence: 0.95, evidence: 'grep -q hello notes.txt exits 0' },
  ],
  acceptance_coverage: [{ condition: 'notes-exist', acceptance: 'note exists' }],
}
const REVIEW_FAIL = {
  verdict: 'fail',
  reasons: ['the file is missing'],
  instruction: 'create notes.txt and write hello into it',
  scope_drift: 'none',
  acceptance_coverage: [],
}

async function setup(queues = {}) {
  const { config } = resolveConfig({
    roles: {
      planner: { provider: 'local', model: 'm' },
      implementer: { provider: 'local', model: 'm' },
      reviewer: { provider: 'local', model: 'm' },
      approver: { provider: 'local', model: 'm' },
    },
    providers: [{ name: 'local' }],
    confidenceThreshold: 0.7,
  })
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const prompts = await loadPrompts({}, PACKAGE_DIR)
  // session-1 is the plan session; session-2 is the build session that every
  // later phase — implement, review, approval — runs inside, in order.
  const script = {
    'session-1': [{ type: 'plan', value: PLAN }],
    'session-2': [{ type: 'implementation', value: IMPLEMENTATION }, { type: 'review', value: REVIEW_PASS }],
    ...queues,
  }
  const driver = {
    ticketSessions: new Map(),
    counter: 0,
    async ensureTicketSession({ ticket, purpose }) {
      const key = `${ticket.id}:${purpose}`
      let id = this.ticketSessions.get(key)
      if (id === undefined) {
        id = `session-${++this.counter}`
        this.ticketSessions.set(key, id)
      }
      return { sessionId: id }
    },
    setPhase() {},
    setRoute() {},
    async sendTurn({ sessionId }) {
      const queue = script[sessionId] ?? []
      return { status: 'ok', action: queue.shift() ?? null, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
    },
    async closeSession() {},
    async closeTicketSessions() {},
    liveTicketSession(ticketId, purpose) { return this.ticketSessions.get(`${ticketId}:${purpose}`) },
    isLive() { return true },
    isTicketBusy() { return false },
  }
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  const engine = new Engine({ ctx: { get: () => undefined }, store, driver, getConfig: () => config, getPrompts: () => prompts, log })
  const promptOf = (kind) => {
    const row = store.latestArtifact(store.listTickets()[0].id, kind)
    return row === undefined ? null : row.content
  }
  return { store, engine, driver, promptOf }
}

function working(store) {
  const ticket = store.createTicket({
    title: 'demo',
    body: 'make the note',
    acceptance: ['note exists'],
    workspaceCwd: CWD,
    planTiming: 'at_pickup',
    planQuestions: 'autonomous',
    column: 'working',
  })
  return store.getTicket(ticket.id)
}

test('the review prompt carries the plan ids, the tool contract and the readable restatement', async () => {
  const { store, engine, promptOf } = await setup()
  const ticket = working(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  await engine.review(store.getTicket(ticket.id))

  const prompt = promptOf('reviewer_prompt_review')
  assert.ok(prompt, 'the rendered review prompt is recorded as an artifact')
  // Every condition id the reviewer must answer with, verbatim.
  assert.match(prompt, /`notes-exist`/)
  assert.match(prompt, /`says-hello`/)
  assert.match(prompt, /notes\.txt exists/)
  // Every key of kanban_submit_review, and what the engine checks.
  for (const key of ['verdict', 'reasons', 'scope_drift', 'done_when', 'acceptance_coverage', 'instruction']) {
    assert.match(prompt, new RegExp(`\`${key}\``), `review prompt must name the ${key} key`)
  }
  assert.match(prompt, /adversarial/i)
  assert.match(prompt, /same id/)
  // The plan, the human's words and the implementer's result are restated as markdown.
  for (const present of ['## Plan', "## The implementer's result", '## The ticket, as the human wrote it', 'how verified: test -f notes.txt']) {
    assert.ok(prompt.includes(present), `review prompt lacks ${present}`)
  }
  assert.equal(prompt.includes('how_verified:'), false)
})

test('the approval prompt is the one-line hand-over', async () => {
  const { store, engine, promptOf } = await setup({ 'session-2': [{ type: 'implementation', value: IMPLEMENTATION }, { type: 'review', value: REVIEW_PASS }] })
  const ticket = working(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  await engine.review(store.getTicket(ticket.id))

  const prompt = promptOf('approver_prompt_approval')
  assert.ok(prompt, 'the approval turn was prompted')
  assert.match(prompt, /^Without making any further changes, offer the user a selection of a few options for next steps that would enable you to wrap this work up\./)
  assert.match(prompt, /kanban_approve/)
  assert.match(prompt, /kanban_discard/)
  assert.match(prompt, /kanban_submit_plan/)
  assert.match(prompt, /only when, the human asks|only when, the human asks for one of them/)
  assert.equal(prompt.includes('{{'), false, 'the approval prompt still has an unresolved placeholder')
  assert.equal(prompt.includes('{'), false, 'the approval prompt still carries structured data')
})

test('the rework prompt restates the review, the ticket and the plan', async () => {
  const { store, engine, promptOf } = await setup({ 'session-2': [{ type: 'implementation', value: IMPLEMENTATION }, { type: 'review', value: REVIEW_FAIL }] })
  const ticket = working(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  await engine.review(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))

  const prompt = promptOf('implementer_prompt_implement')
  assert.match(prompt, /Review requested changes to kanban ticket/)
  assert.match(prompt, /create notes\.txt and write hello into it/)
  assert.match(prompt, /kanban_submit_implementation/)
  for (const present of ['## Plan', '## done_when', '## The review that sent this back', '## Submission contract']) {
    assert.ok(prompt.includes(present), `rework prompt lacks ${present}`)
  }
})

test('a long review instruction is rendered in full into the rework prompt', async () => {
  const long = { ...REVIEW_FAIL, instruction: `fix everything: ${'x'.repeat(400)}` }
  const { store, engine, promptOf } = await setup({ 'session-2': [{ type: 'implementation', value: IMPLEMENTATION }, { type: 'review', value: long }] })
  const ticket = working(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  await engine.review(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  const prompt = promptOf('implementer_prompt_implement')
  assert.ok(prompt.includes(`fix everything: ${'x'.repeat(400)}`), 'the instruction is rendered verbatim')
})

test('the implement prompt restates the full plan and conditions', async () => {
  const { store, engine, promptOf } = await setup()
  const ticket = working(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  const prompt = promptOf('implementer_prompt_implement')
  assert.match(prompt, /Implement the plan for kanban ticket/)
  assert.match(prompt, /## Plan/)
  assert.match(prompt, /## done_when/)
  assert.match(prompt, /how verified: test -f notes\.txt/)
})

test('both plan prompts coach that done_when conditions are agent-verifiable, never human', async () => {
  // KAN-19: a plan once carried a `human-visual-verify` condition no agent could
  // ever evidence. Both plan prompts must now state the hard rule, and the
  // rendered artifact — not just the file on disk — is what the planner reads.
  for (const planQuestions of ['interactive', 'autonomous']) {
    const { store, engine, promptOf } = await setup()
    const ticket = store.createTicket({
      title: 'demo',
      body: 'make the note',
      acceptance: ['note exists'],
      workspaceCwd: CWD,
      planTiming: 'at_pickup',
      planQuestions,
      column: 'working',
    })
    await engine.plan(store.getTicket(ticket.id))
    const prompt = promptOf('planner_prompt_plan')
    assert.ok(prompt, `the rendered ${planQuestions} plan prompt is recorded as an artifact`)
    assert.match(prompt, /verifiable by an agent without human input/, `${planQuestions} prompt must demand agent-verifiable conditions`)
    assert.match(prompt, /Never write a condition that requires a human action, visual confirmation, a production restart/, `${planQuestions} prompt must name the forbidden evidence`)
    assert.match(prompt, /human approval is already implicit/, `${planQuestions} prompt must say approval is already implicit`)
    assert.match(prompt, /agent-verifiable proxy/, `${planQuestions} prompt must point at the proxy strategy`)
    assert.equal(prompt.includes('{{'), false, 'the plan prompt still has an unresolved placeholder')
  }
})

// ------------------------------------------------------------------- KAN-32
//
// The Questions setting now covers the whole ticket, and the prompts say so: an
// autonomous ticket's build and review turns are told that an option-batch ask
// is answered for them and logged, and the interactive planning prompt is told
// that offering options is what keeps a question off a human's screen. An
// interactive ticket's build prompt keeps the exact text it had before.

test('an autonomous ticket’s build, rework and review prompts carry the questions note', async () => {
  const fail = { verdict: 'fail', reasons: ['not done'], instruction: 'do it again', scope_drift: 'none', acceptance_coverage: [] }
  const { store, engine, promptOf } = await setup({
    'session-2': [
      { type: 'implementation', value: IMPLEMENTATION },
      { type: 'review', value: fail },
      { type: 'implementation', value: IMPLEMENTATION },
    ],
  })
  const ticket = working(store) // planQuestions: 'autonomous'
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  const implement = promptOf('implementer_prompt_implement')
  assert.match(implement, /set to decide autonomously/)
  assert.match(implement, /question_answered_autonomously/)
  assert.match(implement, /`kanban_submit_implementation` report/)
  assert.match(implement, /A question with no options is still a question for a human/)
  await engine.review(store.getTicket(ticket.id))
  assert.match(promptOf('reviewer_prompt_review'), /`kanban_submit_review` report/)
  await engine.implement(store.getTicket(ticket.id))
  assert.match(promptOf('implementer_prompt_implement'), /set to decide autonomously/, 'the rework prompt carries it too')
})

test('an interactive ticket’s build and review prompts carry no questions note', async () => {
  const { store, engine, promptOf } = await setup()
  const created = store.createTicket({
    title: 'demo',
    body: 'make the note',
    acceptance: ['note exists'],
    workspaceCwd: CWD,
    planTiming: 'at_pickup',
    planQuestions: 'interactive',
    column: 'working',
  })
  const ticket = store.getTicket(created.id)
  await engine.plan(ticket)
  await engine.implement(ticket)
  const implement = promptOf('implementer_prompt_implement')
  assert.equal(implement.includes('decide autonomously'), false, 'an interactive ticket is not told the engine decides for it')
  assert.equal(implement.includes('{{'), false, 'the placeholder is resolved, not left behind')
  await engine.review(ticket)
  assert.equal(promptOf('reviewer_prompt_review').includes('{{'), false)
})

test('the interactive planning prompt says an all-options batch never reaches a human', async () => {
  const { store, engine, promptOf } = await setup()
  const created = store.createTicket({
    title: 'demo',
    body: 'make the note',
    acceptance: ['note exists'],
    workspaceCwd: CWD,
    planTiming: 'at_pickup',
    planQuestions: 'interactive',
    column: 'working',
  })
  await engine.plan(store.getTicket(created.id))
  const prompt = promptOf('planner_prompt_plan')
  assert.match(prompt, /auto-decided by the board/)
  assert.match(prompt, /reserve an optionless question/)
})

// ------------------------------------------------------------------- KAN-31
//
// One definition of done, rendered the same way into every phase: the plan
// declares a release scope and deferred conditions, the build prompt marks them,
// the review prompt says how to report them, and the approval hand-over lists
// them — while a ticket with none gets the exact prompt it always got.

const DEFERRED_PLAN = {
  summary: 'write the file; the human lands the release',
  steps: ['create notes.txt'],
  release_scope: 'stop_before_merge',
  done_when: [
    { id: 'notes-exist', statement: 'notes.txt exists', how_verified: 'test -f notes.txt' },
    {
      id: 'release-landed',
      statement: 'merged to main and tagged',
      how_verified: 'git ls-remote origin refs/tags/v1 prints a sha',
      deferred: true,
      human_evidence: 'git ls-remote origin refs/tags/v1 prints a sha',
    },
  ],
}
const IMPLEMENT_DEFERRED = {
  status: 'complete',
  summary: 'created notes.txt',
  changed_files: ['notes.txt'],
  done_when: [
    { id: 'notes-exist', met: true, confidence: 0.95, evidence: 'notes.txt:1 hello' },
    { id: 'release-landed', met: false, confidence: 0.95, evidence: 'not merged — deferred to approval' },
  ],
}
const REVIEW_DEFERRED = {
  verdict: 'pass',
  reasons: ['the code round is complete'],
  scope_drift: 'none',
  done_when: [
    { id: 'notes-exist', met: true, confidence: 0.95, evidence: 'notes.txt:1 hello' },
    { id: 'release-landed', met: false, confidence: 0.95, evidence: 'the human lands it at approval' },
  ],
  acceptance_coverage: [{ condition: 'notes-exist', acceptance: 'note exists' }],
}

const APPROVAL_BEFORE_KAN31 = [
  'Without making any further changes, offer the user a selection of a few options for next steps that would enable you to wrap this work up.',
  '',
  '`kanban_approve`, `kanban_discard` and `kanban_submit_plan` are available when, and only when, the human asks for one of them.',
  '',
].join('\n')

async function deferredRun(queues = {}) {
  const { store, engine, promptOf } = await setup({
    'session-1': [{ type: 'plan', value: DEFERRED_PLAN }],
    'session-2': [
      { type: 'implementation', value: IMPLEMENT_DEFERRED },
      { type: 'review', value: REVIEW_DEFERRED },
    ],
    ...queues,
  })
  const ticket = working(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  await engine.review(store.getTicket(ticket.id))
  return { store, engine, promptOf, ticket }
}

test('the approval prompt is byte-identical when nothing is deferred', async () => {
  const { store, engine, promptOf } = await setup()
  const ticket = working(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  await engine.review(store.getTicket(ticket.id))
  const prompt = promptOf('approver_prompt_approval')
  assert.equal(prompt, APPROVAL_BEFORE_KAN31, 'a plain ticket gets the pre-0.17.0 hand-over, byte for byte')
})

test('the approval prompt lists the deferred conditions and what the human checks', async () => {
  const { promptOf } = await deferredRun()
  const prompt = promptOf('approver_prompt_approval')
  assert.match(prompt, /Deferred conditions — the human evidences these, not you/)
  assert.match(prompt, /`release-landed` — merged to main and tagged/)
  assert.match(prompt, /human evidence: git ls-remote origin refs\/tags\/v1 prints a sha/)
  // The hand-over still ends the way it always did.
  assert.match(prompt, /asks for one of them\.\n/)
})

test('the implement prompt carries the release scope and marks the deferred condition', async () => {
  const { promptOf } = await deferredRun()
  assert.match(promptOf('implementer_prompt_implement'), /Release scope: this plan stops before the release/)
  assert.match(promptOf('implementer_prompt_implement'), /- `release-landed` — merged to main and tagged\n  - how verified: git ls-remote origin refs\/tags\/v1 prints a sha \(deferred to approval — human evidence: git ls-remote origin refs\/tags\/v1 prints a sha\)/)
  assert.match(promptOf('implementer_prompt_implement'), /The review is gated on exactly these condition ids/)
})

test('a plan without a release scope leaves the implement prompt without one', async () => {
  const { store, engine, promptOf } = await setup()
  const ticket = working(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  const prompt = promptOf('implementer_prompt_implement')
  assert.equal(prompt.includes('Release scope:'), false, 'no scope declared, no scope line rendered')
  assert.equal(prompt.includes('deferred to approval — human evidence'), false, 'no condition asked for the treatment')
})

test('the rework prompt carries the release scope too', async () => {
  const fail = { verdict: 'fail', reasons: ['not done'], instruction: 'do it again', scope_drift: 'none', acceptance_coverage: [] }
  const { store, engine, promptOf } = await setup({
    'session-1': [{ type: 'plan', value: DEFERRED_PLAN }],
    'session-2': [
      { type: 'implementation', value: IMPLEMENT_DEFERRED },
      { type: 'review', value: fail },
      { type: 'implementation', value: IMPLEMENT_DEFERRED },
    ],
  })
  const ticket = working(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  await engine.review(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  assert.match(promptOf('implementer_prompt_implement'), /Release scope: this plan stops before the release/)
})

test('the review prompt says how to report a deferred condition', async () => {
  const { promptOf } = await deferredRun()
  const prompt = promptOf('reviewer_prompt_review')
  assert.match(prompt, /`release-landed` — merged to main and tagged\n  - how verified: git ls-remote origin refs\/tags\/v1 prints a sha \(deferred to approval — human evidence: git ls-remote origin refs\/tags\/v1 prints a sha\)/)
  assert.match(prompt, /if the only unmet conditions are deferred ones, the verdict is `pass`/)
  assert.match(prompt, /one row per \*\*stored\*\* acceptance statement/)
  assert.match(prompt, /submit an empty array when the ticket stored none/)
})

test('both plan prompts teach release scope and deferred conditions', async () => {
  for (const planQuestions of ['interactive', 'autonomous']) {
    const { store, engine, promptOf } = await setup()
    const ticket = store.createTicket({
      title: 'demo',
      body: 'make the note',
      acceptance: ['note exists'],
      workspaceCwd: CWD,
      planTiming: 'at_pickup',
      planQuestions,
      column: 'working',
    })
    await engine.plan(store.getTicket(ticket.id))
    const prompt = promptOf('planner_prompt_plan')
    assert.match(prompt, /## Release scope and deferred steps/, `${planQuestions} prompt must carry the new section`)
    assert.match(prompt, /`stop_before_merge`/)
    assert.match(prompt, /`full_release`/)
    assert.match(prompt, /`deferred: true`/)
    assert.match(prompt, /`human_evidence`/)
    assert.match(prompt, /costs the build no attempt/)
    // The KAN-19 rule is still there: the new section supplements it.
    assert.match(prompt, /verifiable by an agent without human input/)
    // And the KAN-30 sandbox section is untouched.
    assert.match(prompt, /## Sandbox grants/)
  }
})


// ------------------------------------------------- readable prompts, no JSON
//
// The build, rework and review prompts render the stored plan, the implementer's
// result and the review verdict as markdown, and carry the human's own words.

const IMG = `sha256:${'a'.repeat(64)}`
const RICH_PLAN = {
  summary: 'ship the guard',
  steps: ['write the matcher', 'wire the listener'],
  release_scope: 'stop_before_merge',
  sandbox: {
    grants: { paths: ['/srv/lab/kan9-grant'], commands: ['gh pr create'] },
    checks: [{ path: '/srv/lab/kan9-grant', check: 'test -w', observed: 'writable' }],
  },
  done_when: [
    { id: 'matcher-tested', statement: 'the matcher has tests', how_verified: 'npm test exits 0' },
    {
      id: 'tag-cut',
      statement: 'the release tag exists',
      how_verified: 'git ls-remote origin refs/tags/v9',
      deferred: true,
      human_evidence: 'ls-remote prints a sha',
    },
  ],
}
const RICH_IMPLEMENTATION = {
  status: 'complete',
  summary: 'matcher written',
  changed_files: ['src/guard.mjs'],
  done_when: [
    { id: 'matcher-tested', met: true, confidence: 0.9, evidence: 'npm test exits 0, test/guard.test.mjs:12' },
    { id: 'tag-cut', met: false, confidence: 0.9, evidence: 'deferred to approval' },
  ],
  residual_risks: ['text rule only'],
}
const RICH_REVIEW_FAIL = {
  verdict: 'fail',
  reasons: ['the matcher misses a case'],
  instruction: 'handle the subshell form',
  scope_drift: 'none',
  done_when: [{ id: 'matcher-tested', met: false, confidence: 0.8, evidence: 'src/guard.mjs:40 skips $(...)' }],
  acceptance_coverage: [],
}
const BODY_TEXT = 'Please make the guard.\n\n- it must say **why** it denied\n- keep `kan9-plugins` naming'

async function richRun() {
  const { store, engine, promptOf } = await setup({
    'session-1': [{ type: 'plan', value: RICH_PLAN }],
    'session-2': [
      { type: 'implementation', value: RICH_IMPLEMENTATION },
      { type: 'review', value: RICH_REVIEW_FAIL },
      { type: 'implementation', value: RICH_IMPLEMENTATION },
    ],
  })
  engine.ctx = { get: () => undefined, attachments: { imageHostPath: () => '/store/shot.png' } }
  const created = store.createTicket({
    title: 'Guard "checkouts" & more',
    body: `${BODY_TEXT}\n\n![shot](kanban-image:${IMG})`,
    acceptance: ['a denied ask names the owner', 'closed tickets stay readable'],
    workspaceCwd: CWD,
    planTiming: 'at_pickup',
    planQuestions: 'interactive',
    column: 'working',
  })
  const id = created.id
  const prompts = {}
  await engine.plan(store.getTicket(id))
  await engine.approvePlan(id)
  await engine.implement(store.getTicket(id))
  prompts.implement = promptOf('implementer_prompt_implement')
  await engine.review(store.getTicket(id))
  prompts.review = promptOf('reviewer_prompt_review')
  await engine.implement(store.getTicket(id))
  prompts.rework = promptOf('implementer_prompt_implement')
  return prompts
}

function assertNoStoredJson(name, prompt) {
  assert.equal(prompt.includes('{{'), false, `${name} has an unresolved placeholder`)
  for (const raw of ['"done_when"', '"conditions"', '"howVerified"', '"how_verified"', '"verdict"', '"reasons"', '"changed_files"', '"releaseScope"', '"steps"', '"sandbox"']) {
    assert.equal(prompt.includes(raw), false, `${name} embeds raw JSON key ${raw}`)
  }
  assert.equal(/^\s*[{[]\s*$/m.test(prompt), false, `${name} has a bare JSON brace line`)
  assert.equal(/\{\s*\n\s*"/.test(prompt), false, `${name} embeds a pretty-printed JSON object`)
}

test('build, rework and review prompts carry the human input verbatim and no stored JSON', async () => {
  const { implement, review, rework } = await richRun()
  for (const [name, prompt] of Object.entries({ implement, review, rework })) {
    assertNoStoredJson(name, prompt)
    assert.ok(prompt.includes('Title: Guard "checkouts" & more'), `${name}: title verbatim`)
    assert.ok(prompt.includes(BODY_TEXT), `${name}: body verbatim`)
    assert.ok(prompt.includes('- a denied ask names the owner'), `${name}: acceptance verbatim`)
    assert.ok(prompt.includes('- closed tickets stay readable'), `${name}: acceptance verbatim`)
    assert.ok(prompt.includes('- shot: /store/shot.png'), `${name}: image path`)
  }
})

test('the build prompt renders the plan, conditions, grants, scope and the submission contract', async () => {
  const { implement } = await richRun()
  assert.match(implement, /ship the guard/)
  assert.match(implement, /1\. write the matcher\n2\. wire the listener/)
  assert.match(implement, /### Release scope/)
  assert.match(implement, /### Sandbox grants/)
  assert.match(implement, /- \/srv\/lab\/kan9-grant/)
  assert.match(implement, /- gh pr create/)
  assert.match(implement, /`\/srv\/lab\/kan9-grant` — checked: test -w; observed: writable/)
  assert.match(implement, /- `matcher-tested` — the matcher has tests\n  - how verified: npm test exits 0\n  - source: plan/)
  assert.match(implement, /\(deferred to approval — human evidence: ls-remote prints a sha\)/)
  assert.match(implement, /## Submission contract/)
  assert.match(implement, /`status` is exactly `complete`, `partial` or `blocked`/)
  assert.match(implement, /exactly the plan's condition ids: `matcher-tested`, `tag-cut`/)
  assert.match(implement, /at least 0\.7/)
  assert.equal(implement.includes('differ from where the previous round started'), false, 'first round has no no-progress clause')
})

test('the rework prompt renders the review as markdown and adds the no-progress clause', async () => {
  const { rework } = await richRun()
  assert.match(rework, /Verdict: fail/)
  assert.match(rework, /Reasons:\n- the matcher misses a case/)
  assert.match(rework, /Instruction for the next round:\n\nhandle the subshell form/)
  assert.match(rework, /- `matcher-tested` — NOT met \(confidence 0\.8\): src\/guard\.mjs:40 skips \$\(\.\.\.\)/)
  assert.match(rework, /differ from where the previous round started/)
})

test('the review prompt restates the implementer result as markdown', async () => {
  const { review } = await richRun()
  assert.match(review, /## The implementer's result/)
  assert.match(review, /Status: complete/)
  assert.match(review, /Changed files:\n- src\/guard\.mjs/)
  assert.match(review, /- `matcher-tested` — met \(confidence 0\.9\): npm test exits 0, test\/guard\.test\.mjs:12/)
  assert.match(review, /Residual risks:\n- text rule only/)
})

test('the build and rework prompts forbid handoff documents', async () => {
  const { implement, rework } = await richRun()
  for (const prompt of [implement, rework]) {
    assert.match(prompt, /Do not create handoff, runbook, deploy-notes, smoke-results or summary documents anywhere in the repository\./)
    assert.match(prompt, /Report what shipped and what the human still needs to do in your final message, and keep run evidence under the ignored lab directory\./)
  }
})

test('the build prompt names the ticket-scoped clone convention', async () => {
  const { implement } = await richRun()
  assert.match(implement, /`kan1-plugins` and `kan1-deploy`/)
  assert.match(implement, /never write to the live production checkout/)
})
