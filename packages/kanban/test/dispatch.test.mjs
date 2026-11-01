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

const { SessionDriver, DispatchError, purposeForRole, roleForSession } = driverModule ?? {}

const CWD = mkdtempSync(join(tmpdir(), 'kanban-dispatch-'))

function makeConfig() {
  return resolveConfig({
    roles: {
      planner: { provider: 'local', model: 'm' },
      implementer: { provider: 'local', model: 'm' },
      reviewer: { provider: 'local', model: 'm' },
    },
    providers: [{ name: 'local' }],
    confidenceThreshold: 0.7,
    defaultWorkspaceCwd: CWD,
  }).config
}

/**
 * A stub dsh context: agents that record their prompts, a workspace registry
 * whose archive set the test controls, and the session event stream the driver
 * subscribes to. `failMount` lists preset ids whose mount throws — the shape
 * of a preset that was unregistered or no longer activates (KAN-15).
 */
function makeCtx({ archived = [], store, failMount = [] } = {}) {
  const listeners = {}
  const agentsById = new Map()
  const created = []
  const attached = []
  /** every presets.mount call, in order; undefined (harness default) as '<default>' */
  const mounts = []
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
      /** every tool the plugin registered into this agent, in order */
      registered: [],
      /** every tool guard the plugin registered — must stay empty (KAN-9) */
      guards: [],
      /** the sandbox/mode events this session has been given, oldest first */
      sandboxModes: () => session.appended.filter((e) => e.type === 'sandbox/mode').map((e) => e.data.mode),
      ctx: {
        tools: {
          register: (tool) => {
            agent.registered.push(tool)
            return () => {
              const at = agent.registered.indexOf(tool)
              if (at >= 0) agent.registered.splice(at, 1)
            }
          },
          guard: (fn) => {
            agent.guards.push(fn)
          },
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
      if (name === 'agentPresets') {
        return {
          defaultId: 'standard',
          async mount(agentCtx, id) {
            mounts.push(id === undefined ? '<default>' : id)
            if (id !== undefined && failMount.includes(id)) {
              throw Object.assign(new Error(`Unknown agent preset: ${id}`), { code: 'agent-preset/not-found' })
            }
            return { id: id ?? 'standard' }
          },
        }
      }
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
  return { ctx, agents, agentsById, archived, created, attached, listeners, store, makeAgent, mounts }
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

// ---------------------------------------------------------------- KAN-9 tools
//
// A workflow session runs the bone standard preset, so every standard tool a
// normal session has is available to every role. Kanban's own contribution is
// the five action tools, and they are all present in all three purposes with the
// phase check inside each tool — a session that changes phase (implement ->
// review) or is reattached after a restart never finds a tool missing.

const ACTION_TOOLS = [
  'kanban_submit_plan',
  'kanban_submit_implementation',
  'kanban_submit_review',
  'kanban_approve',
  'kanban_discard',
  'kanban_plan',
]

const PLAN_VALUE = {
  summary: 'do the thing',
  steps: ['step one'],
  done_when: [{ id: 'a', statement: 'A holds', how_verified: 'node --test' }],
}

const IMPLEMENT_VALUE = {
  status: 'complete',
  summary: 'did the thing',
  changed_files: ['src/x.mjs'],
  done_when: [{ id: 'a', met: true, confidence: 0.9, evidence: 'tests pass' }],
}

const REVIEW_VALUE = {
  verdict: 'pass',
  reasons: ['matches the plan'],
  done_when: [{ id: 'a', met: true, confidence: 0.9, evidence: 'tests pass' }],
}

function toolOf(agent, name) {
  const tool = agent.registered.find((item) => item.name === name)
  assert.ok(tool, `${name} is not registered (registered: ${agent.registered.map((t) => t.name).join(', ') || 'none'})`)
  return tool
}

const EXEC = () => ({ concluded: 0, concludeTurn() { this.concluded += 1 } })

test('all six action tools are registered in every workflow session purpose', { skip }, async () => {
  for (const [purpose, role] of [['plan', 'planner'], ['build', 'implementer'], ['build', 'approver']]) {
    const store = newStore()
    const ticket = ticketFor(store)
    const harness = makeCtx({ store })
    const driver = makeDriver({ ...harness, store })
    const { sessionId } = await driver.ensureTicketSession({ ticket, role, route: ROUTE, purpose })
    const agent = harness.agentsById.get(sessionId)
    assert.deepEqual(
      agent.registered.map((tool) => tool.name).sort(),
      [...ACTION_TOOLS].sort(),
      `the ${purpose} session must carry every action tool`,
    )
  }
})

test('a reattached session registers every action tool too', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const id = 'session-reattach-tools'
  store.attachSession({ ticketId: ticket.id, dshSessionId: id, role: 'build', purpose: 'build' })
  const agent = harness.makeAgent(id)
  assert.equal(await driver.attachExistingSession(id, agent), true)
  assert.deepEqual(agent.registered.map((tool) => tool.name).sort(), [...ACTION_TOOLS].sort())
})

test('kanban registers no tool guard at all, so standard tools are undenied', { skip }, async () => {
  for (const [purpose, role] of [['plan', 'planner'], ['build', 'implementer'], ['build', 'approver']]) {
    const store = newStore()
    const ticket = ticketFor(store)
    const harness = makeCtx({ store })
    const driver = makeDriver({ ...harness, store })
    const { sessionId } = await driver.ensureTicketSession({ ticket, role, route: ROUTE, purpose })
    const agent = harness.agentsById.get(sessionId)
    // The old phase guard denied todo_write and ask_user_question in a build
    // session; with no guard registered nothing can deny a standard tool.
    assert.deepEqual(agent.guards, [], `the ${purpose} session must have no tool guard`)
  }
})

test('the sandbox mode follows the purpose, and a phase change leaves it alone', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const plan = await driver.ensureTicketSession({ ticket, role: 'planner', route: ROUTE, purpose: 'plan' })
  const build = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  assert.deepEqual(harness.agentsById.get(plan.sessionId).sandboxModes(), ['read-only'])
  assert.deepEqual(harness.agentsById.get(build.sessionId).sandboxModes(), ['workspace-write'])
  // implement -> review -> approval inside the one build session: the mode never
  // moves, so the approver can still merge or deploy what it built.
  driver.setPhase(build.sessionId, 'reviewer')
  assert.equal(driver.live.get(build.sessionId).role, 'reviewer')
  assert.deepEqual(harness.agentsById.get(build.sessionId).sandboxModes(), ['workspace-write'])
  driver.setPhase(build.sessionId, 'approver')
  assert.equal(driver.live.get(build.sessionId).role, 'approver')
  assert.deepEqual(harness.agentsById.get(build.sessionId).sandboxModes(), ['workspace-write'])
})

test('an action tool refuses a call that does not belong to its phase', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  driver.approval = { approve: async () => {}, discard: async () => {}, plan: async () => {} }
  const { sessionId } = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  const agent = harness.agentsById.get(sessionId)
  await assert.rejects(() => toolOf(agent, 'kanban_approve').execute({}, EXEC()), /kanban_approve is not available in the implementer phase/)
  await assert.rejects(() => toolOf(agent, 'kanban_discard').execute({}, EXEC()), /kanban_discard is not available in the implementer phase/)
  await assert.rejects(() => toolOf(agent, 'kanban_submit_review').execute(REVIEW_VALUE, EXEC()), /kanban_submit_review is not available in the implementer phase/)
  await assert.rejects(() => toolOf(agent, 'kanban_submit_plan').execute(PLAN_VALUE, EXEC()), /kanban_submit_plan is not available in the implementer phase/)
  // The reviewer half of the same session: implementation is now the wrong call.
  driver.setPhase(sessionId, 'reviewer')
  await assert.rejects(() => toolOf(agent, 'kanban_submit_implementation').execute(IMPLEMENT_VALUE, EXEC()), /kanban_submit_implementation is not available in the reviewer phase/)
  await assert.rejects(() => toolOf(agent, 'kanban_approve').execute({}, EXEC()), /kanban_approve is not available in the reviewer phase/)
  // And the approval half: the build tools are the wrong calls, the approval
  // tools are not. This is the same session, only its phase has moved.
  driver.setPhase(sessionId, 'approver')
  await assert.rejects(() => toolOf(agent, 'kanban_submit_implementation').execute(IMPLEMENT_VALUE, EXEC()), /not available in the approver phase/)
  await assert.rejects(() => toolOf(agent, 'kanban_submit_review').execute(REVIEW_VALUE, EXEC()), /not available in the approver phase/)
  assert.deepEqual(await toolOf(agent, 'kanban_approve').execute({}, EXEC()), { accepted: true })
})

