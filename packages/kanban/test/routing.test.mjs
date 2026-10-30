import test from 'node:test'
import assert from 'node:assert/strict'

import { applyRoutes, checkEffort, normalizeEffort, offeredEfforts, prepareRoutes, staleEffortWarnings } from '../src/routing.mjs'

// A stand-in for the host LLM registry: three models, two of them reasoning
// models with different level sets, one with no reasoning metadata at all.
const CATALOG = {
  'local/big-moe': {
    reasoning: {
      efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'xhigh', name: 'Xhigh' }],
      defaultEffort: 'medium',
    },
  },
  'local/medium-dense': {
    reasoning: {
      efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'xhigh', name: 'Xhigh' }],
    },
  },
  'local/plain': {},
}

const ROLES = {
  planner: { provider: null, model: null, reasoningEffort: null },
  implementer: { provider: null, model: null, reasoningEffort: null },
  reviewer: { provider: null, model: null, reasoningEffort: null },
  approver: { provider: null, model: null, reasoningEffort: null },
}

/** The two calls `src/host.mjs`'s setRoutes endpoint makes, in order. */
async function setRoutes(items, { catalog = CATALOG, providers = ['local'], models = Object.keys(CATALOG).map((key) => key.split('/')[1]), current = {}, inherited = {} } = {}) {
  const prepared = await prepareRoutes({
    items,
    roles: ROLES,
    providers,
    listModels: async (provider) => (providers.includes(provider) ? models.filter((id) => `${provider}/${id}` in catalog).map((id) => ({ id })) : []),
    resolveModel: async (provider, model) => {
      const info = catalog[`${provider}/${model}`]
      if (info === undefined) throw new Error(`unknown model "${provider}/${model}"`)
      return { provider, id: model, name: model, ...info }
    },
  })
  if (!prepared.ok) return prepared
  return { ok: true, routes: prepared.routes, next: applyRoutes(current, inherited, prepared.routes) }
}

test('a catalog level is accepted and lands in the edited role row', async () => {
  const result = await setRoutes([
    { role: 'implementer', provider: 'local', model: 'big-moe', reasoningEffort: 'xhigh' },
  ])
  assert.equal(result.ok, true)
  assert.deepEqual(result.routes, [{ role: 'implementer', provider: 'local', model: 'big-moe', reasoningEffort: 'xhigh' }])
  assert.deepEqual(result.next.roles.implementer, { provider: 'local', model: 'big-moe', reasoningEffort: 'xhigh' })
})

test('a level saved for one role leaves the other rows alone', async () => {
  const current = { roles: { planner: { provider: 'local', model: 'plain', reasoningEffort: null }, implementer: { provider: 'local', model: 'big-moe', reasoningEffort: 'low' } } }
  const result = await setRoutes([{ role: 'implementer', provider: 'local', model: 'big-moe', reasoningEffort: 'xhigh' }], { current })
  assert.equal(result.ok, true)
  assert.deepEqual(result.next.roles.planner, { provider: 'local', model: 'plain', reasoningEffort: null })
  assert.equal(result.next.roles.implementer.reasoningEffort, 'xhigh')
})

test('a level the model does not offer is a bad_request naming role, model and offers', async () => {
  const result = await setRoutes([{ role: 'reviewer', provider: 'local', model: 'big-moe', reasoningEffort: 'off' }])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad_request')
  assert.match(result.message, /roles?\s?reviewer|role reviewer/)
  assert.match(result.message, /local\/big-moe/)
  assert.match(result.message, /low, medium, xhigh/)
})

test('a level on a model with no reasoning metadata is a bad_request', async () => {
  const result = await setRoutes([{ role: 'planner', provider: 'local', model: 'plain', reasoningEffort: 'low' }])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad_request')
  assert.match(result.message, /planner/)
  assert.match(result.message, /local\/plain/)
  assert.match(result.message, /no reasoning effort levels/)
})

test('null and empty string both mean Default and clear a stored level', async () => {
  const current = { roles: { planner: { provider: 'local', model: 'big-moe', reasoningEffort: 'xhigh' } } }
  for (const value of [null, '', '  ', undefined]) {
    const result = await setRoutes([{ role: 'planner', provider: 'local', model: 'big-moe', reasoningEffort: value }], { current })
    assert.equal(result.ok, true, `reasoningEffort ${JSON.stringify(value)} must be accepted`)
    assert.equal(result.routes[0].reasoningEffort, null)
    assert.equal(result.next.roles.planner.reasoningEffort, null, `Default must overwrite the saved level, not keep ${JSON.stringify(value)}`)
    assert.equal(result.next.roles.planner.model, 'big-moe')
  }
})

test('a route written without any effort key still writes it explicitly', async () => {
  const current = { roles: { approver: { provider: 'local', model: 'big-moe', reasoningEffort: 'medium' } } }
  const result = await setRoutes([{ role: 'approver', provider: 'local', model: 'big-moe' }], { current })
  assert.equal(result.ok, true)
  assert.ok('reasoningEffort' in result.next.roles.approver)
  assert.equal(result.next.roles.approver.reasoningEffort, null)
})

