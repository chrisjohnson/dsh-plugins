// The orchestrator's board feed and tool contracts, tested as pure decisions.
//
// Three things have to stay true no matter what the model does with them, and
// none of them need a harness to check: a digest says one readable line per
// event and nothing about the orchestrator's own moves; the coalescing window
// turns a burst into one queued message and refuses to stack a third on a
// session that has not read the first two; and a tool call that crosses the
// boundary — closing a ticket, retrying one that is not parked, messaging
// without a word — is refused here rather than reaching the engine.

import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import {
  MAX_DIGEST_LINES,
  MESSAGE_MODES,
  ORCHESTRATOR_TOOL_NAMES,
  ORCHESTRATOR_TOOL_SPECS,
  WATCHED_EVENT_KINDS,
  boardSnapshotText,
  clip,
  createDigestWindow,
  digestEvent,
  isWatchedEvent,
  nextOrchestratorSessionId,
  planMessageDelivery,
  runOrchestratorTool,
  ticketLineFacts,
} from '../src/orchestrator.mjs'

const event = (kind, extra = {}) => ({
  ticketId: 't-1',
  key: 'KAN-1',
  at: '2026-11-04T00:00:00.000Z',
  kind,
  phaseFrom: null,
  phaseTo: null,
  actor: 'engine',
  payload: {},
  ...extra,
})

// ------------------------------------------------------------------- digests --

test('a park becomes one line naming the ticket, the phase and the reason', () => {
  const line = digestEvent(event('needs_attention_reason', {
    phaseTo: 'implement',
    payload: { reason: 'turn stalled', failedPhase: 'implement' },
  }))
  assert.equal(line, 'KAN-1 parked in implement: turn stalled')
})

test('the store twin of a park reads the same way', () => {
  const line = digestEvent(event('needs_attention', { payload: { reason: 'no route configured for role reviewer' } }))
  assert.match(line, /^KAN-1 parked in \?: no route configured for role reviewer$/)
})

test('phase and column moves say which to which', () => {
  assert.equal(digestEvent(event('phase_changed', { phaseFrom: 'plan', phaseTo: 'implement' })), 'KAN-1 phase plan → implement')
  assert.equal(
    digestEvent(event('column_changed', { payload: { from: 'backlog', to: 'working', reason: 'orchestrator move' } })),
    'KAN-1 moved backlog → working (orchestrator move)',
  )
})

test('closures, approvals and retries each get their own wording', () => {
  assert.equal(digestEvent(event('done', { payload: { attempt: 2 } })), 'KAN-1 done after 2 attempt(s)')
  assert.equal(digestEvent(event('discarded', { payload: { reason: 'superseded' } })), 'KAN-1 discarded: superseded')
  assert.equal(digestEvent(event('plan_approved')), 'KAN-1 plan approved, building now')
  assert.equal(digestEvent(event('grant_applied')), 'KAN-1 sandbox grants approved — the build may start')
  assert.equal(
    digestEvent(event('retry_scheduled', { payload: { instruction: 'push the tag first' } })),
    'KAN-1 retry scheduled with an instruction: push the tag first',
  )
  assert.equal(
    digestEvent(event('stalled', { phaseTo: 'review', payload: { sessionId: 'session-abc' } })),
    'KAN-1 stalled in review (session session-abc)',
  )
})

test('a kind nobody declared is silence, not a made-up line', () => {
  assert.equal(digestEvent(event('something_new')), null)
})

test('long free text is clipped onto one line, never wrapped', () => {
  const line = digestEvent(event('needs_attention', { payload: { reason: 'x'.repeat(400) } }))
  assert.equal(line.includes('\n'), false)
  assert.ok(line.length < 260, `line was ${line.length} chars`)
  assert.equal(clip('  a   b  '), 'a b')
  assert.equal(clip('abcdef', 4), 'abc…')
})

test('the feed ignores what is not the orchestrator’s business', () => {
  assert.equal(isWatchedEvent(event('span_started')), false)
  assert.equal(isWatchedEvent(event('session_attached')), false)
  assert.equal(isWatchedEvent(null), false)
  assert.equal(isWatchedEvent({ kind: 'done' }), false, 'an event with no ticket is not a ticket event')
})

test('the orchestrator’s own moves are not fed back to it', () => {
  assert.equal(isWatchedEvent(event('phase_changed', { actor: 'orchestrator', phaseTo: 'implement' })), false)
  assert.equal(digestEvent(event('column_changed', { actor: 'orchestrator', payload: { from: 'backlog', to: 'working' } })), null)
})

test('every watched kind digests to a line that names the ticket', () => {
  for (const kind of WATCHED_EVENT_KINDS) {
    const line = digestEvent(event(kind))
    assert.equal(typeof line, 'string', `${kind} produced no line`)
    assert.match(line, /^KAN-1 /, `${kind} line does not start with the ticket key`)
  }
})

// --------------------------------------------------------------- coalescing --

/**
 * A window with hand-pumped timers: `fire()` runs the armed timer, so a test
 * says "the window closed" instead of sleeping for it.
 */
function harness({ accept = true, ...options } = {}) {
  const sent = []
  const timers = []
  const win = createDigestWindow({
    windowMs: 30000,
    deliver: (text) => {
      sent.push(text)
      return accept
    },
    schedule: (fn) => {
      timers.push(fn)
      return timers.length - 1
    },
    unschedule: (handle) => {
      timers[handle] = null
    },
    ...options,
  })
  const fire = () => {
    const index = timers.findIndex((candidate) => candidate !== null)
    if (index < 0) return false
    const fn = timers[index]
    timers[index] = null
    void fn()
    return true
  }
  return { win, sent, fire }
}

test('a burst inside one window is delivered as one message', async () => {
  const { win, sent, fire } = harness()
  win.push(event('phase_changed', { ticketId: 't-1', phaseFrom: 'plan', phaseTo: 'implement' }))
  win.push(event('done', { ticketId: 't-2', key: 'KAN-2' }))
  assert.equal(sent.length, 0, 'nothing is sent before the window closes')
  assert.equal(fire(), true)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /^\[board events\] 2 change\(s\):/)
  assert.equal(sent[0].split('\n').length, 3, 'header plus one line per event')
  assert.match(sent[0], /KAN-1 phase plan → implement/)
  assert.match(sent[0], /KAN-2 done/)
})

test('the same park reported twice in one window is one line', () => {
  const { win } = harness()
  assert.equal(win.push(event('needs_attention_reason', { payload: { reason: 'x' } })), true)
  assert.equal(win.push(event('needs_attention', { payload: { reason: 'x' } })), false, 'the store twin is the same news')
  assert.equal(win.pending, 1)
})

