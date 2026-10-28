import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, DEFAULT_TOOLS, ROLES, resolveConfig, routeForAttempt } from '../src/config.mjs'

test('defaults resolve with the four workflow roles', () => {
  const { config, warnings } = resolveConfig({})
  assert.deepEqual(warnings, [])
  assert.deepEqual(ROLES, ['planner', 'implementer', 'reviewer', 'approver'])
  assert.deepEqual(Object.keys(config.roles).sort(), [...ROLES].sort())
  assert.equal(config.defaultPlanTiming, 'at_pickup')
  assert.equal(config.defaultPlanQuestions, 'interactive')
})

test('planner is read-only by declaration and can ask', () => {
  const { config } = resolveConfig({})
  assert.ok(config.roles.planner.allowTools.includes('ask_user_question'))
  assert.equal(config.roles.planner.allowTools.includes('write'), false)
  assert.equal(config.roles.planner.allowTools.includes('edit'), false)
})

test('unknown keys warn, wrong values throw', () => {
  const { warnings } = resolveConfig({ nope: true })
  assert.ok(warnings.some((w) => w.includes('nope')))
  assert.throws(() => resolveConfig({ defaultPlanTiming: 'later' }), /defaultPlanTiming/)
  assert.throws(() => resolveConfig({ defaultPlanQuestions: 'maybe' }), /defaultPlanQuestions/)
  assert.throws(() => resolveConfig({ roles: { planner: { allowTools: 'read' } } }), /allowTools/)
})

test('roles fall back to the deployment default and the ladder can override', () => {
  const { config } = resolveConfig({
    roles: {
      planner: { provider: null, model: null, allowTools: [] },
      implementer: { provider: 'paid', model: 'big' },
    },
    escalationLadder: [{ rung: 0 }, { rung: 1, provider: 'paid', model: 'biggest', reasoningEffort: 'high' }],
  })
  assert.equal(config.roles.implementer.provider, 'paid')
  const route = routeForAttempt(config, 'implementer', 3)
  assert.equal(route.model, 'biggest')
  assert.equal(route.reasoningEffort, 'high')
})
