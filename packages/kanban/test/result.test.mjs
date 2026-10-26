import test from 'node:test'
import assert from 'node:assert/strict'

import {
  continuationPrompt,
  extractJson,
  gateImplement,
  isSpecificEvidence,
  normalizePlan,
  validateAdjudication,
  validateGrill,
  validatePlan,
  validateReview,
  validateVerification,
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
