// The browser half is a classic script, so it is loaded the way the client loader
// loads it (window.__ModuleLoader__.load) against stubs: a manual timer wheel, a
// controllable streaming fetch, a fake document with a visibility flag and a fake
// React that is just enough to subscribe to the shared stores. What is checked is
// the transport contract (one stream while a board is shown, nothing while the
// tab is hidden, a slow backed-off ask only when the stream cannot be held) and
// what the store does with what arrives (stale boards dropped, unchanged cards
// kept, drops held back).

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/client.mjs', import.meta.url), 'utf8')

const card = (id, extra = {}) => ({ id, key: id.toUpperCase(), title: id, column: 'backlog', status: 'idle', workingMs: 0, totalMs: 1, ...extra })
function board(seq, cards = {}, extra = {}) {
  return {
    compact: true, seq, boot: 'b1', token: `t${seq}`, asOf: seq,
    counts: { backlog: 0, working: 0, done: 0, discarded: 0 },
    columns: { backlog: cards.backlog ?? [], working: cards.working ?? [] },
    closed: cards.closed ?? [],
    ...extra,
  }
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
  const env = { fetchMode: 'stream', rpcReply: () => ({ ok: true, value: { unchanged: true } }) }
  const fetchImpl = (url, init) => {
    fetchCalls.push({ url, init })
    if (env.fetchMode === 'fail') return Promise.resolve({ ok: false, status: 502 })
    const queue = []
    const waiting = []
    const stream = {
      aborted: false,
      send(text) { const item = { done: false, value: new TextEncoder().encode(text) }; if (waiting.length) waiting.shift()(item); else queue.push(item) },
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
    useMemo: (fn) => fn(),
    useLayoutEffect: () => {},
    memo: (component) => component,
    Fragment: 'Fragment',
  }
  let factory
  const context = vm.createContext({
    window, document: doc, console, AbortController, TextDecoder, Promise, Object, Array, Math, JSON, Date, Set, Number, String, WeakMap, isFinite,
  })
  window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
  context.window = window
  vm.runInContext(source, context)
  const mod = factory((name) => { if (name === 'react') return React; throw new Error(name) })
  const registered = {}
  const connection = {
    rpc: {
      call: (channel, endpoint, payload) => {
        rpcCalls.push({ endpoint, payload })
        return Promise.resolve(env.rpcReply(endpoint, payload))
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
  /** Render the sidebar icon once so it subscribes to the shared board, then subscribe like React would. */
  const mount = () => {
    const before = stores.length
    registered['sidebar.panellist']({})
    return stores.slice(before).map((s) => s.subscribe(() => {}))
  }
  const state = () => stores.at(-1).get()
  return { state, env, streams, rpcCalls, fetchCalls, timers, doc, listeners, advance, flush, mount, registered, stores }
}

const line = (frame) => JSON.stringify(frame) + '\n'

test('showing the board opens one long-lived stream and asks for nothing else', async () => {
  const t = load()
  t.mount()
  await t.flush()
  assert.equal(t.fetchCalls.length, 1)
  assert.match(t.fetchCalls[0].url, /\/api\/kanban\/stream$/)
  for (let i = 1; i <= 10; i += 1) {
    t.streams[0].send(line(board(i, { backlog: [card('a')] })))
    await t.flush()
    t.advance(5000)
  }
  assert.equal(t.rpcCalls.length, 0, 'no board asked for while the stream is up')
  assert.equal(t.fetchCalls.length, 1)
  assert.equal(t.state().mode, 'stream')
})

test('the icon and the page share the one stream, and the last to leave closes it', async () => {
  const t = load()
  const a = t.mount()
  const b = t.mount()
  await t.flush()
  assert.equal(t.fetchCalls.length, 1)
  a.forEach((off) => off())
  assert.equal(t.streams[0].aborted, false)
  b.forEach((off) => off())
  assert.equal(t.streams[0].aborted, true)
  assert.equal(t.timers.size, 0, 'no timer survives the last subscriber')
})

test('a hidden tab holds no stream, no timer and asks for nothing; showing it again reopens the stream', async () => {
  const t = load()
  t.mount()
  await t.flush()
  t.streams[0].send(line(board(1)))
  await t.flush()
  t.doc.hidden = true
  t.listeners.forEach((fn) => fn())
  assert.equal(t.streams[0].aborted, true)
  assert.equal(t.timers.size, 0)
  t.advance(300_000)
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
  t.mount()
  await t.flush()
  t.advance(60_000)
  assert.equal(t.fetchCalls.length, 0)
  assert.equal(t.rpcCalls.length, 0)
})

test('frames split across reads are reassembled and a malformed line is skipped', async () => {
  const t = load()
  t.mount()
  await t.flush()
  const text = line(board(1, { backlog: [card('a')] }))
  t.streams[0].send(text.slice(0, 40))
  await t.flush()
  assert.equal(t.state().board, null, 'half a frame shows nothing')
  t.streams[0].send(text.slice(40) + 'not json\n' + line(board(2, { backlog: [card('a'), card('b')] })))
  await t.flush()
  assert.deepEqual(t.state().board.columns.backlog.map((c) => c.id), ['a', 'b'])
})

test('a compact board is read per column as well as in the closed list', async () => {
  const t = load()
  t.mount()
  await t.flush()
  const closed = [card('d', { column: 'done', status: 'idle' }), card('x', { column: 'discarded' })]
  t.streams[0].send(line(board(1, { backlog: [card('a', { status: 'attention' })], working: [card('w', { status: 'active' }), card('w2', { status: 'active' })], closed })))
  await t.flush()
  const shown = t.state().board
  assert.deepEqual(shown.columns.done.map((c) => c.id), ['d'])
  assert.deepEqual(shown.columns.discarded.map((c) => c.id), ['x'])
  assert.deepEqual(shown.closed.map((c) => c.id), ['d', 'x'])
})

test('a card that said the same thing keeps its identity, and so does an unchanged list', async () => {
  const t = load()
  t.mount()
  await t.flush()
  t.streams[0].send(line(board(1, { backlog: [card('a'), card('b')] })))
  await t.flush()
  const first = t.state().board
  t.streams[0].send(line(board(2, { backlog: [card('a', { totalMs: 99 }), card('b', { status: 'attention' })] })))
  await t.flush()
  const second = t.state().board
  assert.equal(second.columns.backlog[0], first.columns.backlog[0], 'only its age moved: same object')
  assert.notEqual(second.columns.backlog[1], first.columns.backlog[1], 'it turned to attention: new object')
  t.streams[0].send(line(board(3, { backlog: [card('a'), card('b', { status: 'attention' })] })))
  await t.flush()
  assert.equal(t.state().board.columns.backlog, second.columns.backlog, 'nothing changed: the very same list')
})

test('a board older than the one shown is dropped; a new run of the host starts over', async () => {
  const t = load()
  t.mount()
  await t.flush()
  t.streams[0].send(line(board(5, { backlog: [card('new')] })))
  await t.flush()
  t.streams[0].send(line(board(4, { backlog: [card('old')] })))
  await t.flush()
  assert.deepEqual(t.state().board.columns.backlog.map((c) => c.id), ['new'])
  t.streams[0].send(line(board(1, { backlog: [card('rebooted')] }, { boot: 'b2' })))
  await t.flush()
  assert.deepEqual(t.state().board.columns.backlog.map((c) => c.id), ['rebooted'], 'a restart resets the counter')
})

test('a token-only frame moves the token and leaves the board alone', async () => {
  const t = load()
  t.mount()
  await t.flush()
  t.streams[0].send(line(board(1, { backlog: [card('a')] })))
  await t.flush()
  const before = t.state().board
  t.streams[0].send(line({ token: 'later' }))
  await t.flush()
  assert.equal(t.state().token, 'later')
  assert.equal(t.state().board, before)
})

const boardAsks = (t) => t.rpcCalls.filter((c) => c.endpoint.endsWith('board'))

test('the stream falling over drops to asking with the last token, backing off while nothing changes', async () => {
  const t = load()
  t.env.fetchMode = 'fail'
  t.mount()
  await t.flush()
  assert.equal(t.state().mode, 'poll')
  assert.equal(boardAsks(t).length, 1)
  assert.equal(boardAsks(t)[0].payload.compact, true)
  const times = []
  let seen = 1
  for (let ms = 0; ms < 200_000; ms += 500) {
    t.advance(500)
    await t.flush()
    if (boardAsks(t).length > seen) { seen = boardAsks(t).length; times.push(ms) }
  }
  const gaps = times.slice(1).map((at, i) => at - times[i])
  assert.deepEqual(gaps.slice(0, 2), [3000, 3000], 'a few quick asks first')
  assert.ok(gaps[4] > gaps[2] && gaps[2] >= gaps[1], 'then it slows down')
  assert.ok(Math.max(...gaps) <= 30_500, 'but never past thirty seconds')
})

/** Drive the poll with a scripted run of answers: 'ok' (a changed board), 'same' (unchanged), 'down' (rejects). */
async function scripted(steps) {
  const t = load()
  t.env.fetchMode = 'fail'
  let n = 0
  t.env.rpcReply = (endpoint, payload) => {
    const step = steps[Math.min(n, steps.length - 1)]
    n += 1
    if (step === 'down') return Promise.reject(new Error('down'))
    if (step === 'same') return { ok: true, value: { unchanged: true, token: payload.since } }
    return { ok: true, value: board(n, { backlog: [card('a')] }) }
  }
  t.mount()
  await t.flush()
  const next = async () => {
    const before = boardAsks(t).length
    for (let ms = 0; ms < 40_000 && boardAsks(t).length === before; ms += 250) { t.advance(250); await t.flush() }
  }
  return { t, next }
}

test('one failed ask shows nothing; the second in a row shows the banner; the next success clears it', async () => {
  const { t, next } = await scripted(['ok', 'down', 'down', 'ok'])
  assert.equal(t.state().error, null)
  await next()
  assert.equal(t.state().error, null, 'a single dropped request is not worth a banner')
  await next()
  assert.equal(t.state().error, 'Could not reach the Host.', 'two in a row is')
  await next()
  assert.equal(t.state().error, null, 'and the first success takes it down again, whatever else happened')
})

test('a failure between two successes never shows', async () => {
  const { t, next } = await scripted(['ok', 'down', 'ok', 'down', 'ok'])
  for (let i = 0; i < 4; i += 1) { await next(); assert.equal(t.state().error, null) }
})

test('the asking slows with each failure and starts over after a change', async () => {
  const { t, next } = await scripted(['ok', 'down', 'down', 'down', 'down', 'ok', 'down'])
  const gaps = []
  const clockAt = async () => { let elapsed = 0; const before = boardAsks(t).length; for (; boardAsks(t).length === before; elapsed += 250) { t.advance(250); await t.flush() } return elapsed }
  void next
  for (let i = 0; i < 6; i += 1) gaps.push(await clockAt())
  assert.ok(gaps[1] >= gaps[0], 'failures do not speed it up')
  assert.ok(gaps[4] > gaps[0], 'a down host is asked less and less often')
  assert.ok(gaps[5] < gaps[4], 'and the success that follows starts the pace over')
})

test('a banner set by a poll goes when a poll works, wherever the person had clicked in between', async () => {
  const { t, next } = await scripted(['ok', 'down', 'down', 'down', 'same'])
  await next(); await next()
  assert.equal(t.state().error, 'Could not reach the Host.')
  await next()
  assert.equal(t.state().error, 'Could not reach the Host.', 'still down')
  await next()
  assert.equal(t.state().error, null, 'an unchanged answer is a working host too')
})

test('the page keeps what a poll said apart from what an action said', async () => {
  const src = readFileSync(new URL('../src/client.mjs', import.meta.url), 'utf8')
  const page = src.slice(src.indexOf('function KanbanPage()'), src.indexOf('PhaseBanner'))
  assert.match(page, /notice \|\| live\.error \|\| detailProblem/, 'three sources, one banner')
  assert.match(page, /else if \(asked === true\) setNotice\(null\)/, 'the Refresh button clears the banner when the reload works')
  assert.match(page, /onClick: function \(\) \{ loadBoard\(true\); \}, children: "Refresh"/)
  assert.match(page, /React\.useEffect\(function \(\) \{\s*setNotice\(null\);[\s\S]*?\}, \[selectedId, view\]\);/, 'moving to another ticket or view clears it')
  assert.match(page, /detailPollOk\(\);/)
  assert.match(page, /if \(detailFailures\.current >= POLL_FAILURES_SHOWN\) setDetailProblem\(text\)/)
  // KAN-73 round 2: the orchestrator actions moved out of this page into the tray,
  // so "a working action clears the banner" is the status store's rule now, not a
  // setNotice call in a header handler. Same invariant, one level up: the page
  // folds the store into the one banner, and a successful action empties it.
  assert.match(page, /notice \|\| live\.error \|\| detailProblem \|\| orchNews\.text/, 'the orchestrator status shares the one banner')
  const pause = src.slice(src.indexOf('function orchSetPaused('), src.indexOf('function PauseIcon()'))
  assert.match(pause, /orchStatus\.clear\(\);/, 'a working action still clears an action error')
  assert.match(pause, /orchStatus\.set\(res && res\.error \? res\.error\.message : "That did not work\.", "err"\)/, 'and a failed one says so')
})

test('an unchanged answer keeps the board and the ask carries the last token', async () => {
  const t = load()
  t.env.fetchMode = 'fail'
  let n = 0
  t.env.rpcReply = (endpoint, payload) => {
    n += 1
    if (n === 1) return { ok: true, value: board(1, { backlog: [card('a')] }) }
    return { ok: true, value: { unchanged: true, token: payload.since } }
  }
  t.mount()
  await t.flush()
  assert.equal(t.state().token, 't1')
  const shown = t.state().board
  t.advance(3000)
  await t.flush()
  assert.equal(boardAsks(t)[1].payload.since, 't1', 'the second ask carries the token of the first answer')
  assert.equal(t.state().board, shown, 'unchanged leaves the very same board')
})

