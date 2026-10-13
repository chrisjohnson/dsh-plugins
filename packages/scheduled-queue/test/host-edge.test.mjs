// Host edge cases against a stand-in harness: required session id, edit
// validation, permanent and transient delivery failures, a hung delivery,
// in-flight removal, and an unreadable queue file.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { default: plugin } = await import('../src/host.mjs')

const disposers = []
test.after(() => {
  for (const dispose of disposers) dispose()
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, ms = 8000) {
  const end = Date.now() + ms
  while (!predicate() && Date.now() < end) await sleep(50)
}

/** Start a plugin instance over a fresh home, optionally seeded with queue items. */
async function boot({ items, prompt, config = {}, prepare } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'sq-edge-'))
  process.env.DSH_HOME = home
  const file = join(home, 'storages', 'scheduled-queue.json')
  await mkdir(join(home, 'storages'), { recursive: true })
  if (items) await writeFile(file, JSON.stringify(items))
  if (prepare) await prepare(file)
  const routes = new Map()
  const logs = []
  const sink = (level) => (...args) => logs.push([level, ...args].join(' '))
  const scope = {
    connection: { fetch: { register: (route) => routes.set(route.path, route) } },
    sessionController: { prompt },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  plugin(
    {
      logger: () => ({ info: sink('info'), warn: sink('warn'), error: sink('error') }),
      inject: (_names, callback) => callback(scope),
    },
    { scanIntervalMs: 1000, ...config },
  )
  const call = async (endpoint, payload) => {
    const body = { type: 'client-request', rpcId: 'r', method: `scheduledQueue/${endpoint}`, payload }
    const response = await routes.get(`/api/scheduledQueue/${endpoint}`).fetch(new Request('http://127.0.0.1/', { method: 'POST', body: JSON.stringify(body) }))
    return (await response.json()).result
  }
  return { call, file, logs }
}

const due = (over = {}) => ({ id: 'x', messageId: 'mx', sessionId: 'A', text: 'hello', minutes: 1, forceSteer: false, dueAt: Date.now() - 1000, createdAt: 0, ...over })
const later = (over = {}) => due({ dueAt: Date.now() + 3_600_000, ...over })

test('remove, edit and sendNow need a sessionId, like list', async () => {
  const sent = []
  const h = await boot({ items: [later({ id: 'k' })], prompt: async (r) => sent.push(r) })
  for (const endpoint of ['list', 'remove', 'edit', 'sendNow']) {
    for (const payload of [{ id: 'k' }, { id: 'k', sessionId: '' }]) {
      const result = await h.call(endpoint, payload)
      assert.equal(result.ok, false, `${endpoint} ${JSON.stringify(payload)}`)
      assert.equal(result.error.code, 'bad-request')
    }
  }
  assert.deepEqual(sent, [])
  assert.equal((await h.call('list', { sessionId: 'A' })).value.queue.length, 1, 'the item is untouched')
})

test('edit rejects empty text and leaves the item as it was', async () => {
  const h = await boot({ items: [later({ id: 'k', text: 'keep me' })], prompt: async () => {} })
  const result = await h.call('edit', { id: 'k', sessionId: 'A', text: '   ' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
  assert.equal((await h.call('list', { sessionId: 'A' })).value.queue[0].text, 'keep me')
})

test('a request the harness rejects is dropped with its text in the log, not retried', async () => {
  let calls = 0
  const h = await boot({
    items: [due({ text: 'precious words' })],
    prompt: async () => {
      calls++
      throw Object.assign(new Error('prompt content must include text'), { code: 'gateway/bad-request' })
    },
  })
  await until(() => calls > 0)
  await sleep(200)
  assert.equal(calls, 1)
  assert.equal((await h.call('list', { sessionId: 'A' })).value.queue.length, 0)
  assert.ok(h.logs.some((l) => l.startsWith('warn') && l.includes('precious words')), h.logs.join('\n'))
  assert.deepEqual(JSON.parse(await readFile(h.file, 'utf8')), [])
})

test('session/not-found is asked again once; a transient miss still delivers', async () => {
  let calls = 0
  const h = await boot({
    items: [due()],
    prompt: async () => {
      calls++
      if (calls === 1) throw Object.assign(new Error('disposed during admission'), { code: 'session/not-found' })
    },
  })
  await until(() => calls >= 2, 10000)
  await sleep(200)
  assert.equal(calls, 2)
  assert.equal((await h.call('list', { sessionId: 'A' })).value.queue.length, 0)
  assert.ok(!h.logs.some((l) => l.includes('dropping')))
})

test('session/not-found twice drops the item and logs its text', async () => {
  let calls = 0
  const h = await boot({
    items: [due({ text: 'for a deleted session' })],
    prompt: async () => {
      calls++
      throw Object.assign(new Error('gone'), { code: 'session/not-found' })
    },
  })
  await until(() => calls >= 2, 10000)
  await sleep(300)
  assert.equal(calls, 2)
  assert.equal((await h.call('list', { sessionId: 'A' })).value.queue.length, 0)
  assert.ok(h.logs.some((l) => l.includes('dropping') && l.includes('for a deleted session')))
})

test('a hung delivery is aborted after the timeout and does not stall the next item', async () => {
  const seen = []
  let hungSignal
  const h = await boot({
    config: { deliveryTimeoutMs: 1000 },
    items: [due({ id: 'hung', messageId: 'm-hung', dueAt: Date.now() - 2000 }), due({ id: 'ok', messageId: 'm-ok', sessionId: 'B' })],
    prompt: (request, signal) => {
      seen.push(request.requestId)
      if (request.requestId === 'm-hung') {
        hungSignal = signal
        return new Promise(() => {})
      }
      return Promise.resolve({ accepted: true })
    },
  })
  await until(() => seen.includes('m-ok'), 10000)
  assert.ok(seen.includes('m-ok'), 'the item behind the hung one was delivered')
  assert.equal(hungSignal.aborted, true, 'the hung call was aborted')
  assert.equal((await h.call('list', { sessionId: 'A' })).value.queue.length, 1, 'the hung item stays queued for a retry')
})

test('remove and edit refuse an item that is being sent, and no retry state is kept for a delivered one', async () => {
  let release
  const h = await boot({
    items: [due({ id: 'k' })],
    prompt: () => new Promise((resolve) => (release = () => resolve({ accepted: true }))),
  })
  await until(() => release !== undefined)
  const removed = await h.call('remove', { id: 'k', sessionId: 'A' })
  assert.equal(removed.ok, false)
  assert.equal(removed.error.code, 'being-sent')
  assert.equal((await h.call('edit', { id: 'k', sessionId: 'A', text: 'changed' })).error.code, 'being-sent')
  assert.equal((await h.call('sendNow', { id: 'k', sessionId: 'A' })).error.code, 'being-sent')
  release()
  await until(() => h.logs.length > 0 && true)
  await sleep(300)
  assert.equal((await h.call('list', { sessionId: 'A' })).value.queue.length, 0)
})

test('a queue file that cannot be read is not overwritten', async () => {
  const h = await boot({
    prompt: async () => {},
    // A directory where the file should be: readFile fails with EISDIR, not ENOENT.
    prepare: (file) => mkdir(file, { recursive: true }),
  })
  const made = await h.call('schedule', { sessionId: 'A', text: 'in memory only', minutes: 5 })
  assert.equal(made.ok, true, 'the in-memory queue keeps working')
  assert.equal((await stat(h.file)).isDirectory(), true, 'the unreadable path was left alone')
  assert.ok(h.logs.some((l) => l.startsWith('error') && l.includes('could not read')))
})
