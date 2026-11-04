// The Host's cheap answers, driven through the routes it registers: an
// "unchanged" board and ticket, the compact board, the lean ticket, and the push
// stream. Needs the dsh peer packages (the host imports the driver); skips on a
// bare clone.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'

let kanban
try {
  await import('@deepseek-ai/dsh-llm')
  await import('@deepseek-ai/dsh-tools')
  await import('@deepseek-ai/dsh-sandbox-policy')
  kanban = (await import('../src/host.mjs')).default
} catch {
  kanban = undefined
}
const skip = kanban === undefined ? 'dsh peer packages are not installed' : false
const LOG = { info() {}, warn() {}, error() {}, debug() {} }

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-host-perf-'))
  const dbPath = join(dir, 'kanban.db')
  const routes = new Map()
  const disposers = []
  const ctx = {
    logger: () => LOG,
    get(name) {
      if (name === 'llm') return { listProviders: () => [{ id: 'local' }], listModels: async () => [], resolveModelInfo: async () => null }
      return undefined
    },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    on: () => () => {},
    inject(_deps, callback) {
      callback({ connection: { fetch: { register: (definition) => routes.set(definition.path, definition.fetch) } } })
    },
  }
  const roles = Object.fromEntries(['planner', 'implementer', 'reviewer', 'approver'].map((r) => [r, { provider: 'local', model: 'm' }]))
  await kanban(ctx, { dbPath, providers: [{ name: 'local' }], roles, tickIntervalMs: 3_600_000 })
  const rpc = async (endpoint, payload = {}) => {
    const route = routes.get(`/api/kanban/${endpoint}`)
    assert.ok(route, `no route for ${endpoint}`)
    return (await route({ json: async () => payload })).json()
  }
  const store = new KanbanStore(openDatabase(dbPath))
  const stop = () => disposers.forEach((d) => d())
  return { rpc, store, routes, stop }
}

async function seed(rpc, store) {
  const ids = {}
  for (const [name, column] of [['a', 'backlog'], ['b', 'backlog'], ['c', 'backlog']]) {
    ids[name] = (await rpc('create', { title: `ticket ${name}`, body: `body ${name}`, column })).value.ticket.id
  }
  store.db.prepare("UPDATE tickets SET col = 'done', phase = 'closed', closed_at = ? WHERE id = ?").run(new Date().toISOString(), ids.c)
  return ids
}

test('a board asked with its own token is answered "unchanged", and a write makes it whole again', { skip }, async () => {
  const { rpc, store, stop } = await boot()
  const ids = await seed(rpc, store)
  const first = (await rpc('board')).value
  assert.ok(first.token && first.seq >= 1 && first.boot)
  assert.equal(first.columns.backlog.length, 2)

  const same = (await rpc('board', { since: first.token })).value
  assert.deepEqual(same, { unchanged: true, token: first.token })

  store.setNeedsAttention(ids.a, 'stuck')
  const next = (await rpc('board', { since: first.token })).value
  assert.equal(next.unchanged, undefined)
  assert.notEqual(next.token, first.token)
  assert.equal(next.columns.backlog.find((c) => c.id === ids.a).status, 'attention')
  assert.ok(next.seq > first.seq)
  assert.deepEqual((await rpc('board', { since: next.token })).value, { unchanged: true, token: next.token })
  stop()
})

test('the compact board holds Done and Discarded once, and the plain board is as it always was', { skip }, async () => {
  const { rpc, store, stop } = await boot()
  const ids = await seed(rpc, store)
  const plain = (await rpc('board')).value
  assert.deepEqual(plain.columns.done.map((c) => c.id), [ids.c])
  assert.deepEqual(plain.closed.map((c) => c.id), [ids.c])
  assert.equal(plain.compact, undefined)
  const compact = (await rpc('board', { compact: true })).value
  assert.equal(compact.compact, true)
  assert.equal('done' in compact.columns, false)
  assert.deepEqual(compact.closed.map((c) => c.id), [ids.c])
  const noClock = (list) => list.map(({ totalMs, ...rest }) => { void totalMs; return rest })
  assert.deepEqual(noClock(compact.columns.backlog), noClock(plain.columns.backlog))
  stop()
})

