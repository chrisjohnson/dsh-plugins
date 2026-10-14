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
  const stateLog = []
  return {
    stateLog,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
    // State never re-renders here; every value a component sets is recorded instead.
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, (value) => stateLog.push(typeof value === 'function' ? value(initial) : value)],
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
}

// Primitives are stable named stand-ins that render to nothing; `expand` below
// stops at them, so a test can look at the props the browser half gave them.
const primitiveCache = {}
const primitives = new Proxy({}, {
  get: (_t, name) => {
    if (name === 'then') return undefined
    primitiveCache[name] ??= Object.assign(function Primitive() { return null }, { displayName: String(name) })
    return primitiveCache[name]
  },
})

/** Expand function components (with the fake hooks) down to primitives and plain elements. */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  const { type, props, children } = node
  if (typeof type === 'function' && type.displayName === undefined) return expand(type({ ...props, children }))
  return { type, props, children: (children ?? []).map(expand) }
}

/** The first node in a tree matching `predicate`. */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = find(item, predicate)
      if (hit) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  for (const child of [...(node.children ?? []), ...Object.values(node.props ?? {}).filter((v) => v && typeof v === 'object')]) {
    const hit = find(child, predicate)
    if (hit) return hit
  }
  return undefined
}
const named = (name) => (node) => node.type?.displayName === name
const button = (tree, variant) => find(tree, (n) => n.type?.displayName === 'Button' && n.props.variant === variant)
/** The overlay seat's rendered tree. */
const overlay = (t) => expand(t.slots.winners('shell.overlay')[0].component({}))

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

function load({ snapshot, betterSidebar, services = {}, timeouts, clipboard, holdTimeouts } = {}) {
  const held = new Map()
  const intervalFns = []
  const slots = fakeSlots()
  const flags = { failRemove: false }
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
    if (endpoint === 'remove' && flags.failRemove) {
      return { ok: true, json: async () => ({ ok: false, error: { message: 'refusing to remove' } }) }
    }
    const value = endpoint === 'snapshot' ? await (typeof snapshot === 'function' ? snapshot(JSON.parse(init.body)) : snapshot) : endpoint === 'remove' ? { removed: true } : { status: null }
    if (value && value.__http) return { ok: false, status: value.__http, json: async () => ({}) }
    if (value && value.__fail) return { ok: true, json: async () => ({ ok: false, error: { message: value.__fail } }) }
    return { ok: true, json: async () => ({ ok: true, value }) }
  }
  const react = fakeReact()
  const require = (id) => (id === 'react' ? react : primitives)
  const warnings = []
  // Timers: polling never fires; one-shot timeouts run at once (recording their delay) when a test asks to see them.
  const setTimeoutStub = (fn, ms) => {
    timeouts?.push(ms)
    if (holdTimeouts) {
      held.set(held.size + 1, fn)
      return held.size
    }
    queueMicrotask(fn)
    return 0
  }
  const navigatorStub = clipboard === undefined ? undefined : { clipboard }
  new Function('window', 'document', 'fetch', 'navigator', 'console', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', source)(
    window, document, fetchStub, navigatorStub, { ...console, warn: (...a) => warnings.push(a.join(' ')), error() {} }, (fn) => (intervalFns.push(fn), 0), () => {}, setTimeoutStub, (id) => held.delete(id),
  )
  const exports = loaded.factory(require)
  const sidebarTabs = []
  const ctx = {
    slots,
    effect: (fn, label) => effects.push({ run: fn, label }),
    get: (name) => services[name],
    inject: (names, callback) => {
      injected.push(names)
      if (betterSidebar !== undefined) callback({ betterSidebar, effect: (fn, label) => effects.push({ run: fn, label }) })
    },
  }
  return { id: loaded.id, exports, ctx, slots, fetched, created, effects, injected, sidebarTabs, react, warnings, held, poll: () => intervalFns.forEach((fn) => fn()), failRemove: () => { flags.failRemove = true } }
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
  const tree = overlay(t)
  const modal = find(tree, named('Modal'))
  assert.ok(modal, 'the dialog is open')
  assert.equal(modal.props.open, true)
  assert.equal(modal.props.title, "Remove this session's worktree?")
  const text = JSON.stringify(tree)
  assert.match(text, /brave-otter/)
  assert.match(text, /2 uncommitted path\(s\) will be lost with it\./)
  assert.match(text, /1 unpushed commit\(s\)/)
  assert.match(text, /does nothing while the session is still running/)

  // "Keep" archives without removing the copy.
  button(tree, 'outline').props.onClick()
  assert.deepEqual(official.calls, [['sidebar.workspaces.session.row.action', 'session-wt']])
  assert.equal(t.fetched.some((f) => f.url.endsWith('/remove')), false)
})

