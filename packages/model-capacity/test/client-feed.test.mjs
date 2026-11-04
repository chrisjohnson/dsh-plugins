// The browser half is a classic script, so it is loaded the way the client
// loader loads it (window.__ModuleLoader__.load) against stubs: a manual timer
// wheel, a controllable streaming fetch, a fake document with a visibility flag,
// and a fake React that is just enough to subscribe to the shared store. What is
// checked is the transport contract: one long-lived stream while anything is
// shown, nothing while the tab is hidden, and a slow poll only when the stream
// cannot be held.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/client.mjs', import.meta.url), 'utf8')

function snapshot(extra = {}) {
  return { enabled: true, asOf: 1, totals: { active: 0, waiting: 0 }, rates: { instant: 0, avg1m: 0, avg5m: 0, avg1h: 0, totalTokens: 0 }, waitSeq: 0, providers: [], ...extra }
}

function load() {
  let now = 0
  let seq = 0
  const timers = new Map()
  const listeners = []
  const doc = {
    hidden: false,
    addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.push(fn) },
    removeEventListener: () => {},
    getElementById: () => ({}),
    createElement: () => ({ appendChild() {} }),
    head: { appendChild() {} },
  }
  const streams = []
  const rpcCalls = []
  const fetchCalls = []
  const env = { fetchMode: 'stream' }
  const fetchImpl = (url, init) => {
    fetchCalls.push({ url, init })
    if (env.fetchMode === 'fail') return Promise.resolve({ ok: false, status: 502 })
    let pushChunk
    let finish
    const queue = []
    const waiting = []
    const stream = {
      aborted: false,
      send(text) { const item = { done: false, value: new TextEncoder().encode(text) }; if (waiting.length) waiting.shift()(item); else queue.push(item) },
      end() { const item = { done: true }; if (waiting.length) waiting.shift()(item); else queue.push(item) },
    }
    init.signal.addEventListener?.('abort', () => { stream.aborted = true })
    streams.push(stream)
    return Promise.resolve({
      ok: true,
      body: { getReader: () => ({ read: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiting.push(resolve))) }) },
    })
  }
  const window = {
    fetch: fetchImpl,
    setTimeout: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: now + ms, every: null }); return seq },
    setInterval: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: now + ms, every: ms }); return seq },
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    matchMedia: () => ({ matches: false }),
  }
  window.window = window
  const stores = []
  const React = {
    createElement: () => null,
    useSyncExternalStore: (subscribe, get) => { stores.push({ subscribe, get }); return get() },
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useLayoutEffect: () => {},
    Fragment: 'Fragment',
  }
  let factory
  const context = vm.createContext({
    window, document: doc, console, AbortController, TextDecoder, Promise, Object, Array, Math, JSON, Date, Set, Number, String, isFinite,
  })
  window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
  context.window = window
  vm.runInContext(source, context)
  const mod = factory((name) => { if (name === 'react') return React; throw new Error(name) })
  const registered = {}
  const connection = {
    rpc: {
      call: (channel, endpoint, payload) => {
        rpcCalls.push(endpoint)
        return Promise.resolve({ ok: true, value: snapshot({ asOf: rpcCalls.length }) })
      },
    },
  }
  const slots = {
    inject: (name, cb) => { cb(); return () => {} },
    register: (meta, component) => { registered[meta.name] = component; return () => {} },
  }
  mod.apply({ connection, slots, effect: (fn) => { fn() }, get: () => undefined })
  const advance = (ms) => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      const [id, t] = due
      now = Math.max(now, t.at)
      if (t.every !== null) t.at += t.every
      else timers.delete(id)
      t.fn()
    }
    now = target
  }
  const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }
  /** Render a component once so it registers with the store, then subscribe like React would. */
  const mount = (name, props = {}) => {
    const before = stores.length
    registered[name](props)
    return stores.slice(before).map((store) => store.subscribe(() => {}))
  }
  const state = () => stores.at(-1).get()
  return { state, env, streams, rpcCalls, fetchCalls, timers, doc, listeners, advance, flush, mount, registered }
}

const frame = (extra) => JSON.stringify(snapshot(extra)) + '\n'

test('showing the panel opens one long-lived stream and no polling', async () => {
  const t = load()
  t.mount('sidebar.panellist')
  await t.flush()
  assert.equal(t.fetchCalls.length, 1)
  assert.match(t.fetchCalls[0].url, /\/api\/modelCapacity\/stream$/)
  assert.equal(t.fetchCalls[0].init.method, 'POST')
  for (let i = 0; i < 12; i += 1) {
    t.streams[0].send(frame())
    await t.flush()
    t.advance(5000)
  }
  assert.equal(t.rpcCalls.length, 0, 'no snapshot polling while the stream is up')
  assert.equal(t.fetchCalls.length, 1)
})

