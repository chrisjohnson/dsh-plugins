import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, describeEndpoint, errorSummary, resolveSettings } from '../src/config.mjs'

test('defaults: no config resolves to the documented defaults without warnings', () => {
  const { settings, warnings } = resolveSettings(undefined)
  assert.equal(settings.connectUrl, DEFAULTS.connectUrl)
  assert.equal(settings.connectTimeoutMs, 10000)
  assert.equal(settings.retryRemoteAfterMs, 30000)
  assert.equal(settings.fallbackExecutablePath, undefined)
  assert.equal(settings.logToStderr, false)
  assert.deepEqual(settings.controllerOverrides, {})
  assert.deepEqual(warnings, [])
})

test('page and timeout keys are overrides only: unset keys are not invented', () => {
  const { settings, warnings } = resolveSettings({ viewportWidth: 1920, actionTimeoutMs: 5000, screenshotDir: 'shots' })
  assert.deepEqual(settings.controllerOverrides, { viewportWidth: 1920, actionTimeoutMs: 5000, screenshotDir: 'shots' })
  assert.deepEqual(warnings, [])
})

test('connectUrl: custom value, empty string turns remote off, bad values warn and keep the default', () => {
  assert.equal(resolveSettings({ connectUrl: 'wss://bl.example/chromium/playwright?token=abc' }).settings.connectUrl, 'wss://bl.example/chromium/playwright?token=abc')
  assert.equal(resolveSettings({ connectUrl: '' }).settings.connectUrl, undefined)
  const wrongScheme = resolveSettings({ connectUrl: 'http://bl.example' })
  assert.equal(wrongScheme.settings.connectUrl, DEFAULTS.connectUrl)
  assert.equal(wrongScheme.warnings.length, 1)
  const wrongType = resolveSettings({ connectUrl: 3100 })
  assert.equal(wrongType.settings.connectUrl, DEFAULTS.connectUrl)
  assert.equal(wrongType.warnings.length, 1)
})

test('unusable numbers, strings and unknown keys each warn once and are ignored', () => {
  const { settings, warnings } = resolveSettings({
    connectTimeoutMs: 0,
    retryRemoteAfterMs: -1,
    viewportWidth: '1920',
    fallbackExecutablePath: '  ',
    logToStderr: 'yes',
    typo: true,
  })
  assert.equal(settings.connectTimeoutMs, DEFAULTS.connectTimeoutMs)
  assert.equal(settings.retryRemoteAfterMs, DEFAULTS.retryRemoteAfterMs)
  assert.deepEqual(settings.controllerOverrides, {})
  assert.equal(settings.fallbackExecutablePath, undefined)
  assert.equal(warnings.length, 6)
})

test('retryRemoteAfterMs accepts 0 (retry on every new session)', () => {
  const { settings, warnings } = resolveSettings({ retryRemoteAfterMs: 0 })
  assert.equal(settings.retryRemoteAfterMs, 0)
  assert.deepEqual(warnings, [])
})

test('describeEndpoint strips credentials, query and fragment', () => {
  assert.equal(describeEndpoint('wss://user:pw@bl.example:3000/chromium/playwright?token=secret#x'), 'wss://bl.example:3000/chromium/playwright')
  assert.equal(describeEndpoint('not a url'), '(unparseable connectUrl)')
})

test('errorSummary keeps the first line and masks query values', () => {
  const error = new Error('connect to ws://h/p?token=secret&x=1 failed\nCall log:\n  - more')
  assert.equal(errorSummary(error), 'connect to ws://h/p?token=***&x=*** failed')
  assert.equal(errorSummary(''), 'unknown error')
})
