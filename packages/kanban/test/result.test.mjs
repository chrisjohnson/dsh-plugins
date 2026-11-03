import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyGaps,
  continuationPrompt,
  extractJson,
  gateImplement,
  isSpecificEvidence,
  nonDeferredProven,
  normalizePlan,
  validateAdjudication,
  validateGrill,
  validatePlan,
  validateReview,
  validateVerification,
  verifyReview,
} from '../src/result.mjs'

const conditions = [
  { id: 'compiles', statement: 'project compiles', howVerified: 'npm run build' },
  { id: 'tests', statement: 'tests pass', howVerified: 'npm test' },
]

function implementer(doneWhen, extra = {}) {
  return {
    status: 'complete',
    summary: 'done',
    changed_files: ['src/a.mjs'],
    done_when: doneWhen,
    questions: [],
    residual_risks: [],
    ...extra,
  }
}

test('extracts bare, fenced and prose-followed JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { ok: true, value: { a: 1 }, raw: '{"a":1}' })
  const fenced = extractJson('Here you go:\n```json\n{"a":{"b":2}}\n```\n')
  assert.equal(fenced.ok, true)
  assert.equal(fenced.value.a.b, 2)
  const prose = extractJson('I ran the tests. {"status":"complete","x":"}"}')
  assert.equal(prose.ok, true)
  assert.equal(prose.value.status, 'complete')
  assert.equal(extractJson('no json here').ok, false)
})

test('schema invalidity goes to adjudication', () => {
  const decision = gateImplement({ value: { status: 'done' }, conditions, threshold: 0.7 })
  assert.equal(decision.decision, 'adjudicate')
  assert.equal(decision.reason, 'schema')
})

test('ids must match exactly', () => {
  const decision = gateImplement({
    value: implementer([
      { id: 'compiles', met: true, confidence: 0.99, evidence: 'src/a.mjs:10 build passed' },
    ]),
    conditions,
    threshold: 0.7,
  })
  assert.equal(decision.decision, 'adjudicate')
  assert.match(decision.gaps.join(' '), /missing conditions: tests/)
})

test('generic evidence is not specific', () => {
  assert.equal(isSpecificEvidence('it works'), false)
  assert.equal(isSpecificEvidence('done'), false)
  assert.equal(isSpecificEvidence('tests pass'), false)
  assert.equal(isSpecificEvidence('src/a.mjs:10 build passed with exit code 0'), true)
  assert.equal(isSpecificEvidence('ran `npm test`, 12 passed'), true)
})

test('a pass requires every condition met, evidenced and confident', () => {
  const good = gateImplement({
    value: implementer([
      { id: 'compiles', met: true, confidence: 0.95, evidence: 'npm run build exited 0' },
      { id: 'tests', met: true, confidence: 0.9, evidence: 'tests/run.test.mjs:12 12 passed' },
    ]),
    conditions,
    threshold: 0.7,
  })
  assert.equal(good.decision, 'pass')

  const lowConfidence = gateImplement({
    value: implementer([
      { id: 'compiles', met: true, confidence: 0.4, evidence: 'npm run build exited 0' },
      { id: 'tests', met: true, confidence: 0.9, evidence: 'tests/run.test.mjs:12 12 passed' },
    ]),
    conditions,
    threshold: 0.7,
  })
  assert.equal(lowConfidence.decision, 'adjudicate')
  assert.match(lowConfidence.gaps.join(' '), /confidence 0.4/)
})

test('blocked and questions short-circuit', () => {
  assert.equal(gateImplement({ value: implementer([], { status: 'blocked' }), conditions, threshold: 0.7 }).decision, 'blocked')
  assert.equal(gateImplement({ value: implementer([], { questions: ['which db?'] }), conditions, threshold: 0.7 }).decision, 'questions')
})

test('plan needs at least one individually checkable condition', () => {
  assert.deepEqual(validatePlan({ summary: 'x', done_when: [] }), ['done_when must be a non-empty array'])
  assert.deepEqual(
    validatePlan({ done_when: [{ id: 'a', statement: 's', how_verified: 'v' }] }),
    [],
  )
  assert.ok(validatePlan({ done_when: [{ id: 'a', statement: 's' }, { id: 'a', statement: 's', how_verified: 'v' }] }).length > 0)
})