test('every component shares the one stream, and the last one to leave closes it', async () => {
  const t = load()
  const a = t.mount('sidebar.panellist')
  const b = t.mount('conversation.input.dock', { sessionId: 's' })
  const c = t.mount('main')
  await t.flush()
  assert.equal(t.fetchCalls.length, 1)
  a.forEach((off) => off())
  b.forEach((off) => off())
  assert.equal(t.streams[0].aborted, false)
  c.forEach((off) => off())
  assert.equal(t.streams[0].aborted, true)
  assert.equal(t.timers.size, 0, 'no timer survives the last subscriber')
})

test('frames split across reads are reassembled and a malformed line is skipped', async () => {
  const t = load()
  t.mount('sidebar.panellist')
  await t.flush()
  assert.equal(t.state().snapshot, null)
  const text = frame({ rates: { instant: 42, avg1m: 1, avg5m: 1, avg1h: 1, totalTokens: 9 } })
  t.streams[0].send(text.slice(0, 30))
  await t.flush()
  assert.equal(t.state().snapshot, null, 'half a frame shows nothing')
  t.streams[0].send(text.slice(30) + 'not json\n' + frame({ waitSeq: 3 }))
  await t.flush()
  assert.equal(t.state().snapshot.waitSeq, 3)
  // The frame is the whole story now: the per-provider graph series arrives inside
  // it, so the feed keeps no client-side accumulation of its own.
  assert.equal('history' in t.state(), false)
  t.streams[0].send(frame().repeat(200))
  await t.flush()
  assert.equal(t.rpcCalls.length, 0)
})

test('a hidden tab holds no stream and no timer; becoming visible reopens it', async () => {
  const t = load()
  t.mount('main')
  await t.flush()
  t.streams[0].send(frame())
  await t.flush()
  t.doc.hidden = true
  t.listeners.forEach((fn) => fn())
  assert.equal(t.streams[0].aborted, true)
  assert.equal(t.timers.size, 0)
  t.advance(120_000)
  assert.equal(t.fetchCalls.length, 1)
  assert.equal(t.rpcCalls.length, 0)
  t.doc.hidden = false
  t.listeners.forEach((fn) => fn())
  await t.flush()
  assert.equal(t.fetchCalls.length, 2)
})

test('a tab that starts hidden opens nothing until it is shown', async () => {
  const t = load()
  t.doc.hidden = true
  t.mount('main')
  await t.flush()
  t.advance(30_000)
  assert.equal(t.fetchCalls.length, 0)
  assert.equal(t.rpcCalls.length, 0)
})

test('when the stream cannot be held the page falls back to a 2 s snapshot poll and retries the stream with back-off', async () => {
  const t = load()
  t.env.fetchMode = 'fail'
  t.mount('main')
  await t.flush()
  assert.equal(t.fetchCalls.length, 1)
  assert.equal(t.rpcCalls.length, 1, 'one snapshot straight away')
  t.advance(2000)
  await t.flush()
  assert.equal(t.rpcCalls.length, 2)
  t.advance(2000)
  await t.flush()
  assert.equal(t.rpcCalls.length, 3)
  // The first retry comes after the back-off delay, not on every poll.
  assert.ok(t.fetchCalls.length <= 2)
  t.env.fetchMode = 'stream'
  t.advance(30_000)
  await t.flush()
  assert.ok(t.streams.length >= 1, 'the stream was retried once the Host allowed it')
  const polledBefore = t.rpcCalls.length
  t.streams.at(-1).send(frame())
  await t.flush()
  t.advance(10_000)
  assert.equal(t.rpcCalls.length, polledBefore, 'polling stops once a frame arrives on the stream')
})

test('a stream that goes silent past the keep-alive is abandoned and the poll takes over', async () => {
  const t = load()
  t.mount('main')
  await t.flush()
  t.streams[0].send(frame())
  await t.flush()
  t.advance(21_000)
  await t.flush()
  assert.equal(t.streams[0].aborted, true)
  assert.ok(t.rpcCalls.length >= 1)
})

test('a stream that ends is treated as a failure and recovers', async () => {
  const t = load()
  t.mount('main')
  await t.flush()
  t.streams[0].send(frame())
  t.streams[0].end()
  await t.flush()
  assert.ok(t.rpcCalls.length >= 1, 'polls while the stream is down')
})