test('an empty window delivers nothing', async () => {
  const { win, sent } = harness()
  assert.equal(await win.flush(), false)
  assert.equal(sent.length, 0)
})

test('a session that has not read its digests is not stacked', async () => {
  const { win, sent } = harness({ maxInFlight: 2 })
  win.pushText('one')
  assert.equal(await win.flush(), true)
  win.pushText('two')
  assert.equal(await win.flush(), true)
  win.pushText('three')
  assert.equal(await win.flush(), false, 'a third queued digest waits for the session to catch up')
  assert.equal(sent.length, 2)
  assert.equal(win.pending, 1)
  win.settle()
  assert.equal(await win.flush(), true)
  assert.equal(sent.length, 3)
  assert.match(sent[2], /three/)
})

test('a delivery the session refused stays buffered, in order', async () => {
  const { win, sent } = harness({ accept: false })
  win.pushText('first')
  assert.equal(await win.flush(), false)
  assert.equal(sent.length, 1, 'the attempt was made')
  assert.equal(win.pending, 1, 'and the line was kept')
  win.pushText('second')
  assert.equal(await win.flush(), false)
  assert.equal(win.pending, 2)
})

test('a window that never drains stays bounded and says what it dropped', async () => {
  const { win, sent } = harness({ maxInFlight: 1, maxLines: 3 })
  for (let i = 1; i <= 6; i += 1) win.pushText(`line ${i}`)
  assert.equal(win.pending, 3, 'only the newest lines are kept')
  assert.equal(await win.flush(), true)
  assert.match(sent[0], /plus 3 earlier, dropped/)
  assert.match(sent[0], /line 6/)
  assert.equal(sent[0].includes('line 1'), false)
})

test('the default line bound is the one the module documents', async () => {
  const { win } = harness({ maxInFlight: 1 })
  for (let i = 0; i < MAX_DIGEST_LINES + 5; i += 1) win.pushText(`l${i}`)
  assert.equal(win.pending, MAX_DIGEST_LINES)
})

test('dispose unarms the window and refuses further news', async () => {
  const { win, sent, fire } = harness()
  win.pushText('doomed')
  win.dispose()
  assert.equal(fire(), false, 'the armed flush is gone')
  assert.equal(win.pushText('after'), false)
  assert.equal(await win.flush(), false)
  assert.equal(sent.length, 0)
})

test('a window with no deliver function is a programming error, said loudly', () => {
  assert.throws(() => createDigestWindow({}), /deliver function/)
})

// ----------------------------------------------------------------- snapshot --

test('the board snapshot lists counts then one line per open ticket', () => {
  const text = boardSnapshotText({
    asOf: '2026-11-04T00:00:00Z',
    counts: { backlog: 2, working: 1, done: 9, discarded: 0 },
    tickets: [
      { key: 'KAN-1', title: 'Orchestrator', column: 'working', phase: 'implement', running: true },
      { key: 'KAN-2', title: 'Parked thing', column: 'backlog', phase: 'plan', parked: 'no route' },
      { key: 'KAN-3', title: 'Waiting', column: 'backlog', phase: 'plan', waitingOnHuman: true, attemptCount: 2 },
    ],
  })
  const lines = text.split('\n')
  assert.equal(lines[0], '[board snapshot 2026-11-04T00:00:00Z] backlog 2 · working 1 · done 9 · discarded 0')
  assert.match(lines[1], /KAN-1 .*working · implement · running/)
  assert.match(lines[2], /PARKED: no route/)
  assert.match(lines[3], /attempt 2 · waiting on a person/)
})

test('an empty board says so instead of printing a bare header', () => {
  const text = boardSnapshotText({ counts: {}, tickets: [] })
  assert.match(text, /board is empty/)
})

test('a long board is truncated with a count of what is missing', () => {
  const tickets = Array.from({ length: 60 }, (_unused, i) => ({ key: `KAN-${i}`, title: 't', column: 'working', phase: 'plan' }))
  const text = boardSnapshotText({ counts: { working: 60 }, tickets })
  assert.match(text, /and 20 more ticket\(s\) not listed/)
  assert.equal(text.split('\n').length, 42)
})

// --------------------------------------------------------------------- tools --

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
      // The pristine lock is a boolean, not a result object: the guard asks it
      // the same question the human edit boundary asks the store.
      ticketEditable: (...args) => {
        calls.push(['ticketEditable', ...args])
        return over.ticketEditable === undefined ? true : over.ticketEditable
      },
      move: record('move'),
      start: record('start'),
      retry: record('retry'),
      kick: record('kick'),
      message: record('message'),
      discard: record('discard'),
      sessions: record('sessions'),
    },
  }
}

test('every declared tool is reachable and has a model-facing contract', () => {
  assert.equal(ORCHESTRATOR_TOOL_SPECS.length, ORCHESTRATOR_TOOL_NAMES.length)
  for (const spec of ORCHESTRATOR_TOOL_SPECS) {
    assert.equal(typeof spec.name, 'string')
    assert.match(spec.name, /^kanban_/, `${spec.name} must be namespaced`)
    assert.ok(spec.description.length > 40, `${spec.name} has a thin description`)
    assert.equal(typeof spec.parameters, 'object')
    assert.equal(typeof spec.guard, 'function')
    assert.equal(typeof spec.run, 'function')
  }
})

test('the orchestrator can author, configure and discard tickets but cannot approve or close them', () => {
  // The boundary KAN-65 moved: discarding an open ticket is the orchestrator's,
  // with a reason (KAN-66 had already given it `kanban_configure` for an open
  // ticket's settings). Approving and closing as done are not, so nothing in this
  // tool set may even spell them — the board owner kept those two.
  const forbidden = /approve|close|delete|submit|answer/
  for (const name of ORCHESTRATOR_TOOL_NAMES) {
    assert.equal(forbidden.test(name), false, `${name} crosses the boundary`)
  }
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
})

test('discard needs a reason and refuses a ticket that is already closed', async () => {
  const { api, calls } = fakeApi()
  await assert.rejects(() => runOrchestratorTool('kanban_discard', { ticket: 'KAN-1' }, api), /reason is required/)
  await assert.rejects(() => runOrchestratorTool('kanban_discard', { ticket: 'KAN-1', reason: '   ' }, api), /reason is required/)
  assert.equal(calls.length, 0, 'a refused call never reaches the host seam')

  for (const column of ['done', 'discarded']) {
    const closed = fakeApi({ ticket: fakeTicket({ column, phase: 'closed' }) })
    await assert.rejects(
      () => runOrchestratorTool('kanban_discard', { ticket: 'KAN-1', reason: 'superseded by KAN-9' }, closed.api),
      new RegExp(`already ${column}; only an open ticket can be discarded`),
    )
    assert.equal(closed.calls.some((call) => call[0] === 'discard'), false)
  }
})

