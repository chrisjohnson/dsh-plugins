// KAN-66, gap 2: `kanban_configure` — the orchestrator's lever over a ticket's
// settings.
//
// Preset, write mode, worktree, priority, plan timing and budget used to be set
// by the human create form and then frozen: `kanban_edit` is title/body-only and
// only pre-start, so when the orchestrator found a card filed with the wrong
// combination — a harness change with no Creator preset, no Full Access, no
// worktree of its own — the only move was to ask a person to flip it in the UI.
//
// Two boundaries make that safe, and both are tested here:
//
//   - an **open ticket only**. Backlog and Working are the orchestrator's;
//     Done and Discarded are a human's calls and a closed card is frozen;
//   - **the same validation the create form applies**, key by key, so a refusal
//     is a sentence the model can correct rather than a store error.
//
// The second half runs the accepted patch through the real store, because the
// claim is parity: what the guard lets through must be what the store writes,
// with `actor: 'orchestrator'` recorded as the audit trail.

import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from '../src/db.mjs'
import { ORCHESTRATOR_TOOL_SPECS, runOrchestratorTool, ticketLineFacts } from '../src/orchestrator.mjs'
import { KanbanStore, WRITE_MODES } from '../src/store.mjs'

const spec = ORCHESTRATOR_TOOL_SPECS.find((candidate) => candidate.name === 'kanban_configure')

const ticket = (over = {}) => ({
  id: 't-65',
  key: 'KAN-65',
  title: 'A dsh change',
  column: 'backlog',
  phase: 'plan',
  planTiming: 'at_pickup',
  planQuestions: 'interactive',
  priority: 0,
  allowPaid: false,
  budgetUsd: 0,
  preset: null,
  writeMode: null,
  worktree: false,
  needsAttentionReason: null,
  ...over,
})

function fakeApi(over = {}) {
  const calls = []
  const found = over.ticket ?? ticket()
  return {
    calls,
    api: {
      resolveTicket: (key) => (key === found.key || key === found.id ? found : null),
      configure: async (target, patch, reason) => {
        calls.push(['configure', target, patch, reason])
        return { configured: true, patch }
      },
    },
  }
}

const configure = async (args, api = fakeApi().api) => runOrchestratorTool('kanban_configure', args, api)

/** The "nothing to configure" sentence, read off the tool rather than copied. */
const CONFIGURE_KEYS_SENTENCE = await runOrchestratorTool('kanban_configure', { ticket: 'KAN-65' }, fakeApi().api)
  .then(() => '', (error) => error.message)

// ------------------------------------------------------------ what it accepts --

test('configure is declared with a model-facing contract', () => {
  assert.ok(spec, 'no kanban_configure spec')
  assert.equal(spec.parameters.ticket.required, true)
  for (const key of ['preset', 'writeMode', 'worktree', 'priority', 'planTiming', 'planQuestions', 'allowPaid', 'budgetUsd', 'reason']) {
    assert.ok(spec.parameters[key], `${key} is not in the contract`)
    assert.ok(typeof spec.parameters[key].description === 'string' && spec.parameters[key].description.length > 10)
  }
  // The two fields that may be cleared to "no opinion" say so in their type.
  for (const key of ['preset', 'writeMode']) {
    assert.deepEqual(spec.parameters[key].oneOf, [{ type: 'string' }, { type: 'null' }], `${key} must accept null`)
  }
})

test('a settings patch reaches the host seam on a Backlog ticket', async () => {
  const { api, calls } = fakeApi()
  await configure({
    ticket: 'KAN-65',
    preset: 'cordis',
    writeMode: 'danger-full-access',
    worktree: true,
    reason: 'a harness change needs the Creator preset, Full Access and its own worktree',
  }, api)
  assert.equal(calls.length, 1)
  const [, target, patch, reason] = calls[0]
  assert.equal(target.key, 'KAN-65', 'the resolved ticket, not the string it was given')
  assert.deepEqual(patch, { preset: 'cordis', writeMode: 'danger-full-access', worktree: true })
  assert.match(reason, /Creator preset/)
})

