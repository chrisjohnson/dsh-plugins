// Tests for configuration resolution — in particular for what happens when a key
// is missing, which is the state every new user's profile is in.

import test from 'node:test'
import assert from 'node:assert/strict'

import { asRoute, pickRoute, resolveSettings, DEFAULT_CONFIG } from '../src/config.mjs'

test('defaults: a plugin with no config at all resolves to working settings', () => {
  const { settings, escalation, warnings } = resolveSettings({})
  assert.equal(settings.fitRatio, DEFAULT_CONFIG.fitRatio)
  assert.equal(settings.autoCompact, true, 'compacting before a switch is the safe default')
  assert.deepEqual(settings.preferredRoutes, [])
  assert.equal(escalation, undefined)
  assert.equal(settings.reader, undefined)
  assert.equal(warnings.length, 1, 'one warning: the escalation tool is not offered')
  assert.match(warnings[0], /escalationProvider/)
})

test('routes: both halves or neither', () => {
  assert.deepEqual(pickRoute('p', 'm'), { provider: 'p', model: 'm' })
  assert.equal(pickRoute('p', undefined), undefined)
  assert.equal(pickRoute('', 'm'), undefined)
  assert.equal(pickRoute(42, 'm'), undefined)
})

test('escalation: half-configured is not configured', () => {
  const { escalation, warnings } = resolveSettings({ escalationProvider: 'p' })
  assert.equal(escalation, undefined)
  assert.match(warnings.join('\n'), /escalationModel/)
})

test('reader: unset leaves no preference; set becomes the default preference', () => {
  assert.deepEqual(resolveSettings({ readerProvider: 'p', readerModel: 'big' }).settings.preferredRoutes, [
    { provider: 'p', model: 'big' },
  ])
  assert.deepEqual(resolveSettings({}).settings.preferredRoutes, [])
})

test('preferredRoutes: parsed in order, garbage dropped with a warning', () => {
  const { settings, warnings } = resolveSettings({ preferredRoutes: ['a/one', 'nope', 'b/two/three', 7] })
  assert.deepEqual(settings.preferredRoutes, [
    { provider: 'a', model: 'one' },
    { provider: 'b', model: 'two/three' },
  ])
  assert.match(warnings.join('\n'), /nope/, 'a silently dropped entry is a lost recommendation')

  const allBad = resolveSettings({ preferredRoutes: ['nonsense'] })
  assert.deepEqual(allBad.settings.preferredRoutes, [])
  assert.match(allBad.warnings.join('\n'), /entry "nonsense" .* was skipped/)
})

test('a configured reader is not appended when preferredRoutes is explicit', () => {
  const { settings } = resolveSettings({
    readerProvider: 'p',
    readerModel: 'big',
    preferredRoutes: ['q/other'],
  })
  assert.deepEqual(settings.preferredRoutes, [{ provider: 'q', model: 'other' }])
})

test('fitRatio: honoured, and out-of-range values warn rather than silently pass', () => {
  assert.equal(resolveSettings({ fitRatio: 0.65 }).settings.fitRatio, 0.65)
  assert.match(resolveSettings({ fitRatio: 1.4 }).warnings.join('\n'), /outside/)
  assert.match(resolveSettings({ fitRatio: 0 }).warnings.join('\n'), /outside/)
  const quoted = resolveSettings({ fitRatio: '0.8' })
  assert.equal(quoted.settings.fitRatio, DEFAULT_CONFIG.fitRatio, 'a YAML string is not a number')
  assert.match(quoted.warnings.join('\n'), /fitRatio "0\.8" is not a number/)
})

test('autoCompact: only an explicit false turns it off', () => {
  assert.equal(resolveSettings({ autoCompact: false }).settings.autoCompact, false)
  assert.equal(resolveSettings({ autoCompact: undefined }).settings.autoCompact, true)
  assert.equal(resolveSettings({}).settings.autoCompact, true)
})

test('a typo in a key name is reported, not ignored', () => {
  const { warnings } = resolveSettings({ escalationsProvider: 'p', fitRation: 0.5 })
  const joined = warnings.join('\n')
  assert.match(joined, /unknown config key "escalationsProvider"/)
  assert.match(joined, /unknown config key "fitRation"/)
})

test('a half-configured route says which one', () => {
  const { settings, warnings } = resolveSettings({ readerProvider: 'p' })
  assert.equal(settings.reader, undefined)
  assert.match(warnings.join('\n'), /reader route is half-configured/)
})

test('asRoute: the shape used by preferredRoutes', () => {
  assert.deepEqual(asRoute('p/m'), { provider: 'p', model: 'm' })
  assert.equal(asRoute('/m'), undefined, 'a route needs a provider')
  assert.equal(asRoute('p/'), undefined, 'a route needs a model')
  assert.equal(asRoute(undefined), undefined)
})
