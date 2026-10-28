import test from 'node:test'
import assert from 'node:assert/strict'

import { createBrowserPool } from '../src/pool.mjs'
import { createBackends, quietLog } from './fakes.mjs'

const VIEWPORT = { viewport: { width: 1024, height: 768 } }

function poolFor(backends, extra = {}) {
  return createBrowserPool({
    connectRemote: backends.connectRemote,
    launchLocal: backends.launchLocal,
    log: quietLog,
    ...extra,
  })
}

test('many sessions share one remote connection, one context each', async () => {
  const backends = createBackends()
  const pool = poolFor(backends)
  const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((id) => pool.acquire(id, VIEWPORT)))
  assert.equal(backends.remoteConnects, 1)
  assert.equal(backends.localLaunches, 0)
  assert.equal(backends.remotes[0].contexts.length, 3)
  assert.equal(new Set([a.context, b.context, c.context]).size, 3)
  assert.deepEqual([a.kind, b.kind, c.kind], ['remote', 'remote', 'remote'])
  assert.deepEqual(pool.stats(), { remoteConnected: true, localConnected: false, contexts: 3, sessions: ['a', 'b', 'c'] })
})

test('contexts are created lazily and the session keeps the same one', async () => {
  const backends = createBackends()
  const pool = poolFor(backends)
  assert.equal(backends.remoteConnects, 0)
  const first = await pool.acquire('a', VIEWPORT)
  const second = await pool.acquire('a', VIEWPORT)
  assert.equal(first.context, second.context)
  assert.deepEqual(first.context.options, VIEWPORT)
  assert.equal(backends.remotes[0].contexts.length, 1)
})

test('concurrent first calls for one session share a single context', async () => {
  const backends = createBackends()
  const pool = poolFor(backends)
  const [x, y] = await Promise.all([pool.acquire('a', VIEWPORT), pool.acquire('a', VIEWPORT)])
  assert.equal(x.context, y.context)
  assert.equal(backends.remotes[0].contexts.length, 1)
})

test('a disconnect drops the browser and every context; the next acquire reconnects', async () => {
  const backends = createBackends()
  const pool = poolFor(backends)
  const lost = []
  pool.onLost((kind, sessions) => lost.push([kind, sessions]))
  const before = await pool.acquire('a', VIEWPORT)
  await pool.acquire('b', VIEWPORT)

  await backends.remotes[0].drop()
  assert.equal(pool.stats().contexts, 0)
  assert.equal(pool.isLive('a', before.context), false)

  const after = await pool.acquire('a', VIEWPORT)
  assert.equal(backends.remoteConnects, 2)
  assert.notEqual(after.context, before.context)
  assert.equal(after.context.closed, false)
  assert.equal(pool.isLive('a', after.context), true)
  assert.ok(lost.every(([kind]) => kind === 'remote'))
})

test('a cached context is never returned once its browser is not connected, even with no event', async () => {
  const backends = createBackends()
  const pool = poolFor(backends)
  const before = await pool.acquire('a', VIEWPORT)
  backends.remotes[0].connected = false // dead, but `disconnected` has not fired yet
  assert.equal(pool.isLive('a', before.context), false)
  const after = await pool.acquire('a', VIEWPORT)
  assert.notEqual(after.context, before.context)
  assert.equal(backends.remoteConnects, 2)
})

test('a connection that dies between the liveness check and newContext reconnects instead of falling back', async () => {
  const backends = createBackends()
  const pool = poolFor(backends)
  await pool.acquire('a', VIEWPORT)
  const browser = backends.remotes[0]
  browser.failNewContext = new Error('Target closed')
  browser.connected = false
  const { kind } = await pool.acquire('b', VIEWPORT)
  assert.equal(kind, 'remote')
  assert.equal(backends.localLaunches, 0)
  assert.equal(backends.remoteConnects, 2)
})

test('releasing a session closes only its context; the last release frees the remote connection', async () => {
  const backends = createBackends()
  const pool = poolFor(backends)
  const a = await pool.acquire('a', VIEWPORT)
  const b = await pool.acquire('b', VIEWPORT)

  assert.equal(await pool.release('a'), true)
  assert.equal(a.context.closed, true)
  assert.equal(b.context.closed, false)
  assert.equal(backends.remotes[0].connected, true)
  assert.equal(pool.stats().contexts, 1)

  assert.equal(await pool.release('b'), true)
  assert.equal(backends.remotes[0].connected, false)
  assert.equal(pool.stats().remoteConnected, false)
  assert.equal(await pool.release('b'), false, 'releasing twice is a no-op')
  assert.equal(await pool.release('never-opened'), false)
})

