import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, ConfigError, isEnabled, limitFor, resolveConfig } from '../src/config.mjs'

test('defaults are inert-safe and per-provider', () => {
  const { config, warnings } = resolveConfig({})
  assert.deepEqual(warnings, [])
  assert.equal(config.enabled, true)
  assert.equal(config.defaultMaxConcurrent, 1)
  assert.equal(limitFor(config, 'anything'), 1)
  assert.deepEqual(config.subagentTools, ['subagent', 'subagent_fork', 'spawn_teammate'])
})

test('provider limits are strict', () => {
  const { config } = resolveConfig({ limits: [{ provider: 'gpu-a', maxConcurrent: 3 }] })
  assert.equal(limitFor(config, 'gpu-a'), 3)
  assert.equal(limitFor(config, 'gpu-b'), 1)
  assert.throws(() => resolveConfig({ limits: [{ provider: 'gpu-a', maxConcurrent: 0 }] }), ConfigError)
  assert.throws(() => resolveConfig({ limits: [{ provider: 'gpu-a', maxConcurrent: 1 }, { provider: 'gpu-a', maxConcurrent: 2 }] }), /duplicate/)
  assert.throws(() => resolveConfig({ limits: [{ provider: 'gpu-a', maxConcurrent: 1, model: 'x' }] }), /unknown key/)
})

test('unknown keys warn, wrong types refuse', () => {
  const { warnings } = resolveConfig({ mystery: true })
  assert.equal(warnings.length, 1)
  assert.throws(() => resolveConfig({ enabled: 'yes' }), ConfigError)
  assert.throws(() => resolveConfig({ reservationTtlMs: 10 }), ConfigError)
  assert.throws(() => resolveConfig({ subagentTools: ['ok', 3] }), ConfigError)
})

test('isEnabled honours the rollout switch', () => {
  assert.equal(isEnabled(DEFAULT_CONFIG), true)
  assert.equal(isEnabled({ ...DEFAULT_CONFIG, enabled: false }), false)
})