test('plan normalization is flat', () => {
  const plan = normalizePlan({ summary: 's', steps: ['one'], done_when: [{ id: 'a', statement: 'st', how_verified: 'h' }] })
  assert.equal(plan.conditions[0].howVerified, 'h')
  assert.equal(plan.conditions[0].ordinal, 0)
})

// KAN-30: the optional sandbox section.
test('plan validation rejects an unusable grant', () => {
  const base = { done_when: [{ id: 'a', statement: 's', how_verified: 'v' }] }
  assert.ok(validatePlan({ ...base, sandbox: { grants: { paths: ['relative/dir'] } } }).some((e) => /absolute path/.test(e)))
  assert.ok(validatePlan({ ...base, sandbox: { grants: { commands: ['   '] } } }).some((e) => /commands\[0\]/.test(e)))
  assert.ok(
    validatePlan({ ...base, sandbox: { grants: { commands: ['systemctl restart dsh'] } } }).some((e) => /can never be granted/.test(e)),
  )
  assert.deepEqual(validatePlan({ ...base, sandbox: { grants: { paths: ['/abs/dir'], commands: ['git push'] } } }), [])
  assert.deepEqual(validatePlan(base), [])
})

test('plan normalization carries the sandbox section and leaves a plain plan untouched', () => {
  const withGrants = normalizePlan({
    summary: 's',
    done_when: [{ id: 'a', statement: 'st', how_verified: 'h' }],
    sandbox: { grants: { paths: ['/ws/grant'], commands: ['git push'] }, checks: [{ path: '/ws/grant', check: 'test -w /ws/grant', observed: 'writable' }] },
  })
  assert.deepEqual(withGrants.sandbox.grants, { paths: ['/ws/grant'], commands: ['git push'] })
  assert.equal(withGrants.sandbox.checks[0].observed, 'writable')
  const plain = normalizePlan({ summary: 's', done_when: [{ id: 'a', statement: 'st', how_verified: 'h' }] })
  assert.equal('sandbox' in plain, false)
})

test('review, verification, grill and adjudication schemas', () => {
  assert.deepEqual(validateReview({ verdict: 'pass', reasons: [] }), [])
  assert.ok(validateReview({ verdict: 'fail', reasons: [] }).length > 0)
  assert.deepEqual(validateVerification({ done_when: [{ id: 'a', met: true, confidence: 0.9, evidence: 'x' }] }), [])
  assert.deepEqual(validateGrill({ questions: [], answers: [], refined_acceptance: ['a'] }), [])
  assert.deepEqual(validateAdjudication({ verdict: 'not_done', done_when: [], instruction: 'fix tests' }), [])
  assert.ok(validateAdjudication({ verdict: 'not_done', done_when: [] }).length > 0)
})

test('continuation carries only the gaps', () => {
  const text = continuationPrompt(['tests: met but evidence is not specific'], 'SCHEMA')
  assert.match(text, /tests: met but evidence/)
  assert.match(text, /SCHEMA/)
})

// ------------------------------------------------------------------- KAN-31
//
// One definition of done, read the same way by the plan, the build and the
// review: a condition can be deferred to the human's approval step, and a review
// whose only open conditions are deferred ones is a pass, not a round burned.

const deferredConditions = [
  { id: 'unit-tests', statement: 'the suites pass', howVerified: 'node --test' },
  { id: 'release-landed', statement: 'merged to main and tagged', howVerified: 'git ls-remote', deferred: true, humanEvidence: 'git ls-remote origin refs/tags/v1 prints a sha' },
]

test('release_scope is optional, and only the two declared scopes', () => {
  const base = { done_when: [{ id: 'a', statement: 's', how_verified: 'v' }] }
  assert.deepEqual(validatePlan(base), [])
  assert.deepEqual(validatePlan({ ...base, release_scope: 'stop_before_merge' }), [])
  assert.deepEqual(validatePlan({ ...base, release_scope: 'full_release' }), [])
  assert.ok(validatePlan({ ...base, release_scope: 'merge_it' }).some((e) => /release_scope/.test(e)))
  assert.ok(validatePlan({ ...base, release_scope: null }).some((e) => /release_scope/.test(e)))
})