test('after the idle connection was freed, the next session connects again', async () => {
  const backends = createBackends()
  const pool = poolFor(backends)
  await pool.acquire('a', VIEWPORT)
  await pool.release('a')
  await pool.acquire('b', VIEWPORT)
  assert.equal(backends.remoteConnects, 2)
})

test('an unreachable remote falls back to a local browser and reports why', async () => {
  const backends = createBackends({ remoteFails: true })
  const pool = poolFor(backends)
  const { kind, remoteNote, context } = await pool.acquire('a', VIEWPORT)
  assert.equal(kind, 'local')
  assert.match(remoteNote, /ECONNREFUSED/)
  assert.doesNotMatch(remoteNote, /Call log/, 'only the first line of the error is surfaced')
  assert.equal(backends.localLaunches, 1)
  assert.equal(backends.locals[0].contexts[0], context)
})

test('after a failed connect the remote is not retried until retryRemoteAfterMs passes', async () => {
  const backends = createBackends({ remoteFails: true })
  let now = 1000
  const pool = poolFor(backends, { retryRemoteAfterMs: 30000, now: () => now })
  await pool.acquire('a', VIEWPORT)
  now += 10000
  const second = await pool.acquire('b', VIEWPORT)
  assert.equal(backends.remoteConnects, 1, 'inside the window: straight to local')
  assert.equal(second.kind, 'local')
  assert.match(second.remoteNote, /ECONNREFUSED/)

  backends.remoteFails = false
  now += 30000
  const third = await pool.acquire('c', VIEWPORT)
  assert.equal(backends.remoteConnects, 2)
  assert.equal(third.kind, 'remote')
  assert.equal(third.remoteNote, null)
  assert.equal(pool.stats().contexts, 3, 'sessions on the local browser stay there')
})

test('the local fallback browser is shared and closed with its last session', async () => {
  const backends = createBackends({ remoteFails: true })
  const pool = poolFor(backends)
  await pool.acquire('a', VIEWPORT)
  await pool.acquire('b', VIEWPORT)
  assert.equal(backends.localLaunches, 1)
  await pool.release('a')
  assert.equal(backends.locals[0].connected, true)
  await pool.release('b')
  assert.equal(backends.locals[0].connected, false)
})

test('when both backends fail the error names both reasons', async () => {
  const backends = createBackends({ remoteFails: true, localFails: true })
  const pool = poolFor(backends)
  await assert.rejects(pool.acquire('a', VIEWPORT), /Remote: .*ECONNREFUSED.*Local fallback: .*Executable does not exist/)
  assert.equal(pool.stats().contexts, 0)
})

test('with remote switched off the local browser is used without a fallback note', async () => {
  const backends = createBackends()
  const pool = createBrowserPool({ connectRemote: undefined, launchLocal: backends.launchLocal, log: quietLog })
  const { kind, remoteNote } = await pool.acquire('a', VIEWPORT)
  assert.equal(kind, 'local')
  assert.equal(remoteNote, null)
  assert.equal(backends.remoteConnects, 0)
})

test('a context the browser closes on its own is forgotten and warned about', async () => {
  const backends = createBackends()
  const lines = []
  const pool = poolFor(backends, { log: { info() {}, warn: (...args) => lines.push(args.join(' ')) } })
  const { context } = await pool.acquire('a', VIEWPORT)
  await pool.acquire('b', VIEWPORT)
  await context.close()
  assert.equal(pool.stats().contexts, 1)
  assert.ok(lines.some((line) => /closed by the browser/.test(line)))
  const again = await pool.acquire('a', VIEWPORT)
  assert.notEqual(again.context, context)
  assert.equal(backends.remoteConnects, 1, 'one lost context does not reconnect')
})

test('closeAll closes every context and both browsers', async () => {
  const backends = createBackends()
  const pool = poolFor(backends)
  const a = await pool.acquire('a', VIEWPORT)
  await pool.acquire('b', VIEWPORT)
  await pool.closeAll()
  assert.equal(a.context.closed, true)
  assert.equal(backends.remotes[0].connected, false)
  assert.equal(pool.stats().contexts, 0)
})
