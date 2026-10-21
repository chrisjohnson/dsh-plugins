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
})

test('legacy maxConcurrent is accepted with a warning and ignored', () => {
  const { config, warnings } = resolveConfig({ providers: [{ name: 'p', maxConcurrent: 2 }] })
  assert.ok(warnings.some((w) => /maxConcurrent is ignored/.test(w)))
  assert.equal('maxConcurrent' in providerPolicy(config, 'p'), false)
})

test('duplicate provider names are rejected', () => {
  assert.throws(() => resolveConfig({ providers: [{ name: 'p', maxConcurrent: 1 }, { name: 'p', maxConcurrent: 1 }] }), /duplicate/)
})

test('unknown provider is unpriced; concurrency is owned elsewhere', () => {
  const { config } = resolveConfig({})
  const policy = providerPolicy(config, 'mystery')
  assert.equal(policy.priceIn, null)
  assert.equal(policy.known, false)
  assert.equal('maxConcurrent' in policy, false)
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

test('the role guard denies everything outside the allow-list', async () => {
  const { roleToolGuard } = await import('../src/tools.mjs')
  const implementer = roleToolGuard('implementer', ['read', 'edit', 'bash'])
  assert.equal(implementer({ name: 'edit' }), undefined)
  assert.equal(implementer({ name: 'bash' }), undefined)
  assert.match(implementer({ name: 'kanban_move' }), /may not call "kanban_move"/)
  assert.match(implementer({ name: 'subagent' }), /may not call "subagent"/)
  assert.match(implementer({}), /unnamed tool/)
  const verifier = roleToolGuard('verifier', ['read', 'bash'])
  assert.match(verifier({ name: 'edit' }), /may not call "edit"/)
})
