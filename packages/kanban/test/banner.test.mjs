// The turn-tail banner's decision, evaluated from the real client source.
//
// src/client.mjs is a browser module: it is one self-contained factory with no
// relative imports, so its helpers cannot be `require`d. They are also pure —
// no DOM, no React, no RPC — so the test slices the banner block out of the
// file and evaluates it. That is the only way to test the thing that actually
// broke: a session with a rework round holds a FAILED review and a later PASSED
// one, and a banner derived only from the ticket's current phase labels both
// "Review passed", which is the opposite of what the first turn did.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../src/client.mjs', import.meta.url))

/**
 * Evaluate the banner helpers exactly as the browser half defines them.
 * @returns {{bannerFor:Function, callFeedback:Function, rememberBanner:Function, bannerCache:Map, kanbanCallsInTurn:Function}}
 */
async function bannerModule() {
  const src = await readFile(CLIENT, 'utf8')
  const start = src.indexOf('var PHASE_ORDER')
  const end = src.indexOf('function fetchSessionInfo')
  assert.ok(start > 0 && end > start, 'the banner block must sit between PHASE_ORDER and fetchSessionInfo')
  const block = src.slice(start, end)
  // `rpc` is referenced only by fetchSessionInfo, which is outside the slice.
  const load = new Function(`${block}\nreturn { bannerFor, callFeedback, rememberBanner, bannerCache, kanbanCallsInTurn, parseToolArgs };`)
  return load()
}

const review = (args) => ({ name: 'kanban_submit_review', args })
const PASS_CALL = { verdict: 'pass', reasons: ['all conditions met'] }
const FAIL_CALL = { verdict: 'fail', instruction: 'a.txt missing', reasons: ['no file'] }
// `review` is the ticket's LATEST review artifact and `reviewFeedback` the latest
// feedback: both are per-ticket, which is exactly the trap this pins.
const VERIFY = { ticket: { phase: 'verify', column: 'working' }, plan: { summary: 's', conditions: [{ id: 'alpha' }] }, review: PASS_CALL, reviewFeedback: 'the newest round text' }
const IMPLEMENT = { ticket: { phase: 'implement', column: 'working' }, plan: { summary: 's', conditions: [{ id: 'alpha' }] }, review: FAIL_CALL, reviewFeedback: 'the newest round text' }

test('a failed review does not borrow a later round pass', async () => {
  const { bannerFor } = await bannerModule()
  const failed = [review(FAIL_CALL)]
  // The ticket is now in verify because a LATER round passed. This turn failed.
  assert.equal(bannerFor(failed, VERIFY), null, 'a failed review must not claim a pass once the ticket moved on')
})

test('a passed review claims the pass, and only it does', async () => {
  const { bannerFor } = await bannerModule()
  const banner = bannerFor([review(PASS_CALL)], VERIFY)
  assert.equal(banner.tone, 'ok')
  assert.match(banner.text, /^Review passed — all conditions met\. Now proceeding to approval\.$/)
})

test('two review rounds in one session each say what their own turn did', async () => {
  const { bannerFor } = await bannerModule()
  const first = [review({ verdict: 'fail', instruction: 'round one: create a.txt' })]
  const second = [review(PASS_CALL)]
  // Same ticket state, two different turns — the regression this pins.
  assert.equal(bannerFor(first, VERIFY), null, 'the failed round renders nothing, not the later pass')
  assert.match(bannerFor(second, VERIFY).text, /^Review passed/, 'the passed round renders its own pass')
})

test('a rejected review quotes its own instruction, not the latest artifact', async () => {
  const { bannerFor } = await bannerModule()
  // IMPLEMENT's latest artifact is round two's; round one's turn must still quote
  // round one's instruction, not the newest text on the ticket.
  const roundOne = [review({ verdict: 'fail', instruction: 'round one: create a.txt', reasons: ['ignored'] })]
  const roundTwo = [review({ verdict: 'fail', instruction: 'round two: a.txt says the wrong word' })]
  assert.match(bannerFor(roundOne, IMPLEMENT).text, /round one: create a\.txt/)
  assert.equal(bannerFor(roundOne, IMPLEMENT).text.includes('the newest round text'), false, 'a turn must not display a later round feedback')
  assert.match(bannerFor(roundTwo, IMPLEMENT).text, /round two: a\.txt says the wrong word/)
})