test('a valid discard hands the resolved ticket and the trimmed reason to the seam', async () => {
  const { api, calls } = fakeApi()
  await runOrchestratorTool('kanban_discard', { ticket: 'KAN-1', reason: '  a duplicate of KAN-9  ' }, api)
  assert.equal(calls[0][0], 'discard')
  assert.equal(calls[0][1].id, 't-1', 'the guard hands over the resolved ticket, not the string it was given')
  assert.equal(calls[0][2], 'a duplicate of KAN-9')
})

test('a read tool needs nothing and reaches the host seam', async () => {
  const { api, calls } = fakeApi()
  await runOrchestratorTool('kanban_board', {}, api)
  await runOrchestratorTool('kanban_sessions', {}, api)
  assert.deepEqual(calls.map((call) => call[0]), ['board', 'sessions'])
})

test('an unknown tool is an error, not a silent no-op', async () => {
  const { api } = fakeApi()
  await assert.rejects(() => runOrchestratorTool('kanban_approve', {}, api), /unknown orchestrator tool/)
})

test('a ticket is resolved by key or id before anything else runs', async () => {
  const { api } = fakeApi()
  await assert.rejects(() => runOrchestratorTool('kanban_ticket', { ticket: 'KAN-404' }, api), /no ticket matches/)
  await assert.rejects(() => runOrchestratorTool('kanban_ticket', { ticket: '  ' }, api), /required/)
})

test('move is limited to the two columns the orchestrator owns', async () => {
  const { api, calls } = fakeApi()
  await runOrchestratorTool('kanban_move', { ticket: 'KAN-1', to: 'backlog', reason: 'hold on' }, api)
  assert.equal(calls[0][0], 'move')
  assert.equal(calls[0][1].id, 't-1', 'the guard hands over the resolved ticket, not the string it was given')
  assert.deepEqual(calls[0].slice(2), ['backlog', 'hold on'])
  for (const to of ['done', 'discarded']) {
    await assert.rejects(
      () => runOrchestratorTool('kanban_move', { ticket: 'KAN-1', to }, api),
      /Done and Discarded belong to the human/,
    )
  }
})

test('start only accepts the two things that start work', async () => {
  const { api } = fakeApi()
  await runOrchestratorTool('kanban_start', { ticket: 'KAN-1', what: 'planning' }, api)
  await runOrchestratorTool('kanban_start', { ticket: 'KAN-1', what: 'build' }, api)
  await assert.rejects(() => runOrchestratorTool('kanban_start', { ticket: 'KAN-1', what: 'verify' }, api), /"planning" or "build"/)
})

test('retry needs a parked ticket and a real instruction', async () => {
  const { api } = fakeApi()
  await assert.rejects(() => runOrchestratorTool('kanban_retry', { ticket: 'KAN-1' }, api), /instruction is required/)
  await assert.rejects(() => runOrchestratorTool('kanban_retry', { ticket: 'KAN-1', instruction: '  ' }, api), /instruction is required/)
  await assert.rejects(
    () => runOrchestratorTool('kanban_retry', { ticket: 'KAN-1', instruction: 'do it again' }, api),
    /is not parked/,
  )
  const parked = fakeApi({ ticket: fakeTicket({ needsAttentionReason: 'turn stalled' }) })
  await runOrchestratorTool('kanban_retry', { ticket: 'KAN-1', instruction: 'push the tag first' }, parked.api)
  assert.equal(parked.calls[0][0], 'retry')
  assert.equal(parked.calls[0][1].id, 't-1')
  assert.equal(parked.calls[0][2], 'push the tag first')
})

test('kick takes a session id and nothing else', async () => {
  const { api, calls } = fakeApi()
  await assert.rejects(() => runOrchestratorTool('kanban_kick', {}, api), /session id is required/)
  await runOrchestratorTool('kanban_kick', { session: ' session-9 ' }, api)
  assert.deepEqual(calls[0], ['kick', 'session-9'])
})

test('message needs text and a known purpose', async () => {
  const { api } = fakeApi()
  await assert.rejects(() => runOrchestratorTool('kanban_message', { ticket: 'KAN-1' }, api), /text is required/)
  await assert.rejects(
    () => runOrchestratorTool('kanban_message', { ticket: 'KAN-1', text: 'hi', purpose: 'approval' }, api),
    /purpose must be/,
  )
  await runOrchestratorTool('kanban_message', { ticket: 'KAN-1', text: 'the lockfile is stale' }, api)
})

test('create needs a title and a body, and nothing else', async () => {
  const { api, calls } = fakeApi()
  await assert.rejects(() => runOrchestratorTool('kanban_create', {}, api), /title is required/)
  await assert.rejects(() => runOrchestratorTool('kanban_create', { title: '  ', body: 'b' }, api), /title is required/)
  await assert.rejects(() => runOrchestratorTool('kanban_create', { title: 't' }, api), /body is required/)
  await assert.rejects(() => runOrchestratorTool('kanban_create', { title: 't', body: '   ' }, api), /body is required/)
  assert.equal(calls.length, 0, 'a refused call never reaches the host seam')
})

test('create takes an integer priority and nothing else', async () => {
  const { api, calls } = fakeApi()
  await assert.rejects(() => runOrchestratorTool('kanban_create', { title: 't', body: 'b', priority: 'high' }, api), /integer/)
  await assert.rejects(() => runOrchestratorTool('kanban_create', { title: 't', body: 'b', priority: 1.5 }, api), /integer/)
  await runOrchestratorTool('kanban_create', { title: ' t ', body: 'the body', priority: 3 }, api)
  assert.deepEqual(calls[0], ['create', { title: 't', body: 'the body', priority: 3 }])
  await runOrchestratorTool('kanban_create', { title: 't', body: 'b' }, api)
  assert.deepEqual(calls[1], ['create', { title: 't', body: 'b', priority: undefined }])
})

test('create cannot file a body that references an image it cannot attach', async () => {
  const { api, calls } = fakeApi()
  await assert.rejects(
    () => runOrchestratorTool('kanban_create', { title: 't', body: 'look: ![shot](kanban-image:pending-abc)' }, api),
    /kanban-image:/,
  )
  assert.equal(calls.length, 0)
})

