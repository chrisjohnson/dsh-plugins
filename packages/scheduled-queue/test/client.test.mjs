// The browser half cannot import a sibling module, so its copy of the session
// filter is reached through the module loader stub (the same approach as
// model-switch's visibility test) and held to the same cases as the pure one.

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { itemsForSession } from '../src/queue.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

const registered = []
globalThis.window = { __ModuleLoader__: { load: (def) => registered.push(def) } }
await import(pathToFileURL(path.join(here, '..', 'src', 'client.mjs')).href)

const definition = registered.find((def) => def.id === 'dsh-scheduled-queue')
assert.ok(definition, 'client half did not register with the module loader')

const reactStandIn = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {} }
const client = definition.factory(() => reactStandIn)

test('client exposes the slots service it needs', () => {
  assert.deepEqual(client.inject, ['connection', 'slots'])
  assert.equal(typeof client.apply, 'function')
  assert.equal(typeof client.sessionItems, 'function')
})

test('the queue a host response carries is the one the dock shows', () => {
  const queue = [{ id: 'a1', sessionId: 'A' }]
  assert.deepEqual(client.queueFromResult({ ok: true, value: { queue } }), { queue, warning: null })
  assert.deepEqual(client.queueFromResult({ ok: true, value: { queue, warning: 'not saved yet' } }), { queue, warning: 'not saved yet' })
})

test('a response that carries no queue is not applied', () => {
  for (const res of [undefined, null, { ok: false, error: { message: 'no' } }, { ok: true }, { ok: true, value: {} }, { ok: true, value: { queue: 'x' } }]) {
    assert.equal(client.queueFromResult(res), null, JSON.stringify(res))
  }
})

test('a schedule event for this session updates the dock without a poll', () => {
  const queue = [{ id: 'a1', sessionId: 'A' }]
  const event = { detail: { sessionId: 'A', queue, warning: 'w' } }
  assert.deepEqual(client.dockUpdateFor(event, 'A'), { action: 'apply', queue, warning: 'w' })
  // No warning field is not a warning.
  assert.deepEqual(client.dockUpdateFor({ detail: { sessionId: 'A', queue } }, 'A'), { action: 'apply', queue, warning: null })
})

test('a schedule event for another session leaves this dock alone', () => {
  const queue = [{ id: 'b1', sessionId: 'B' }]
  assert.deepEqual(client.dockUpdateFor({ detail: { sessionId: 'B', queue } }, 'A'), { action: 'ignore' })
})

test('an event with no usable detail asks the host instead', () => {
  for (const event of [undefined, null, {}, { detail: null }, { detail: {} }, { detail: { sessionId: 'A' } }, { detail: { sessionId: 'A', queue: 'no' } }]) {
    assert.deepEqual(client.dockUpdateFor(event, 'A'), { action: 'refresh' }, JSON.stringify(event))
  }
})

test('dock filter: an item scheduled in session A is not visible in session B', () => {
  const queue = [
    { id: 'a1', sessionId: 'A', text: 'for a' },
    { id: 'b1', sessionId: 'B', text: 'for b' },
  ]
  assert.deepEqual(client.sessionItems(queue, 'A').map((i) => i.id), ['a1'])
  assert.deepEqual(client.sessionItems(queue, 'B').map((i) => i.id), ['b1'])
  assert.deepEqual(client.sessionItems(queue, 'C'), [])
})

test('dock filter: no session id shows nothing', () => {
  const queue = [{ id: 'a1', sessionId: 'A' }]
  for (const missing of [undefined, null, '', 7]) assert.deepEqual(client.sessionItems(queue, missing), [])
  assert.deepEqual(client.sessionItems(undefined, 'A'), [])
})

test('dock filter agrees with the host-side itemsForSession on the same inputs', () => {
  const queue = [{ id: 'a', sessionId: 'A' }, { id: 'b', sessionId: 'B' }, null, { id: 'a2', sessionId: 'A' }, { id: 'n' }]
  for (const sid of ['A', 'B', 'C', '', undefined, null]) {
    assert.deepEqual(client.sessionItems(queue, sid), itemsForSession(queue, sid), `sessionId ${String(sid)}`)
  }
})