test('the right action tool in the right phase is accepted', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const { sessionId } = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  const agent = harness.agentsById.get(sessionId)
  const exec = EXEC()
  assert.deepEqual(await toolOf(agent, 'kanban_submit_implementation').execute(IMPLEMENT_VALUE, exec), {
    accepted: true,
    action: 'implementation',
    manual: true,
  })
  assert.equal(exec.concluded, 1)
  assert.equal(driver.actions.get(sessionId).type, 'implementation')
  driver.setPhase(sessionId, 'reviewer')
  assert.equal((await toolOf(agent, 'kanban_submit_review').execute(REVIEW_VALUE, EXEC())).action, 'review')
})

test('kanban_submit_plan branches on the phase: planner submits, approver re-plans', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const planned = []
  driver.approval = { plan: async (ticketId, value) => { planned.push([ticketId, value]) } }

  const planSession = await driver.ensureTicketSession({ ticket, role: 'planner', route: ROUTE, purpose: 'plan' })
  const planAgent = harness.agentsById.get(planSession.sessionId)
  const planExec = EXEC()
  assert.deepEqual(await toolOf(planAgent, 'kanban_submit_plan').execute(PLAN_VALUE, planExec), {
    accepted: true,
    action: 'plan',
    manual: true,
  })
  assert.equal(driver.actions.get(planSession.sessionId).type, 'plan')
  assert.deepEqual(planned, [], 'the planner branch must not touch the approval handlers')

  const approvalPhase = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  driver.setPhase(approvalPhase.sessionId, 'approver')
  const approvalAgent = harness.agentsById.get(approvalPhase.sessionId)
  const approvalExec = EXEC()
  assert.deepEqual(await toolOf(approvalAgent, 'kanban_submit_plan').execute(PLAN_VALUE, approvalExec), { accepted: true })
  assert.equal(approvalExec.concluded, 1)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(planned, [[ticket.id, PLAN_VALUE]])
})