test('create passes the settings a build needs straight through to the seam', async () => {
  // KAN-65: a dsh-deploy/dsh-plugins build is denied install, lab and git access
  // under the defaults, so the orchestrator has to be able to file the card with
  // the Creator preset, Full Access and a worktree on. The guard checks shape
  // only; whether a preset id exists is the host seam's question.
  const { api, calls } = fakeApi()
  await runOrchestratorTool('kanban_create', {
    title: 't',
    body: 'b',
    preset: 'cordis',
    writeMode: 'danger-full-access',
    worktree: true,
    planTiming: 'at_pickup',
    planQuestions: 'autonomous',
  }, api)
  assert.deepEqual(calls[0], ['create', {
    title: 't',
    body: 'b',
    priority: undefined,
    preset: 'cordis',
    writeMode: 'danger-full-access',
    worktree: true,
    planTiming: 'at_pickup',
    planQuestions: 'autonomous',
  }])
})

test('create leaves a setting it was not given at the store default', async () => {
  const { api, calls } = fakeApi()
  await runOrchestratorTool('kanban_create', { title: 't', body: 'b', writeMode: 'workspace-write' }, api)
  const filed = calls[0][1]
  assert.equal(filed.writeMode, 'workspace-write')
  for (const key of ['preset', 'worktree', 'planTiming', 'planQuestions']) {
    assert.equal(Object.prototype.hasOwnProperty.call(filed, key), false, `${key} was pinned to a default nobody asked for`)
  }
})

test('create refuses a write mode outside the sandbox vocabulary', async () => {
  const { api, calls } = fakeApi()
  for (const writeMode of ['full-access', 'yolo', 'READ-ONLY', 3]) {
    await assert.rejects(() => runOrchestratorTool('kanban_create', { title: 't', body: 'b', writeMode }, api), /writeMode must be one of/)
  }
  assert.equal(calls.length, 0)
})

test('create refuses a plan mode the lifecycle does not know', async () => {
  const { api, calls } = fakeApi()
  await assert.rejects(() => runOrchestratorTool('kanban_create', { title: 't', body: 'b', planTiming: 'soon' }, api), /planTiming must be one of/)
  await assert.rejects(() => runOrchestratorTool('kanban_create', { title: 't', body: 'b', planQuestions: 'silent' }, api), /planQuestions must be one of/)
  // A half-given pair is completed with the store's own defaults, then checked.
  await runOrchestratorTool('kanban_create', { title: 't', body: 'b', planTiming: 'now' }, api)
  assert.deepEqual(calls[0][1], { title: 't', body: 'b', priority: undefined, planTiming: 'now', planQuestions: 'interactive' })
  assert.equal(calls.length, 1)
})

test('create refuses a worktree that is not a boolean and a preset that is blank', async () => {
  const { api, calls } = fakeApi()
  for (const worktree of ['yes', 1, 'true']) {
    await assert.rejects(() => runOrchestratorTool('kanban_create', { title: 't', body: 'b', worktree }, api), /worktree must be true or false/)
  }
  await assert.rejects(() => runOrchestratorTool('kanban_create', { title: 't', body: 'b', preset: '   ' }, api), /preset must be a non-empty string/)
  assert.equal(calls.length, 0)
  // Turning it off explicitly is a real answer, not a missing one.
  await runOrchestratorTool('kanban_create', { title: 't', body: 'b', worktree: false }, api)
  assert.equal(calls[0][1].worktree, false)
})

test('edit needs at least one of title and body', async () => {
  const { api, calls } = fakeApi()
  await assert.rejects(() => runOrchestratorTool('kanban_edit', { ticket: 'KAN-1' }, api), /nothing to edit/)
  await assert.rejects(() => runOrchestratorTool('kanban_edit', { ticket: 'KAN-1', title: '  ' }, api), /cannot be empty/)
  await assert.rejects(() => runOrchestratorTool('kanban_edit', { ticket: 'KAN-1', body: '' }, api), /cannot be empty/)
  assert.equal(calls.filter((call) => call[0] === 'edit').length, 0)
})

test('edit only edits an unstarted ticket: the pristine lock is the same one the human boundary uses', async () => {
  const started = fakeApi({ ticket: fakeTicket({ column: 'working', phase: 'implement' }), ticketEditable: false })
  await assert.rejects(
    () => runOrchestratorTool('kanban_edit', { ticket: 'KAN-1', title: 'new' }, started.api),
    /already started; it can no longer be edited/,
  )
  assert.equal(started.calls.some((call) => call[0] === 'edit'), false)

  for (const column of ['done', 'discarded']) {
    const closed = fakeApi({ ticket: fakeTicket({ column, phase: 'done' }) })
    await assert.rejects(
      () => runOrchestratorTool('kanban_edit', { ticket: 'KAN-1', title: 'new' }, closed.api),
      /only a Backlog or Working ticket can be edited/,
    )
  }
})

test('edit hands the host seam a patch of title and body only', async () => {
  const pristine = fakeApi({ ticket: fakeTicket({ column: 'backlog', phase: 'plan' }) })
  await runOrchestratorTool('kanban_edit', { ticket: 'KAN-1', title: ' A cleaner title ' }, pristine.api)
  assert.deepEqual(pristine.calls.at(-1), ['edit', pristine.api.resolveTicket('KAN-1'), { title: 'A cleaner title' }])
  await runOrchestratorTool('kanban_edit', { ticket: 'KAN-1', title: 't', body: 'the new body' }, pristine.api)
  assert.deepEqual(pristine.calls.at(-1)[2], { title: 't', body: 'the new body' })
  await assert.rejects(
    () => runOrchestratorTool('kanban_edit', { ticket: 'KAN-1', body: '![x](kanban-image:pending-1)' }, pristine.api),
    /kanban-image:/,
  )
})

test('a tool that throws inside the host seam surfaces as a tool error', async () => {
  const { api } = fakeApi({ move: () => { throw new Error('invalid_transition: not allowed') } })
  await assert.rejects(() => runOrchestratorTool('kanban_move', { ticket: 'KAN-1', to: 'working' }, api), /invalid_transition/)
})

test('arguments that are not an object are treated as empty, not crashed on', async () => {
  const { api } = fakeApi()
  await assert.rejects(() => runOrchestratorTool('kanban_ticket', null, api), /required/)
})

