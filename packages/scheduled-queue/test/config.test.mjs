import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, resolveQueueFile, resolveSettings } from '../src/config.mjs'

test('no config resolves to the defaults without a warning', () => {
  assert.deepEqual(resolveSettings(undefined), { settings: { ...DEFAULT_CONFIG }, warnings: [] })
  assert.deepEqual(resolveSettings({}).warnings, [])
  assert.equal(resolveSettings({}).settings.scanIntervalMs, 5000)
})

test('scanIntervalMs: accepted, clamped, or rejected with a named warning', () => {
  assert.equal(resolveSettings({ scanIntervalMs: 2000 }).settings.scanIntervalMs, 2000)
  const low = resolveSettings({ scanIntervalMs: 10 })
  assert.equal(low.settings.scanIntervalMs, 1000)
  assert.match(low.warnings[0], /scanIntervalMs/)
  assert.equal(resolveSettings({ scanIntervalMs: 9e9 }).settings.scanIntervalMs, 60000)
  const bad = resolveSettings({ scanIntervalMs: 'often' })
  assert.equal(bad.settings.scanIntervalMs, 5000)
  assert.match(bad.warnings[0], /scanIntervalMs/)
})

test('deliveryTimeoutMs: default, clamped, rejected', () => {
  assert.equal(resolveSettings({}).settings.deliveryTimeoutMs, 60000)
  assert.equal(resolveSettings({ deliveryTimeoutMs: 5000 }).settings.deliveryTimeoutMs, 5000)
  assert.equal(resolveSettings({ deliveryTimeoutMs: 1 }).settings.deliveryTimeoutMs, 1000)
  const bad = resolveSettings({ deliveryTimeoutMs: 'x' })
  assert.equal(bad.settings.deliveryTimeoutMs, 60000)
  assert.match(bad.warnings[0], /deliveryTimeoutMs/)
})

test('unknown keys warn once each', () => {
  const { warnings } = resolveSettings({ scanIntervalMS: 1, other: 2 })
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /scanIntervalMS/)
})

test('resolveQueueFile: the storage location earlier versions used', () => {
  assert.equal(resolveQueueFile({}, '/h/u'), '/h/u/.dsh/storages/scheduled-queue.json')
  assert.equal(resolveQueueFile({ DSH_HOME: '/data/dsh' }, '/h/u'), '/data/dsh/storages/scheduled-queue.json')
  assert.equal(resolveQueueFile({ DSH_HOME: '/data/dsh/' }, '/h/u'), '/data/dsh/storages/scheduled-queue.json')
  assert.equal(resolveQueueFile({ DSH_HOME: '~/state' }, '/h/u'), '/h/u/state/storages/scheduled-queue.json')
  assert.equal(resolveQueueFile({ DSH_HOME: '   ' }, '/h/u'), '/h/u/.dsh/storages/scheduled-queue.json')
})
