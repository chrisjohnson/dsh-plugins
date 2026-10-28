import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'

import { createBrowserPool } from '../src/pool.mjs'
import { createSessionControllerClass, createSessionRegistry, patchPrototype, ROUTED_METHODS } from '../src/routing.mjs'
import { createBackends, FakeBaseController, quietLog } from './fakes.mjs'

const CONFIG = { viewportWidth: 1024, viewportHeight: 768, actionTimeoutMs: 15000, navigationTimeoutMs: 30000, maxSnapshotChars: 40000, screenshotDir: 'shots' }

/** A controller class per test, so patching one never leaks into another. */
function setup({ backends = createBackends(), overrides = {}, connectUrl = 'ws://bl.example:3000/chromium/playwright?token=secret' } = {}) {
  class Base extends FakeBaseController {}
  const pool = createBrowserPool({ connectRemote: backends.connectRemote, launchLocal: backends.launchLocal, log: quietLog })
  const SessionController = createSessionControllerClass(Base)
  const registry = createSessionRegistry({ SessionController, pool, controllerOverrides: overrides, connectUrl })
  const storage = new AsyncLocalStorage()
  const original = new Base(CONFIG)
  const inSession = (sessionId, fn) => {
    const store = { sessionId, notices: new Set(), routed: false }
    return storage.run(store, () => fn(store))
  }
  return { Base, pool, registry, storage, original, backends, inSession }
}

test('patching replaces exactly the routed methods and unpatching restores the very same functions', () => {
  const { Base, storage, registry } = setup()
  const before = Object.fromEntries(ROUTED_METHODS.map((name) => [name, Base.prototype[name]]))
  const closeBefore = Base.prototype.close
  const unpatch = patchPrototype(Base.prototype, { storage, registry })
  for (const name of ROUTED_METHODS) assert.notEqual(Base.prototype[name], before[name], `${name} is routed`)
  assert.equal(Base.prototype.close, closeBefore, 'close stays the original')
  unpatch()
  for (const name of ROUTED_METHODS) assert.equal(Base.prototype[name], before[name], `${name} is restored`)
})

test('patching twice does not wrap a wrapper, and a stale uninstall cannot undo the live patch', async () => {
  const { Base, storage, registry } = setup()
  const pristine = Base.prototype.listTabs
  const first = patchPrototype(Base.prototype, { storage, registry })
  const second = patchPrototype(Base.prototype, { storage, registry })
  first() // the replaced install being disposed late
  assert.notEqual(Base.prototype.listTabs, pristine, 'second patch still installed')
  second()
  assert.equal(Base.prototype.listTabs, pristine)
})

test('patching an unsupported controller fails loudly instead of half-patching', () => {
  const { storage, registry } = setup()
  class Old {
    async open() {}
  }
  assert.throws(() => patchPrototype(Old.prototype, { storage, registry }), /unsupported dsh-playwright-browser version/)
  assert.equal(Object.hasOwn(Old.prototype, 'navigate'), false)
})

test('a call with no session in scope runs the original method on the original controller', async () => {
  const { Base, storage, registry, original } = setup()
  const seen = []
  Base.prototype.listTabs = async function listTabs() {
    seen.push(this)
    return 'original'
  }
  patchPrototype(Base.prototype, { storage, registry })
  assert.equal(await original.listTabs(), 'original')
  assert.deepEqual(seen, [original])
  assert.equal(registry.size(), 0)
})

test('calls inside a session run on that session\'s controller, and sessions do not see each other', async () => {
  const { Base, storage, registry, original, inSession } = setup()
  patchPrototype(Base.prototype, { storage, registry })

  await Promise.all([
    inSession('a', () => original.open('https://a.example/')),
    inSession('b', () => original.open('https://b.example/')),
  ])
  const tabsA = await inSession('a', () => original.listTabs())
  const tabsB = await inSession('b', () => original.listTabs())

  assert.deepEqual(tabsA.map((tab) => tab.url), ['https://a.example/'])
  assert.deepEqual(tabsB.map((tab) => tab.url), ['https://b.example/'])
  assert.equal(registry.size(), 2)
  assert.equal(original.context, undefined, 'the original controller never started a browser')
  assert.equal(original.pages.size, 0)
})

test('the routing survives interleaved awaits (the store follows the async chain)', async () => {
  const { Base, storage, registry, original, inSession } = setup()
  patchPrototype(Base.prototype, { storage, registry })
  const order = []
  await Promise.all(
    ['a', 'b', 'c'].map((id) =>
      inSession(id, async () => {
        await original.open(`https://${id}.example/`)
        await new Promise((resolve) => setTimeout(resolve, id === 'a' ? 15 : 1))
        const tabs = await original.listTabs()
        order.push([id, tabs.map((tab) => tab.url).join()])
      }),
    ),
  )
  assert.deepEqual(order.sort(), [['a', 'https://a.example/'], ['b', 'https://b.example/'], ['c', 'https://c.example/']])
})

test('methods the original calls on itself stay inside the session controller (no re-routing, no recursion)', async () => {
  const { Base, storage, registry, original, inSession } = setup()
  patchPrototype(Base.prototype, { storage, registry })
  // open() calls this.snapshot() and this.start(); with `this` = session controller these must not re-enter routing.
  const snapshot = await inSession('a', () => original.open('https://a.example/'))
  assert.equal(snapshot.url, 'https://a.example/')
  assert.equal(snapshot.tabId, 'tab-1')
})

