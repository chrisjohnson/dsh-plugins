import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { format } from 'node:util'

import { createToolBridge } from '../src/bridge.mjs'

function setup() {
  const storage = new AsyncLocalStorage()
  const errors = []
  const bridge = createToolBridge({ storage, log: { error: (...args) => errors.push(format(...args)) } })
  return { storage, bridge, errors }
}

const ok = (text = '{}') => ({ isError: false, value: {}, content: [{ type: 'text', text }] })
const exec = (name, agentId = 'sess-1') => ({ name, token: Symbol(name), agent: agentId === null ? undefined : { id: agentId } })
const accept = async () => ({ kind: 'accept' })

test('browser_* calls run inside a store carrying the calling agent id', async () => {
  const { storage, bridge } = setup()
  let seen
  await bridge.execute(exec('browser_open', 'agent-7'), async () => {
    seen = storage.getStore()
    seen.routed = true
    return ok()
  })
  assert.equal(seen.sessionId, 'agent-7')
})

test('other tools are not wrapped', async () => {
  const { storage, bridge } = setup()
  let seen = 'unset'
  await bridge.execute(exec('read_file'), async () => {
    seen = storage.getStore()
    return ok()
  })
  assert.equal(seen, undefined)
})

test('a call without an agent still gets one stable session id', async () => {
  const { storage, bridge } = setup()
  const ids = []
  for (let i = 0; i < 2; i += 1) {
    await bridge.execute(exec('browser_open', null), async () => {
      ids.push(storage.getStore().sessionId)
      storage.getStore().routed = true
      return ok()
    })
  }
  assert.equal(ids[0], ids[1])
})

test('notices left by the controller are appended to that call\'s result text, once', async () => {
  const { storage, bridge } = setup()
  const call = exec('browser_tabs')
  const result = ok('[]')
  await bridge.execute(call, async () => {
    const store = storage.getStore()
    store.routed = true
    store.notices.add('Remote browser is unreachable. LOCAL fallback in use.')
    return result
  })
  const decision = await bridge.postExecute(call, result, accept)
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content.length, 2)
  assert.equal(decision.content[0].text, '[]')
  assert.equal(decision.content[1].text, 'dsh-browser: Remote browser is unreachable. LOCAL fallback in use.')
  assert.deepEqual(await bridge.postExecute(call, result, accept), { kind: 'accept' }, 'a second pass adds nothing')
})

test('a call with no notices is passed through untouched', async () => {
  const { storage, bridge } = setup()
  const call = exec('browser_open')
  await bridge.execute(call, async () => {
    storage.getStore().routed = true
    return ok()
  })
  assert.deepEqual(await bridge.postExecute(call, ok(), accept), { kind: 'accept' })
})

test('notices ride on a failed result too (the connection note explains the error)', async () => {
  const { storage, bridge } = setup()
  const call = exec('browser_click')
  const failure = { isError: true, error: { message: 'x' }, content: [{ type: 'text', text: 'Error: x' }] }
  await bridge.execute(call, async () => {
    storage.getStore().routed = true
    storage.getStore().notices.add('re-established')
    return failure
  })
  const decision = await bridge.postExecute(call, failure, accept)
  assert.equal(decision.content.at(-1).text, 'dsh-browser: re-established')
})

test('another policy\'s block or value replacement is left alone', async () => {
  const { storage, bridge } = setup()
  const call = exec('browser_open')
  await bridge.execute(call, async () => {
    storage.getStore().routed = true
    storage.getStore().notices.add('n')
    return ok()
  })
  const block = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] }
  assert.equal(await bridge.postExecute(call, ok(), async () => block), block)
})

test('a replaced content list from another policy is extended, not discarded', async () => {
  const { storage, bridge } = setup()
  const call = exec('browser_open')
  await bridge.execute(call, async () => {
    storage.getStore().routed = true
    storage.getStore().notices.add('n')
    return ok()
  })
  const decision = await bridge.postExecute(call, ok('orig'), async () => ({ kind: 'accept', content: [{ type: 'text', text: 'policy' }] }))
  assert.deepEqual(decision.content.map((block) => block.text), ['policy', 'dsh-browser: n'])
})

test('no undefined fields are introduced into the decision', async () => {
  const { storage, bridge } = setup()
  const call = exec('browser_open')
  await bridge.execute(call, async () => {
    storage.getStore().routed = true
    storage.getStore().notices.add('n')
    return ok()
  })
  const decision = await bridge.postExecute(call, ok(), accept)
  assert.equal(JSON.stringify(decision).includes('undefined'), false)
  for (const value of Object.values(decision)) assert.notEqual(value, undefined)
  for (const block of decision.content) for (const value of Object.values(block)) assert.notEqual(value, undefined)
})

test('a successful browser tool that never reached the patched controller is reported loudly', async () => {
  const { bridge, errors } = setup()
  const call = exec('browser_open')
  await bridge.execute(call, async () => ok()) // routed stays false
  assert.equal(errors.length, 1)
  assert.match(errors[0], /browser_open ran on the original plugin's shared browser/)
  const decision = await bridge.postExecute(call, ok(), accept)
  assert.match(decision.content.at(-1).text, /NOT in effect/)
})

test('a failed call that never reached the controller (bad arguments) is not reported as unattached', async () => {
  const { bridge, errors } = setup()
  await bridge.execute(exec('browser_open'), async () => ({ isError: true, error: { message: 'bad' }, content: [{ type: 'text', text: 'Error: bad' }] }))
  assert.deepEqual(errors, [])
})