test('a plan payload is rejected before the phase branch accepts it', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  driver.approval = { plan: async () => {} }
  const { sessionId } = await driver.ensureTicketSession({ ticket, role: 'planner', route: ROUTE, purpose: 'plan' })
  const agent = harness.agentsById.get(sessionId)
  await assert.rejects(
    () => toolOf(agent, 'kanban_submit_plan').execute({ ...PLAN_VALUE, done_when: [] }, EXEC()),
    /done_when/,
  )
})

// ------------------------------------------------- KAN-11 approval is a build phase
//
// Approval no longer has a session of its own: the build session carries it, so
// a session reopened after a restart has to come back as the phase its ticket is
// actually in. A `verify` ticket's build session is an approver — the approval
// tools accept there and the build tools refuse — and the pre-0.7.0 rows whose
// purpose was literally `approval` keep reattaching the same way.

test('approval is a phase of the build session, not a purpose of its own', { skip }, () => {
  assert.equal(purposeForRole('approver'), 'build')
  assert.equal(purposeForRole('implementer'), 'build')
  assert.equal(purposeForRole('reviewer'), 'build')
  assert.equal(purposeForRole('planner'), 'plan')
  assert.throws(() => purposeForRole('orchestrator'), /NO_PURPOSE|no workflow session purpose/)
})

test('roleForSession reads the ticket phase for a build session', { skip }, () => {
  assert.equal(roleForSession('plan', { phase: 'plan' }), 'planner')
  assert.equal(roleForSession('build', { phase: 'implement' }), 'implementer')
  assert.equal(roleForSession('build', { phase: 'review' }), 'reviewer')
  assert.equal(roleForSession('build', { phase: 'verify' }), 'approver')
  // The legacy purpose, kept so rows written before 0.7.0 still come back live.
  assert.equal(roleForSession('approval', { phase: 'verify' }), 'approver')
})

test('a reopened build session whose ticket is awaiting approval comes back as the approver', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine' })
  store.transitionTicket(ticket.id, { phase: 'review' }, { actor: 'engine' })
  store.transitionTicket(ticket.id, { phase: 'verify' }, { actor: 'engine' })
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  driver.approval = { approve: async () => {}, discard: async () => {}, plan: async () => {} }
  const id = 'session-reattach-approver'
  store.attachSession({ ticketId: ticket.id, dshSessionId: id, role: 'build', purpose: 'build' })
  const agent = harness.makeAgent(id)
  assert.equal(await driver.attachExistingSession(id, agent), true)
  assert.equal(driver.live.get(id).role, 'approver')
  assert.equal(driver.liveTicketSession(ticket.id, 'build'), id)
  // The approval tools accept in this session; the build tools refuse it.
  assert.deepEqual(await toolOf(agent, 'kanban_approve').execute({}, EXEC()), { accepted: true })
  await assert.rejects(
    () => toolOf(agent, 'kanban_submit_implementation').execute(IMPLEMENT_VALUE, EXEC()),
    /kanban_submit_implementation is not available in the approver phase/,
  )
  await assert.rejects(
    () => toolOf(agent, 'kanban_submit_review').execute(REVIEW_VALUE, EXEC()),
    /kanban_submit_review is not available in the approver phase/,
  )
})

test('a pre-0.7.0 approval-purpose row still reattaches as the approver', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine' })
  store.transitionTicket(ticket.id, { phase: 'review' }, { actor: 'engine' })
  store.transitionTicket(ticket.id, { phase: 'verify' }, { actor: 'engine' })
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const id = 'session-legacy-approval'
  store.attachSession({ ticketId: ticket.id, dshSessionId: id, role: 'approval', purpose: 'approval' })
  assert.equal(await driver.attachExistingSession(id, harness.makeAgent(id)), true)
  assert.equal(driver.live.get(id).role, 'approver')
})

