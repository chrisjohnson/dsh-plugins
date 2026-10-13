// The browser half has no DOM here, so this loads the module the way the client
// loader does (window.__ModuleLoader__.load) against a stub and checks the one
// contract that matters outside a browser: it mounts a better-sidebar tab when
// the service is there, and is a quiet no-op when it is not.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.mjs', import.meta.url), 'utf8')

function loadClient() {
  let loaded
  const created = []
  const document = {
    getElementById: () => null,
    createElement: () => ({}),
    head: { appendChild: (tag) => created.push(tag) },
  }
  const window = { __ModuleLoader__: { load: (spec) => (loaded = spec) } }
  const react = { createElement: (...args) => args, useState: () => [null, () => {}] }
  new Function('window', 'document', source)(window, document)
  const exports = loaded.factory(() => react)
  return { id: loaded.id, exports, styles: created }
}

test('the module declares itself under the package name and needs only betterSidebar', () => {
  const { id, exports } = loadClient()
  assert.equal(id, 'dsh-loop-watchdog')
  assert.deepEqual(exports.inject, ['betterSidebar'])
})

test('with better-sidebar present, it registers one tab and returns a disposer through ctx.effect', () => {
  const { exports, styles } = loadClient()
  const registered = []
  let disposed = 0
  const disposer = () => disposed++
  const effects = []
  exports.apply({
    betterSidebar: { registerTab: (d) => (registered.push(d), disposer) },
    effect: (fn, name) => effects.push([fn, name]),
  })
  assert.equal(registered.length, 0, 'registration is deferred to the effect')
  assert.equal(effects.length, 1)
  const dispose = effects[0][0]()
  assert.equal(registered.length, 1)
  const tab = registered[0]
  assert.equal(tab.id, 'loop-watchdog:evals')
  assert.equal(typeof tab.component, 'function')
  assert.equal(typeof tab.title, 'string')
  assert.equal(styles.length, 1, 'styles are injected once')
  dispose()
  assert.equal(disposed, 1, 'the tab registration is disposed')
})

test('without registerTab (or without the service) it mounts nothing and does not throw', () => {
  const { exports, styles } = loadClient()
  assert.doesNotThrow(() => exports.apply({ effect: () => assert.fail('must not register an effect') }))
  assert.doesNotThrow(() => exports.apply({ betterSidebar: {}, effect: () => assert.fail('must not register an effect') }))
  assert.equal(styles.length, 0)
})