test('a deferred condition must say what the human is asked to check', () => {
  const base = { done_when: [{ id: 'a', statement: 's', how_verified: 'v' }] }
  assert.deepEqual(validatePlan({ done_when: [{ id: 'a', statement: 's', how_verified: 'v', deferred: true, human_evidence: 'git tag v1 is on main' }] }), [])
  assert.ok(validatePlan({ done_when: [{ id: 'a', statement: 's', how_verified: 'v', deferred: true }] }).some((e) => /human_evidence is required/.test(e)))
  assert.ok(validatePlan({ done_when: [{ id: 'a', statement: 's', how_verified: 'v', deferred: true, human_evidence: '  ' }] }).some((e) => /human_evidence is required/.test(e)))
  assert.ok(validatePlan({ done_when: [{ id: 'a', statement: 's', how_verified: 'v', deferred: 'yes' }] }).some((e) => /deferred must be a boolean/.test(e)))
  // An inert field on a non-deferred row is not a reason to lose the whole plan.
  assert.deepEqual(validatePlan({ ...base, done_when: [{ id: 'a', statement: 's', how_verified: 'v', deferred: false, human_evidence: '' }] }), [])
})

test('normalizePlan carries the scope and the deferred marker, and leaves a plain plan alone', () => {
  const plan = normalizePlan({
    summary: 's',
    release_scope: 'stop_before_merge',
    done_when: [
      { id: 'a', statement: 's', how_verified: 'v' },
      { id: 'b', statement: 't', how_verified: 'w', deferred: true, human_evidence: 'the tag is on main' },
    ],
  })
  assert.equal(plan.releaseScope, 'stop_before_merge')
  assert.equal('deferred' in plan.conditions[0], false, 'a plain condition keeps its pre-0.17 shape')
  assert.equal(plan.conditions[1].deferred, true)
  assert.equal(plan.conditions[1].humanEvidence, 'the tag is on main')
  const plain = normalizePlan({ summary: 's', done_when: [{ id: 'a', statement: 's', how_verified: 'v' }] })
  assert.equal('releaseScope' in plain, false)
})

function reviewOf(rows, extra = {}) {
  return { verdict: 'pass', reasons: ['ok'], done_when: rows, acceptance_coverage: [], ...extra }
}

test('a deferred condition reported unmet is collected, not a gap', () => {
  const out = verifyReview(
    reviewOf([
      { id: 'unit-tests', met: true, confidence: 0.9, evidence: 'node --test: 98 pass, 0 fail' },
      { id: 'release-landed', met: false, confidence: 0.9, evidence: 'not merged — the human lands it at approval' },
    ]),
    deferredConditions,
    [],
    0.7,
  )
  assert.deepEqual(out.gaps, [])
  assert.deepEqual(out.deferred, ['release-landed'])
})

test('a deferred condition still needs a row, and evidence to hand over', () => {
  const missing = verifyReview(reviewOf([{ id: 'unit-tests', met: true, confidence: 0.9, evidence: 'node --test exits 0' }]), deferredConditions, [], 0.7)
  assert.match(missing.gaps.join('; '), /done_when\.release-landed is missing from the review/)
  assert.deepEqual(missing.deferred, [])
  const noEvidence = verifyReview(
    reviewOf([
      { id: 'unit-tests', met: true, confidence: 0.9, evidence: 'node --test exits 0' },
      { id: 'release-landed', met: false, confidence: 0.9, evidence: '   ' },
    ]),
    deferredConditions,
    [],
    0.7,
  )
  assert.match(noEvidence.gaps.join('; '), /release-landed is deferred and the review names no human evidence/)
  // met:true on a deferred condition is accepted like anywhere else.
  const met = verifyReview(
    reviewOf([
      { id: 'unit-tests', met: true, confidence: 0.9, evidence: 'node --test exits 0' },
      { id: 'release-landed', met: true, confidence: 0.9, evidence: 'tag v1 is on main' },
    ]),
    deferredConditions,
    [],
    0.7,
  )
  assert.deepEqual(met.gaps, [])
  assert.deepEqual(met.deferred, [])
})

test('an unmet condition that is not deferred is still a real gap', () => {
  const out = verifyReview(
    reviewOf([
      { id: 'unit-tests', met: false, confidence: 0.9, evidence: 'two suites fail' },
      { id: 'release-landed', met: false, confidence: 0.9, evidence: 'the human lands it' },
    ]),
    deferredConditions,
    [],
    0.7,
  )
  assert.match(out.gaps.join('; '), /done_when\.unit-tests is not met/)
  assert.deepEqual(out.deferred, ['release-landed'])
})

