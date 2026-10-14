// The browser half has no DOM here, so it is loaded the way the client loader
// loads it (window.__ModuleLoader__.load) against stubs: a slot ledger that
// implements the registry's shadowing rule (lowest priority renders), a fake
// React that is just enough to call components, and a fake host route. What is
// checked is the contract with the official 0.2.0 workspace UI: which seats are
// filled, that the official archive entries are shadowed with their injected
// share intact, that the archive decision is made before the callback runs, and
// that the optional better-sidebar integration degrades to nothing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.mjs', import.meta.url), 'utf8')

function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
}

const primitives = new Proxy({}, { get: (_t, name) => (name === 'then' ? undefined : function Primitive() {}) })

/** A slot ledger with the real shadowing rule: per id, the lowest priority wins. */
function fakeSlots() {
  const ledger = new Map()
  const listeners = new Map()
  const declared = new Set()
  const notify = (name) => (listeners.get(name) ?? []).forEach((fn) => queueMicrotask(fn))
  const slots = {
    declare: (name) => {
      declared.add(name)
      return slots
    },
    entries: (name) => ledger.get(name) ?? [],
    subscribe: (name, fn) => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn])
      return () => listeners.set(name, listeners.get(name).filter((f) => f !== fn))
    },
    inject: (name, callback) => {
      assert.ok(declared.has(name), `${name} must be declared before an entry can be registered`)
      return callback()
    },
    register: (options, component) => {
      const entry = { component, options, inject: options.inject, locale: options.locale }
      ledger.set(name(options), [...(ledger.get(name(options)) ?? []), entry])
      notify(name(options))
      return () => {
        ledger.set(name(options), ledger.get(name(options)).filter((e) => e !== entry))
        notify(name(options))
      }
    },
    /** What the renderer would show for a slot: one winner per id. */
    winners: (slot) => {
      const byId = new Map()
      for (const entry of ledger.get(slot) ?? []) {
        const current = byId.get(entry.options.id)
        if (current === undefined || (entry.options.priority ?? 0) < (current.options.priority ?? 0)) byId.set(entry.options.id, entry)
      }
      return [...byId.values()]
    },
  }
  const name = (options) => options.name
  return slots
}

function load({ snapshot, betterSidebar } = {}) {
  const slots = fakeSlots()
  const fetched = []
  const created = []
  const effects = []
  const injected = []
  const document = {
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { append: (node) => created.push(node) },
  }
  let loaded
  const window = { __ModuleLoader__: { load: (spec) => (loaded = spec) } }
  const fetchStub = async (url, init) => {
    fetched.push({ url, body: JSON.parse(init.body) })
    const endpoint = url.split('/').pop()
    const value = endpoint === 'snapshot' ? snapshot : { status: null }
    return { ok: true, json: async () => ({ ok: true, value }) }
  }
  const react = fakeReact()
  const require = (id) => (id === 'react' ? react : primitives)
  new Function('window', 'document', 'fetch', 'navigator', 'console', 'setInterval', 'clearInterval', source)(window, document, fetchStub, undefined, { ...console, warn() {}, error() {} }, () => 0, () => {})
  const exports = loaded.factory(require)
  const sidebarTabs = []
  const ctx = {
    slots,
    effect: (fn, label) => effects.push({ run: fn, label }),
    get: () => undefined,
    inject: (names, callback) => {
      injected.push(names)
      if (betterSidebar !== undefined) callback({ betterSidebar, effect: (fn, label) => effects.push({ run: fn, label }) })
    },
  }
  return { id: loaded.id, exports, ctx, slots, fetched, created, effects, injected, sidebarTabs, react }
}

const DECLARED = [
  'sidebar.session.row.leading',
  'sidebar.session.row.hover',
  'sidebar.workspaces.session.menu.item',
  'sidebar.workspaces.session.row.action',
  'conversation.input.left',
  'conversation.session.header.actions',
  'shell.overlay',
]

