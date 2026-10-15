import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, resolveSettings } from '../src/config.mjs'

test('defaults: no config at all resolves to the documented defaults without warnings', () => {
  const { settings, warnings } = resolveSettings(undefined)
  assert.deepEqual(settings, DEFAULT_CONFIG)
  assert.deepEqual(warnings, [])
  assert.equal(settings.maxConsecutiveKicks, 5)
  assert.equal(settings.cooldownMs, 60000)
  assert.equal(settings.liveKickDelayMs, 3000)
  assert.equal(settings.kickOnEmptyCompletion, true)
  assert.equal(settings.includeSubagents, false)
  assert.equal(settings.logToStderr, false)
})

test('valid values override; unspecified keys keep their defaults', () => {
  const { settings, warnings } = resolveSettings({ maxConsecutiveKicks: 3, includeSubagents: true, maxTokensKickText: 'go on' })
  assert.equal(settings.maxConsecutiveKicks, 3)
  assert.equal(settings.includeSubagents, true)
  assert.equal(settings.maxTokensKickText, 'go on')
  assert.equal(settings.cooldownMs, 60000)
  assert.deepEqual(warnings, [])
})

test('unusable values fall back to the default with one warning each', () => {
  const { settings, warnings } = resolveSettings({ cooldownMs: '60000', kickOnMaxTokens: 'yes', interruptedKickText: '  ', typo: 1 })
  assert.equal(settings.cooldownMs, DEFAULT_CONFIG.cooldownMs)
  assert.equal(settings.kickOnMaxTokens, true)
  assert.equal(settings.interruptedKickText, DEFAULT_CONFIG.interruptedKickText)
  assert.equal(warnings.length, 4)
})

test('0 is a valid maxConsecutiveKicks and cooldown', () => {
  const { settings, warnings } = resolveSettings({ maxConsecutiveKicks: 0, cooldownMs: 0 })
  assert.equal(settings.maxConsecutiveKicks, 0)
  assert.equal(settings.cooldownMs, 0)
  assert.deepEqual(warnings, [])
})