test('Cancel closes the dialog and archives nothing', async () => {
  const t = mountClient({ snapshot: SNAPSHOT })
  const official = registerOfficialArchive(t)
  await flush()
  await flush()
  t.slots.winners('sidebar.workspaces.session.menu.item').find((e) => e.options.id === 'archive').inject().archiveSession('session-wt')
  find(overlay(t), named('Modal')).props.onClose()
  assert.equal(find(overlay(t), named('Modal')), undefined, 'the dialog is closed')
  assert.deepEqual(official.calls, [])
})

function archivingServices(archive) {
  const order = []
  const services = {
    uiWorkspace: { archiveSession: async (id) => { order.push(['archive', id]); return archive(id) } },
    workspaces: {},
  }
  return { order, services }
}

async function openRemoveDialog(t) {
  registerOfficialArchive(t)
  await flush()
  await flush()
  t.slots.winners('sidebar.workspaces.session.row.action').find((e) => e.options.id === 'archive').inject().archiveSession('session-wt')
  return overlay(t)
}

test('Remove archives first and deletes the copy only after the archive succeeded', async () => {
  const { order, services } = archivingServices(async () => {})
  const t = mountClient({ snapshot: SNAPSHOT, services })
  const tree = await openRemoveDialog(t)
  button(tree, 'primary').props.onClick()
  await flush()
  await flush()
  const removal = t.fetched.find((f) => f.url === '/betterGitWorktree/remove')
  assert.deepEqual(removal.body, { sessionId: 'session-wt', confirmedPlan: { dirty: 2, unpushed: 1, stashes: 0 } })
  assert.deepEqual(order, [['archive', 'session-wt']])
  assert.ok(t.fetched.indexOf(removal) > -1)
})

test('a session that is still running cannot reach the destructive path: the archive is refused, so nothing is removed', async () => {
  const { order, services } = archivingServices(async () => {
    throw Object.assign(new Error('session has running work'), { name: 'WorkspaceArchiveError' })
  })
  const t = mountClient({ snapshot: SNAPSHOT, services })
  const tree = await openRemoveDialog(t)
  button(tree, 'primary').props.onClick()
  await flush()
  await flush()
  assert.deepEqual(order, [['archive', 'session-wt']], 'the archive was attempted first')
  assert.equal(t.fetched.some((f) => f.url.endsWith('/remove')), false, 'the working copy was never touched')
  const shown = t.react.stateLog.at(-1)
  assert.match(shown.error, /could not be archived, so the worktree was not touched/)
  assert.match(shown.error, /stop it first/)
})

