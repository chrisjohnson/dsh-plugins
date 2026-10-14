// The real host half, mounted on a mock context: the plugin-owned route, the
// worktree_convert tool (built by the real defineTool from @deepseek-ai/dsh-tools),
// the per-agent prompt context and tool restriction, and a registry written in the
// v1 shape found through DSH_HOME. Needs @deepseek-ai/dsh-tools; on a bare clone
// without a dsh installation these tests skip rather than fail.

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { makeRepo, quietLog, tempDir } from './helpers.mjs'
import { REGISTRY_FILE } from '../src/registry.mjs'

let host
let hostModule
try {
  await import('@deepseek-ai/dsh-tools')
  hostModule = await import('../src/host.mjs')
  host = hostModule.default
} catch {
  host = undefined
}
const skip = host === undefined ? 'no @deepseek-ai/dsh-tools installed' : false

function mount({ agents = [], config = {}, services = {} } = {}) {
  const { log } = quietLog()
  const registered = { routes: [], tools: [], contexts: [] }
  const listeners = {}
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]))
  const created = []
  const root = {
    logger: () => log,
    on: (name, fn) => (listeners[name] = fn),
    effect: () => {},
    get: (name) => {
      if (name === 'agents') return { get: (id) => agentMap.get(id), list: () => [...agentMap.values()] }
      if (name === 'agentLoop') return { createAgent: async (_ctx, options) => created.push(options) }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (name === 'agentPresets') return { composedPreset: () => 'standard' }
      return services[name]
    },
    inject: (_names, callback) => {
      callback({
        effect: (fn) => fn(),
        get: (name) => (name === 'webServer' ? { register: (route) => registered.routes.push(route) } : { requestRejection: () => undefined }),
        tools: { register: (definition) => registered.tools.push(definition) },
      })
    },
  }
  host(root, config)
  return { registered, listeners, created, agentMap, tool: () => registered.tools.find((t) => t.name === 'worktree_convert'), route: () => registered.routes[0] }
}

function makeAgent(id, cwd) {
  const restrictions = []
  const contexts = []
  return {
    id,
    session: {
      id,
      header: { cwd },
      snapshotEvents: () => [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: 'completed' } },
      ],
    },
    ctx: {
      tools: { restrict: (filter) => restrictions.push(filter) },
      systemPrompt: { context: (entry) => contexts.push(entry) },
    },
    restrictions,
    contexts,
  }
}

