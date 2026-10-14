// The host wiring against a stand-in for the harness: a queue file written by an
// earlier version is restored, the routes only ever return the asking session's
// items, and a due item is handed to sessionController.prompt exactly once.
//
// The shapes stood in for here are the ones in @deepseek-ai/dsh-client-connection
// 0.2.0-rc.2 (HostConnectionService.fetch.register, the client-request /
// server-response envelope) and @deepseek-ai/dsh-api-session-controller 0.2.0-rc.2
// (SessionController.prompt(request, signal)).

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'sq-host-'))
process.env.DSH_HOME = home
const file = join(home, 'storages', 'scheduled-queue.json')

const past = Date.now() - 60_000
const future = Date.now() + 3_600_000
await mkdir(join(home, 'storages'), { recursive: true })
await writeFile(
  file,
  JSON.stringify(
    [
      { id: 'a-due', messageId: 'ma', sessionId: 'A', text: 'due in A', minutes: 5, forceSteer: false, dueAt: past, createdAt: past },
      { id: 'a-later', messageId: 'ma2', sessionId: 'A', text: 'later in A', minutes: 60, forceSteer: true, dueAt: future, createdAt: past },
      { id: 'b-later', messageId: 'mb', sessionId: 'B', text: 'later in B', minutes: 60, forceSteer: false, dueAt: future, createdAt: past },
    ],
    null,
    2,
  ),
)

const { default: plugin } = await import('../src/host.mjs')

const prompts = []
const routes = new Map()
const disposers = []
const logs = []
const sink = (level) => (...args) => logs.push([level, ...args])

const scope = {
  connection: { fetch: { register: (route) => routes.set(route.path, route) } },
  sessionController: {
    prompt: async (request, signal) => {
      assert.ok(signal instanceof AbortSignal)
      prompts.push(request)
      return { accepted: true }
    },
  },
  effect: (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
}
const ctx = {
  logger: () => ({ info: sink('info'), warn: sink('warn'), error: sink('error') }),
  inject: (names, callback) => {
    assert.deepEqual(names, ['connection', 'sessionController'])
    callback(scope)
  },
}

plugin(ctx, { scanIntervalMs: 1000 })

async function call(endpoint, payload) {
  const route = routes.get(`/api/scheduledQueue/${endpoint}`)
  assert.ok(route, `route for ${endpoint}`)
  assert.deepEqual(route.methods, ['POST'])
  const body = { type: 'client-request', rpcId: 'rpc-1', method: `scheduledQueue/${endpoint}`, payload }
  const response = await route.fetch(new Request('http://127.0.0.1/x', { method: 'POST', body: JSON.stringify(body) }))
  const json = await response.json()
  assert.equal(json.type, 'server-response')
  assert.equal(json.rpcId, 'rpc-1')
  return json.result
}

test('registers an exact POST route per endpoint', () => {
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/scheduledQueue/edit',
    '/api/scheduledQueue/list',
    '/api/scheduledQueue/remove',
    '/api/scheduledQueue/schedule',
    '/api/scheduledQueue/sendNow',
  ])
})

test('list returns only the asking session, and a legacy queue file is restored', async () => {
  const a = await call('list', { sessionId: 'A' })
  assert.equal(a.ok, true)
  assert.deepEqual(a.value.queue.map((i) => i.id).sort(), ['a-due', 'a-later'])
  const b = await call('list', { sessionId: 'B' })
  assert.deepEqual(b.value.queue.map((i) => i.id), ['b-later'])
  assert.deepEqual((await call('list', { sessionId: 'C' })).value.queue, [])
  assert.equal((await call('list', {})).ok, false, 'list without a session is refused, not answered with everything')
})

test('another session cannot remove, edit or send an item', async () => {
  assert.deepEqual((await call('remove', { id: 'b-later', sessionId: 'A' })).value.removed, false)
  assert.equal((await call('edit', { id: 'b-later', sessionId: 'A', text: 'hijack' })).ok, false)
  assert.equal((await call('sendNow', { id: 'b-later', sessionId: 'A' })).ok, false)
  assert.deepEqual((await call('list', { sessionId: 'B' })).value.queue.map((i) => i.text), ['later in B'])
  assert.equal(prompts.some((p) => p.sessionId === 'B'), false)
})

test('schedule returns the queue for its own session only', async () => {
  const made = await call('schedule', { sessionId: 'C', text: 'hello C', minutes: 10, forceSteer: false })
  assert.equal(made.ok, true)
  assert.deepEqual(made.value.queue.map((i) => i.text), ['hello C'])
  assert.equal((await call('schedule', { sessionId: 'C', text: '  ' })).ok, false)
})

test('a due item is delivered through sessionController.prompt exactly once, then leaves the file', async () => {
  const deadline = Date.now() + 6000
  while (prompts.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  await new Promise((r) => setTimeout(r, 1500))
  assert.deepEqual(prompts, [
    { requestId: 'ma', sessionId: 'A', mode: 'queue', content: [{ type: 'text', text: 'due in A' }] },
  ])
  assert.deepEqual((await call('list', { sessionId: 'A' })).value.queue.map((i) => i.id), ['a-later'])
  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(saved.map((i) => i.id).sort(), ['a-later', 'b-later', saved.find((i) => i.sessionId === 'C').id].sort())
})

test('sendNow delivers a steering item in steer mode', async () => {
  const sent = await call('sendNow', { id: 'a-later', sessionId: 'A' })
  assert.equal(sent.value.delivered, true)
  assert.equal(prompts.at(-1).mode, 'steer')
  assert.equal(prompts.at(-1).sessionId, 'A')
})

test.after(() => {
  for (const dispose of disposers) dispose()
})