/** Mount the module: declare the seats, apply, and run every effect (as the loader's fiber would). */
function mountClient(options) {
  const t = load(options)
  for (const slot of DECLARED) t.slots.declare(slot)
  t.exports.apply(t.ctx)
  const disposers = t.effects.map((effect) => effect.run())
  return { ...t, disposers }
}

/** The official archive entries, as ui-workspace registers them (priority unset = 0). */
function registerOfficialArchive(t) {
  const calls = []
  const make = (slot, order) => {
    const component = function OfficialArchive() {}
    const hooks = { archived: { getSnapshot: () => new Set() } }
    t.slots.register({
      name: slot,
      id: 'archive',
      order,
      locale: 'workspace',
      inject: () => ({
        hooks,
        archiveSession: (id) => calls.push([slot, id]),
        unarchiveSession: () => {},
      }),
    }, component)
    return component
  }
  return { calls, row: make('sidebar.workspaces.session.row.action', 100), menu: make('sidebar.workspaces.session.menu.item', 400) }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

const SNAPSHOT = {
  worktrees: [
    {
      sessionId: 'session-wt',
      managedRoot: '/work/project/.dsh-worktrees/brave-otter',
      branch: 'dsh/brave-otter',
      decoration: { state: 'behind', label: 'Behind', needsRebase: true, tooltip: 'line one\nline two', name: 'brave-otter', title: 'brave-otter - Behind' },
      archive: { prompt: true, dirty: 2, unpushed: 1 },
    },
    {
      sessionId: 'session-gone',
      managedRoot: '/work/project/.dsh-worktrees/gone',
      missing: true,
      decoration: { state: 'unknown', label: 'Missing', needsRebase: false, tooltip: 'gone', name: 'gone', title: 'gone - Unknown' },
      archive: { prompt: false, dirty: 0, unpushed: 0 },
    },
  ],
  capabilities: { folderOpener: 'xdg-open' },
  at: 1,
}

test('the module declares itself under the package name and needs only the services it always uses', () => {
  const { id, exports } = load()
  assert.equal(id, 'dsh-better-git-worktree')
  assert.deepEqual(exports.inject, ['slots', 'sessions', 'workspaces'])
  assert.equal(typeof exports.apply, 'function')
})

test('it fills the 0.2.0 seats and nothing else: no workspace browser, no election', () => {
  const t = mountClient()
  assert.deepEqual(t.slots.winners('sidebar.session.row.leading').map((e) => e.options.id), ['better-git-worktree.status'])
  assert.deepEqual(t.slots.winners('sidebar.session.row.hover').map((e) => e.options.id), ['better-git-worktree.hover'])
  assert.deepEqual(
    t.slots.winners('sidebar.workspaces.session.menu.item').map((e) => e.options.id).sort(),
    ['better-git-worktree.copy-path', 'better-git-worktree.open-folder'],
  )
  assert.deepEqual(t.slots.winners('conversation.input.left').map((e) => e.options.id), ['better-git-worktree.switch'])
  assert.deepEqual(t.slots.winners('conversation.session.header.actions').map((e) => e.options.id), ['better-git-worktree.actions'])
  assert.deepEqual(t.slots.winners('shell.overlay').map((e) => e.options.id), ['better-git-worktree.archive-prompt'])
  assert.equal(t.slots.entries('sidebar').length, 0)
  assert.equal(t.slots.entries('sidebar.workspaces').length, 0, 'the official browser is never replaced')
  assert.equal(t.created.length, 1, 'styles are installed once')
})

test('the official archive entries are shadowed in both places, reusing their component and locale', async () => {
  const t = mountClient()
  const official = registerOfficialArchive(t)
  await flush()
  for (const [slot, component] of [
    ['sidebar.workspaces.session.row.action', official.row],
    ['sidebar.workspaces.session.menu.item', official.menu],
  ]) {
    const winner = t.slots.winners(slot).find((e) => e.options.id === 'archive')
    assert.equal(winner.options.priority, -1, 'lower than the official entry\'s default, so it renders')
    assert.equal(winner.component, component, 'the official component draws it')
    assert.equal(winner.locale, 'workspace')
    assert.equal(t.slots.entries(slot).filter((e) => e.options.id === 'archive').length, 2, 'the official entry stays on the ledger underneath')
  }
  assert.equal(t.slots.winners('sidebar.workspaces.session.row.action').find((e) => e.options.id === 'archive').options.order, 100)
  assert.equal(t.slots.winners('sidebar.workspaces.session.menu.item').find((e) => e.options.id === 'archive').options.order, 400)
})

test('a shadow is registered once even when the official entry arrives after this module, and is withdrawn with it', async () => {
  const t = mountClient()
  await flush()
  assert.equal(t.slots.entries('sidebar.workspaces.session.row.action').length, 0, 'nothing to shadow yet')
  registerOfficialArchive(t)
  await flush()
  await flush()
  assert.equal(t.slots.entries('sidebar.workspaces.session.row.action').filter((e) => e.options.id === 'archive').length, 2)
  for (const dispose of t.disposers) if (typeof dispose === 'function') dispose()
  assert.equal(t.slots.entries('sidebar.workspaces.session.row.action').filter((e) => e.options.priority === -1).length, 0)
})

test('the shadowed inject keeps the official share and archives straight away for a plain session', async () => {
  const t = mountClient({ snapshot: SNAPSHOT })
  const official = registerOfficialArchive(t)
  await flush()
  await flush()
  const winner = t.slots.winners('sidebar.workspaces.session.row.action').find((e) => e.options.id === 'archive')
  const share = winner.inject()
  assert.ok(share.hooks.archived, 'hooks bag untouched')
  assert.equal(typeof share.unarchiveSession, 'function')
  share.archiveSession('session-plain')
  assert.deepEqual(official.calls, [['sidebar.workspaces.session.row.action', 'session-plain']])
})

test('a session whose working copy is already gone archives straight away too', async () => {
  const t = mountClient({ snapshot: SNAPSHOT })
  const official = registerOfficialArchive(t)
  await flush()
  await flush()
  const winner = t.slots.winners('sidebar.workspaces.session.menu.item').find((e) => e.options.id === 'archive')
  winner.inject().archiveSession('session-gone')
  assert.deepEqual(official.calls, [['sidebar.workspaces.session.menu.item', 'session-gone']])
})

test('a worktree session asks first: the official archive runs only after the dialog proceeds', async () => {
  const t = mountClient({ snapshot: SNAPSHOT })
  const official = registerOfficialArchive(t)
  await flush()
  await flush()
  const share = t.slots.winners('sidebar.workspaces.session.row.action').find((e) => e.options.id === 'archive').inject()
  share.archiveSession('session-wt')
  assert.deepEqual(official.calls, [], 'nothing was archived behind the dialog')

  // The dialog component reads the pending request: render it and look at what it shows.
  const dialog = t.slots.winners('shell.overlay')[0].component
  const tree = dialog()
  assert.ok(tree, 'the dialog is open')
  assert.equal(tree.props.open, true)
  assert.equal(tree.props.title, "Remove this session's worktree?")
  const text = JSON.stringify(tree)
  assert.match(text, /brave-otter/)
  assert.match(text, /2 uncommitted path\(s\) will be lost with it\./)
  assert.match(text, /1 commit\(s\) are not pushed anywhere/)

  // "Keep" archives without removing the copy.
  const footer = tree.props.footer
  const keep = footer.children.find((c) => c.props.variant === 'outline')
  keep.props.onClick()
  assert.deepEqual(official.calls, [['sidebar.workspaces.session.row.action', 'session-wt']])
  assert.equal(t.fetched.some((f) => f.url.endsWith('/remove')), false)
})

test('Cancel closes the dialog and archives nothing', async () => {
  const t = mountClient({ snapshot: SNAPSHOT })
  const official = registerOfficialArchive(t)
  await flush()
  await flush()
  t.slots.winners('sidebar.workspaces.session.menu.item').find((e) => e.options.id === 'archive').inject().archiveSession('session-wt')
  const dialog = t.slots.winners('shell.overlay')[0].component
  dialog().props.onClose()
  assert.equal(dialog(), null)
  assert.deepEqual(official.calls, [])
})

test('Remove asks the host to delete the copy and only then runs the official archive', async () => {
  const t = mountClient({ snapshot: SNAPSHOT })
  const official = registerOfficialArchive(t)
  await flush()
  await flush()
  t.slots.winners('sidebar.workspaces.session.row.action').find((e) => e.options.id === 'archive').inject().archiveSession('session-wt')
  const tree = t.slots.winners('shell.overlay')[0].component()
  const remove = tree.props.footer.children.find((c) => c.props.variant === 'primary')
  remove.props.onClick()
  await flush()
  await flush()
  const removal = t.fetched.find((f) => f.url === '/betterGitWorktree/remove')
  assert.deepEqual(removal.body, { sessionId: 'session-wt' })
  assert.deepEqual(official.calls, [['sidebar.workspaces.session.row.action', 'session-wt']])
})

test('row seats: the badge and the hover line render only for a session with a decoration', async () => {
  const t = mountClient({ snapshot: SNAPSHOT })
  await flush()
  await flush()
  const badge = t.slots.winners('sidebar.session.row.leading')[0].component
  const hover = t.slots.winners('sidebar.session.row.hover')[0].component
  assert.equal(badge({ sessionId: 'session-plain' }), null)
  assert.equal(hover({ sessionId: 'session-plain' }), null)
  const element = badge({ sessionId: 'session-wt' })
  assert.equal(element.props['data-bgw-state'], 'behind')
  assert.equal(element.props['data-bgw-rebase'], 'true')
  assert.equal(element.props['aria-label'], 'Worktree Behind, needs rebasing')
  const line = hover({ sessionId: 'session-wt' })
  assert.equal(line.children.at(-1).children[0], 'line one\nline two')
})

test('row menu items are for sessions with a live managed copy only', async () => {
  const t = mountClient({ snapshot: SNAPSHOT })
  await flush()
  await flush()
  const useMenuOpenState = () => [true, () => {}]
  for (const entry of t.slots.winners('sidebar.workspaces.session.menu.item')) {
    assert.equal(entry.component({ sessionId: 'session-plain', useMenuOpenState }), null)
    assert.equal(entry.component({ sessionId: 'session-gone', useMenuOpenState }), null, 'a missing copy has nothing to open')
    assert.ok(entry.component({ sessionId: 'session-wt', useMenuOpenState }))
  }
})

test('with dsh-better-sidebar the Branch tab is registered, and disposed with the plugin', () => {
  const registered = []
  let disposed = 0
  const t = mountClient({ betterSidebar: { registerTab: (descriptor) => (registered.push(descriptor), () => disposed++) } })
  assert.deepEqual(t.injected, [['betterSidebar']])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'git-worktree-review')
  assert.equal(registered[0].single, true)
  assert.equal(registered[0].component({ scope: {} }), null)
  assert.ok(registered[0].component({ scope: { sessionId: 'session-wt' } }))
})

test('without dsh-better-sidebar nothing is registered and nothing throws', () => {
  const t = mountClient()
  assert.deepEqual(t.injected, [['betterSidebar']])
  assert.doesNotThrow(() => t.exports.apply)
})

test('there is no inlined workspace client, no election and no file import left behind', () => {
  assert.doesNotMatch(source, /officialWorkspace|OFFICIAL_WORKSPACE|ui-workspace.*disabled|__OFFICIAL/)
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /Outline16|Outline14/, 'icons use the 0.2.0 Regular/Medium names')
})