async function call(route, endpoint, payload, method = 'POST') {
  const req = new EventEmitter()
  req.method = method
  req.url = `/betterGitWorktree/${endpoint}`
  const res = { status: undefined, headers: undefined, body: undefined, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
  const done = route.handler(req, res)
  req.emit('data', Buffer.from(JSON.stringify(payload ?? {})))
  req.emit('end')
  await done
  return { status: res.status, headers: res.headers, json: res.body && res.body.startsWith('{') ? JSON.parse(res.body) : res.body }
}

// The v1 registry for the "15 sessions bound to copies" case: records written the
// way put() writes them, found through DSH_HOME with no configuration at all.
function v1Registry(root, copies) {
  return {
    version: 1,
    worktrees: Object.fromEntries(copies.map(({ sessionId, managedRoot, pet }) => [sessionId, {
      sessionId,
      origin: 'pre-session',
      repoRoot: root,
      managedRoot,
      branch: `dsh/${pet}`,
      petName: pet,
      baseBranch: 'main',
      baseRef: 'origin/main',
      activated: true,
      createdAt: 1700000000000,
    }])),
  }
}

test('existing bound sessions keep their status and binding: the registry is found under DSH_HOME and served', { skip }, async () => {
  const { dir, cleanup } = tempDir('bgw-host-')
  const previous = process.env.DSH_HOME
  try {
    const { repo } = makeRepo(dir)
    const copies = []
    for (let i = 0; i < 15; i += 1) {
      const managedRoot = join(repo, '.dsh-worktrees', `pet-${i}`)
      mkdirSync(managedRoot, { recursive: true })
      copies.push({ sessionId: `session-${i}`, managedRoot, pet: `pet-${i}` })
    }
    const home = join(dir, 'dsh-home')
    mkdirSync(join(home, 'plugins', 'dsh-better-git-worktree'), { recursive: true })
    const registryFile = join(home, 'plugins', 'dsh-better-git-worktree', REGISTRY_FILE)
    const before = `${JSON.stringify(v1Registry(repo, copies), null, 2)}\n`
    writeFileSync(registryFile, before)
    process.env.DSH_HOME = home

    const agents = copies.map(({ sessionId, managedRoot }) => makeAgent(sessionId, managedRoot))
    const m = mount({ agents })

    const { status, json } = await call(m.route(), 'snapshot', {})
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.value.worktrees.length, 15)
    const byId = Object.fromEntries(json.value.worktrees.map((w) => [w.sessionId, w]))
    for (const { sessionId, managedRoot, pet } of copies) {
      assert.equal(byId[sessionId].managedRoot, managedRoot, 'binding kept')
      assert.equal(byId[sessionId].petName, pet)
      assert.equal(byId[sessionId].activated, true)
      assert.ok(byId[sessionId].decoration, 'every bound session has a status to show')
    }
    assert.equal(readFileSync(registryFile, 'utf8'), before, 'serving the registry does not rewrite it')

    // Every bound agent got the prompt context (for its own record) and lost the tool.
    for (const [index, agent] of agents.entries()) {
      assert.deepEqual(agent.restrictions, [{ deny: ['worktree_convert'] }])
      assert.equal(agent.contexts.length, 1)
      assert.equal(agent.contexts[0].name, 'better-git-worktree:session-root')
      assert.equal(agent.contexts[0].order, 118)
      const text = agent.contexts[0].text()
      assert.match(text, new RegExp(`Authoritative working directory: ${copies[index].managedRoot}`))
      assert.match(text, /Branch: dsh\/pet-\d+ \(compares against origin\/main\)/)
      assert.match(text, /no escalation/)
      assert.doesNotMatch(text, /linked|denied|pre-approves|sandbox_permissions/i)
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    cleanup()
  }
})

test('the route enforces the connection trust fence and only answers POST', { skip }, async () => {
  const { dir, cleanup } = tempDir('bgw-host-')
  try {
    const m = mount({ config: { stateDir: join(dir, 'state') } })
    const route = m.route()
    assert.equal(route.kind, 'prefix')
    assert.equal(route.path, '/betterGitWorktree')
    assert.equal((await call(route, 'snapshot', {}, 'GET')).status, 405)
    assert.equal((await call(route, 'nonsense', {})).json.error.code, 'unknown-endpoint')
  } finally {
    cleanup()
  }
})

test('the full path: route prepare, then the tool converts another session, V4 seed and all', { skip }, async () => {
  const { dir, cleanup } = tempDir('bgw-host-')
  try {
    const { repo } = makeRepo(dir, { remote: true })
    const live = makeAgent('session-live', repo)
    const blank = makeAgent('session-blank', repo)
    const m = mount({ agents: [live, blank], config: { stateDir: join(dir, 'state') } })

    const prepared = await call(m.route(), 'prepare', { sourceSessionId: 'session-blank', targetSessionId: 'session-target' })
    assert.equal(prepared.json.ok, true)
    const state = JSON.parse(readFileSync(join(dir, 'state', REGISTRY_FILE), 'utf8'))
    assert.deepEqual(Object.keys(state.worktrees), ['session-target'])

    // The tool, as the model calls it.
    const tool = m.tool()
    assert.ok(tool, 'worktree_convert is registered')
    writeFileSync(join(repo, 'tracked.txt'), 'wip\n')
    const out = await tool.execute({}, { agent: live })
    assert.equal(out.kind, 'worktree_converted')
    assert.equal(out.conversationCarried, true)
    assert.equal(out.movedFiles, 1)
    assert.match(out.detail, /Moved this session into a git worktree\./)
    assert.match(out.detail, new RegExp(`Continuing in session ${out.targetSessionId}`))
    assert.equal(m.created.length, 1)
    const options = m.created[0]
    assert.equal(options.sessionId, out.targetSessionId)
    assert.equal(options.meta.cwd, out.managedRoot)
    assert.equal(options.meta.parentSession, 'session-live')
    assert.equal(options.meta.isSeeded, true)
    assert.equal(options.meta.agentPreset, 'standard')
    assert.equal(options.seed.length, 2)
    assert.equal(options.seed.at(-1).type, 'turn/end')
    assert.equal(options.inheritedEventCount, 2)
    assert.deepEqual(options.agentOptions, { provider: 'p', model: 'm' })

    // Converting again is refused with the reason.
    await assert.rejects(tool.execute({}, { agent: live }), /already a worktree session/)
    await assert.rejects(tool.execute({}, {}), /only run inside a DSH session/)
  } finally {
    cleanup()
  }
})

test('a new agent in a worktree gets the tool hidden; a plain one keeps it and gets an empty context', { skip }, async () => {
  const { dir, cleanup } = tempDir('bgw-host-')
  try {
    const { repo } = makeRepo(dir)
    const copy = join(repo, '.dsh-worktrees', 'brave-otter')
    mkdirSync(copy, { recursive: true })
    mkdirSync(join(dir, 'state'))
    writeFileSync(join(dir, 'state', REGISTRY_FILE), JSON.stringify(v1Registry(repo, [{ sessionId: 'session-b', managedRoot: copy, pet: 'brave-otter' }])))
    const m = mount({ config: { stateDir: join(dir, 'state') } })
    const inCopy = makeAgent('session-continued', copy)
    const plain = makeAgent('session-plain', repo)
    await m.listeners['agent/created']({ agent: inCopy })
    await m.listeners['agent/created']({ agent: plain })
    await m.listeners['agent/created']({ agent: plain })
    assert.deepEqual(inCopy.restrictions, [{ deny: ['worktree_convert'] }], 'rooted in a managed copy')
    assert.deepEqual(plain.restrictions, [])
    assert.equal(plain.contexts.length, 1, 'composed once')
    assert.equal(plain.contexts[0].text(), '')
  } finally {
    cleanup()
  }
})

test('an unreadable registry is reported at boot and never rewritten', { skip }, async () => {
  const { dir, cleanup } = tempDir('bgw-host-')
  try {
    mkdirSync(join(dir, 'state'))
    const file = join(dir, 'state', REGISTRY_FILE)
    writeFileSync(file, '{"version": 2, "worktrees": {}}')
    const { log, calls } = quietLog()
    const ctx = { logger: () => log, on: () => {}, effect: () => {}, get: () => undefined, inject: () => {} }
    host(ctx, { stateDir: join(dir, 'state') })
    assert.ok(calls.warn.some((line) => /registry version 2/.test(line)), calls.warn.join('\n'))
    assert.equal(readFileSync(file, 'utf8'), '{"version": 2, "worktrees": {}}')
    assert.equal(existsSync(join(dir, 'state', `${REGISTRY_FILE}.tmp`)), false)
  } finally {
    cleanup()
  }
})

test('prompt and report texts are accurate for a self-contained copy', { skip }, () => {
  const text = hostModule.sessionRootContext({ managedRoot: '/w/c', branch: 'dsh/c', baseRef: 'origin/main' })
  assert.match(text, /self-contained git working copy/)
  assert.doesNotMatch(text, /linked|escalat.*retry/i)
  const report = hostModule.convertReport(
    { ok: false, error: 'no loop', record: { managedRoot: '/w/c', branch: 'dsh/c' }, move: { moved: false, files: 0 } },
    undefined,
  )
  assert.equal(report.conversationCarried, false)
  assert.equal(report.status, 'progressing')
  assert.match(report.detail, /session handoff failed: no loop/)
})
