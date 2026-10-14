// Runs the registered tools through the same output validation dsh's tool
// registry applies, using dsh's own functions.
//
// ToolRuntime.createSuccessResult (@deepseek-ai/dsh-tools lib/index.js) takes the
// handler's return value through three steps: snapshotJsonValue (undefined means
// "value is not lossless JSON" and the call is marked failed), then
// validateJsonSchemaValue against the tool's declared output schema, then
// output.render. This file performs those same steps with the real exported
// functions, against the real host.mjs, so a handler that returns something dsh
// would reject fails here rather than in a live session.
//
// It needs a dsh installation (the packages are peers, not dependencies), so it
// skips on a bare clone. CI's compose job installs the harness and runs it.

import test from 'node:test'
import assert from 'node:assert/strict'

let tools, util, host
try {
  tools = await import('@deepseek-ai/dsh-tools')
  util = await import('@deepseek-ai/dsh-util-values')
  host = await import('../src/host.mjs')
} catch {
  tools = undefined
}
const skip = tools === undefined ? 'dsh packages are not installed' : false

const BIG = 1048576
const LOCAL = 262144
const WINDOWS = { 'cloud/big': BIG, 'local/small': LOCAL }
const ESCALATION = { escalationProvider: 'local', escalationModel: 'small' }

function boot(config) {
  const registered = new Map()
  const logger = { info() {}, warn() {} }
  const ctx = {
    logger: () => logger,
    effect: (fn) => fn(),
    get: () => undefined,
    inject: (_deps, fn) =>
      fn({
        tools: { register: (definition) => registered.set(definition.name, definition) },
        get: () => undefined,
        effect: (f) => f()
      })
  }
  host.default(ctx, config)
  return registered
}

// A session whose services are fakes with the shapes rc.2 declares.
function fakeAgent({ tokens, routed = { provider: 'cloud', model: 'big' }, windows = WINDOWS, compactFails, selectFails } = {}) {
  let current = tokens
  const nodes = () => Array.from({ length: 6 }, (_, seq) => ({ seq, tokens: Math.floor((current ?? 0) / 6) }))
  const services = {
    sessionController: {
      selectModel: async ({ provider, model }) => {
        if (selectFails) throw new Error('unknown route')
        return { selected: { provider, model } }
      },
      modelCatalog: async () => ({ groups: [{ id: 'cloud', models: [{ id: 'big' }] }] })
    },
    llm: {
      resolveModelInfo: async (provider, model) => {
        const window = windows[`${provider}/${model}`]
        return window === undefined ? {} : { context: { contextWindow: window } }
      }
    },
    tokenMeter: {
      measure: () => {
        if (current === undefined) throw new Error('not measurable')
        return { totalTokens: current, nodes: nodes() }
      }
    },
    compaction: {
      compactRegion: async () => {
        if (compactFails) throw new Error('summarization failed')
        current = 100000
        return {}
      }
    }
  }
  return {
    id: 's1',
    session: { requestHeader: () => ({ config: routed }) },
    ctx: { get: (name) => services[name] },
    steer() {}
  }
}

// What the registry does with a handler's return value.
async function throughRegistry(definition, args, agent) {
  const returned = await definition.execute(args, { agent, signal: new AbortController().signal })
  const detached = util.snapshotJsonValue(returned)
  assert.notEqual(detached, undefined, `value is not lossless JSON: ${JSON.stringify(returned)}`)
  const violations = tools.validateJsonSchemaValue(definition.output.schema, detached, 'value')
  assert.deepEqual(violations, [])
  const text = definition.output.render(args, util.deepFreeze(detached))
  return { value: detached, text: text.map((block) => block.text).join('\n'), returned }
}

const SWITCH = { provider: 'local', model: 'small', message: 'carry on' }

test('the check has teeth: an undefined property is not lossless JSON', { skip }, () => {
  assert.equal(util.snapshotJsonValue({ ok: true, freed: undefined }), undefined)
})

test('switch_model success passes dsh output validation', { skip }, async () => {
  const { switch_model } = Object.fromEntries(boot({}))
  const { value, text } = await throughRegistry(switch_model, SWITCH, fakeAgent({ tokens: 50000 }))
  assert.equal(value.ok, true)
  assert.equal('freed' in value, false)
  assert.equal(text, 'Session switched to local/small (was cloud/big). A notice explaining the switch was steered to the new model; a durable "model changed" notice marks the boundary in the transcript.')
})

test('switch_model with no measurement or window still passes', { skip }, async () => {
  const { switch_model } = Object.fromEntries(boot({}))
  const none = await throughRegistry(switch_model, SWITCH, fakeAgent({ tokens: undefined }))
  assert.equal(none.value.ok, true)
  const noWindow = await throughRegistry(switch_model, SWITCH, fakeAgent({ tokens: 420948, windows: { 'cloud/big': BIG } }))
  assert.equal(noWindow.value.ok, true)
})

test('switch_model compact-then-switch passes and reports the numbers', { skip }, async () => {
  const { switch_model } = Object.fromEntries(boot({}))
  const { value, text } = await throughRegistry(switch_model, SWITCH, fakeAgent({ tokens: 420948 }))
  assert.equal(value.ok, true)
  assert.equal(value.compacted, true)
  assert.equal(typeof value.freed, 'number')
  assert.match(text, /The conversation was compacted to fit first \(~\d+ tokens freed; now ~\d+ against a 262144-token window\)\./)
})

test('switch_model already on the route passes', { skip }, async () => {
  const { switch_model } = Object.fromEntries(boot({}))
  const agent = fakeAgent({ tokens: 50000, routed: { provider: 'local', model: 'small' } })
  const { value, text } = await throughRegistry(switch_model, SWITCH, agent)
  assert.equal(value.alreadyOnRoute, true)
  assert.match(text, /already on local\/small/)
})

test('switch_model refusal and failures pass as plain failure values', { skip }, async () => {
  const { switch_model } = Object.fromEntries(boot({}))
  const refused = await throughRegistry(
    switch_model, SWITCH, fakeAgent({ tokens: 420948, routed: { provider: 'local', model: 'small' } }))
  assert.equal(refused.value.ok, false)
  assert.match(refused.text, /^model switch refused: /)

  const compactFailed = await throughRegistry(switch_model, SWITCH, fakeAgent({ tokens: 420948, compactFails: true }))
  assert.equal(compactFailed.value.ok, false)
  assert.match(compactFailed.text, /could not be compacted automatically/)

  const selectFailed = await throughRegistry(switch_model, SWITCH, fakeAgent({ tokens: 50000, selectFails: true }))
  assert.equal(selectFailed.value.ok, false)
  assert.match(selectFailed.text, /^model switch failed: unknown route/)

  const noAgent = await throughRegistry(switch_model, SWITCH, undefined)
  assert.equal(noAgent.value.ok, false)
})

test('switch_model_escalate passes on success, compaction and refusal', { skip }, async () => {
  const { switch_model_escalate } = Object.fromEntries(boot(ESCALATION))
  const fits = await throughRegistry(switch_model_escalate, {}, fakeAgent({ tokens: 50000 }))
  assert.equal(fits.value.ok, true)
  const compacted = await throughRegistry(switch_model_escalate, {}, fakeAgent({ tokens: 420948 }))
  assert.equal(compacted.value.compacted, true)
  const refused = await throughRegistry(
    switch_model_escalate, {}, fakeAgent({ tokens: 420948, routed: { provider: 'local', model: 'small' } }))
  assert.equal(refused.value.ok, false)
})