test('a Working ticket is configurable too: open means open', async () => {
  const { api, calls } = fakeApi({ ticket: ticket({ column: 'working', phase: 'implement' }) })
  await configure({ ticket: 'KAN-65', priority: 40 }, api)
  assert.deepEqual(calls[0][2], { priority: 40 })
})

test('the patch carries only the keys that were sent', async () => {
  const { api, calls } = fakeApi()
  await configure({ ticket: 'KAN-65', planTiming: 'now' }, api)
  assert.deepEqual(calls[0][2], { planTiming: 'now' }, 'one key in, one key out')
  await configure({ ticket: 'KAN-65', allowPaid: true, budgetUsd: 12.5 }, api)
  assert.deepEqual(calls.at(-1)[2], { allowPaid: true, budgetUsd: 12.5 })
})

test('null clears preset and writeMode back to the default', async () => {
  const { api, calls } = fakeApi()
  await configure({ ticket: 'KAN-65', preset: null, writeMode: null }, api)
  assert.deepEqual(calls[0][2], { preset: null, writeMode: null })
})

test('a preset id is trimmed, and a zero budget is a legal value', async () => {
  const { api, calls } = fakeApi()
  await configure({ ticket: 'KAN-65', preset: '  cordis  ', budgetUsd: 0 }, api)
  assert.deepEqual(calls[0][2], { preset: 'cordis', budgetUsd: 0 })
})

// ------------------------------------------------------------- what it refuses --

for (const column of ['done', 'discarded']) {
  test(`a ${column} ticket is a human call and refuses to be reconfigured`, async () => {
    const { api, calls } = fakeApi({ ticket: ticket({ column, phase: 'closed' }) })
    await assert.rejects(() => configure({ ticket: 'KAN-65', priority: 1 }, api), /only an open ticket can be reconfigured/)
    assert.equal(calls.length, 0, 'a refusal never reaches the store')
  })
}

test('at least one setting must be named', async () => {
  const { api, calls } = fakeApi()
  await assert.rejects(() => configure({ ticket: 'KAN-65' }, api), /nothing to configure/)
  await assert.rejects(() => configure({ ticket: 'KAN-65', reason: 'just a note' }, api), /nothing to configure/)
  assert.equal(calls.length, 0)
})

test('an unknown ticket is refused before anything else', async () => {
  const { api } = fakeApi()
  await assert.rejects(() => configure({ ticket: 'KAN-404', priority: 1 }, api), /no ticket matches/)
})

test('writeMode is the closed sandbox vocabulary or null', async () => {
  for (const mode of WRITE_MODES) {
    const { api, calls } = fakeApi()
    await configure({ ticket: 'KAN-65', writeMode: mode }, api)
    assert.deepEqual(calls[0][2], { writeMode: mode })
  }
  for (const bad of ['full-access', 'WRITE', '', 'danger']) {
    await assert.rejects(() => configure({ ticket: 'KAN-65', writeMode: bad }), /writeMode must be one of/)
  }
})

test('planTiming and planQuestions are the two enums the create form offers', async () => {
  await assert.rejects(() => configure({ ticket: 'KAN-65', planTiming: 'immediately' }), /planTiming must be one of now, at_pickup/)
  await assert.rejects(() => configure({ ticket: 'KAN-65', planQuestions: 'quiet' }), /planQuestions must be one of interactive, autonomous/)
  const { api, calls } = fakeApi()
  await configure({ ticket: 'KAN-65', planTiming: 'now', planQuestions: 'autonomous' }, api)
  assert.deepEqual(calls[0][2], { planTiming: 'now', planQuestions: 'autonomous' })
})

test('priority must be an integer', async () => {
  for (const bad of ['high', 1.5, NaN, true]) {
    await assert.rejects(() => configure({ ticket: 'KAN-65', priority: bad }), /priority must be an integer/)
  }
})