// ------------------------------------------------- message delivery modes --
//
// KAN-67: a message that only queues is useless when it is sent to correct a
// turn already in flight, so the tool gained `mode` and the result gained the
// truth about what happened. The choice is a pure decision; the host seam just
// carries it out.

test('the delivery vocabulary is queue and steer, and nothing else reaches the seam', async () => {
  assert.deepEqual(MESSAGE_MODES, ['queue', 'steer'])
  const { api, calls } = fakeApi()
  for (const mode of ['interrupt', 'QUEUE', 'immediate', '']) {
    await assert.rejects(
      () => runOrchestratorTool('kanban_message', { ticket: 'KAN-1', text: 'hi', mode }, api),
      /mode must be one of queue or steer/,
    )
  }
  assert.equal(calls.length, 0, 'a refused mode never reaches the host seam')
})

test('the mode reaches the host seam, and omitting it means queue', async () => {
  const { api, calls } = fakeApi()
  await runOrchestratorTool('kanban_message', { ticket: 'KAN-1', text: 'hold the tag' }, api)
  assert.deepEqual(calls[0], ['message', api.resolveTicket('KAN-1'), 'hold the tag', null, 'queue'])
  await runOrchestratorTool('kanban_message', { ticket: 'KAN-1', text: 'hold the tag', purpose: 'build', mode: 'steer' }, api)
  assert.deepEqual(calls.at(-1), ['message', api.resolveTicket('KAN-1'), 'hold the tag', 'build', 'steer'])
})

test('a steer into a session that is mid-turn is injected', () => {
  assert.deepEqual(
    planMessageDelivery({ mode: 'steer', sessionId: 's-1', agentStatus: 'running', steerAvailable: true }),
    { delivery: 'injected' },
  )
})

test('a steer into an idle session degrades to a queue and says why', () => {
  for (const agentStatus of ['idle', 'maintenance']) {
    const plan = planMessageDelivery({ mode: 'steer', sessionId: 's-1', agentStatus, steerAvailable: true })
    assert.equal(plan.delivery, 'queued', `${agentStatus} must not claim an injection`)
    assert.match(plan.degradeReason, new RegExp(agentStatus))
  }
})

test('a steer on a harness build with no steer seam degrades to a queue', () => {
  const plan = planMessageDelivery({ mode: 'steer', sessionId: 's-1', agentStatus: 'running', steerAvailable: false })
  assert.equal(plan.delivery, 'queued')
  assert.match(plan.degradeReason, /no steer seam/)
})

test('a queue to a running session queues: the default never interrupts', () => {
  assert.deepEqual(
    planMessageDelivery({ mode: 'queue', sessionId: 's-1', agentStatus: 'running', steerAvailable: true }),
    { delivery: 'queued' },
  )
  assert.deepEqual(planMessageDelivery({ sessionId: 's-1', agentStatus: 'running', steerAvailable: true }), { delivery: 'queued' })
})

test('no live session is session-gone, whichever mode was asked for', () => {
  const dead = [
    { sessionId: null, agentStatus: null },
    { sessionId: undefined, agentStatus: undefined },
    { sessionId: 's-1', agentStatus: null },
    { sessionId: 's-1', agentStatus: 'not-in-process' },
    { sessionId: 's-1', agentStatus: 'closed' },
  ]
  for (const state of dead) {
    for (const mode of MESSAGE_MODES) {
      assert.equal(planMessageDelivery({ mode, ...state, steerAvailable: true }).delivery, 'session-gone', `${mode} over ${JSON.stringify(state)}`)
    }
  }
})

// ------------------------------------------------------------------ rotation --

test('a detach rotates the session id forward and never reuses one', () => {
  // An archived id stays archived, so the fresh session after a detach has to be
  // a new id — reusing the retired one would come back dead.
  assert.equal(nextOrchestratorSessionId('kanban-orchestrator'), 'kanban-orchestrator-2')
  assert.equal(nextOrchestratorSessionId('kanban-orchestrator-2'), 'kanban-orchestrator-3')
  assert.equal(nextOrchestratorSessionId('kanban-orchestrator-3'), 'kanban-orchestrator-4')
})

test('the stored generation wins over the id suffix when the two disagree', () => {
  assert.equal(nextOrchestratorSessionId('kanban-orchestrator', 4), 'kanban-orchestrator-5')
  assert.equal(nextOrchestratorSessionId('kanban-orchestrator-2', 7), 'kanban-orchestrator-8')
})

test('a renamed orchestrator keeps its own stem, and junk falls back to the default', () => {
  assert.equal(nextOrchestratorSessionId('my-orch', null), 'my-orch-2')
  assert.equal(nextOrchestratorSessionId('my-orch-9', NaN), 'my-orch-10')
  assert.equal(nextOrchestratorSessionId('', 0), 'kanban-orchestrator-2')
  assert.equal(nextOrchestratorSessionId(undefined, -3), 'kanban-orchestrator-2')
})

// ---------------------------------------------------------------- KAN-72 ---
//
// The Working cap is the engine's, but the orchestrator is the caller most
// likely to push against it. What it has to get from a tool call is the same
// sentence a human gets on the card: queued, at this position, starting on its
// own — not an error that reads like "retry harder".

const specOf = (name) => ORCHESTRATOR_TOOL_SPECS.find((tool) => tool.name === name)

test('kanban_board reports the cap in force, what is using it and who waits', async () => {
  const engineBlock = {
    driving: 3,
    wipCap: 3,
    working: 3,
    queue: [{ key: 'KAN-9', title: 'next up', position: 1, phase: 'implement' }],
  }
  const { api } = fakeApi({ board: () => ({ tickets: [], engine: engineBlock }) })
  const answer = await runOrchestratorTool('kanban_board', {}, api)
  assert.deepEqual(answer.engine, engineBlock, 'the seam is passed through whole, not re-summarised')
})

test('a move the cap queued comes back as queued, with the reason readable', async () => {
  const queued = {
    cap: 3,
    occupancy: 3,
    position: 2,
    reason: 'WIP cap 3/3 — queued at position 2. It starts automatically when a Working slot frees.',
  }
  const { api, calls } = fakeApi({ move: () => ({ moved: false, queued, reason: queued.reason, ticket: fakeTicket() }) })
  const answer = await runOrchestratorTool('kanban_move', { ticket: 'KAN-1', to: 'working', reason: 'start it' }, api)
  assert.equal(calls[0][0], 'move')
  assert.equal(answer.moved, false)
  assert.equal(answer.queued.position, 2)
  assert.match(answer.reason, /^WIP cap 3\/3 — queued at position 2/)
})

