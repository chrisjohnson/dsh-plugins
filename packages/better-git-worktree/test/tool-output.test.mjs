// worktree_convert through the steps dsh's tool registry applies to a handler's
// return value (ToolRuntime.createSuccessResult in @deepseek-ai/dsh-tools):
// snapshotJsonValue (undefined means "not lossless JSON", and the call is marked
// failed), validateJsonSchemaValue against the declared output schema, then
// output.render. The real exported functions are used against the real host, a
// real temp repository and the real session class. Needs a dsh installation;
// on a bare clone these tests skip.

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

import { makeRepo, quietLog, tempDir } from './helpers.mjs'

let tools, util, session, host
try {
  tools = await import('@deepseek-ai/dsh-tools')
  util = await import('@deepseek-ai/dsh-util-values')
  session = await import('@deepseek-ai/dsh-session')
  host = await import('../src/host.mjs')
} catch {
  tools = undefined
}
const skip = tools === undefined ? 'dsh packages are not installed' : false

function boot(stateDir, { createAgent }) {
  const registered = new Map()
  const { log } = quietLog()
  const agents = new Map()
  const ctx = {
    logger: () => log,
    on: () => {},
    effect: () => {},
    get: (name) => {
      if (name === 'agents') return { get: (id) => agents.get(id), list: () => [...agents.values()] }
      if (name === 'agentLoop') return { createAgent }
      return undefined
    },
    inject: (_deps, fn) => fn({
      effect: (f) => f(),
      get: () => undefined,
      tools: { register: (definition) => registered.set(definition.name, definition) },
    }),
  }
  host.default(ctx, { stateDir })
  return { tool: registered.get('worktree_convert'), agents }
}

/** A live agent over a REAL Session whose log holds `completedTurns` turns and optionally an open one. */
function agentWith(id, cwd, { completedTurns, openTurn }) {
  const version = session.Session.create('probe').header.version
  const real = session.Session.create(id, undefined, { version, id, createdAt: Date.now(), cwd, isSeeded: false })
  for (let turn = 1; turn <= completedTurns; turn += 1) {
    real.append('turn/start', { turn })
    real.append('turn/end', { turn, reason: 'completed' })
  }
  if (openTurn) real.append('turn/start', { turn: completedTurns + 1 })
  return { id, session: real, ctx: { tools: { restrict() {} }, systemPrompt: { context() {} } } }
}

async function throughRegistry(definition, args, agent) {
  const returned = await definition.execute(args, { agent, signal: new AbortController().signal })
  const detached = util.snapshotJsonValue(returned)
  assert.notEqual(detached, undefined, `value is not lossless JSON: ${JSON.stringify(returned)}`)
  assert.deepEqual(tools.validateJsonSchemaValue(definition.output.schema, detached, 'value'), [])
  const text = definition.output.render(args, util.deepFreeze(detached)).map((block) => block.text).join('\n')
  return { value: detached, text, returned }
}

test('the check has teeth: an undefined property is not lossless JSON', { skip }, () => {
  assert.equal(util.snapshotJsonValue({ kind: 'x', baseRef: undefined }), undefined)
})

test('a conversion after a completed turn carries the conversation and passes dsh output validation', { skip }, async () => {
  const t = tempDir('bgw-tool-')
  try {
    const { repo } = makeRepo(t.dir, { remote: true })
    const seeded = []
    const { tool, agents } = boot(join(t.dir, 'state'), { createAgent: async (_ctx, options) => seeded.push(options) })
    const agent = agentWith('session-live', repo, { completedTurns: 2, openTurn: true })
    agents.set(agent.id, agent)
    writeFileSync(join(repo, 'tracked.txt'), 'wip\n')
    const { value, text } = await throughRegistry(tool, {}, agent)
    assert.equal(value.conversationCarried, true)
    assert.match(value.baseRef, /^origin\/main$/)
    assert.match(value.stashRef, /^[0-9a-f]{40}$/)
    assert.match(text, /Continuing in session session-[0-9a-f-]+, whose working directory is the worktree\./)
    assert.equal(seeded.length, 1)
    // The seed is the two completed turns, and the real session class accepts it as a fork prefix.
    assert.deepEqual(seeded[0].seed.map((event) => event.type), ['turn/start', 'turn/end', 'turn/start', 'turn/end'])
    assert.equal(seeded[0].inheritedEventCount, 4)
    const header = { version: agent.session.header.version, id: seeded[0].sessionId, createdAt: Date.now(), cwd: seeded[0].meta.cwd, parentSession: 'session-live', isSeeded: true }
    const child = session.Session.create(seeded[0].sessionId, seeded[0].seed, header, seeded[0].inheritedEventCount)
    assert.deepEqual(child.snapshotEvents().map((event) => event.type), [...seeded[0].seed.map((e) => e.type), 'session/end-seed'])
  } finally {
    t.cleanup()
  }
})

test('a conversion in the first turn has nothing to carry: a blank continuation, reported as such, and still valid output', { skip }, async () => {
  const t = tempDir('bgw-tool-')
  try {
    const { repo } = makeRepo(t.dir) // no remote, and a clean tree: no stash
    const seeded = []
    const { tool, agents } = boot(join(t.dir, 'state'), { createAgent: async (_ctx, options) => seeded.push(options) })
    const agent = agentWith('session-first', repo, { completedTurns: 0, openTurn: true })
    agents.set(agent.id, agent)
    const { value, text } = await throughRegistry(tool, {}, agent)
    assert.equal(value.conversationCarried, false)
    assert.equal(seeded[0].seed, undefined, 'no seed: the only turn is the one making the call')
    assert.equal(seeded[0].meta.isSeeded, undefined)
    assert.match(text, /A new session \(session-[0-9a-f-]+\) was created in the worktree; open it to continue there\./)
    assert.equal(value.baseRef, 'main', 'no remote: the comparison ref is the local default branch')
    assert.equal('stashRef' in value, false)
  } finally {
    t.cleanup()
  }
})

test('a failed session handoff still returns valid output (no undefined target)', { skip }, async () => {
  const t = tempDir('bgw-tool-')
  try {
    const { repo } = makeRepo(t.dir)
    const { tool, agents } = boot(join(t.dir, 'state'), { createAgent: async () => { throw new Error('agent loop is busy') } })
    const agent = agentWith('session-live', repo, { completedTurns: 1, openTurn: true })
    agents.set(agent.id, agent)
    const { value, text } = await throughRegistry(tool, {}, agent)
    assert.equal(value.conversationCarried, false)
    assert.equal('targetSessionId' in value, false)
    assert.match(text, /The worktree is ready but the session handoff failed: agent loop is busy/)
  } finally {
    t.cleanup()
  }
})