test('budgetUsd must be a finite number, never negative', async () => {
  for (const bad of [-1, -0.01, '10', Number.POSITIVE_INFINITY, null]) {
    await assert.rejects(() => configure({ ticket: 'KAN-65', budgetUsd: bad }), /budgetUsd must be a finite number/)
  }
})

test('the two booleans are booleans', async () => {
  await assert.rejects(() => configure({ ticket: 'KAN-65', worktree: 'yes' }), /worktree must be true or false/)
  await assert.rejects(() => configure({ ticket: 'KAN-65', allowPaid: 1 }), /allowPaid must be true or false/)
})

test('a preset must be a real id or null', async () => {
  await assert.rejects(() => configure({ ticket: 'KAN-65', preset: '   ' }), /preset must be an agent preset id/)
  await assert.rejects(() => configure({ ticket: 'KAN-65', preset: 7 }), /preset must be an agent preset id/)
})

test('turning a ticket paid without a budget is refused, however the pair arrives', async () => {
  // Nothing on the ticket, and nothing in the patch: the resulting ticket would
  // be paid with no money, which is what the create form refuses too.
  await assert.rejects(() => configure({ ticket: 'KAN-65', allowPaid: true }), /positive budgetUsd/)
  await assert.rejects(() => configure({ ticket: 'KAN-65', allowPaid: true, budgetUsd: 0 }), /positive budgetUsd/)
  // Turning it off is always allowed.
  const { api, calls } = fakeApi({ ticket: ticket({ allowPaid: true, budgetUsd: 5 }) })
  await configure({ ticket: 'KAN-65', allowPaid: false }, api)
  assert.deepEqual(calls[0][2], { allowPaid: false })
})

test('a budget already on the ticket satisfies allowPaid sent on its own', async () => {
  const { api, calls } = fakeApi({ ticket: ticket({ budgetUsd: 8 }) })
  await configure({ ticket: 'KAN-65', allowPaid: true }, api)
  assert.deepEqual(calls[0][2], { allowPaid: true })
})

// ------------------------------------------------------- parity with the store --

function storeHarness(over = {}) {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const created = store.createTicket({ title: 'A dsh change', body: 'b', ...over })
  return {
    store,
    created,
    api: {
      resolveTicket: (key) => (key === created.key ? store.getTicket(created.id) : null),
      configure: async (target, patch, reason) => store.updateTicket(target.id, patch, { actor: 'orchestrator', reason }),
    },
  }
}

test('what the guard accepts is what the store writes, recorded as the orchestrator', async () => {
  const { store, created, api } = storeHarness()
  const updated = await configure(
    { ticket: 'KAN-1', preset: 'cordis', writeMode: 'danger-full-access', worktree: true, priority: 30, planTiming: 'now', planQuestions: 'autonomous', reason: 'KAN-65 combination fix' },
    api,
  )
  assert.equal(updated.preset, 'cordis')
  assert.equal(updated.writeMode, 'danger-full-access')
  assert.equal(updated.worktree, true)
  assert.equal(updated.priority, 30)
  assert.equal(updated.planTiming, 'now')
  assert.equal(updated.planQuestions, 'autonomous')
  const event = store.listEvents(created.id).find((row) => row.kind === 'ticket_updated')
  assert.ok(event, 'the ticket_updated event is the audit trail')
  assert.equal(event.actor, 'orchestrator')
  assert.equal(event.payload.reason, 'KAN-65 combination fix')
  assert.deepEqual([...event.payload.fields].sort(), ['planQuestions', 'planTiming', 'preset', 'priority', 'worktree', 'writeMode'])
})

test('the store refuses what the guard let through, the pair included', async () => {
  const { store, api } = storeHarness()
  // The guard checks each key; the store re-checks the vocabulary and the paid
  // rule on the resulting row. A patch that slips past one is still not written.
  assert.throws(() => store.updateTicket('KAN-1', { writeMode: 'nope' }, { actor: 'orchestrator' }), /writeMode must be one of/)
  await assert.rejects(() => configure({ ticket: 'KAN-1', allowPaid: true }, api), /positive budgetUsd/)
})

