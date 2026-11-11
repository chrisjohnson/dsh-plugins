import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, DEPRECATED_ROLE_KEYS, ROLES, resolveConfig, routeForAttempt } from '../src/config.mjs'

test('defaults resolve with the four workflow roles plus the orchestrator', () => {
  const { config, warnings } = resolveConfig({})
  assert.deepEqual(warnings, [])
  assert.deepEqual(ROLES, ['planner', 'implementer', 'reviewer', 'approver', 'orchestrator'])
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

test('every default prompt, approval included, loads from the package prompts dir', async () => {
  const { fileURLToPath } = await import('node:url')
  const { DEFAULT_PROMPTS } = await import('../src/config.mjs')
  const { loadPrompts } = await import('../src/prompts.mjs')
  const packageDir = fileURLToPath(new URL('..', import.meta.url))
  assert.equal(DEFAULT_PROMPTS.approval, 'approval.md')
  const prompts = await loadPrompts({}, packageDir)
  for (const name of Object.keys(DEFAULT_PROMPTS)) {
    assert.ok(prompts.bodies[name]?.length > 0, `${name} prompt did not load`)
    assert.ok(prompts.hashes[name], `${name} prompt was not hashed`)
  }
  // The approval prompt is the slim hand-over: the user's one-line job
  // statement, plus the note that the three approval tools exist for the human
  // to ask for. Nothing else — the session already holds the plan and the review.
  assert.match(prompts.bodies.approval, /kanban_approve/)
  assert.match(prompts.bodies.approval, /kanban_discard/)
  assert.match(prompts.bodies.approval, /kanban_submit_plan/)
  assert.match(prompts.bodies.approval, /^Without making any further changes, offer the user a selection of a few options for next steps that would enable you to wrap this work up\./)
  assert.equal(prompts.bodies.approval.includes('{{plan}}'), false, 'approval prompt still dumps the plan')
  assert.equal(prompts.bodies.approval.includes('{{review}}'), false, 'approval prompt still dumps the review')
})

// KAN-60: the orchestrator's own keys. They are config because they survive a
// deleted database, and they are optional because a deployment that drives its
// board by hand must be able to say so with one key.
test('the orchestrator is on, with a stable session id and a 30s digest window', () => {
  const { config } = resolveConfig({})
  assert.equal(config.orchestratorEnabled, true)
  assert.equal(config.orchestratorSessionId, 'kanban-orchestrator')
  assert.equal(config.orchestratorDigestWindowMs, 30000)
  assert.deepEqual(config.roles.orchestrator, { provider: null, model: null, reasoningEffort: null })
})

test('a deployment may retune the orchestrator without restating anything else', () => {
  const { config } = resolveConfig({
    orchestratorEnabled: false,
    orchestratorSessionId: 'board-keeper',
    orchestratorDigestWindowMs: 5000,
    roles: { orchestrator: { provider: 'local', model: 'small' } },
  })
  assert.equal(config.orchestratorEnabled, false)
  assert.equal(config.orchestratorSessionId, 'board-keeper')
  assert.equal(config.orchestratorDigestWindowMs, 5000)
  assert.equal(config.roles.orchestrator.provider, 'local')
  // The untouched roles keep their defaults: a config row merges, it does not replace.
  assert.equal(config.roles.planner.provider, null)
})

test('a malformed orchestrator setting is refused with the key named', () => {
  assert.throws(() => resolveConfig({ orchestratorEnabled: 'yes' }), /orchestratorEnabled: must be a boolean/)
  assert.throws(() => resolveConfig({ orchestratorSessionId: '  ' }), /orchestratorSessionId: must be a non-empty string/)
  assert.throws(() => resolveConfig({ orchestratorDigestWindowMs: 0 }), /orchestratorDigestWindowMs: must be a positive number/)
})

// ------------------------------------------------------------------- KAN-81 --

test('the board’s management tools are on for ordinary sessions unless the deployment says otherwise', () => {
  // Default on: the feature is the point of a shared board, and a deployment that
  // never heard of the key must not silently lose it on upgrade.
  assert.equal(resolveConfig({}).config.agentManagementTools, true)
  assert.equal(resolveConfig({ agentManagementTools: false }).config.agentManagementTools, false)
  // A string "false" in a YAML row would be truthy at the registration check, so
  // it is refused rather than quietly meaning on.
  assert.throws(() => resolveConfig({ agentManagementTools: 'false' }), /agentManagementTools: must be a boolean/)
})

test('a deployment row that names only its own roles still gets the orchestrator entry', () => {
  const { config } = resolveConfig({ roles: { planner: { provider: 'p', model: 'm' } } })
  assert.equal(config.roles.orchestrator.provider, null)
})
