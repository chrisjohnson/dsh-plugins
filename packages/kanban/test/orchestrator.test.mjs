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

import {
  MAX_DIGEST_LINES,
  ORCHESTRATOR_TOOL_NAMES,
  ORCHESTRATOR_TOOL_SPECS,
  WATCHED_EVENT_KINDS,
  boardSnapshotText,
  clip,
  createDigestWindow,
  digestEvent,
  isWatchedEvent,
  runOrchestratorTool,
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

test('the orchestrator can author tickets but cannot approve, discard or close them', () => {
  // The boundary KAN-63 moved: filing a ticket and fixing the title/body of an
  // unstarted one are now the orchestrator's. Ending a ticket is not. KAN-66
  // added `kanban_configure`: the settings of an open ticket are its own lever
  // now, which is still not a way to close one.
  const forbidden = /approve|discard|close|delete|submit|answer/
  for (const name of ORCHESTRATOR_TOOL_NAMES) {
    assert.equal(forbidden.test(name), false, `${name} crosses the boundary`)
  }
  assert.deepEqual([...ORCHESTRATOR_TOOL_NAMES].sort(), [
    'kanban_board',
    'kanban_configure',
    'kanban_create',
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
