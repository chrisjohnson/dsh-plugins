import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, ConfigError, isEnabled, limitFor, resolveConfig } from '../src/config.mjs'

test('defaults are inert-safe and per-provider', () => {
  const { config, warnings } = resolveConfig({})
  assert.deepEqual(warnings, [])
  assert.equal(config.enabled, true)
  assert.equal(config.defaultMaxConcurrent, 1)
  assert.equal(limitFor(config, 'anything'), 1)
  // Exactly the keys the plugin still has: no reservation TTL, no tool list.
  assert.deepEqual(Object.keys(config).sort(), ['defaultMaxConcurrent', 'enabled', 'limits', 'queueLimitPerProvider'])
  assert.deepEqual(Object.keys(DEFAULT_CONFIG).sort(), Object.keys(config).sort())
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
  assert.throws(() => resolveConfig({ queueLimitPerProvider: 0 }), ConfigError)
})

test('the removed subagent keys only warn as unknown', () => {
  // 0.3.0 validated `reservationTtlMs` and `subagentTools` and refused a bad
  // value. Both are gone, and a deployment that still carries them must boot:
  // each lands in the unknown-key warning list, which is logged once at startup.
  const { warnings } = resolveConfig({ reservationTtlMs: 300000, subagentTools: ['subagent', 3] })
  assert.deepEqual(warnings, [
    'unknown config key "reservationTtlMs" (ignored)',
    'unknown config key "subagentTools" (ignored)',
  ])
})

test('unlimited providers are explicit and mutually exclusive with a limit', () => {
  const { config } = resolveConfig({ limits: [{ provider: 'cloud', unlimited: true }] })
  assert.equal(limitFor(config, 'cloud'), Infinity)
  assert.throws(() => resolveConfig({ limits: [{ provider: 'cloud', unlimited: true, maxConcurrent: 1 }] }), ConfigError)
  assert.throws(() => resolveConfig({ limits: [{ provider: 'cloud', unlimited: false }] }), ConfigError)
})

test('isEnabled honours the rollout switch', () => {
  assert.equal(isEnabled(DEFAULT_CONFIG), true)
  assert.equal(isEnabled({ ...DEFAULT_CONFIG, enabled: false }), false)
})
