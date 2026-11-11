// KAN-81: the five ticket-management tools on ordinary sessions.
//
// Two promises hold this feature up, and both are decisions rather than wiring,
// so both are testable without a harness:
//
//   1. An interactive session gets *the same* tools the orchestrator has, not a
//      paraphrase of them. Same specs, same guards, same refusal messages — one
//      shared list, so a rule fixed for the orchestrator is fixed everywhere.
//   2. A session the board already owns does not get them at all. A build session
//      that can discard its own ticket can end its own review; that is the one
//      thing this feature must never allow.
//
// Plus the one behavioral difference from the orchestrator's runner: a paused
// orchestrator stops the engine's driver, not the board, so it must not hide the
// board from everyone else.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MANAGEMENT_TOOL_NAMES,
  MANAGEMENT_TOOL_SPECS,
  ORCHESTRATOR_TOOL_NAMES,
  ORCHESTRATOR_TOOL_SPECS,
  runManagementTool,
  runOrchestratorTool,
} from '../src/orchestrator.mjs'
import {
  agentSessionId,
  isBoardOwnedSession,
  managementActor,
  managementToolWhen,
} from '../src/agent-tools.mjs'

// ------------------------------------------------------- the shared five specs --

test('the management list is exactly the five ticket-management tools', () => {
  assert.deepEqual(MANAGEMENT_TOOL_NAMES, [
    'kanban_board',
    'kanban_ticket',
    'kanban_create',
    'kanban_edit',
    'kanban_discard',
  ])
  assert.deepEqual(MANAGEMENT_TOOL_SPECS.map((spec) => spec.name), MANAGEMENT_TOOL_NAMES)
})

test('the orchestrator still offers all twelve, and the five are the same objects', () => {
  // Not a copy: one spec, two registrations. A guard fixed in the management
  // list is fixed for the orchestrator too, and vice versa.
  for (const spec of MANAGEMENT_TOOL_SPECS) {
    assert.equal(ORCHESTRATOR_TOOL_SPECS.includes(spec), true, `${spec.name} must be shared by identity`)
  }
  assert.equal(ORCHESTRATOR_TOOL_SPECS.length, 12)
  assert.deepEqual([...ORCHESTRATOR_TOOL_NAMES].sort(), [
    'kanban_board',
    'kanban_configure',
    'kanban_create',
    'kanban_discard',
    'kanban_edit',
    'kanban_kick',
    'kanban_message',
    'kanban_move',
    'kanban_retry',
    'kanban_sessions',
    'kanban_start',
    'kanban_ticket',
  ])
  assert.equal(new Set(ORCHESTRATOR_TOOL_NAMES).size, ORCHESTRATOR_TOOL_NAMES.length, 'no name is registered twice')
})

test('every management spec is a complete model-facing contract', () => {
  for (const spec of MANAGEMENT_TOOL_SPECS) {
    assert.match(spec.name, /^kanban_/)
    assert.ok(spec.description.length > 40, `${spec.name} has a thin description`)
    assert.equal(typeof spec.parameters, 'object')
    assert.equal(typeof spec.guard, 'function')
    assert.equal(typeof spec.run, 'function')
  }
})

// ------------------------------------------------------------------ the store --

const fakeTicket = (over = {}) => ({
  id: 't-1',
  key: 'KAN-1',
  title: 'A ticket',
  column: 'working',
  phase: 'implement',
  needsAttentionReason: null,
  attemptCount: 1,
  body: 'the body',
  ...over,
})

function fakeApi(over = {}) {
  const calls = []
  const record = (name) => (...args) => {
    calls.push([name, ...args])
    return over[name] === undefined ? { ok: true } : over[name](...args)
  }
  return {
    calls,
    api: {
      resolveTicket: (key) => (key === 'KAN-1' || key === 't-1' ? (over.ticket ?? fakeTicket()) : null),
      board: record('board'),
      ticket: record('ticket'),
      create: record('create'),
      edit: record('edit'),
      ticketEditable: () => (over.ticketEditable === undefined ? true : over.ticketEditable),
      discard: record('discard'),
      sessions: record('sessions'),
    },
  }
}

// ---------------------------------------------------------- runManagementTool --

test('each management tool reaches the host seam the orchestrator’s tools reach', async () => {
  const { calls, api } = fakeApi()
  assert.deepEqual(await runManagementTool('kanban_board', {}, api), { ok: true })
  assert.deepEqual(await runManagementTool('kanban_ticket', { ticket: 'KAN-1' }, api), { ok: true })
  await runManagementTool('kanban_create', { title: 'file it', body: 'and why' }, api)
  await runManagementTool('kanban_edit', { ticket: 'KAN-1', title: 'fixed' }, api)
  await runManagementTool('kanban_discard', { ticket: 'KAN-1', reason: 'a duplicate of KAN-9' }, api)
  assert.deepEqual(calls.map(([name]) => name), ['board', 'ticket', 'create', 'edit', 'discard'])
})

