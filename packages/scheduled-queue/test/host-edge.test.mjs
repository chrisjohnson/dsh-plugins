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
  const mine = []
  const scope = {
    connection: { fetch: { register: (route) => routes.set(route.path, route) } },
    sessionController: { prompt },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') {
        disposers.push(dispose)
        mine.push(dispose)
      }
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
  return { call, file, logs, dispose: () => mine.forEach((d) => d()) }
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

const readQueue = async (file) => JSON.parse(await readFile(file, 'utf8'))

test('an item removed, edited or sent while an earlier delivery is in flight is not sent stale', async () => {
  const sent = []
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const t = Date.now()
  const h = await boot({
    config: { deliveryTimeoutMs: 20000 },
    items: [
      due({ id: 'slow', messageId: 'mslow', text: 'slow', dueAt: t - 9000 }),
      due({ id: 'rm', messageId: 'mrm', text: 'removed me', dueAt: t - 8000 }),
      due({ id: 'ed', messageId: 'med', text: 'old text', dueAt: t - 7000 }),
      due({ id: 'sn', messageId: 'msn', text: 'sendnow', dueAt: t - 6000 }),
    ],
    prompt: async (request) => {
      sent.push(`${request.requestId}:${request.content[0].text}`)
      if (request.requestId === 'mslow') await gate
      return { accepted: true }
    },
  })
  await until(() => sent.length > 0)
  assert.equal((await h.call('remove', { id: 'rm', sessionId: 'A' })).value.removed, true)
  assert.equal((await h.call('edit', { id: 'ed', sessionId: 'A', text: 'NEW text', minutes: 30 })).ok, true)
  const now = h.call('sendNow', { id: 'sn', sessionId: 'A' })
  await sleep(200)
  release()
  assert.equal((await now).value.outcome, 'delivered')
  await sleep(1500)
  assert.deepEqual(sent.sort(), ['mslow:slow', 'msn:sendnow'], 'nothing removed, edited-away or already sent went out again')
  const left = await readQueue(h.file)
  assert.deepEqual(left.map((i) => `${i.id}:${i.text}`), ['ed:NEW text'], 'the edit was kept, and it is no longer due')
  h.dispose()
})

test('a disposed plugin neither prompts nor writes the file', async () => {
  const sent = []
  const t = Date.now()
  const h = await boot({
    items: [due({ id: 'd1', messageId: 'm1', dueAt: t - 2000 }), due({ id: 'd2', messageId: 'm2', dueAt: t - 1000 })],
    prompt: async (request, signal) => {
      sent.push(request.requestId)
      await new Promise((resolve, reject) => {
        const end = setTimeout(resolve, 1500)
        signal.addEventListener('abort', () => (clearTimeout(end), reject(signal.reason)))
      })
      return { accepted: true }
    },
  })
  await until(() => sent.length > 0)
  const before = await readFile(h.file, 'utf8')
  h.dispose()
  await sleep(4000)
  assert.deepEqual(sent, ['m1'], 'the second item was never prompted')
  assert.equal(await readFile(h.file, 'utf8'), before, 'the file was not written after dispose')
})

test('a refused time zone is retried once without it', async () => {
  const requests = []
  const h = await boot({
    items: [due({ timeZone: 'Europe/Berlin' })],
    prompt: async (request) => {
      requests.push(request)
      if (request.clientTimeZone !== undefined) throw Object.assign(new Error('bad zone'), { code: 'session/invalid-time-zone' })
    },
  })
  await until(() => requests.length >= 2)
  await sleep(200)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].clientTimeZone, 'Europe/Berlin')
  assert.equal('clientTimeZone' in requests[1], false)
  assert.equal((await h.call('list', { sessionId: 'A' })).value.queue.length, 0)
})

test('scheduling while the file is unreadable warns, and recovery does not resurrect settled items', async () => {
  const sent = []
  const h = await boot({
    prompt: async (request) => sent.push(request.requestId),
    prepare: (file) => mkdir(file, { recursive: true }),
  })
  const made = await h.call('schedule', { sessionId: 'A', text: 'kept in memory', minutes: 5 })
  assert.equal(made.ok, true)
  assert.match(made.value.warning, /not being saved/)
  assert.match((await h.call('list', { sessionId: 'A' })).value.warning, /not being saved/)
  // Make the file readable: an old copy still holding an item that was since removed.
  const { rm } = await import('node:fs/promises')
  const doomed = due({ id: 'old', messageId: 'mold', dueAt: Date.now() + 3_600_000 })
  const kept = later({ id: 'file-only' })
  await rm(h.file, { recursive: true })
  const id = made.value.id
  await writeFile(h.file, JSON.stringify([doomed, kept, later({ id })]))
  assert.equal((await h.call('remove', { id, sessionId: 'A' })).value.removed, true)
  await sleep(1600)
  const queued = (await h.call('list', { sessionId: 'A' })).value
  assert.deepEqual(queued.queue.map((i) => i.id).sort(), ['file-only', 'old'])
  assert.equal(queued.warning, undefined)
  assert.ok(!(await readQueue(h.file)).some((i) => i.id === id), 'the removed item did not come back')
  h.dispose()
})