test('clearing a preset through configure lands as null, not as the string "null"', async () => {
  const { store, api } = storeHarness({ preset: 'cordis', writeMode: 'read-only' })
  const updated = await configure({ ticket: 'KAN-1', preset: null, writeMode: null }, api)
  assert.equal(updated.preset, null)
  assert.equal(updated.writeMode, null)
  assert.equal(store.getTicket(store.listTickets({ columns: ['backlog'] })[0].id).preset, null)
})

// ---------------------------------------------------------------- KAN-93 ---
//
// The workspace joins the configurable settings. The case is the whole point of
// the ticket: an agent filed a batch of cards against the wrong checkout — or
// none, which is the engine default — and there was no tool on the board that
// could say which directory a ticket works in. `null` matters as much as a path:
// "I do not know, use the default" has to be an answer the model can give.

test('workspace is a configurable setting, and null clears it', async () => {
  assert.ok(spec.parameters.workspace, 'kanban_configure must declare workspace')
  assert.deepEqual(spec.parameters.workspace.oneOf, [{ type: 'string' }, { type: 'null' }])
  assert.match(spec.parameters.workspace.description, /engine default/)

  const { api, calls } = fakeApi()
  await configure({ ticket: 'KAN-65', workspace: '/srv/work/dsh-deploy' }, api)
  assert.deepEqual(calls[0][2], { workspaceCwd: '/srv/work/dsh-deploy' }, 'the model-facing name is workspace; the store field is workspaceCwd')
  await configure({ ticket: 'KAN-65', workspace: '  /srv/trimmed  ' }, api)
  assert.deepEqual(calls.at(-1)[2], { workspaceCwd: '/srv/trimmed' })
  await configure({ ticket: 'KAN-65', workspace: null }, api)
  assert.deepEqual(calls.at(-1)[2], { workspaceCwd: null }, 'null is an answer: fall back to the engine default')
})

test('a workspace that is not a path is refused before anything is written', async () => {
  const { api, calls } = fakeApi()
  for (const bad of ['', '   ', 7, true, {}]) {
    await assert.rejects(() => configure({ ticket: 'KAN-65', workspace: bad }, api), /workspace must be/)
  }
  assert.equal(calls.length, 0)
})

test('workspace counts as naming a setting, and appears in the refusal sentence', async () => {
  assert.match(CONFIGURE_KEYS_SENTENCE, /workspace/, 'the "nothing to configure" answer has to list the lever it just refused')
  const { api, calls } = fakeApi()
  await configure({ ticket: 'KAN-65', workspace: '/srv/x', priority: 5 }, api)
  assert.deepEqual(calls[0][2], { workspaceCwd: '/srv/x', priority: 5 })
})

function storeHarnessWithWorkspace(over = {}) {
  const harness = storeHarness(over)
  return {
    ...harness,
    configureWorkspace: async (value) => harness.api.configure(harness.created, value === null ? { workspaceCwd: null } : { workspaceCwd: value }, 'KAN-93 workspace fix'),
  }
}

test('a configured workspace lands on the row, and clearing it lands as null', async () => {
  const { store, created, configureWorkspace } = storeHarnessWithWorkspace()
  assert.equal(created.workspaceCwd, null, 'a ticket filed without one has no opinion stored')
  await configureWorkspace('/srv/work/dsh-plugins')
  assert.equal(store.getTicket(created.id).workspaceCwd, '/srv/work/dsh-plugins')
  await configureWorkspace(null)
  assert.equal(store.getTicket(created.id).workspaceCwd, null)
  const event = store.listEvents(created.id).find((row) => row.kind === 'ticket_updated')
  assert.equal(event.actor, 'orchestrator')
  assert.deepEqual(event.payload.fields, ['workspaceCwd'])
})

test('the settings block a read carries names the workspace', async () => {
  const { store, created, configureWorkspace } = storeHarnessWithWorkspace()
  await configureWorkspace('/srv/work/dsh-deploy')
  const row = store.getTicket(created.id)
  assert.equal(ticketLineFacts(row).settings.workspaceCwd, '/srv/work/dsh-deploy')
})
