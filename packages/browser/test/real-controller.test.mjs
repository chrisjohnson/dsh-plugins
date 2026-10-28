// Runs the routing against the REAL dsh-playwright-browser controller class,
// with fake Playwright objects behind it. Skipped on a bare clone, where the
// peer is not installed; it runs wherever dsh-playwright-browser resolves from
// this package (a deployment's node_modules, or a node_modules symlink).
import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'

import { createBrowserPool } from '../src/pool.mjs'
import { createSessionControllerClass, createSessionRegistry, patchPrototype, ROUTED_METHODS } from '../src/routing.mjs'
import { createBackends, quietLog } from './fakes.mjs'

const real = await import('dsh-playwright-browser/controller').catch(() => null)
const skip = real === null ? 'dsh-playwright-browser is not installed here' : false

const CONFIG = { browser: 'chromium', headless: true, viewportWidth: 1280, viewportHeight: 800, actionTimeoutMs: 15000, navigationTimeoutMs: 30000, maxSnapshotChars: 40000, screenshotDir: 'shots' }

test('the real controller exposes every method this plugin routes', { skip }, () => {
  for (const name of ROUTED_METHODS) assert.equal(typeof real.BrowserController.prototype[name], 'function', name)
})

test('two sessions on the real controller class get separate contexts and tab lists', { skip }, async () => {
  const { BrowserController } = real
  const backends = createBackends()
  const pool = createBrowserPool({ connectRemote: backends.connectRemote, launchLocal: backends.launchLocal, log: quietLog })
  const registry = createSessionRegistry({
    SessionController: createSessionControllerClass(BrowserController),
    pool,
    controllerOverrides: {},
    connectUrl: 'ws://bl.example/chromium/playwright',
  })
  const storage = new AsyncLocalStorage()
  const unpatch = patchPrototype(BrowserController.prototype, { storage, registry })
  try {
    const original = new BrowserController(CONFIG)
    const signal = new AbortController().signal
    const as = (sessionId, fn) => storage.run({ sessionId, notices: new Set(), routed: false }, fn)

    await as('a', () => original.open(undefined, signal))
    await as('a', () => original.open(undefined, signal))
    await as('b', () => original.open(undefined, signal))

    const tabsA = await as('a', () => original.listTabs())
    const tabsB = await as('b', () => original.listTabs())
    assert.deepEqual(tabsA.map((tab) => tab.id), ['tab-1', 'tab-2'])
    assert.deepEqual(tabsB.map((tab) => tab.id), ['tab-1'])
    assert.equal(backends.remoteConnects, 1)
    assert.equal(backends.remotes[0].contexts.length, 2)
    assert.equal(original.context, undefined, 'the original controller never launched anything')

    const snapshot = await as('b', () => original.snapshot(undefined, 'aria', signal))
    assert.equal(snapshot.content, '- text: hello')

    await backends.remotes[0].drop()
    assert.deepEqual(await as('a', () => original.listTabs()), [])
    assert.equal(backends.remoteConnects, 2)

    await registry.release('a')
    await registry.release('b')
    assert.equal(pool.stats().contexts, 0)
  } finally {
    unpatch()
  }
})
