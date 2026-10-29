import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, DEPRECATED_ROLE_KEYS, ROLES, resolveConfig, routeForAttempt } from '../src/config.mjs'

test('defaults resolve with the four workflow roles', () => {
  const { config, warnings } = resolveConfig({})
  assert.deepEqual(warnings, [])
  assert.deepEqual(ROLES, ['planner', 'implementer', 'reviewer', 'approver'])
  assert.deepEqual(Object.keys(config.roles).sort(), [...ROLES].sort())
  assert.equal(config.defaultPlanTiming, 'at_pickup')
  assert.equal(config.defaultPlanQuestions, 'interactive')
})

test('a role is a model route and carries no tool list', () => {
  const { config } = resolveConfig({})
  for (const role of ROLES) {
    assert.deepEqual(
      Object.keys(config.roles[role]).sort(),
      ['model', 'provider', 'reasoningEffort'],
      `${role} must declare only its route`,
    )
    assert.equal(config.roles[role].allowTools, undefined)
  }
})

test('the deprecated allowTools key is accepted and warned, not an error', () => {
  assert.deepEqual(DEPRECATED_ROLE_KEYS, ['allowTools'])
  const { config, warnings } = resolveConfig({
    roles: { planner: { provider: 'local', model: 'm', allowTools: ['read'] } },
  })
  assert.equal(config.roles.planner.provider, 'local')
  assert.ok(
    warnings.some((w) => w.includes('roles.planner.allowTools') && w.includes('deprecated')),
    `expected a deprecation warning, got ${JSON.stringify(warnings)}`,
  )
  // Any shape is tolerated now — the key decides nothing.
  assert.doesNotThrow(() => resolveConfig({ roles: { planner: { allowTools: 'read' } } }))
  assert.doesNotThrow(() => resolveConfig({ roles: { reviewer: { allowTools: [] } } }))
})

test('unknown keys warn, wrong values throw', () => {
  const { warnings } = resolveConfig({ nope: true })
  assert.ok(warnings.some((w) => w.includes('nope')))
  assert.throws(() => resolveConfig({ defaultPlanTiming: 'later' }), /defaultPlanTiming/)
  assert.throws(() => resolveConfig({ defaultPlanQuestions: 'maybe' }), /defaultPlanQuestions/)
  assert.throws(() => resolveConfig({ roles: { planner: { toolGuard: true } } }), /unknown key/)
})

test('roles fall back to the deployment default and the ladder can override', () => {
  const { config } = resolveConfig({
    roles: {
      planner: { provider: null, model: null },
      implementer: { provider: 'paid', model: 'big' },
    },
    escalationLadder: [{ rung: 0 }, { rung: 1, provider: 'paid', model: 'biggest', reasoningEffort: 'high' }],
  })
  assert.equal(config.roles.implementer.provider, 'paid')
  const route = routeForAttempt(config, 'implementer', 3)
  assert.equal(route.model, 'biggest')
  assert.equal(route.reasoningEffort, 'high')
})