test('a started build the cap queued says so the same way', async () => {
  const queued = {
    cap: 3,
    occupancy: 3,
    position: 1,
    reason: 'WIP cap 3/3 — queued at position 1. It starts automatically when a Working slot frees.',
  }
  const { api } = fakeApi({ start: () => ({ started: false, queued, reason: queued.reason, ticket: fakeTicket() }) })
  const answer = await runOrchestratorTool('kanban_start', { ticket: 'KAN-1', what: 'build', reason: 'go' }, api)
  assert.equal(answer.started, false)
  assert.deepEqual(answer.queued, queued)
})

test('the tool contracts say the engine queues at the cap and must not be forced', () => {
  assert.match(specOf('kanban_move').description, /cap on Working/i)
  assert.match(specOf('kanban_move').description, /queued rather than made/i)
  assert.match(specOf('kanban_move').description, /do not retry the move/i)
  assert.match(specOf('kanban_start').description, /queued, not forced/i)
  const board = specOf('kanban_board').description
  for (const field of ['wipCap', 'working', 'queue']) {
    assert.ok(board.includes(field), `kanban_board must advertise engine.${field}`)
  }
})

// ---------------------------------------------------------------- KAN-93 ---
//
// Every field the human new-ticket and edit-ticket screens set is now reachable
// from `kanban_create` and `kanban_edit`. The case that prompted it: an agent
// filed a batch of tickets into the wrong workspace and had no way to say so —
// not at creation, and not afterwards, because `kanban_edit` was title/body
// only. Two claims matter, and they are tested separately:
//
//   - the **guard** accepts the whole field set and refuses the same junk the
//     human form refuses, before anything is written;
//   - the **store** keeps what the guard handed over — the workspace on the row,
//     the acceptance as rows, the budget as numbers — because a tool that files
//     a value into a column it does not land in is worse than no tool.
//
// The second half runs the real host seam (`KanbanOrchestrator.managementApi`)
// against a real SQLite store. That class imports the dsh peers, so those tests
// skip on a bare clone rather than pretend.

const CREATE_FIELDS = ['title', 'body', 'acceptance', 'priority', 'workspace', 'preset', 'writeMode', 'worktree', 'planTiming', 'planQuestions', 'allowPaid', 'budgetUsd', 'column']
const EDIT_FIELDS = ['ticket', 'title', 'body', 'acceptance', 'workspace', 'priority', 'preset', 'writeMode', 'planTiming', 'planQuestions', 'allowPaid', 'budgetUsd']

test('kanban_create declares every field the new-ticket screen has', () => {
  const params = specOf('kanban_create').parameters
  for (const key of CREATE_FIELDS) {
    assert.ok(params[key], `${key} is missing from kanban_create`)
    assert.ok(typeof params[key].description === 'string' && params[key].description.length > 10, `${key} has no model-facing description`)
  }
  assert.equal(params.acceptance.type, 'array', 'acceptance is a list of statements')
  assert.equal(params.acceptance.items.type, 'string')
  assert.equal(params.column.enum, undefined, 'the refusal sentence names the two columns; the enum would hide it')
  assert.match(params.column.description, /backlog/i)
  assert.match(params.workspace.description, /default/i, 'omitting the workspace has to read as the engine default, not as a bug')
})

test('kanban_edit declares every field the edit screen has', () => {
  const params = specOf('kanban_edit').parameters
  for (const key of EDIT_FIELDS) {
    assert.ok(params[key], `${key} is missing from kanban_edit`)
    assert.ok(typeof params[key].description === 'string' && params[key].description.length > 10, `${key} has no model-facing description`)
  }
  // The three the human editor can clear back to a default say so in their type.
  for (const key of ['workspace', 'preset', 'writeMode']) {
    assert.deepEqual(params[key].oneOf, [{ type: 'string' }, { type: 'null' }], `${key} must accept null`)
  }
  assert.equal(Object.prototype.hasOwnProperty.call(params, 'worktree'), false, 'the edit screen has no worktree control; configure does')
})

test('create hands the seam the workspace, acceptance, budget and column it was given', async () => {
  const { api, calls } = fakeApi()
  await runOrchestratorTool('kanban_create', {
    title: ' A card with everything ',
    body: 'the body',
    acceptance: ['the row carries its workspace', 'a read shows the budget'],
    workspace: '/srv/work/dsh-deploy',
    priority: 4,
    allowPaid: true,
    budgetUsd: 25,
    column: 'working',
  }, api)
  assert.deepEqual(calls[0], ['create', {
    title: 'A card with everything',
    body: 'the body',
    priority: 4,
    acceptance: ['the row carries its workspace', 'a read shows the budget'],
    workspaceCwd: '/srv/work/dsh-deploy',
    allowPaid: true,
    budgetUsd: 25,
    column: 'working',
  }])
})

test('create refuses the combinations the human form refuses', async () => {
  const { api, calls } = fakeApi()
  const base = { title: 't', body: 'b' }
  for (const column of ['done', 'discarded', 'review', 'Backlog']) {
    await assert.rejects(() => runOrchestratorTool('kanban_create', { ...base, column }, api), /column must be "backlog" or "working"/)
  }
  // Paid needs money, on a fresh card exactly as on an existing one.
  await assert.rejects(() => runOrchestratorTool('kanban_create', { ...base, allowPaid: true }, api), /positive budgetUsd/)
  await assert.rejects(() => runOrchestratorTool('kanban_create', { ...base, allowPaid: true, budgetUsd: 0 }, api), /positive budgetUsd/)
  await assert.rejects(() => runOrchestratorTool('kanban_create', { ...base, allowPaid: 'yes' }, api), /allowPaid must be true or false/)
  for (const budgetUsd of [-1, '25', Number.POSITIVE_INFINITY]) {
    await assert.rejects(() => runOrchestratorTool('kanban_create', { ...base, budgetUsd }, api), /budgetUsd must be a finite number/)
  }
  // Acceptance is a list of statements, not a blob and not a list of blanks.
  await assert.rejects(() => runOrchestratorTool('kanban_create', { ...base, acceptance: 'one long string' }, api), /acceptance must be an array/)
  await assert.rejects(() => runOrchestratorTool('kanban_create', { ...base, acceptance: ['fine', '   '] }, api), /non-empty string/)
  await assert.rejects(() => runOrchestratorTool('kanban_create', { ...base, acceptance: [42] }, api), /non-empty string/)
  await assert.rejects(() => runOrchestratorTool('kanban_create', { ...base, acceptance: null }, api), /acceptance must be an array/)
  // A workspace is a path or nothing; an empty one is nothing, spelled wrong.
  await assert.rejects(() => runOrchestratorTool('kanban_create', { ...base, workspace: '   ' }, api), /workspace must be a non-empty directory path/)
  await assert.rejects(() => runOrchestratorTool('kanban_create', { ...base, workspace: 7 }, api), /workspace must be a non-empty directory path/)
  assert.equal(calls.length, 0, 'not one refusal reached the host seam')
})

