// The ledger reader: existing history (both schemas) must stay readable.

import test from 'node:test'
import assert from 'node:assert/strict'

import { answer, normalize, parseLedger } from '../src/ledger.mjs'

const v1Fingerprint = { ts: '2026-09-20T10:00:00Z', sessionId: 's1', source: 'fingerprint', verdict: 'LOOP', confidence: 99, band: 'stuck', fingerprints: [{ fp: 'grep|x', count: 3, distinctResults: 1 }], window: 'a\nb' }
const v1Llm = { ts: '2026-09-20T10:01:00Z', sessionId: 's1', source: 'llm', verdict: 'PROGRESS', confidence: 80, band: 'noise', latencyMs: 900 }
const v2Skip = { v: 2, ts: '2026-10-01T10:00:00Z', sessionId: 's2', skip: 'cooldown', events: { total: 5, substantive: 3 }, outcome: 'skipped', window: '' }
const v2Model = {
  v: 2, ts: '2026-10-01T10:05:00Z', sessionId: 's2', skip: null, source: 'llm', verdict: 'LOOP', confidence: 92, band: 'stuck', streak: 2, mode: 'log',
  code: { ran: true, calls: 4, groupCount: 2, stuckGroups: [], stuck: false, topGroups: [] },
  model: { verdict: 'LOOP', confidence: 92, latencyMs: 1200, raw: 'LOOP:92', hasReasoning: false, inferred: false },
  window: 'l1\nl2\nl3', outcome: 'logged',
}
const text = [v1Fingerprint, v1Llm, v2Skip, v2Model].map((r) => JSON.stringify(r)).join('\n') + '\n'

test('v1 decisions are normalised into the v2 phase shape', () => {
  const fp = normalize(v1Fingerprint, 0)
  assert.equal(fp.layer, 'code')
  assert.equal(fp.code.stuck, true)
  assert.equal(fp.code.synthesized, true)
  assert.equal(fp.model, null)
  const llm = normalize(v1Llm, 1)
  assert.equal(llm.layer, 'model')
  assert.equal(llm.code.stuck, false)
  assert.equal(llm.model.verdict, 'PROGRESS')
})

test('v2 records keep their phases, and skips have no deciding layer', () => {
  assert.equal(normalize(v2Skip, 2).layer, 'none')
  assert.equal(normalize(v2Skip, 2).skip, 'cooldown')
  const model = normalize(v2Model, 3)
  assert.equal(model.layer, 'model')
  assert.equal(model.model.raw, 'LOOP:92')
  assert.equal(model.streak, 2)
})

test('the id is the line index, and a corrupt line is counted without hiding the rest', () => {
  const led = parseLedger(`${JSON.stringify(v1Llm)}\n{broken\n\n${JSON.stringify(v2Model)}\n[1]\n`)
  assert.equal(led.records.length, 2)
  assert.equal(led.corrupt, 2)
  assert.deepEqual(led.records.map((r) => r.id), [0, 3])
  assert.equal(led.byId.get(3).sessionId, 's2')
})

test('sessions are summarised and ordered newest first', () => {
  const { sessions } = parseLedger(text)
  assert.deepEqual(sessions.map((s) => s.sessionId), ['s2', 's1'])
  const s1 = sessions.find((s) => s.sessionId === 's1')
  assert.equal(s1.count, 2)
  assert.equal(s1.code, 1)
  assert.equal(s1.model, 1)
  assert.equal(s1.stuck, 1)
})

test('list: filters by session, can drop skips, projects without the window, and caps by limit', () => {
  const led = { ...parseLedger(text), error: null }
  const all = answer('list', {}, led, '/l').value
  assert.equal(all.records.length, 4)
  assert.equal(all.stats.skipped, 1)
  assert.equal(all.stats.stuck, 2)
  assert.equal(all.ledgerFile, '/l')
  assert.equal('window' in all.records[0], false)
  assert.equal(all.records[3].windowLines, 3)

  assert.equal(answer('list', { sessionId: 's2' }, led, '/l').value.records.length, 2)
  assert.equal(answer('list', { includeSkipped: false }, led, '/l').value.records.length, 3)
  const capped = answer('list', { limit: 1 }, led, '/l').value
  assert.equal(capped.stats.truncated, true)
  assert.equal(capped.records[0].id, 3, 'the newest rows are kept')
})

test('detail returns the full record including its window; bad ids are errors, not throws', () => {
  const led = { ...parseLedger(text), error: null }
  assert.equal(answer('detail', { id: 3 }, led, '/l').value.record.window, 'l1\nl2\nl3')
  assert.equal(answer('detail', { id: 99 }, led, '/l').error.code, 'not_found')
  assert.equal(answer('detail', {}, led, '/l').error.code, 'bad_request')
  assert.equal(answer('nope', {}, led, '/l').error.code, 'unknown_endpoint')
})

test('a missing ledger is an empty result carrying the reason', () => {
  const led = { records: [], byId: new Map(), sessions: [], corrupt: 0, error: 'ledger-missing' }
  const res = answer('list', {}, led, '/l')
  assert.equal(res.ok, true)
  assert.equal(res.value.error, 'ledger-missing')
  assert.deepEqual(res.value.records, [])
})

test('historical PROGRESS rows banded stuck/watch read as noise, and are not counted stuck anywhere', () => {
  const progress = { v: 2, ts: '2026-10-02T10:00:00Z', sessionId: 's3', skip: null, source: 'llm', verdict: 'PROGRESS', confidence: 95, band: 'stuck', streak: 1, window: 'w' }
  const watch = { ...progress, ts: '2026-10-02T10:01:00Z', confidence: 75, band: 'watch' }
  const loop = { ...progress, ts: '2026-10-02T10:02:00Z', verdict: 'LOOP', confidence: 95, band: 'stuck' }
  const rec = normalize(progress, 0)
  assert.equal(rec.band, 'noise')
  assert.equal(rec.rawBand, 'stuck')
  assert.equal(normalize(watch, 1).band, 'noise')
  assert.equal(normalize(loop, 2).band, 'stuck', 'a LOOP keeps its band')
  assert.equal(normalize(v1Llm, 0).band, 'noise')

  const led = { ...parseLedger([progress, watch, loop].map((r) => JSON.stringify(r)).join('\n')), error: null }
  const res = answer('list', {}, led, '/l').value
  assert.equal(res.stats.stuck, 1)
  assert.equal(res.sessions[0].stuck, 1)
  assert.deepEqual(res.records.map((r) => r.band), ['noise', 'noise', 'stuck'])
})