test('a fail with no instruction falls back to its own reasons', async () => {
  const { bannerFor } = await bannerModule()
  const banner = bannerFor([review({ verdict: 'fail', reasons: ['no a.txt', 'b.txt empty'] })], IMPLEMENT)
  assert.match(banner.text, /no a\.txt; b\.txt empty/)
  assert.equal(banner.tone, 'warn')
})

test('a pass the code check sent back reads as not finished', async () => {
  const { bannerFor } = await bannerModule()
  // The reviewer claimed a pass; verifyReview found gaps and returned it to implement.
  const claimed = { verdict: 'pass', reasons: ['looks done'] }
  const banner = bannerFor([review(claimed)], {
    ...IMPLEMENT,
    review: claimed,
    reviewFeedback: 'Review cannot be code-verified: done_when.alpha is missing',
    reviewRejected: true,
  })
  assert.equal(banner.tone, 'warn')
  assert.match(banner.text, /^Review status: not finished — Review cannot be code-verified: done_when\.alpha is missing\. Back to implementation\.$/)
})

test('a pass that landed is never called not finished by a later phase move', async () => {
  const { bannerFor } = await bannerModule()
  // The review passed and the ticket reached verify. Later the human asked for a
  // follow-up plan from approval, which moves the ticket back to implement
  // (engine submitApprovalPlan). The passed turn must not read "not finished",
  // and must not quote the stale feedback an earlier round left behind.
  const landed = { verdict: 'pass', reasons: ['all conditions met'] }
  const followUp = {
    ticket: { phase: 'implement', column: 'working' },
    plan: { summary: 's', conditions: [{ id: 'alpha' }] },
    review: landed,
    reviewFeedback: 'round one gaps: coverage mismatch',
    reviewRejected: false,
  }
  const banner = bannerFor([review(landed)], followUp)
  assert.equal(banner, null, 'a clean pass returned to implement by a follow-up plan renders nothing')
  if (banner !== null) assert.equal(banner.text.includes('not finished'), false, 'must not claim the pass did not finish')
  // The same state with no reviewRejected field at all (an older host) is also
  // silence: only an explicit rejection may call a pass "not finished".
  assert.equal(bannerFor([review(landed)], { ...followUp, reviewRejected: undefined }), null)
})

test('a review call with no readable verdict keeps the phase-only reading', async () => {
  const { bannerFor } = await bannerModule()
  // An old transcript, or args that never parsed: better a phase-derived line than silence.
  assert.match(bannerFor([review({})], VERIFY).text, /^Review passed/)
  assert.match(bannerFor([review({ verdict: 'PASS' })], VERIFY).text, /^Review passed/, 'the verdict is matched case-insensitively')
  assert.match(bannerFor([review({})], IMPLEMENT).text, /^Review status: not finished — the newest round text/)
  // A pass that an earlier round claimed but the code check rejected must not be
  // shown as this round's pass once a later round gets through.
  const stalePass = { verdict: 'pass', reasons: ['claimed too early'] }
  assert.equal(bannerFor([review(stalePass)], { ...VERIFY, review: PASS_CALL }), null, 'a superseded pass claim renders nothing')
})

test('a review turn whose phase never moved renders nothing', async () => {
  const { bannerFor } = await bannerModule()
  // The call was refused by its gate or rejected by validation: still in review.
  assert.equal(bannerFor([review({ verdict: 'fail', instruction: 'x' })], { ...VERIFY, ticket: { phase: 'review', column: 'working' } }), null)
  assert.equal(bannerFor([review(PASS_CALL)], { ...VERIFY, ticket: { phase: 'review', column: 'working' } }), null)
})