test('create files a paid card when the money arrives with it, and leaves an empty acceptance list out', async () => {
  const { api, calls } = fakeApi()
  await runOrchestratorTool('kanban_create', { title: 't', body: 'b', allowPaid: true, budgetUsd: 5 }, api)
  assert.deepEqual(calls[0][1], { title: 't', body: 'b', priority: undefined, allowPaid: true, budgetUsd: 5 })
  await runOrchestratorTool('kanban_create', { title: 't', body: 'b', acceptance: [] }, api)
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1][1], 'acceptance'), false, 'no statements is the store default, not a blank row')
})

test('edit patches the whole edit screen in one call', async () => {
  const pristine = fakeApi({
    ticket: fakeTicket({
      column: 'backlog', phase: 'plan', planTiming: 'at_pickup', planQuestions: 'interactive',
      priority: 0, allowPaid: false, budgetUsd: 0, preset: null, writeMode: null, workspaceCwd: null,
    }),
  })
  await runOrchestratorTool('kanban_edit', {
    ticket: 'KAN-1',
    title: ' a cleaner title ',
    body: ' the fuller body ',
    acceptance: ['one', 'two'],
    workspace: '/srv/work/dsh-plugins',
    priority: 7,
    preset: 'cordis',
    writeMode: 'danger-full-access',
    planTiming: 'now',
    planQuestions: 'autonomous',
    allowPaid: true,
    budgetUsd: 12,
  }, pristine.api)
  const edit = pristine.calls.find((call) => call[0] === 'edit')
  assert.deepEqual(edit[2], {
    title: 'a cleaner title',
    body: ' the fuller body '.trim(),
    acceptance: ['one', 'two'],
    workspaceCwd: '/srv/work/dsh-plugins',
    priority: 7,
    preset: 'cordis',
    writeMode: 'danger-full-access',
    planTiming: 'now',
    planQuestions: 'autonomous',
    allowPaid: true,
    budgetUsd: 12,
  })
})

test('edit sends only what was sent, and null clears what the form can clear', async () => {
  const pristine = fakeApi({ ticket: fakeTicket({ column: 'backlog', phase: 'plan', planTiming: 'at_pickup', planQuestions: 'interactive' }) })
  await runOrchestratorTool('kanban_edit', { ticket: 'KAN-1', workspace: null }, pristine.api)
  assert.deepEqual(pristine.calls.find((call) => call[0] === 'edit')[2], { workspaceCwd: null })
  await runOrchestratorTool('kanban_edit', { ticket: 'KAN-1', acceptance: [] }, pristine.api)
  assert.deepEqual(pristine.calls.at(-1)[2], { acceptance: [] }, 'an emptied list is an answer: it clears the criteria')
})

test('edit refuses the junk create refuses, and keeps the pristine lock', async () => {
  const pristine = fakeApi({ ticket: fakeTicket({ column: 'backlog', phase: 'plan', planTiming: 'at_pickup', planQuestions: 'interactive', budgetUsd: 0 }) })
  const base = { ticket: 'KAN-1' }
  await assert.rejects(() => runOrchestratorTool('kanban_edit', { ...base, writeMode: 'full-access' }, pristine.api), /writeMode must be one of/)
  await assert.rejects(() => runOrchestratorTool('kanban_edit', { ...base, priority: 1.5 }, pristine.api), /priority must be an integer/)
  await assert.rejects(() => runOrchestratorTool('kanban_edit', { ...base, budgetUsd: -2 }, pristine.api), /budgetUsd must be a finite number/)
  await assert.rejects(() => runOrchestratorTool('kanban_edit', { ...base, allowPaid: true }, pristine.api), /positive budgetUsd/, 'flipping a ticket paid without money is refused')
  await assert.rejects(() => runOrchestratorTool('kanban_edit', { ...base, acceptance: ['ok', ''] }, pristine.api), /non-empty string/)
  await assert.rejects(() => runOrchestratorTool('kanban_edit', { ...base, workspace: '  ' }, pristine.api), /workspace must be a non-empty directory path/)
  await assert.rejects(() => runOrchestratorTool('kanban_edit', { ...base, planTiming: 'soon' }, pristine.api), /planTiming must be one of/)
  assert.equal(pristine.calls.some((call) => call[0] === 'edit'), false)

  // The lock is the first thing asked, whatever the patch carries: a setting is
  // as much a change to a card a role may already be reading as a new title is.
  const started = fakeApi({ ticket: fakeTicket({ column: 'working', phase: 'implement' }), ticketEditable: false })
  await assert.rejects(() => runOrchestratorTool('kanban_edit', { ticket: 'KAN-1', workspace: '/srv/x' }, started.api), /already started; it can no longer be edited/)
  await assert.rejects(() => runOrchestratorTool('kanban_edit', { ticket: 'KAN-1', acceptance: ['too late'] }, started.api), /already started/)
  assert.equal(started.calls.some((call) => call[0] === 'edit'), false)
})

test('a paid edit is legal when the budget is already on the ticket', async () => {
  const funded = fakeApi({ ticket: fakeTicket({ column: 'backlog', phase: 'plan', budgetUsd: 40 }) })
  await runOrchestratorTool('kanban_edit', { ticket: 'KAN-1', allowPaid: true }, funded.api)
  assert.deepEqual(funded.calls.find((call) => call[0] === 'edit')[2], { allowPaid: true })
})

test('every read shows the workspace a ticket was filed against', () => {
  const facts = ticketLineFacts(fakeTicket({ column: 'backlog', workspaceCwd: '/srv/work/dsh-deploy' }))
  assert.equal(facts.settings.workspaceCwd, '/srv/work/dsh-deploy')
  assert.equal(ticketLineFacts(fakeTicket()).settings.workspaceCwd, null, 'no workspace is the engine default, spelled null')
})

// ------------------------------------------------- parity with the real store --

const LOG = { info() {}, warn() {}, error() {}, debug() {} }

