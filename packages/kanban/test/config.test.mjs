import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, canonicalJson, providerPolicy, resolveConfig, routeForAttempt, ConfigError } from '../src/config.mjs'

test('defaults resolve and every role is present', () => {
  const { config, warnings } = resolveConfig({})
  assert.deepEqual(warnings, [])
  for (const role of ['orchestrator', 'griller', 'planner', 'implementer', 'verifier', 'reviewer']) {
    assert.equal(typeof config.roles[role].prompt, 'string')
  }
  assert.equal(config.maxAttempts, 3)
})

test('unknown keys warn once instead of refusing to boot', () => {
  const { warnings } = resolveConfig({ totalyUnknown: 1 })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /totalyUnknown/)
})

test('wrong types and impossible values refuse to start', () => {
  assert.throws(() => resolveConfig({ providers: [{ name: 'p', maxConcurrent: 0 }] }), ConfigError)
  assert.throws(() => resolveConfig({ providers: [{ name: 'p', maxConcurrent: 1, priceIn: -1 }] }), ConfigError)
  assert.throws(() => resolveConfig({ wipCap: 0 }), ConfigError)
  assert.throws(() => resolveConfig({ confidenceThreshold: 2 }), ConfigError)
  assert.throws(() => resolveConfig({ escalationLadder: [] }), ConfigError)
  assert.throws(() => resolveConfig({ leaseTtlMs: 1000, leaseHeartbeatMs: 1000 }), ConfigError)
})

test('duplicate provider names are rejected', () => {
  assert.throws(() => resolveConfig({ providers: [{ name: 'p', maxConcurrent: 1 }, { name: 'p', maxConcurrent: 1 }] }), /duplicate/)
})

test('unknown provider is admitted one at a time and unpriced', () => {
  const { config } = resolveConfig({})
  const policy = providerPolicy(config, 'mystery')
  assert.equal(policy.maxConcurrent, 1)
  assert.equal(policy.priceIn, null)
  assert.equal(policy.known, false)
})

test('escalation ladder maps attempts to rungs', () => {
  const { config } = resolveConfig({
    roles: { implementer: { provider: 'local', model: 'small' } },
    escalationLadder: [{ rung: 0 }, { rung: 1, provider: 'paid', model: 'big', paid: true }],
  })
  assert.equal(routeForAttempt(config, 'implementer', 1).rung, 0)
  assert.equal(routeForAttempt(config, 'implementer', 2).rung, 0)
  assert.equal(routeForAttempt(config, 'implementer', 3).rung, 1)
  assert.equal(routeForAttempt(config, 'implementer', 3).provider, 'paid')
  assert.equal(routeForAttempt(config, 'implementer', 9).rung, 1)
})

test('canonical JSON sorts keys', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')
})

test('the two illegal intake combos are not config errors but store errors', () => {
  // config itself accepts the enum; lifecycle rejects the combination server-side.
  const { config } = resolveConfig({ defaultGrillMode: 'at_pickup', defaultPlanMode: 'now' })
  assert.equal(config.defaultPlanMode, 'now')
})

test('orchestrator may not carry tool permissions', () => {
  assert.throws(() => resolveConfig({ roles: { orchestrator: { allowTools: ['bash'] } } }), /orchestrator/)
})
