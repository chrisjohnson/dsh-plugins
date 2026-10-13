// End-to-end tests of the switch tool's guard path with fake services. They exist
// because the decision tests alone passed while the wiring between decideFit's
// verdict and the switch sequence was wrong.

import test from 'node:test'
import assert from 'node:assert/strict'

import { guardRouteChange, switchAgentModel } from '../src/guard.mjs'

const BIG = 1048576
const LOCAL = 262144
const CONFIG = { fitRatio: 0.8, autoCompact: true }

function harness({ tokens, windows = {}, routed = { provider: 'cloud', model: 'big' }, compact, selectFails } = {}) {
  const calls = { selected: [], steered: [], compacted: [], windowLookups: [] }
  let current = tokens
  const agent = {
    id: 's1',
    session: { requestHeader: () => ({ config: routed }) },
    steer: (m) => calls.steered.push(m)
  }
  const controller = {
    selectModel: async (req) => {
      if (selectFails) throw new Error('unknown route')
      calls.selected.push(req)
      return { selected: { provider: req.provider, model: req.model } }
    },
    modelCatalog: async () => ({ groups: [{ id: 'cloud', models: [{ id: 'big' }] }] })
  }
  const deps = {
    service: (_agent, name) => (name === 'sessionController' ? controller : undefined),
    readPressure: () => (current === undefined ? undefined : { totalTokens: current, nodes: [] }),
    resolveWindow: async (_agent, provider, model) => {
      calls.windowLookups.push(`${provider}/${model}`)
      return windows[`${provider}/${model}`]
    },
    compactToFit: async (_agent, budget) => {
      calls.compacted.push(budget)
      const result = compact ?? { ok: true, freed: 100000 }
      if (result.ok) current = result.after ?? budget - 1
      return result
    },
    createUserMessage: (input) => ({ id: 'm1', role: 'user', ...input })
  }
  return { agent, deps, calls }
}

const WINDOWS = { 'cloud/big': BIG, 'local/small': LOCAL }
const run = (h, extra = {}) =>
  switchAgentModel(h.deps, undefined, { ...CONFIG, ...extra }, h.agent, 'local', 'small', 'carry on', 'Model switched to local/small')

test('a switch that fits is allowed and reaches selectModel', async () => {
  const h = harness({ tokens: 50000, windows: WINDOWS })
  const result = await run(h)
  assert.equal(result.ok, true)
  assert.deepEqual(h.calls.selected, [{ sessionId: 's1', provider: 'local', model: 'small' }])
  assert.equal(h.calls.steered.length, 1)
  assert.equal(h.calls.steered[0].source.kind, 'plugin:model-switch')
  assert.deepEqual(h.calls.compacted, [])
})

test('a plain allow does not look up the current route window', async () => {
  const h = harness({ tokens: 50000, windows: WINDOWS })
  await run(h)
  assert.deepEqual(h.calls.windowLookups, ['local/small'])
})

test('a refusal reports its reason and never switches', async () => {
  const h = harness({ tokens: 420948, windows: WINDOWS, routed: { provider: 'local', model: 'small' } })
  const result = await run(h)
  assert.equal(result.ok, false)
  assert.match(result.error, /^model switch refused: context is ~420948 tokens/)
  assert.doesNotMatch(result.error, /undefined/)
  assert.match(result.error, /Delegate this work to a local subagent/)
  assert.deepEqual(h.calls.selected, [])
})

test('between the margin and the full current window the tool path still refuses', async () => {
  const h = harness({ tokens: Math.floor(LOCAL * 0.85), windows: { ...WINDOWS, 'local/tiny': 65536 }, routed: { provider: 'local', model: 'small' } })
  const result = await switchAgentModel(h.deps, undefined, CONFIG, h.agent, 'local', 'tiny', 'x', 's')
  assert.equal(result.ok, false)
  assert.match(result.error, /cannot be compacted from the current route/)
})

test('a compactable switch compacts first, then switches', async () => {
  const h = harness({ tokens: 420948, windows: WINDOWS })
  const result = await run(h)
  assert.equal(result.ok, true)
  assert.equal(result.compacted, true)
  assert.deepEqual(h.calls.compacted, [Math.floor(LOCAL * 0.8)])
  assert.equal(h.calls.selected.length, 1)
  assert.match(h.calls.steered[0].content[0].text, /compacted first/)
})

test('a failed compaction refuses with the reason and does not switch', async () => {
  const h = harness({ tokens: 420948, windows: WINDOWS, compact: { ok: false, reason: 'no compactable history yet' } })
  const result = await run(h)
  assert.equal(result.ok, false)
  assert.match(result.error, /no compactable history yet/)
  assert.deepEqual(h.calls.selected, [])
})

test('compaction that frees too little is refused', async () => {
  const h = harness({ tokens: 420948, windows: WINDOWS, compact: { ok: true, freed: 10, after: 400000 } })
  const result = await run(h)
  assert.equal(result.ok, false)
  assert.match(result.error, /still ~400000/)
  assert.deepEqual(h.calls.selected, [])
})

test('autoCompact false refuses instead of compacting', async () => {
  const h = harness({ tokens: 420948, windows: WINDOWS })
  const result = await run(h, { autoCompact: false })
  assert.equal(result.ok, false)
  assert.match(result.error, /autoCompact: false/)
  assert.deepEqual(h.calls.compacted, [])
})

test('no token measurement allows the switch with a note', async () => {
  const h = harness({ tokens: undefined, windows: WINDOWS })
  const guard = await guardRouteChange(h.deps, h.agent, 'local', 'small', CONFIG)
  assert.equal(guard.allowed, true)
  assert.match(guard.note, /no token measurement/)
  assert.equal((await run(h)).ok, true)
})

test('no declared destination window allows the switch with a note', async () => {
  const h = harness({ tokens: 420948, windows: { 'cloud/big': BIG } })
  const guard = await guardRouteChange(h.deps, h.agent, 'local', 'small', CONFIG)
  assert.equal(guard.allowed, true)
  assert.match(guard.note, /no declared context window for local\/small/)
  assert.equal((await run(h)).ok, true)
})

test('a selectModel failure lists the available routes', async () => {
  const h = harness({ tokens: 50000, windows: WINDOWS, selectFails: true })
  const result = await run(h)
  assert.equal(result.ok, false)
  assert.match(result.error, /model switch failed: unknown route/)
  assert.match(result.error, /Available routes: cloud\/big/)
})