test('coverage rows are judged against stored acceptance only', () => {
  const acceptance = [{ statement: 'the suites pass' }]
  const rows = [{ condition: 'unit-tests', acceptance: 'the suites pass' }]
  const condition = [{ id: 'unit-tests', statement: 's', howVerified: 'v' }]
  assert.deepEqual(verifyReview(reviewOf([{ id: 'unit-tests', met: true, confidence: 0.9, evidence: 'node --test exits 0' }], { acceptance_coverage: rows }), condition, acceptance, 0.7).gaps, [])
  // A row quoting the ticket body is not a stored statement: ignored, not a gap.
  const invented = verifyReview(
    reviewOf([{ id: 'unit-tests', met: true, confidence: 0.9, evidence: 'node --test exits 0' }], {
      acceptance_coverage: [...rows, { condition: 'unit-tests', acceptance: 'the panel looks nice' }],
    }),
    condition,
    acceptance,
    0.7,
  )
  assert.deepEqual(invented.gaps, [])
  // A stored statement left uncovered is still a gap, and a real coverage row must
  // still name a planned condition.
  const uncovered = verifyReview(reviewOf([{ id: 'unit-tests', met: true, confidence: 0.9, evidence: 'node --test exits 0' }]), condition, [{ statement: 'and the docs say so' }], 0.7)
  assert.match(uncovered.gaps.join('; '), /acceptance is not covered: and the docs say so/)
  const badRef = verifyReview(
    reviewOf([{ id: 'unit-tests', met: true, confidence: 0.9, evidence: 'node --test exits 0' }], { acceptance_coverage: [{ condition: 'nope', acceptance: 'the suites pass' }] }),
    condition,
    acceptance,
    0.7,
  )
  assert.match(badRef.gaps.join('; '), /acceptance_coverage\.nope is not a planned condition/)
})

test('gaps split into what the build must fix and what the reviewer must fix', () => {
  const { substantive, cosmetic } = classifyGaps([
    'done_when.unit-tests is not met',
    'done_when.unit-tests confidence is below 0.7',
    'done_when.unit-tests has no evidence',
    'done_when.release-landed is missing from the review',
    'done_when.extra is not a planned condition',
    'done_when.unit-tests is duplicated',
    'done_when contains a row without an id',
    'acceptance_coverage contains a malformed row',
    'acceptance is not covered: the suites pass',
    'done_when.release-landed is deferred and the review names no human evidence',
  ])
  assert.deepEqual(substantive, [
    'done_when.unit-tests is not met',
    'done_when.unit-tests confidence is below 0.7',
    'done_when.unit-tests has no evidence',
  ])
  assert.equal(cosmetic.length, 7)
  // An unrecognised shape is not a gap we blame the build for: it gets the
  // retry-then-park path, which costs no attempt and still lands in front of a
  // human with its exact text. Nothing is approved by being called cosmetic.
  assert.deepEqual(classifyGaps(['something new']).substantive, [])
  assert.deepEqual(classifyGaps(['something new']).cosmetic, ['something new'])
})

test('a fail must prove every non-deferred condition with a met:true row', () => {
  const conditions = [
    { id: 'A', statement: 'a', howVerified: 'v' },
    { id: 'B', statement: 'b', howVerified: 'v' },
    { id: 'D', statement: 'd', howVerified: 'v', deferred: true, humanEvidence: 'he' },
  ]
  const row = (id, met) => ({ id, met, confidence: 0.9, evidence: 'x' })
  assert.deepEqual(nonDeferredProven({ done_when: [row('A', true), row('B', true), row('D', false)] }, conditions), { ok: true, unproven: [] })
  // A missing row is not proof: the tool lets a fail omit rows it already bounced.
  assert.deepEqual(nonDeferredProven({ done_when: [row('A', true), row('D', false)] }, conditions), { ok: false, unproven: ['B'] })
  assert.deepEqual(nonDeferredProven({ done_when: [] }, conditions), { ok: false, unproven: ['A', 'B'] })
  // An unmet non-deferred row is a real gap, not a lack of proof.
  assert.deepEqual(nonDeferredProven({ done_when: [row('A', false), row('B', true), row('D', false)] }, conditions), { ok: false, unproven: ['A'] })
  // Deferred conditions are never required to be proven.
  assert.deepEqual(nonDeferredProven({ done_when: [row('A', true), row('B', true)] }, conditions), { ok: true, unproven: [] })
  assert.deepEqual(nonDeferredProven({}, conditions), { ok: false, unproven: ['A', 'B'] })
})