test('the other banners still confirm against the real phase', async () => {
  const { bannerFor } = await bannerModule()
  const plan = [{ name: 'kanban_submit_plan', args: {} }]
  const impl = [{ name: 'kanban_submit_implementation', args: {} }]
  assert.equal(bannerFor(plan, { ...VERIFY, ticket: { phase: 'plan', column: 'working' } }), null, 'a plan call that never moved the ticket says nothing')
  assert.match(bannerFor(plan, VERIFY).text, /^Plan submitted — s · Done when: alpha\. Now proceeding to build\.$/)
  assert.match(bannerFor(impl, VERIFY).text, /^Implementation submitted — here's the plan: s · done when: alpha\./)
  assert.equal(bannerFor(impl, { ...VERIFY, ticket: { phase: 'implement', column: 'working' } }), null)
  assert.match(bannerFor([{ name: 'kanban_approve', args: {} }], { ...VERIFY, ticket: { phase: 'closed', column: 'done' } }).text, /^Ticket approved and closed\.$/)
  assert.equal(bannerFor([{ name: 'kanban_approve', args: {} }], VERIFY), null, 'a refused approve must not claim a close')
  assert.match(bannerFor([{ name: 'kanban_discard', args: {} }], { ...VERIFY, ticket: { phase: 'closed', column: 'discarded' } }).text, /^Ticket discarded\.$/)
})

test('callFeedback and the cache bound behave', async () => {
  const { callFeedback, rememberBanner, bannerCache } = await bannerModule()
  assert.equal(callFeedback({ instruction: 'do it' }), 'do it')
  assert.equal(callFeedback({ reasons: ['a', 'b'] }), 'a; b')
  assert.equal(callFeedback({ instruction: ' \n multi   line  ' }), 'multi line', 'feedback is flattened to one line')
  assert.equal(callFeedback(null), '')
  assert.equal(callFeedback({}), '')
  for (let i = 0; i < 260; i += 1) rememberBanner(`stale:${i}`, { tone: 'ok', text: `banner ${i}` })
  assert.ok(bannerCache.size <= 200, `the cache must stay bounded, saw ${bannerCache.size}`)
  assert.equal(bannerCache.has('stale:0'), false, 'the oldest entry is evicted first')
  assert.equal(bannerCache.has('stale:259'), true, 'the newest entry survives')
})

test('tool calls are read out of the turn the way the renderer needs them', async () => {
  const { kanbanCallsInTurn, parseToolArgs } = await bannerModule()
  const turn = {
    turn: 3,
    steps: [
      { data: { get: () => ({ blocks: [{ kind: 'text', text: 'hi' }, { kind: 'tool-call', name: 'bash', argsRaw: '{}' }] }) } },
      { data: { get: () => ({ blocks: [{ kind: 'tool-call', name: 'kanban_submit_review', argsRaw: '{"verdict":"fail","instruction":"fix a.txt"}' }] }) } },
      { data: { get: () => undefined } },
      { data: null },
    ],
  }
  const calls = kanbanCallsInTurn(turn)
  assert.equal(calls.length, 1, 'only kanban_* calls are collected')
  assert.equal(calls[0].name, 'kanban_submit_review')
  assert.deepEqual(calls[0].args, { verdict: 'fail', instruction: 'fix a.txt' })
  assert.deepEqual(parseToolArgs('not json'), {}, 'unparseable args become an empty object, never a throw')
  assert.deepEqual(parseToolArgs(null), {})
  assert.deepEqual(kanbanCallsInTurn(undefined), [])
})

// The banner trusts the host's `reviewRejected` flag, so the premise behind it
// must hold on the real store: the engine writes the `review` row before the
// `review_feedback` row that rejects it, and artifact ids are AUTOINCREMENT, so
// "feedback newer than review" can only mean "that review was sent back".
test('reviewRejected ordering holds against a real store', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { migrate } = await import('../src/db.mjs')
  const { KanbanStore } = await import('../src/store.mjs')
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const ticket = store.createTicket({ title: 'x', acceptance: [], column: 'working' })

  const rejected = () => {
    const review = store.latestArtifact(ticket.id, 'review')
    const feedback = store.latestArtifact(ticket.id, 'review_feedback')
    return review !== undefined && feedback !== undefined && Number(feedback.id) > Number(review.id)
  }

  // A pass the code check bounced: review first, then the feedback that rejects it.
  store.addArtifact(ticket.id, 'review', JSON.stringify({ verdict: 'pass', reasons: ['looks done'] }))
  assert.equal(rejected(), false, 'a pass with no feedback has not been sent back')
  store.addArtifact(ticket.id, 'review_feedback', 'Review cannot be code-verified: done_when.alpha is missing')
  assert.equal(rejected(), true, 'feedback written after the review means that review was bounced')

  // A later round passes cleanly: its review is newer than the old feedback.
  store.addArtifact(ticket.id, 'review', JSON.stringify({ verdict: 'pass', reasons: ['all conditions met'] }))
  assert.equal(rejected(), false, 'a clean pass must not inherit an older round rejection')

  // A fail verdict sends feedback too, and is still a rejection of that review.
  store.addArtifact(ticket.id, 'review', JSON.stringify({ verdict: 'fail', reasons: ['nope'] }))
  store.addArtifact(ticket.id, 'review_feedback', 'fix it')
  assert.equal(rejected(), true)
  db.close()
})
