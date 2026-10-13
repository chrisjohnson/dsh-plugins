import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SOURCE_KIND, SUMMARY_MAX_CHARS, boundSummary, noticeSource } from '../src/notice.mjs'

// Mirrors the native V4 admission rule in @deepseek-ai/dsh-session-format-v3-to-v4
// (lib/types/message-sources.js `source()`): a message source needs a nonempty
// string `kind` that is not the retired shared "plugin" wrapper.
function admittedByV4(source) {
  return typeof source?.kind === 'string' && source.kind.length > 0 && source.kind !== 'plugin'
}

test('the notice source is producer-owned, not the retired shared plugin kind', () => {
  const source = noticeSource('Model switched to a/b')
  assert.equal(source.kind, 'plugin:model-switch')
  assert.equal(SOURCE_KIND, 'plugin:model-switch')
  assert.notEqual(source.kind, 'plugin')
  assert.equal(admittedByV4(source), true)
})

test('the retired shape would be refused, which is what the producer kind avoids', () => {
  assert.equal(admittedByV4({ kind: 'plugin', plugin: 'model-switch' }), false)
})

test('the notice carries its form and summary and no legacy plugin field', () => {
  const source = noticeSource('Escalated to p/m')
  assert.equal(source.form, 'notice')
  assert.equal(source.summary, 'Escalated to p/m')
  assert.equal('plugin' in source, false)
})

test('a long route name is bounded to the host limit with an ellipsis', () => {
  const long = `Model switched to ${'x'.repeat(300)}`
  const source = noticeSource(long)
  assert.equal(source.summary.length, SUMMARY_MAX_CHARS)
  assert.ok(source.summary.endsWith('…'))
  assert.equal(boundSummary('short'), 'short')
  assert.equal(boundSummary('y'.repeat(SUMMARY_MAX_CHARS)).length, SUMMARY_MAX_CHARS)
})
