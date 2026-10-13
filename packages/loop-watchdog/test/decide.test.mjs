import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PLUGIN_SOURCE_KIND,
  SUMMARY_MAX_CHARS,
  bandOf,
  boundSummary,
  buildRequestBody,
  evalRecord,
  interventionGate,
  interventionSource,
  nextStreak,
  parseModeOverride,
  parseVerdict,
} from '../src/decide.mjs'

const bands = { bandStuck: 90, bandWatch: 70 }

test('source kind: producer-owned, never the bare "plugin" that V4 refuses on read', () => {
  assert.equal(PLUGIN_SOURCE_KIND, 'plugin:loop-watchdog')
  const source = interventionSource()
  assert.equal(source.kind, 'plugin:loop-watchdog')
  assert.notEqual(source.kind, 'plugin')
  assert.equal(source.form, 'notice')
  assert.equal('plugin' in source, false, 'the retired `plugin` field is not written')
  assert.ok(source.summary.length > 0 && source.summary.length <= SUMMARY_MAX_CHARS)
})

test('boundSummary caps at 120 chars with an ellipsis and leaves short text alone', () => {
  assert.equal(boundSummary('short'), 'short')
  const bounded = boundSummary('y'.repeat(500))
  assert.equal(bounded.length, 120)
  assert.equal(bounded, `${'y'.repeat(119)}…`)
  assert.equal(boundSummary('z'.repeat(120)).length, 120)
})

test('parseVerdict accepts every form the model has produced', () => {
  assert.deepEqual(parseVerdict('LOOP:72'), { verdict: 'LOOP', confidence: 72, inferred: false })
  assert.deepEqual(parseVerdict('PROGRESS:15'), { verdict: 'PROGRESS', confidence: 15, inferred: false })
  assert.equal(parseVerdict('VERDICT:LOOP 88').confidence, 88)
  assert.equal(parseVerdict('loop 40').verdict, 'LOOP')
  assert.deepEqual(parseVerdict('LOOP'), { verdict: 'LOOP', confidence: null, inferred: true })
  assert.deepEqual(parseVerdict('{"verdict":"loop","confidence":91}'), { verdict: 'LOOP', confidence: 91, inferred: false })
  assert.equal(parseVerdict('LOOP:900').confidence, 100, 'clamped')
  assert.deepEqual(parseVerdict('no idea'), { verdict: null, confidence: null, inferred: false })
  assert.deepEqual(parseVerdict(''), { verdict: null, confidence: null, inferred: false })
})

test('bands: only a LOOP verdict can be stuck or watch', () => {
  assert.equal(bandOf(95, bands, 'LOOP'), 'stuck')
  assert.equal(bandOf(90, bands, 'LOOP'), 'stuck')
  assert.equal(bandOf(75, bands, 'LOOP'), 'watch')
  assert.equal(bandOf(10, bands, 'LOOP'), 'noise')
  assert.equal(bandOf(null, bands, 'LOOP'), 'noise')
  // Confidence is confidence in the verdict: PROGRESS:95 is a confident "working".
  assert.equal(bandOf(95, bands, 'PROGRESS'), 'noise')
})

test('a confident PROGRESS verdict does not build a stuck streak toward intervention', () => {
  let streak = 0
  streak = nextStreak(streak, bandOf(95, bands, 'PROGRESS'))
  streak = nextStreak(streak, bandOf(95, bands, 'PROGRESS'))
  assert.equal(streak, 0)
  streak = nextStreak(streak, bandOf(95, bands, 'LOOP'))
  const gate = interventionGate({ verdict: 'LOOP', band: 'stuck', streak, interventionOn: true, alreadyActed: false })
  assert.equal(gate.intervene, false, 'one LOOP is a signal, not a sustained streak')
  assert.equal(gate.reason, 'streak=1<2')
})

test('streak: stuck extends, anything else resets', () => {
  assert.equal(nextStreak(undefined, 'stuck'), 1)
  assert.equal(nextStreak(1, 'stuck'), 2)
  assert.equal(nextStreak(3, 'watch'), 0)
  assert.equal(nextStreak(3, 'noise'), 0)
})

test('intervention needs every gate: LOOP, stuck band, sustained, act mode, not yet acted', () => {
  const ok = { verdict: 'LOOP', band: 'stuck', streak: 2, interventionOn: true, alreadyActed: false }
  assert.deepEqual(interventionGate(ok), { intervene: true, reason: 'act' })
  assert.equal(interventionGate({ ...ok, interventionOn: false }).reason, 'mode=log')
  assert.equal(interventionGate({ ...ok, alreadyActed: true }).reason, 'already-acted-in-streak')
  assert.equal(interventionGate({ ...ok, streak: 1 }).reason, 'streak=1<2')
  assert.equal(interventionGate({ ...ok, band: 'watch' }).reason, 'band=watch')
  assert.equal(interventionGate({ ...ok, verdict: 'PROGRESS' }).intervene, false)
})

test('mode override: only a boolean interventionEnabled overrides', () => {
  assert.equal(parseModeOverride('{"interventionEnabled":true}'), true)
  assert.equal(parseModeOverride('{"interventionEnabled":false}'), false)
  assert.equal(parseModeOverride('{"interventionEnabled":"yes"}'), null)
  assert.equal(parseModeOverride('{}'), null)
  assert.equal(parseModeOverride('not json'), null)
  assert.equal(parseModeOverride(''), null)
})

test('request body: deployment extras sit under the fixed fields', () => {
  const llm = { model: 'm1', maxTokens: 128, extraBody: { chat_template_kwargs: { enable_thinking: false }, model: 'ignored', temperature: 9 } }
  const body = buildRequestBody(llm, 'transcript')
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
  assert.equal(body.model, 'm1')
  assert.equal(body.temperature, 0)
  assert.equal(body.max_tokens, 128)
  assert.equal(body.messages[1].content, 'transcript')
  assert.equal(body.messages[0].role, 'system')
})

test('ledger record format is the v2 shape existing history uses', () => {
  const r = evalRecord('s1', { total: 3, substantive: 2 }, new Date('2026-01-02T03:04:05Z'))
  assert.deepEqual(Object.keys(r), [
    'v', 'ts', 'sessionId', 'skip', 'events', 'code', 'model', 'source', 'verdict',
    'confidence', 'band', 'streak', 'mode', 'fingerprints', 'latencyMs', 'window', 'outcome',
  ])
  assert.equal(r.v, 2)
  assert.equal(r.ts, '2026-01-02T03:04:05.000Z')
  assert.equal(r.outcome, 'logged')
})
