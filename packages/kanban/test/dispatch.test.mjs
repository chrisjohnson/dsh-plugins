// The SessionDriver against a stubbed dsh context.
//
// The defect this covers: sessions are grouped by purpose, not role, so a build
// session that a human archived stayed in the driver's live map and every later
// phase in that purpose was dispatched into it. Core's archived-session gate
// then rejected the turn before its first step, the driver read the instant
// `blocked` end as a successful no-op turn, and the engine blamed the role for
// "not submitting". The driver now consults the workspace registry's archive
// set, fails loud when it is the only thing left, and treats `blocked` as a
// failure.
//
// It needs the peer dsh packages (dispatch.mjs imports createUserMessage,
// defineTool and setSandboxMode), so it skips on a bare clone, same as the other
// packages' host tests.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

let driverModule
try {
  await import('@deepseek-ai/dsh-llm')
  await import('@deepseek-ai/dsh-tools')
  await import('@deepseek-ai/dsh-sandbox-policy')
  driverModule = await import('../src/dispatch.mjs')
} catch {
  driverModule = undefined
}
const skip = driverModule === undefined ? 'dsh peer packages are not installed' : false

import { resolveConfig } from '../src/config.mjs'
import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'

const { SessionDriver, DispatchError } = driverModule ?? {}

const CWD = mkdtempSync(join(tmpdir(), 'kanban-dispatch-'))

function makeConfig() {
  return resolveConfig({
    autoPromote: false,
    roles: {
      planner: { provider: 'local', model: 'm', allowTools: ['read'] },
      implementer: { provider: 'local', model: 'm', allowTools: ['read', 'write', 'edit'] },
      reviewer: { provider: 'local', model: 'm', allowTools: ['read'] },
    },
    providers: [{ name: 'local' }],
    confidenceThreshold: 0.7,
    defaultWorkspaceCwd: CWD,
  }).config
}

/**
 * A stub dsh context: agents that record their prompts, a workspace registry
 * whose archive set the test controls, and the session event stream the driver
 * subscribes to.
 */
function makeCtx({ archived = [], store } = {}) {
  const listeners = {}
  const agentsById = new Map()
  const created = []
  const attached = []
  const makeAgent = (sessionId) => {
    const session = {
      id: sessionId,
      header: { id: sessionId },
      events: [],
      appended: [],
      append(type, data) {
        session.appended.push({ type, data })
      },
      snapshotEvents: () => session.events,
    }
    const agent = {
      id: sessionId,
      status: 'idle',
      session,
      prompts: [],
      ctx: {
        tools: {
          register: () => () => {},
          guard: () => {},
        },
      },
      followup: (message) => {
        agent.prompts.push(message)
      },
      cancel: () => {},
    }
    agentsById.set(sessionId, agent)
    return agent
  }
  const agents = {
    create: async (spec) => {
      const agent = makeAgent(spec.sessionId)
      const handle = { agent, dispose: async () => {} }
      created.push(spec.sessionId)
      if (typeof spec.setup === 'function') {
        await spec.setup(agent.ctx)
      }
      return handle
    },
    get: (sessionId) => agentsById.get(sessionId),
  }
  const ctx = {
    get(name) {
      if (name === 'agents') return agents
      if (name === 'agentPresets') return { mount: async () => {} }
      if (name === 'sessionController') return { selectForNextRequest: () => {} }
      if (name === 'workspaceRegistry') {
        return {
          get archivedSessionIds() {
            return archived.slice()
          },
          list: () => [{ path: CWD, attachSession: async (id) => { attached.push(id) } }],
        }
      }
      return undefined
    },
    on(name, fn) {
      listeners[name] = fn
      return () => { delete listeners[name] }
    },
  }
  return { ctx, agents, agentsById, archived, created, attached, listeners, store, makeAgent }
}

function makeDriver(options = {}) {
  const db = options.db
  const store = options.store
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  const driver = new SessionDriver({ ctx: options.ctx, log, getConfig: makeConfig, store })
  driver.start()
  return driver
}

function newStore() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return new KanbanStore(db)
}

function ticketFor(store) {
  return store.createTicket({
    title: 'dispatch fixture',
    acceptance: ['it works'],
    workspaceCwd: CWD,
    planTiming: 'at_pickup',
    planQuestions: 'autonomous',
  })
}

