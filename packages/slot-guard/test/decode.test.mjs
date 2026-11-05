// The decoder is the part of dsh-slot-guard with a verdict in it, so it is tested
// against the shipped browser half: src/client.mjs is loaded in a bare VM with a
// stub `window`, and the pure functions it exports on its module face are
// exercised directly. No browser, no dsh, no build step.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Evaluate the browser half the way the harness's module loader does: hand it a
 * `window` whose `__ModuleLoader__.load` captures the registration, run the
 * factory, and return its exports plus the stubs so a test can poke at them.
 */
function loadClient({ readyState = 'complete' } = {}) {
  const source = readFileSync(join(root, 'src/client.mjs'), 'utf8')
  const logged = []
  const listeners = []
  const fakeConsole = {
    error: (...args) => logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')),
    warn: () => {},
    log: () => {}
  }
  const stubWindow = {
    __ModuleLoader__: {
      load(registration) {
        captured.registration = registration
      }
    },
    addEventListener(kind, handler) {
      listeners.push({ kind, handler })
    },
    location: { reload() {} }
  }
  const captured = {}
  const context = vm.createContext({
    window: stubWindow,
    console: fakeConsole,
    document: undefined,
    MutationObserver: undefined,
    setTimeout: () => 0,
    setInterval: () => 0,
    Date,
    Math,
    JSON,
    String,
    Number,
    Object,
    Array,
    Error,
    RegExp
  })
  vm.runInContext(source, context)
  assert.ok(captured.registration, 'the browser half never called window.__ModuleLoader__.load')
  assert.equal(captured.registration.id, 'dsh-slot-guard')
  const exports = captured.registration.factory(() => {
    throw new Error('dsh-slot-guard needs no external client modules')
  })
  return { exports, logged, listeners, fakeConsole, stubWindow, readyState }
}

test('reactErrorCode finds the production code and nothing else', () => {
  const { exports } = loadClient()
  assert.equal(exports.reactErrorCode('Error: Minified React error #311; visit https://react.dev/errors/311'), 311)
  assert.equal(exports.reactErrorCode('Minified React error #310'), 310)
  assert.equal(exports.reactErrorCode('TypeError: cannot read property x of undefined'), null)
  assert.equal(exports.reactErrorCode(undefined), null)
  assert.equal(exports.reactErrorCode(null), null)
})

test('slotKeyIn reads the key the renderer names', () => {
  const { exports } = loadClient()
  assert.equal(exports.slotKeyIn("slot entry crashed in 'conversation.input.right':"), 'conversation.input.right')
  assert.equal(exports.slotKeyIn("slot factory occurrence crashed in 'composer.pill':"), 'composer.pill')
  assert.equal(exports.slotKeyIn('nothing here'), null)
})

test('the three hook-order codes decode as hook-order, with the fix to apply', () => {
  const { exports } = loadClient()
  for (const code of [300, 310, 311, 312]) {
    const d = exports.decode(`Minified React error #${code}`)
    assert.equal(d.code, code)
    assert.equal(d.hookOrder, true, `#${code} must be reported as a hook-order change`)
    assert.ok(d.reactMessage.length > 10, `#${code} must carry React's own message`)
    assert.ok(/hook/i.test(d.reason), `#${code} reason must talk about hooks`)
    assert.ok(/fallback/i.test(d.advice), `#${code} advice must name the stable-fallback fix`)
  }
})

test('a non-hook React code decodes to the generic face and a link, not a hook verdict', () => {
  const { exports } = loadClient()
  const d = exports.decode('Minified React error #185')
  assert.equal(d.code, 185)
  assert.equal(d.hookOrder, false)
  // Only the hook-order family carries React's own text; anything else points at
  // the decoder, which is the honest thing to do with a code table this small.
  assert.equal(d.reactMessage, 'Minified React error #185')
  assert.match(d.advice, /react\.dev\/errors\/185/)
})

test('a non-React error passes through undecoded', () => {
  const { exports } = loadClient()
  const d = exports.decode('TypeError: x is not a function')
  assert.equal(d.code, null)
  assert.equal(d.hookOrder, false)
  assert.match(d.reason, /TypeError/)
})

test('the headline names the slot and the decoded cause', () => {
  const { exports } = loadClient()
  const line = exports.headline(exports.decode('Minified React error #311'), 'sidebar.right.context', 'slot boundary')
  assert.match(line, /^slot 'sidebar\.right\.context' crashed with React #311/)
  assert.match(line, /hooks/i)
  assert.match(line, /slot boundary/)
  const unknown = exports.headline(exports.decode('Minified React error #310'), null, 'unhandledrejection')
  assert.match(unknown, /^a slot entry crashed with React #310/)
})

test('a slot-boundary console.error line produces one decoded line and keeps the original', () => {
  const { exports, logged, fakeConsole } = loadClient()
  exports.apply()
  // The wrapper installed by the browser half is what the renderer's own
  // console.error call now runs through.
  const boundary = "slot entry crashed in 'conversation.input.right':"
  fakeConsole.error(boundary, new Error('Minified React error #311; visit https://react.dev/errors/311 for the full message'))
  const all = logged.join('\n')
  assert.ok(logged.some((l) => l.startsWith(boundary)), 'the original line must still be logged')
  assert.match(all, /\[dsh-slot-guard [^\]]+\] react-error: slot 'conversation\.input\.right' crashed with React #311/)
  assert.match(all, /stable module-scope fallback/)
})

test('the same crash repeated inside the dedupe window is decoded once', () => {
  const { exports, logged, fakeConsole } = loadClient()
  exports.apply()
  const text = "slot entry crashed in 'x': Minified React error #311"
  const decodedCount = () => logged.filter((l) => l.includes('[dsh-slot-guard')).length
  fakeConsole.error(text)
  assert.equal(decodedCount(), 1)
  fakeConsole.error(text)
  fakeConsole.error(text)
  assert.equal(decodedCount(), 1, 'repeat decodes must be suppressed')
  assert.ok(logged.filter((l) => l.startsWith(text)).length === 3, 'the original lines must all still be logged')
})

test('window error and unhandledrejection listeners are installed', () => {
  const { exports, listeners, logged } = loadClient()
  exports.apply()
  const kinds = listeners.map((l) => l.kind)
  assert.ok(kinds.includes('error'), 'no window error listener')
  assert.ok(kinds.includes('unhandledrejection'), 'no unhandledrejection listener')
  const error = listeners.find((l) => l.kind === 'error')
  error.handler({ message: 'Uncaught Error: Minified React error #310; visit https://react.dev/errors/310' })
  assert.ok(logged.some((l) => /react-error:.*React #310/.test(l)), 'the window error was not decoded')
  const rejection = listeners.find((l) => l.kind === 'unhandledrejection')
  rejection.handler({ reason: new Error('Minified React error #311') })
  assert.ok(logged.some((l) => /unhandledrejection/.test(l)), 'the rejection was not decoded')
})
