// The browser half has no DOM here, so it is loaded the way the client loader
// loads it (window.__ModuleLoader__.load) against stubs: a slot ledger that
// records what the module registers, and a fake React that is just enough to
// call the registered components. KAN-105 regression: the sidebar.panellist
// entry (TakeANumberIcon) renders one QueueBadge per queue, and QueueBadge is a
// React component — it receives its props OBJECT, so the queue arrives as
// props.queue. The released 0.1.8 read queue.active off the first argument
// (i.e. props.active, undefined) and threw, which crashed the whole
// sidebar.panellist slot so the Activity row never appeared.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.mjs', import.meta.url), 'utf8')

function fakeReact(store) {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    // The feed is bypassed: return whatever snapshot the test wants rendered.
    useSyncExternalStore: () => store.value,
  }
}

/** Expand function components (with the fake hooks) down to plain elements. */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  const { type, props, children } = node
  if (typeof type === 'function') return expand(type({ ...props, children }))
  return { type, props, children: (children ?? []).map(expand) }
}

/** Flatten an expanded tree to the rendered element objects. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out }
  out.push(node)
  walk(node.children, out)
  return out
}

/** Mount the module against stubs and return the registered sidebar.panellist component. */
function mount(storeValue) {
  const store = { value: { snapshot: storeValue, error: null, mode: 'stream' } }
  const react = fakeReact(store)
  const registrations = []
  const slots = {
    inject: (_name, fn) => { fn(); return () => {} },
    register: (spec, component) => { registrations.push({ spec, component }); return () => {} },
  }
  const effects = []
  const ctx = {
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    slots,
    effect: (fn) => { effects.push(fn) },
    get: () => undefined,
  }
  const created = []
  const document = {
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: () => null,
    createElement: () => { const el = { dataset: {} }; created.push(el); return el },
    head: { appendChild: () => {} },
  }
  const window = {
    __ModuleLoader__: { load: (spec) => { window.__loaded = spec } },
    fetch: undefined,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'console', source)(window, document, { error() {}, warn() {}, log() {} })
  const exports = window.__loaded.factory((id) => (id === 'react' ? react : {}))
  exports.apply(ctx)
  effects.forEach((fn) => fn())
  const panel = registrations.find((r) => r.spec.name === 'sidebar.panellist')
  return { panel, exports }
}

test('the module registers a sidebar.panellist entry labelled Activity', () => {
  const { panel } = mount({ queues: [] })
  assert.ok(panel, 'no sidebar.panellist registration')
  assert.equal(panel.spec.id, 'take-a-number')
  assert.equal(panel.spec.label(), 'Activity')
})

test('the Activity nav entry renders a queue badge without throwing (KAN-105)', () => {
  const { panel } = mount({
    queues: [
      { id: 'strix-apu', limit: 3, unlimited: false, used: 2, active: [{}, {}], waiters: [{}] },
      { id: 'r9700-egpu', limit: 1, unlimited: false, used: 0, active: [], waiters: [] },
    ],
  })
  // Before the fix this threw: "Cannot read properties of undefined (reading 'length')".
  const tree = expand(panel.component({}))
  const badges = walk(tree).filter((n) => n.type === 'span' && /tn-badge/.test(n.props.className || ''))
  assert.equal(badges.length, 2, 'expected one badge per queue')
  // The badge text is the third h() argument (children), not a prop.
  // strix-apu: 2 active + 1 waiter = 3/3, waiting (waiters present).
  assert.equal(badges[0].children[0], '3/3')
  assert.match(badges[0].props.className, /waiting/)
  // r9700-egpu: 0/1, ok.
  assert.equal(badges[1].children[0], '0/1')
  assert.match(badges[1].props.className, /\bok\b/)
})

test('a malformed queue missing active/waiters does not crash the nav entry', () => {
  const { panel } = mount({ queues: [{ id: 'odd', limit: 2, unlimited: false }] })
  const tree = expand(panel.component({}))
  const badges = walk(tree).filter((n) => n.type === 'span' && /tn-badge/.test(n.props.className || ''))
  assert.equal(badges.length, 1)
  assert.equal(badges[0].children[0], '0/2')
})