test('the guards are the shared ones: the same refusals, word for word', async () => {
  const { api } = fakeApi()
  await assert.rejects(() => runManagementTool('kanban_create', { title: 't' }, api), /a body is required/)
  await assert.rejects(() => runManagementTool('kanban_discard', { ticket: 'KAN-1' }, api), /a reason is required/)
  await assert.rejects(() => runManagementTool('kanban_ticket', { ticket: 'KAN-404' }, api), /no ticket matches/)
  await assert.rejects(() => runManagementTool('kanban_edit', { ticket: 'KAN-1' }, api), /nothing to edit/)
  const closed = fakeApi({ ticket: fakeTicket({ column: 'done' }) })
  await assert.rejects(
    () => runManagementTool('kanban_discard', { ticket: 'KAN-1', reason: 'again' }, closed.api),
    /already done/,
  )
})

test('a tool that is the orchestrator’s alone is not reachable from an ordinary session', async () => {
  // The boundary KAN-81 deliberately did not move: starting, moving, retrying,
  // messaging and kicking role sessions stays with the session the engine feeds.
  const { calls, api } = fakeApi()
  for (const name of ['kanban_move', 'kanban_start', 'kanban_retry', 'kanban_kick', 'kanban_message', 'kanban_configure', 'kanban_sessions']) {
    await assert.rejects(() => runManagementTool(name, { ticket: 'KAN-1' }, api), new RegExp(`unknown management tool ${name}`))
  }
  assert.deepEqual(calls, [], 'a refused name must not reach the seam at all')
})

test('a paused orchestrator does not hide the board from an ordinary session', async () => {
  // The one behavioral difference between the two runners, stated as a test.
  const { api } = fakeApi({ board: () => ({ tickets: [] }) })
  const paused = { ...api, paused: () => true }
  await assert.rejects(() => runOrchestratorTool('kanban_board', {}, paused), /paused/i)
  assert.deepEqual(await runManagementTool('kanban_board', {}, paused), { tickets: [] })
})

// -------------------------------------------------- who the board already owns --

/** A store whose `sessions` table holds the two role sessions and nothing else. */
function storeWith(ownedIds) {
  const owned = new Set(ownedIds)
  return { findSession: (id) => (owned.has(id) ? { ticketId: 't-1', sessionId: id, role: 'implementer' } : undefined) }
}

test('isBoardOwnedSession is one store lookup, and fails open when it cannot ask', () => {
  const store = storeWith(['kanban-build-1'])
  assert.equal(isBoardOwnedSession(store, 'kanban-build-1'), true)
  assert.equal(isBoardOwnedSession(store, 'some-chat-session'), false)
  assert.equal(isBoardOwnedSession(store, ''), false, 'an empty id is not a session')
  assert.equal(isBoardOwnedSession(store, null), false)
  assert.equal(isBoardOwnedSession(null, 'kanban-build-1'), false, 'no store must not hide the tool')
  assert.equal(isBoardOwnedSession({}, 'kanban-build-1'), false, 'a store without the lookup must not hide the tool')
})

test('agentSessionId reads the durable id, and falls back to the thin one', () => {
  // A harness session id is `session-<uuid>` (or a bare uuid on older rows);
  // the shape is whatever the store keys `sessions.dsh_session_id` on, so both
  // accessors must agree. They do — `Agent.id` is derived from the same header.
  assert.equal(agentSessionId({ session: { header: { id: 'session-abc' } } }), 'session-abc')
  assert.equal(agentSessionId({ session: { id: 'session-abc' } }), 'session-abc')
  assert.equal(agentSessionId({ id: 'session-abc' }), 'session-abc')
  assert.equal(agentSessionId({ session: { header: {} }, id: 'session-abc' }), 'session-abc')
  assert.equal(agentSessionId({}), null)
  assert.equal(agentSessionId(null), null)
  assert.equal(agentSessionId(undefined), null)
})

test('managementActor credits a write to the session that made it', () => {
  assert.equal(managementActor({ session: { header: { id: 'sess-9' } } }), 'agent:sess-9')
  assert.equal(managementActor({ id: 'sess-9' }), 'agent:sess-9')
  assert.equal(managementActor(undefined), 'agent', 'no id still says what kind of actor it was')
})

test('a lookup that cannot be made never removes the tool', () => {
  // The blast radius is the reason: a `when` that throws aborts the harness's
  // whole step-time tool selection, so one bad board read would leave every
  // session on the host with no tools at all. An unprovable exclusion costs the
  // caller the exclusion, nothing more.
  const broken = { findSession: () => { throw new Error('SQLITE_MISUSE: database is closed') } }
  assert.equal(isBoardOwnedSession(broken, 'session-abc'), false)
  assert.equal(managementToolWhen(broken)({ agent: { id: 'session-abc' } }), true)
  const exploding = { get session() { throw new Error('unreachable agent') } }
  assert.equal(managementToolWhen(storeWith([]))({ agent: exploding }), true)
})

test('the when condition hides all five from a board session and shows them to everyone else', () => {
  const when = managementToolWhen(storeWith(['kanban-build-1', 'kanban-plan-1']))
  assert.equal(when({ agent: { id: 'kanban-build-1' } }), false, 'a build session may not manage its own board')
  assert.equal(when({ agent: { session: { header: { id: 'kanban-plan-1' } } } }), false)
  assert.equal(when({ agent: { id: 'a-persons-chat' } }), true)
  assert.equal(when({ agent: { id: 'kanban-orchestrator' } }), true, 'the orchestrator keeps its own scoped set; the global one is shadowed, not hidden')
  assert.equal(when({}), true, 'no agent in context is not a reason to hide the board')
  assert.equal(when(undefined), true)
})