test('the original plugin\'s resolved config seeds each session, and explicit overrides win', async () => {
  const { Base, storage, registry, original, inSession } = setup({ overrides: { viewportWidth: 800 } })
  patchPrototype(Base.prototype, { storage, registry })
  await inSession('a', () => original.open())
  const controller = registry.controllerFor('a', original)
  assert.equal(controller.config.viewportWidth, 800)
  assert.equal(controller.config.viewportHeight, 768)
  assert.equal(controller.config.maxSnapshotChars, 40000)
  const [context] = (await controller.start()) ? [controller.context] : []
  assert.deepEqual(context.options, { viewport: { width: 800, height: 768 } })
  assert.equal(context.defaultTimeout, 15000)
  assert.equal(context.defaultNavigationTimeout, 30000)
})

test('a lost connection gives the session a fresh context, new tab ids and a one-time notice', async () => {
  const backends = createBackends()
  const { Base, storage, registry, original, inSession } = setup({ backends })
  patchPrototype(Base.prototype, { storage, registry })

  await inSession('a', () => original.open('https://a.example/'))
  await backends.remotes[0].drop()

  const store = await inSession('a', async (current) => {
    const tabs = await original.listTabs()
    assert.deepEqual(tabs, [], 'no tabs from the dead context')
    return current
  })
  assert.equal(backends.remoteConnects, 2)
  assert.equal([...store.notices].length, 1)
  assert.match([...store.notices][0], /re-established/)

  const snapshot = await inSession('a', () => original.open('https://a2.example/'))
  assert.equal(snapshot.tabId, 'tab-2', 'ids keep counting so a stale id cannot name a different page')
  const next = await inSession('a', async (current) => {
    await original.listTabs()
    return current
  })
  assert.equal(next.notices.size, 0, 'the notice is given once')
  await assert.rejects(inSession('a', () => original.snapshot('tab-1')), /unknown or closed tab_id/)
})

test('a cached context is not reused when its browser died without an event', async () => {
  const backends = createBackends()
  const { Base, storage, registry, original, inSession } = setup({ backends })
  patchPrototype(Base.prototype, { storage, registry })
  await inSession('a', () => original.open('https://a.example/'))
  backends.remotes[0].connected = false
  const tabs = await inSession('a', () => original.listTabs())
  assert.deepEqual(tabs, [])
  assert.equal(backends.remoteConnects, 2)
})

test('on the local fallback every call carries the notice naming the endpoint without its token', async () => {
  const backends = createBackends({ remoteFails: true })
  const { Base, storage, registry, original, inSession } = setup({ backends })
  patchPrototype(Base.prototype, { storage, registry })
  for (const call of [() => original.open(), () => original.listTabs()]) {
    const store = await inSession('a', async (current) => {
      await call()
      return current
    })
    const [notice] = [...store.notices]
    assert.match(notice, /LOCAL fallback/)
    assert.match(notice, /unreachable/)
    assert.match(notice, /ws:\/\/bl\.example:3000\/chromium\/playwright/)
    assert.doesNotMatch(notice, /secret|token/)
  }
})

test('on a healthy remote no notice is produced', async () => {
  const { Base, storage, registry, original, inSession } = setup()
  patchPrototype(Base.prototype, { storage, registry })
  const store = await inSession('a', async (current) => {
    await original.open()
    await original.listTabs()
    return current
  })
  assert.equal(store.notices.size, 0)
  assert.equal(store.routed, true)
})

test('with the remote switched off the local browser is used and no fallback is claimed', async () => {
  const backends = createBackends()
  const { Base, storage, registry, original, inSession } = setup({ backends, connectUrl: undefined })
  // The pool in setup() always has a remote; build the remote-less one explicitly.
  const pool = createBrowserPool({ connectRemote: undefined, launchLocal: backends.launchLocal, log: quietLog })
  const localRegistry = createSessionRegistry({ SessionController: createSessionControllerClass(Base), pool, controllerOverrides: {}, connectUrl: undefined })
  patchPrototype(Base.prototype, { storage, registry: localRegistry })
  const store = await inSession('a', async (current) => {
    await original.open()
    return current
  })
  assert.equal(store.notices.size, 0)
  assert.equal(backends.localLaunches, 1)
  assert.equal(registry.size(), 0)
})

test('releasing a session closes its context and forgets its controller; the others are untouched', async () => {
  const backends = createBackends()
  const { Base, storage, registry, original, inSession, pool } = setup({ backends })
  patchPrototype(Base.prototype, { storage, registry })
  await inSession('a', () => original.open('https://a.example/'))
  await inSession('b', () => original.open('https://b.example/'))
  const [contextA, contextB] = backends.remotes[0].contexts

  assert.equal(await registry.release('a'), true)
  assert.equal(contextA.closed, true)
  assert.equal(contextB.closed, false)
  assert.equal(registry.has('a'), false)
  assert.deepEqual(pool.stats().sessions, ['b'])
  assert.equal(await registry.release('a'), false, 'idempotent')

  const tabsB = await inSession('b', () => original.listTabs())
  assert.deepEqual(tabsB.map((tab) => tab.url), ['https://b.example/'])
})

test('the original controller\'s own close() does not touch session contexts', async () => {
  const backends = createBackends()
  const { Base, storage, registry, original, inSession } = setup({ backends })
  patchPrototype(Base.prototype, { storage, registry })
  await inSession('a', () => original.open('https://a.example/'))
  await original.close() // what the original plugin does when it is disposed
  assert.equal(backends.remotes[0].contexts[0].closed, false)
})

test('releaseAll ends every session', async () => {
  const backends = createBackends()
  const { Base, storage, registry, original, inSession, pool } = setup({ backends })
  patchPrototype(Base.prototype, { storage, registry })
  await inSession('a', () => original.open())
  await inSession('b', () => original.open())
  await registry.releaseAll()
  assert.equal(registry.size(), 0)
  assert.equal(pool.stats().contexts, 0)
})