const ROUTE = { provider: 'local', model: 'm', reasoningEffort: null }

test('a live session that is not archived is reused for its purpose', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const first = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  const second = await driver.ensureTicketSession({ ticket, role: 'reviewer', route: ROUTE, purpose: 'build' })
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(harness.created.length, 1)
})

test('an archived live session is skipped for a non-archived one in the same purpose', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const archivedSession = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  // A second build session arrives the way a reopened one does: through reattach.
  const spareId = 'session-spare'
  store.attachSession({ ticketId: ticket.id, dshSessionId: spareId, role: 'build', purpose: 'build' })
  const spareAgent = harness.makeAgent(spareId)
  assert.equal(await driver.attachExistingSession(spareId, spareAgent), true)
  // The human archives the session the engine created first.
  harness.archived.push(archivedSession.sessionId)
  const next = await driver.ensureTicketSession({ ticket, role: 'reviewer', route: ROUTE, purpose: 'build' })
  assert.equal(next.sessionId, spareId)
  // Skipping is not evicting: unarchiving makes the original session eligible again.
  harness.archived.length = 0
  const back = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  assert.equal(back.sessionId, spareId)
  assert.ok(driver.isLive(archivedSession.sessionId))
})

test('SESSION_ARCHIVED names the archived session when it is the only live one', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const only = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  harness.archived.push(only.sessionId)
  await assert.rejects(
    () => driver.ensureTicketSession({ ticket, role: 'reviewer', route: ROUTE, purpose: 'build' }),
    (error) => {
      assert.ok(error instanceof DispatchError)
      assert.equal(error.code, 'SESSION_ARCHIVED')
      assert.equal(error.message, `workflow session ${only.sessionId} is archived; unarchive it and retry`)
      return true
    },
  )
  // No fresh session was created behind the archive, and nothing was evicted.
  assert.equal(harness.created.length, 1)
  assert.equal(driver.liveTicketSessions(ticket.id, 'build').length, 1)
})

test('a purpose with no live session at all still creates one', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const created = await driver.ensureTicketSession({ ticket, role: 'planner', route: ROUTE, purpose: 'plan' })
  assert.match(created.sessionId, /^session-/)
  assert.equal(harness.created.length, 1)
  assert.deepEqual(driver.liveTicketSessions(ticket.id, 'plan'), [created.sessionId])
})

test('attachExistingSession refuses an archived session', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const id = 'session-archived-reattach'
  store.attachSession({ ticketId: ticket.id, dshSessionId: id, role: 'build', purpose: 'build' })
  harness.archived.push(id)
  assert.equal(await driver.attachExistingSession(id, harness.makeAgent(id)), false)
  assert.equal(driver.isLive(id), false)
  assert.deepEqual(driver.liveTicketSessions(ticket.id, 'build'), [])
})

test('a turn that ends blocked settles as a failure, not a silent success', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const { sessionId } = await driver.ensureTicketSession({ ticket, role: 'reviewer', route: ROUTE, purpose: 'build' })
  const session = harness.agentsById.get(sessionId).session
  const pending = driver.sendTurn({ sessionId, prompt: 'review this', stallTimeoutMs: 60_000 })
  harness.listeners['session/event'](session, { type: 'turn/start', data: { turn: 1 }, time: Date.now() })
  harness.listeners['session/event'](session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'blocked' } },
    time: Date.now(),
  })
  const result = await pending
  assert.equal(result.status, 'failed')
  assert.match(result.error, /blocked/)
  assert.deepEqual(result.reason, { kind: 'blocked' })
})

test('a turn that ends with a model error keeps reporting the error message', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const { sessionId } = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  const session = harness.agentsById.get(sessionId).session
  const pending = driver.sendTurn({ sessionId, prompt: 'build this', stallTimeoutMs: 60_000 })
  harness.listeners['session/event'](session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { message: 'provider is down' } } },
    time: Date.now(),
  })
  const result = await pending
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'provider is down')
})

test('a completed turn still settles as success', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const { sessionId } = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  const session = harness.agentsById.get(sessionId).session
  const pending = driver.sendTurn({ sessionId, prompt: 'build this', stallTimeoutMs: 60_000 })
  harness.listeners['session/event'](session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
    time: Date.now(),
  })
  const result = await pending
  assert.equal(result.status, 'ok')
  assert.equal(result.error, null)
})
