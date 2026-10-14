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