test('a deprecated role key survives a route rewrite', async () => {
  const current = { roles: { planner: { provider: 'local', model: 'big-moe', reasoningEffort: 'low', allowTools: ['read'] } } }
  const result = await setRoutes([{ role: 'planner', provider: 'local', model: 'big-moe', reasoningEffort: 'high' }], { current })
  // 'high' is not offered by big-moe, so this is rejected before anything is written.
  assert.equal(result.ok, false)
  const saved = await setRoutes([{ role: 'planner', provider: 'local', model: 'big-moe', reasoningEffort: 'medium' }], { current })
  assert.deepEqual(saved.next.roles.planner, { provider: 'local', model: 'big-moe', reasoningEffort: 'medium', allowTools: ['read'] })
})

test('the existing route checks are unchanged', async () => {
  assert.equal((await setRoutes([{ role: 'ghost', provider: 'local', model: 'big-moe' }])).code, 'bad_request')
  assert.equal((await setRoutes([{ role: 'planner', provider: 'other', model: 'big-moe' }])).code, 'bad_request')
  assert.equal((await setRoutes([{ role: 'planner', provider: 'local', model: 'nope' }])).code, 'bad_request')
  assert.equal((await setRoutes([{ role: 'planner', provider: 'local', model: '' }])).message, 'role planner needs both provider and model')
  assert.deepEqual(await setRoutes([]), { ok: false, code: 'bad_request', message: 'no routes supplied' })
  assert.deepEqual(await setRoutes('nope'), { ok: false, code: 'bad_request', message: 'no routes supplied' })
})

test('a non-string effort is a client error, not a coercion', async () => {
  const result = await setRoutes([{ role: 'planner', provider: 'local', model: 'big-moe', reasoningEffort: 7 }])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad_request')
  assert.match(result.message, /reasoningEffort must be a string or null/)
})

test('an unreadable catalog rejects an effort instead of guessing', async () => {
  const result = await setRoutes([{ role: 'planner', provider: 'local', model: 'big-moe', reasoningEffort: 'low' }], { catalog: {} })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unavailable')
  assert.match(result.message, /could not read the catalog/)
})

test('routes without an effort never touch the catalog lookup', async () => {
  let looked = 0
  const prepared = await prepareRoutes({
    items: [{ role: 'planner', provider: 'local', model: 'big-moe' }],
    roles: ROLES,
    providers: ['local'],
    listModels: async () => [{ id: 'big-moe' }],
    resolveModel: async () => {
      looked += 1
      return {}
    },
  })
  assert.equal(prepared.ok, true)
  assert.equal(looked, 0, 'a Default route must not need exact model metadata')
})

test('normalizeEffort and the small helpers', () => {
  assert.deepEqual(normalizeEffort(null), { ok: true, value: null })
  assert.deepEqual(normalizeEffort(undefined), { ok: true, value: null })
  assert.deepEqual(normalizeEffort(''), { ok: true, value: null })
  assert.deepEqual(normalizeEffort(' xhigh '), { ok: true, value: 'xhigh' })
  assert.equal(normalizeEffort(false).ok, false)
  assert.deepEqual(offeredEfforts(undefined), [])
  assert.deepEqual(offeredEfforts({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, null, { name: 'nope' }] } }).map((e) => e.id), ['low'])
  assert.deepEqual(checkEffort({ role: 'planner', provider: 'local', model: 'plain', effort: null, info: {} }), { ok: true, value: null })
})

test('a stale saved effort warns without taking the profile down', async () => {
  const roles = {
    planner: { provider: 'local', model: 'big-moe', reasoningEffort: 'xhigh' },
    implementer: { provider: 'local', model: 'big-moe', reasoningEffort: 'ultra' },
    reviewer: { provider: 'local', model: 'plain', reasoningEffort: 'low' },
    approver: { provider: 'local', model: 'big-moe', reasoningEffort: null },
  }
  const warnings = await staleEffortWarnings(roles, async (provider, model) => {
    const info = CATALOG[`${provider}/${model}`]
    if (info === undefined) throw new Error('provider is down')
    return { provider, id: model, name: model, ...info }
  })
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /roles\.implementer\.reasoningEffort "ultra"/)
  assert.match(warnings[0], /not offered by model "local\/big-moe"/)
  assert.match(warnings[1], /roles\.reviewer\.reasoningEffort "low"/)
  assert.match(warnings[1], /offers no reasoning effort levels/)
})

test('an unreadable catalog produces no boot warning', async () => {
  const warnings = await staleEffortWarnings(
    { planner: { provider: 'local', model: 'big-moe', reasoningEffort: 'xhigh' } },
    async () => {
      throw new Error('provider is down')
    },
  )
  assert.deepEqual(warnings, [])
})