let KanbanOrchestrator
try {
  await import('@deepseek-ai/dsh-llm')
  await import('@deepseek-ai/dsh-tools')
  KanbanOrchestrator = (await import('../src/orchestrator-host.mjs')).KanbanOrchestrator
} catch {
  KanbanOrchestrator = undefined
}
const needsPeers = KanbanOrchestrator === undefined ? 'the dsh peer packages are not installed' : false

function hostHarness({ presets = null, wip = null } = {}) {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const ctx = {
    get: (name) => (name === 'agentPresets' ? presets : undefined),
    on: () => () => {},
  }
  const orchestrator = new KanbanOrchestrator({
    ctx,
    store,
    engine: { active: new Set(), tick: () => {}, wip },
    driver: undefined,
    getConfig: () => ({ orchestratorEnabled: true, orchestratorSessionId: 'kanban-orchestrator', defaultWorkspaceCwd: process.cwd() }),
    getPrompts: () => ({ bodies: {} }),
    log: LOG,
  })
  return { store, api: orchestrator.managementApi('orchestrator') }
}

test('what create files is what the board stores: workspace, acceptance, budget', { skip: needsPeers }, async () => {
  const { store, api } = hostHarness()
  const answer = await runOrchestratorTool('kanban_create', {
    title: 'A card with everything',
    body: 'b',
    workspace: '/srv/work/dsh-deploy',
    acceptance: ['the row carries its workspace', 'the budget reads back'],
    allowPaid: true,
    budgetUsd: 25,
    priority: 4,
    worktree: false,
  }, api)
  assert.equal(answer.created, true)
  const row = store.getTicket(answer.ticket.key)
  assert.equal(row.workspaceCwd, '/srv/work/dsh-deploy')
  assert.deepEqual(store.listAcceptance(row.id).map((entry) => entry.statement), ['the row carries its workspace', 'the budget reads back'])
  assert.equal(row.allowPaid, true)
  assert.equal(row.budgetUsd, 25)
  assert.equal(row.priority, 4)
  assert.equal(row.column, 'backlog', 'a card nobody asked for in Working waits in Backlog')
  assert.equal(answer.ticket.settings.workspaceCwd, '/srv/work/dsh-deploy', 'the answer the model reads carries it too')
})

test('create mirrors the human form’s worktree default against the workspace it was given', { skip: needsPeers }, async () => {
  // The board cuts its own copies, so intent is ON wherever there is a checkout
  // to cut one from — and the checkout that decides is the one the card names.
  const { store, api } = hostHarness()
  const inRepo = await runOrchestratorTool('kanban_create', { title: 'in a repo', body: 'b', workspace: process.cwd() }, api)
  assert.equal(store.getTicket(inRepo.ticket.key).worktree, true, 'this checkout is a git work tree, so the card wants its own copy')
  const elsewhere = await runOrchestratorTool('kanban_create', { title: 'nowhere', body: 'b', workspace: '/definitely/not/a/checkout' }, api)
  assert.equal(store.getTicket(elsewhere.ticket.key).worktree, false)
})

test('create into Working obeys the cap the same way a human filing does', { skip: needsPeers }, async () => {
  const refusal = { cap: 2, occupancy: 2, position: 3, reason: 'WIP cap 2/2 — queued at position 3. It starts automatically when a Working slot frees.' }
  const { store, api } = hostHarness({ wip: { arrivalRefusal: () => refusal } })
  const answer = await runOrchestratorTool('kanban_create', { title: 'straight in', body: 'b', column: 'working' }, api)
  assert.equal(answer.created, true)
  assert.deepEqual(answer.queued, refusal)
  const row = store.getTicket(answer.ticket.key)
  assert.equal(row.column, 'backlog', 'at the cap the intent is recorded, nothing is lost')
  assert.equal(row.needsAttentionReason, refusal.reason, 'and the card wears the queue notice')
})

test('create into Working with room on the board lands in Working', { skip: needsPeers }, async () => {
  const { store, api } = hostHarness({ wip: { arrivalRefusal: () => null } })
  const answer = await runOrchestratorTool('kanban_create', { title: 'go now', body: 'b', column: 'working' }, api)
  assert.equal(answer.queued, undefined)
  assert.equal(store.getTicket(answer.ticket.key).column, 'working')
})

test('edit writes the settings patch and replaces acceptance through the store', { skip: needsPeers }, async () => {
  const { store, api } = hostHarness()
  const ticket = store.createTicket({ title: 'pristine', body: 'b' })
  const answer = await runOrchestratorTool('kanban_edit', {
    ticket: ticket.key,
    title: 'fixed up',
    acceptance: ['first', 'second'],
    workspace: '/srv/work/dsh-plugins',
    preset: null,
    budgetUsd: 3,
  }, api)
  assert.equal(answer.edited, true)
  const row = store.getTicket(ticket.id)
  assert.equal(row.title, 'fixed up')
  assert.equal(row.workspaceCwd, '/srv/work/dsh-plugins')
  assert.equal(row.budgetUsd, 3)
  assert.deepEqual(store.listAcceptance(ticket.id).map((entry) => entry.statement), ['first', 'second'])
  assert.deepEqual(answer.acceptance.map((entry) => entry.statement), ['first', 'second'])
  const event = store.listEvents(ticket.id).find((entry) => entry.kind === 'ticket_updated')
  assert.equal(event.actor, 'orchestrator', 'the audit trail says who changed it')
  assert.deepEqual([...event.payload.fields].sort(), ['budgetUsd', 'title', 'workspaceCwd'])

  // A replacement means a replacement: dropping a line drops it.
  await runOrchestratorTool('kanban_edit', { ticket: ticket.key, acceptance: ['only'] }, api)
  assert.deepEqual(store.listAcceptance(ticket.id).map((entry) => entry.statement), ['only'])
  await runOrchestratorTool('kanban_edit', { ticket: ticket.key, workspace: null }, api)
  assert.equal(store.getTicket(ticket.id).workspaceCwd, null, 'null is the engine default, not the string "null"')
})

test('an edit of a ticket the engine has touched is refused before the store sees it', { skip: needsPeers }, async () => {
  const { store, api } = hostHarness()
  const ticket = store.createTicket({ title: 'started', body: 'b' })
  store.updateTicket(ticket.id, { title: 'engine wrote it' }, { actor: 'engine' })
  store.setNeedsAttention(ticket.id, 'parked in implement: it is not pristine any more')
  await assert.rejects(
    () => runOrchestratorTool('kanban_edit', { ticket: ticket.key, workspace: '/srv/x' }, api),
    /already started; it can no longer be edited/,
  )
  assert.equal(store.getTicket(ticket.id).workspaceCwd, null, 'the refusal wrote nothing')
})