test('if the copy cannot be removed after the archive, the dialog says the session was already archived', async () => {
  const { services } = archivingServices(async () => {})
  const t = mountClient({ snapshot: SNAPSHOT, services })
  const tree = await openRemoveDialog(t)
  const realFetch = t.fetched
  // The fake route answers `remove` with a failure for this test only.
  t.failRemove()
  button(tree, 'primary').props.onClick()
  await flush()
  await flush()
  assert.ok(realFetch.some((f) => f.url.endsWith('/remove')))
  assert.match(t.react.stateLog.at(-1).error, /The session was archived but its worktree could not be removed/)
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

// After the agent's own worktree_convert the host marks the record `activated: false`
// and the browser opens the continuation, then archives the (still running) source.
function conversionFixture({ archive }) {
  const calls = { archive: [], opened: [] }
  const snapshot = {
    worktrees: [{
      sessionId: 'session-src',
      targetSessionId: 'session-new',
      managedRoot: '/work/project/.dsh-worktrees/calm-heron',
      activated: false,
      conversationCarried: true,
      decoration: { state: 'progressing', label: 'Progressing', needsRebase: false, tooltip: 't', name: 'calm-heron', title: 'calm-heron - Progressing' },
      archive: { prompt: true, dirty: 0, unpushed: 0 },
    }],
    capabilities: {},
    at: 1,
  }
  const services = {
    workspaces: {
      create: async ({ path }) => ({ path, workspaceId: 'workspace-1' }),
      archiveSession: async (id) => {
        calls.archive.push(id)
        return archive(calls.archive.length)
      },
    },
    sessions: {
      create: async ({ sessionId }) => sessionId,
      using: async (_id, _options, operation) => operation({ binding: { ctx: { get: () => ({ input: { for: () => ({ setDraft() {} }) } }) } } }),
    },
    uiWorkspace: { openSession: (id) => calls.opened.push(id) },
  }
  return { calls, snapshot, services }
}

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await flush()
}

test('the source of an agent-triggered conversion is archived once its turn has ended: refused attempts are retried with back-off', async () => {
  const timeouts = []
  const { calls, snapshot, services } = conversionFixture({
    archive: (attempt) => {
      if (attempt < 3) throw Object.assign(new Error('workspace/session-active'), { name: 'WorkspaceArchiveError' })
    },
  })
  const t = mountClient({ snapshot, services, timeouts })
  await settle()
  assert.deepEqual(calls.opened, ['session-new'], 'the continuation was opened')
  assert.deepEqual(calls.archive, ['session-src', 'session-src', 'session-src'], 'two refusals, then success, then no more attempts')
  assert.deepEqual(timeouts, [0, 3000, 8000])
  assert.deepEqual(t.warnings, [])
})

test('an archive that never succeeds is retried a bounded number of times and then logged, not swallowed', async () => {
  const timeouts = []
  const { calls, snapshot, services } = conversionFixture({
    archive: () => {
      throw new Error('workspace/session-active')
    },
  })
  const t = mountClient({ snapshot, services, timeouts })
  await settle()
  assert.equal(calls.archive.length, 6)
  assert.deepEqual(timeouts, [0, 3000, 8000, 20000, 45000, 90000])
  assert.equal(t.warnings.length, 1)
  assert.match(t.warnings[0], /gave up archiving the source session session-src after 6 attempts: workspace\/session-active/)
  assert.deepEqual(calls.opened, ['session-new'], 'the activation itself was not failed by the archive')
})

test('the Open folder row is hidden when the host has no folder opener, and a missing clipboard is reported', async () => {
  const noOpener = mountClient({ snapshot: { ...SNAPSHOT, capabilities: { folderOpener: null } } })
  await flush()
  await flush()
  const useMenuOpenState = () => [true, () => {}]
  const [copy, open] = ['better-git-worktree.copy-path', 'better-git-worktree.open-folder']
    .map((id) => noOpener.slots.winners('sidebar.workspaces.session.menu.item').find((e) => e.options.id === id))
  assert.ok(copy.component({ sessionId: 'session-wt', useMenuOpenState }))
  assert.equal(open.component({ sessionId: 'session-wt', useMenuOpenState }), null)

  // No clipboard: selecting "Copy worktree path" shows a notice instead of doing nothing.
  const item = expand(copy.component({ sessionId: 'session-wt', useMenuOpenState }))
  item.props.onSelect()
  const shown = find(overlay(noOpener), named('Modal'))
  assert.ok(shown, 'a notice dialog is open')
  assert.match(JSON.stringify(shown), /Clipboard access is unavailable here\./)
})

test('a clipboard failure is reported too', async () => {
  const t = mountClient({ snapshot: SNAPSHOT, clipboard: { writeText: async () => { throw new Error('denied') } } })
  await flush()
  await flush()
  const copy = t.slots.winners('sidebar.workspaces.session.menu.item').find((e) => e.options.id === 'better-git-worktree.copy-path')
  copy.component({ sessionId: 'session-wt', useMenuOpenState: () => [true, () => {}] }).props.onSelect()
  await flush()
  assert.match(JSON.stringify(find(overlay(t), named('Modal'))), /Could not copy the path: denied/)
})

const planOf = (fields) => ({ prompt: true, dirty: 0, unpushed: 0, stashes: 0, unknown: false, reasons: [], ...fields })
const copySnapshot = (archive, extra = {}) => ({
  worktrees: [{
    sessionId: 'session-wt',
    managedRoot: '/work/project/.dsh-worktrees/brave-otter',
    branch: 'dsh/brave-otter',
    decoration: { state: 'progressing', label: 'Progressing', needsRebase: false, tooltip: 't', name: 'brave-otter', title: 'brave-otter - Progressing' },
    archive,
    ...extra,
  }],
  capabilities: {},
  at: 1,
})

test('a copy whose status could not be read is "unknown", never "clean": Remove is disabled, Keep still works, and nothing is touched', async () => {
  const reason = 'could not read the working tree: fatal: unable to normalize alternate object path'
  const { order, services } = archivingServices(async () => {})
  const t = mountClient({ snapshot: copySnapshot(planOf({ unknown: true, reasons: [reason] })), services })
  const tree = await openRemoveDialog(t)
  const text = JSON.stringify(tree)
  assert.match(text, /Could not verify that this copy has no unsaved work; removing it may lose work\./)
  assert.match(text, /unable to normalize alternate object path/)
  assert.doesNotMatch(text, /The working copy is clean/)
  assert.equal(button(tree, 'primary').props.disabled, true)
  assert.equal(button(tree, 'outline').props.disabled, false, 'Keep (archive only) is still available')
  button(tree, 'primary').props.onClick()
  await flush()
  await flush()
  assert.deepEqual(order, [], 'nothing was archived')
  assert.equal(t.fetched.some((f) => f.url.endsWith('/remove')), false, 'nothing was removed')
})

test('the dialog warns about stash entries and unpushed commits separately from uncommitted files', async () => {
  const t = mountClient({ snapshot: copySnapshot(planOf({ dirty: 1, unpushed: 2, stashes: 3 })) })
  const text = JSON.stringify(await openRemoveDialog(t))
  assert.match(text, /1 uncommitted path\(s\) will be lost with it\./)
  assert.match(text, /2 unpushed commit\(s\)/)
  assert.match(text, /3 stash entries inside the copy/)
})

test('archiving the source row of a conversion cannot remove the copy its continuation still works in', async () => {
  const snapshot = copySnapshot(planOf(), { targetSessionId: 'session-new' })
  const { order, services } = archivingServices(async () => {})
  const t = mountClient({ snapshot, services })
  const tree = await openRemoveDialog(t)
  assert.equal(button(tree, 'primary').props.disabled, true)
  assert.match(JSON.stringify(tree), /Session session-new still works in this copy\. Remove is unavailable until that session is archived\./)
  button(tree, 'primary').props.onClick()
  await flush()
  assert.deepEqual(order, [])
  assert.equal(t.fetched.some((f) => f.url.endsWith('/remove')), false)

  // Archiving the continuation itself (the session that lives there) is not blocked.
  archivePrompt(t, 'session-new')
  const own = overlay(t)
  assert.equal(button(own, 'primary').props.disabled, false)
})

function archivePrompt(t, sessionId) {
  t.slots.winners('sidebar.workspaces.session.row.action').find((e) => e.options.id === 'archive').inject().archiveSession(sessionId)
}

test('the dialog reads the present state on open and re-reads it before removing: work done since is not deleted unseen', async () => {
  let fresh = 0
  const clean = copySnapshot(planOf())
  const dirtier = copySnapshot(planOf({ dirty: 3 }))
  const { order, services } = archivingServices(async () => {})
  const t = mountClient({ snapshot: (body) => (body.force ? (++fresh === 1 ? clean : dirtier) : clean), services })
  const tree = await openRemoveDialog(t)
  await flush()
  await flush()
  assert.ok(t.fetched.some((f) => f.url.endsWith('/snapshot') && f.body.force === true), 'a fresh (cache-bypassing) read was requested on open')
  button(tree, 'primary').props.onClick()
  await flush()
  await flush()
  assert.equal(fresh, 2, 'and once more just before removing')
  assert.deepEqual(order, [], 'the plan got worse, so nothing was archived')
  assert.equal(t.fetched.some((f) => f.url.endsWith('/remove')), false)
  assert.match(t.react.stateLog.at(-1).error, /changed while this dialog was open \(now 3 uncommitted path\(s\), 0 unpushed commit\(s\), 0 stash entries\)/)
})

test('a copy that becomes unverifiable between the dialog and Remove is not removed', async () => {
  let fresh = 0
  const { order, services } = archivingServices(async () => {})
  const t = mountClient({
    snapshot: (body) => (body.force && ++fresh > 1 ? copySnapshot(planOf({ unknown: true, reasons: ['timed out'] })) : copySnapshot(planOf())),
    services,
  })
  const tree = await openRemoveDialog(t)
  await flush()
  await flush()
  button(tree, 'primary').props.onClick()
  await flush()
  await flush()
  assert.deepEqual(order, [])
  assert.match(t.react.stateLog.at(-1).error, /Could not verify that this copy has no unsaved work, so it was not removed/)
})

test('after "archived but the copy could not be removed" the dialog names the path so removal can be retried', async () => {
  const { services } = archivingServices(async () => {})
  const t = mountClient({ snapshot: SNAPSHOT, services })
  const tree = await openRemoveDialog(t)
  t.failRemove()
  button(tree, 'primary').props.onClick()
  await flush()
  await flush()
  const last = t.react.stateLog.at(-1)
  assert.equal(last.archived, true)
  assert.match(last.error, /still at \/work\/project\/\.dsh-worktrees\/brave-otter; press Remove to try again/)
})

test('the source archive stops at once on a permanent error (the session is gone)', async () => {
  const timeouts = []
  const { calls, snapshot, services } = conversionFixture({
    archive: () => {
      throw Object.assign(new Error('session not found'), { name: 'WorkspaceArchiveError', rpcError: { code: 'session/not-found' } })
    },
  })
  const t = mountClient({ snapshot, services, timeouts })
  await settle()
  assert.equal(calls.archive.length, 1)
  assert.deepEqual(timeouts, [0])
  assert.match(t.warnings.join('\n'), /not archiving the source session session-src: session not found/)
})

test('a pending archive retry is cancelled when the plugin is disposed', async () => {
  const { calls, snapshot, services } = conversionFixture({
    archive: () => {
      throw new Error('workspace/session-active')
    },
  })
  const t = mountClient({ snapshot, services, holdTimeouts: true })
  await settle()
  assert.equal(t.held.size, 1, 'the first attempt is waiting')
  ;[...t.held.values()][0]()
  await settle()
  assert.equal(calls.archive.length, 1)
  assert.equal(t.held.size, 2, 'a retry is now scheduled (the first timer entry is spent)')
  for (const dispose of t.disposers) if (typeof dispose === 'function') dispose()
  assert.equal([...t.held.keys()].filter((id) => id !== 1).length, 0, 'the scheduled retry was cancelled')
})

for (const [label, failure] of [['an HTTP 500', { __http: 500 }], ['an ok:false answer', { __fail: 'host exploded' }]]) {
  test(`a forced re-read that fails (${label}) is a refusal: nothing is archived or removed on the stale snapshot`, async () => {
    let fresh = 0
    const { order, services } = archivingServices(async () => {})
    const t = mountClient({
      snapshot: (body) => (body.force && ++fresh > 1 ? failure : copySnapshot(planOf())),
      services,
    })
    const tree = await openRemoveDialog(t)
    await flush()
    await flush()
    assert.equal(fresh, 1, 'the open-time read succeeded')
    button(tree, 'primary').props.onClick()
    await flush()
    await flush()
    assert.equal(fresh, 2, 'the pre-remove read failed')
    assert.deepEqual(order, [], 'nothing was archived')
    assert.equal(t.fetched.some((f) => f.url.endsWith('/remove')), false, 'nothing was removed')
    assert.match(t.react.stateLog.at(-1).error, /could not be re-checked \(.+\), so it was not removed/)
  })
}

test('a slow older poll cannot overwrite a fresher forced snapshot', async () => {
  let releaseOld
  const behind = copySnapshot(planOf(), {})
  behind.worktrees[0].decoration = { ...behind.worktrees[0].decoration, state: 'behind', label: 'Behind' }
  const stale = copySnapshot(planOf())
  stale.worktrees[0].decoration = { ...stale.worktrees[0].decoration, state: 'progressing', label: 'Progressing' }
  let calls = 0
  const t = mountClient({
    snapshot: () => (++calls === 1 ? new Promise((resolve) => { releaseOld = () => resolve(stale) }) : behind),
  })
  await flush()
  // The poll started at mount is still in flight; the next poll starts later and answers first.
  t.poll()
  await flush()
  await flush()
  const badge = t.slots.winners('sidebar.session.row.leading')[0].component
  assert.equal(badge({ sessionId: 'session-wt' }).props['data-bgw-state'], 'behind', 'the forced answer is in')
  releaseOld()
  await flush()
  await flush()
  assert.equal(badge({ sessionId: 'session-wt' }).props['data-bgw-state'], 'behind', 'the older answer arrived later and was dropped')
})

test('the dialog tells about ignored files and half-done operations without blocking Remove', async () => {
  const t = mountClient({
    snapshot: copySnapshot(planOf({ ignored: { count: 7, examples: ['.env', 'node_modules/'] }, operations: ['a rebase is in progress'] })),
  })
  const tree = await openRemoveDialog(t)
  const text = JSON.stringify(tree)
  assert.match(text, /7 ignored file\(s\) or folder\(s\) will be deleted too, e\.g\. \.env, node_modules\/, \.\.\./)
  assert.match(text, /In progress: a rebase is in progress\./)
  assert.equal(button(tree, 'primary').props.disabled, false)
})

test('the source row of a conversion is unblocked once the continuation is archived', async () => {
  const snapshot = copySnapshot(planOf(), { targetSessionId: 'session-new' })
  const archived = []
  const { services } = archivingServices(async () => {})
  services.workspaces = { list: { getSnapshot: () => ({ archivedSessionIds: archived }) } }
  const live = mountClient({ snapshot, services })
  assert.equal(button(await openRemoveDialog(live), 'primary').props.disabled, true, 'blocked while the continuation is live')
  archived.push('session-new')
  const done = mountClient({ snapshot, services })
  assert.equal(button(await openRemoveDialog(done), 'primary').props.disabled, false, 'unblocked once it is archived')
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