// ------------------------------------------------------- KAN-15 ticket options
//
// A ticket chooses its build session's preset and write mode at creation; plan
// and verify stay fixed on the standard preset and read-only. NULL on either
// column must reproduce the pre-0.12.0 behavior exactly.

test('a build session mounts the ticket preset while the plan session stays standard', { skip }, async () => {
  const store = newStore()
  const ticket = store.createTicket({ title: 't', workspaceCwd: CWD, preset: 'ptc' })
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const build = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  const plan = await driver.ensureTicketSession({ ticket, role: 'planner', route: ROUTE, purpose: 'plan' })
  assert.deepEqual(harness.mounts, ['ptc', 'standard'])
  assert.equal(driver.live.get(build.sessionId).preset, 'ptc')
  assert.equal(driver.live.get(plan.sessionId).preset, 'standard')
  assert.equal(build.preset, 'ptc', 'the returned preset is what the engine records on the session row')
})

test('a default ticket mounts the harness default for build and standard for plan', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const build = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  const plan = await driver.ensureTicketSession({ ticket, role: 'planner', route: ROUTE, purpose: 'plan' })
  // undefined = the registry's own default, so the ticket keeps tracking it.
  assert.deepEqual(harness.mounts, ['<default>', 'standard'])
  assert.equal(driver.live.get(build.sessionId).preset, 'standard')
})

test('the build sandbox mode follows the ticket write mode; plan and verify stay read-only', { skip }, async () => {
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    const store = newStore()
    const ticket = store.createTicket({ title: 't', workspaceCwd: CWD, writeMode: mode })
    const harness = makeCtx({ store })
    const driver = makeDriver({ ...harness, store })
    const build = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
    assert.deepEqual(harness.agentsById.get(build.sessionId).sandboxModes(), [mode])
    const plan = await driver.ensureTicketSession({ ticket, role: 'planner', route: ROUTE, purpose: 'plan' })
    assert.deepEqual(harness.agentsById.get(plan.sessionId).sandboxModes(), ['read-only'])
  }
})

test('a NULL write mode reproduces the legacy workspace-write build default', { skip }, async () => {
  const store = newStore()
  const ticket = ticketFor(store)
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const build = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  assert.equal(driver.live.get(build.sessionId).writeMode, null)
  assert.deepEqual(harness.agentsById.get(build.sessionId).sandboxModes(), ['workspace-write'])
})

test('a vanished preset falls back to the harness default with a warning and an event', { skip }, async () => {
  const store = newStore()
  const ticket = store.createTicket({ title: 't', workspaceCwd: CWD, preset: 'gone' })
  const harness = makeCtx({ store, failMount: ['gone'] })
  const warnings = []
  const log = { info() {}, warn(...args) { warnings.push(args.join(' ')) }, error() {}, debug() {} }
  const driver = new SessionDriver({ ctx: harness.ctx, log, getConfig: makeConfig, store })
  driver.start()
  const build = await driver.ensureTicketSession({ ticket, role: 'implementer', route: ROUTE, purpose: 'build' })
  // The requested id failed; the default mount succeeded; the session lives.
  assert.deepEqual(harness.mounts, ['gone', '<default>'])
  assert.equal(driver.live.get(build.sessionId).preset, 'standard')
  assert.ok(
    warnings.some((w) => /could not be mounted/.test(w) && w.includes('gone')),
    `expected a fallback warning naming the preset, got: ${warnings.join(' | ')}`,
  )
  const events = store.listEvents(ticket.id).filter((e) => e.kind === 'preset_fallback')
  assert.equal(events.length, 1)
  assert.equal(events[0].payload.requested, 'gone')
  assert.equal(events[0].payload.used, 'standard')
})

test('a reattached build session re-applies the ticket write mode and preset', { skip }, async () => {
  const store = newStore()
  const ticket = store.createTicket({ title: 't', workspaceCwd: CWD, preset: 'ptc', writeMode: 'read-only' })
  const harness = makeCtx({ store })
  const driver = makeDriver({ ...harness, store })
  const id = 'session-reattach-options'
  store.attachSession({ ticketId: ticket.id, dshSessionId: id, role: 'build', purpose: 'build' })
  const agent = harness.makeAgent(id)
  assert.equal(await driver.attachExistingSession(id, agent), true)
  assert.deepEqual(agent.sandboxModes(), ['read-only'])
  assert.equal(driver.live.get(id).writeMode, 'read-only')
  assert.equal(driver.live.get(id).preset, 'ptc')
})