test('a ticket asked with its own token is answered "unchanged" until something about it changes', { skip }, async () => {
  const { rpc, store, stop } = await boot()
  const ids = await seed(rpc, store)
  const first = (await rpc('ticket', { id: ids.a })).value
  assert.ok(first.token)
  assert.deepEqual((await rpc('ticket', { id: ids.a, since: first.token })).value, { unchanged: true, token: first.token })
  store.setNeedsAttention(ids.a, 'stuck')
  const next = (await rpc('ticket', { id: ids.a, since: first.token })).value
  assert.equal(next.unchanged, undefined)
  assert.equal(next.ticket.needsAttentionReason, 'stuck')
  assert.notEqual(next.token, first.token)
  stop()
})

test('a ticket asked without events leaves the lifecycle log out; the default still carries it', { skip }, async () => {
  const { rpc, store, stop } = await boot()
  const ids = await seed(rpc, store)
  for (let i = 0; i < 30; i += 1) store.appendEvent(ids.a, 'note', { payload: { i } })
  const full = (await rpc('ticket', { id: ids.a })).value
  const lean = (await rpc('ticket', { id: ids.a, events: false })).value
  assert.ok(full.events.length >= 30)
  assert.equal('events' in lean, false)
  const { events, token, ...fullRest } = full
  const { token: leanToken, ...leanRest } = lean
  void events; void token; void leanToken
  assert.deepEqual(leanRest, fullRest, 'everything else is the same')
  assert.equal(JSON.stringify((await rpc('events', { id: ids.a, limit: 300 })).value), JSON.stringify(events), 'and the events endpoint serves the log')
  stop()
})

test('the ticket payload no longer carries the span tree or a second copy of every artifact', { skip }, async () => {
  const { rpc, store, stop } = await boot()
  const ids = await seed(rpc, store)
  const span = store.startSpan({ ticketId: ids.a, kind: 'judge', name: 'judge', role: 'reviewer' })
  store.addArtifact(ids.a, 'review', '{"verdict":"pass"}', { spanId: span.id })
  store.endSpan(span.id, { status: 'ok' })
  const shown = (await rpc('ticket', { id: ids.a })).value
  assert.equal('spanTree' in shown, false)
  assert.equal('artifacts' in shown, false)
  const step = shown.timeline.find((item) => item.kind === 'judge')
  assert.equal(step.artifacts[0].content, '{"verdict":"pass"}', 'the artifact is still on its timeline step')
  assert.equal(shown.spans.length, 1)
  stop()
})

test('the stream opens with the board, pushes a change, and lets go when the reader does', { skip }, async () => {
  // The feed's one-second token tick is unref'd on purpose — a board feed must
  // never be what keeps a process alive — so an await here would otherwise let the
  // event loop drain before the tick that carries the change. Keep the loop ref'd
  // for the length of this test only.
  const keepAlive = setInterval(() => {}, 250)
  try {
    const { routes, rpc, store, stop } = await boot()
    const ids = await seed(rpc, store)
    const controller = new AbortController()
    const response = await routes.get('/api/kanban/stream')({ signal: controller.signal })
    assert.match(response.headers.get('content-type'), /ndjson/)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const nextFrame = async () => {
      for (;;) {
        const cut = buffer.indexOf('\n')
        if (cut >= 0) { const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1); return JSON.parse(line) }
        const chunk = await reader.read()
        if (chunk.done) return null
        buffer += decoder.decode(chunk.value, { stream: true })
      }
    }
    const first = await nextFrame()
    assert.equal(first.compact, true)
    assert.equal(first.columns.backlog.length, 2)
    store.setNeedsAttention(ids.b, 'stuck')
    const second = await nextFrame()
    assert.equal(second.columns.backlog.find((c) => c.id === ids.b).status, 'attention')
    assert.notEqual(second.token, first.token)
    assert.ok(second.seq > first.seq)
    controller.abort()
    assert.equal((await nextFrame()), null, 'the response ends')
    stop()
  } finally {
    clearInterval(keepAlive)
  }
})
