// Archiving a closed ticket's workspace: the pure decisions, then the engine's
// post-close step against a fake worktree service and workspace registry.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { archiveSkipReason, archivesColumn, copyIsGone, isManagedWorktreePath } from '../src/archive.mjs'
import { resolveConfig } from '../src/config.mjs'
import { pickedUp, setup } from './support/engine-harness.mjs'

const ROOT = mkdtempSync(join(tmpdir(), 'kanban-archive-'))
let counter = 0
/** A real directory under a `.dsh-worktrees` root, so existence checks mean something. */
function worktreeDir() {
  const dir = join(ROOT, `repo${++counter}`, '.dsh-worktrees', `copy-${counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test('config: archiveWorkspaceOnClose defaults to off and rejects anything else', () => {
  assert.equal(resolveConfig({}).config.archiveWorkspaceOnClose, 'off')
  for (const mode of ['off', 'done', 'done_and_discarded']) {
    assert.equal(resolveConfig({ archiveWorkspaceOnClose: mode }).config.archiveWorkspaceOnClose, mode)
  }
  assert.throws(() => resolveConfig({ archiveWorkspaceOnClose: 'always' }), /archiveWorkspaceOnClose/)
  assert.throws(() => resolveConfig({ archiveWorkspaceOnClose: true }), /archiveWorkspaceOnClose/)
})

test('archivesColumn: which closures each mode covers', () => {
  assert.equal(archivesColumn('off', 'done'), false)
  assert.equal(archivesColumn('done', 'done'), true)
  assert.equal(archivesColumn('done', 'discarded'), false)
  assert.equal(archivesColumn('done_and_discarded', 'discarded'), true)
  assert.equal(archivesColumn('done_and_discarded', 'working'), false)
})

test('isManagedWorktreePath needs an absolute path strictly inside a .dsh-worktrees directory', () => {
  assert.equal(isManagedWorktreePath('/r/p/.dsh-worktrees/otter'), true)
  assert.equal(isManagedWorktreePath('/r/p/.dsh-worktrees/otter/'), true)
  assert.equal(isManagedWorktreePath('/r/p/.dsh-worktrees'), false)
  assert.equal(isManagedWorktreePath('/r/p/work'), false)
  assert.equal(isManagedWorktreePath('/r/p/.dsh-worktrees-x/otter'), false)
  assert.equal(isManagedWorktreePath('.dsh-worktrees/otter'), false)
  assert.equal(isManagedWorktreePath(null), false)
})

test('archiveSkipReason: silent without a managed copy, loud for a live checkout or a sharing ticket', () => {
  const path = '/r/p/.dsh-worktrees/otter'
  const mine = { id: 'a', key: 'KAN-1', workspaceCwd: path, column: 'done' }
  const run = (extra = {}) => archiveSkipReason({ ticket: mine, tickets: [mine], openSessions: [], ...extra })
  assert.equal(run(), null)
  assert.deepEqual(run({ ticket: { ...mine, workspaceCwd: null } }), { reason: 'no_workspace', silent: true })
  assert.equal(run({ ticket: { ...mine, workspaceCwd: '/r/p' } }).silent, true)
  assert.equal(run({ liveCheckouts: ['/r/p'] }), null, 'a managed copy under the live checkout is archivable')
  assert.equal(run({ liveCheckouts: ['/r/p/.dsh-worktrees/otter'] }).reason, 'live_checkout', 'the live root itself is skipped')
  const nested = { ...mine, workspaceCwd: '/r/p/sub/.dsh-worktrees/otter' }
  assert.equal(run({ ticket: nested, tickets: [nested], liveCheckouts: ['/r/p'] }).reason, 'live_checkout', 'only a directory directly under the root is managed')
  const evil = { ...mine, workspaceCwd: '/r/p/.dsh-worktrees-evil/.dsh-worktrees/otter' }
  assert.equal(run({ ticket: evil, tickets: [evil], liveCheckouts: ['/r/p'] }).reason, 'live_checkout')
  const other = { id: 'b', key: 'KAN-2', workspaceCwd: `${path}/`, column: 'working' }
  assert.equal(run({ tickets: [mine, other] }).reason, 'shared_with_open_ticket')
  const closedOther = { ...other, column: 'done' }
  assert.equal(run({ tickets: [mine, closedOther] }), null, 'a closed sharer does not block')
  assert.equal(run({ tickets: [mine, closedOther], openSessions: [{ ticketId: 'b' }] }).reason, 'shared_with_open_ticket')
  assert.equal(run({ tickets: [mine, { ...other, workspaceCwd: '/r/p/.dsh-worktrees/heron' }] }), null)
})

test('copyIsGone: a refusal never counts; nothing-to-do counts only when the directory is absent', () => {
  assert.equal(copyIsGone({ removed: true, refused: false }, false), true)
  assert.equal(copyIsGone({ removed: false, refused: true, code: 'unsaved-work' }, true), false)
  assert.equal(copyIsGone({ removed: false, refused: false, code: 'already-gone' }, false), true)
  assert.equal(copyIsGone({ removed: false, refused: false, code: 'not-managed' }, true), false)
  assert.equal(copyIsGone({ removed: false, refused: false, code: 'not-managed' }, false), true)
  assert.equal(copyIsGone(undefined, false), false)
})

// ---------------------------------------------------------------- the engine step

/** Engine + store with a fake worktree service and workspace registry wired in. */
function rig({ mode = 'done', service, archive, config = {} } = {}) {
  const t = setup({}, { config: { archiveWorkspaceOnClose: mode, ...config } })
  const calls = { removed: [], archived: [] }
  const worktree = service === undefined
    ? {
      removeForPath: async ({ path }) => {
        calls.removed.push(path)
        rmSync(path, { recursive: true, force: true })
        return { removed: true, refused: false }
      },
    }
    : service
  const registry = {
    archiveSession: archive ?? (async (id) => { calls.archived.push(id) }),
  }
  t.engine.ctx = {
    get(name) {
      if (name === 'betterGitWorktree') return worktree
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
  }
  const ticketIn = (cwd, extra = {}) => {
    const ticket = pickedUp(t.store, { workspaceCwd: cwd, ...extra })
    t.store.attachSession({ ticketId: ticket.id, dshSessionId: `s-${ticket.key}-1`, role: 'build', purpose: 'build' })
    t.store.attachSession({ ticketId: ticket.id, dshSessionId: `s-${ticket.key}-2`, role: 'review', purpose: 'review' })
    return t.store.getTicket(ticket.id)
  }
  const kinds = (ticket) => t.store.listEvents(ticket.id, { limit: 100 }).filter((e) => e.kind.startsWith('workspace_'))
  const close = async (ticket, how = 'markDone') => {
    if (how === 'discard') {
      for (const phase of ['implement', 'review', 'verify']) t.store.transitionTicket(ticket.id, { phase }, { actor: 'engine', reason: 'seed' })
    }
    const result = how === 'discard' ? await t.engine.discard(ticket.id, 'no longer needed') : await t.engine.markDone(ticket.id, 'done by hand')
    await t.engine.settlePostClose()
    return result
  }
  return { ...t, calls, ticketIn, kinds, close }
}

test('a clean worktree: closing removes it, archives every session, records one event, and a second close is a no-op', async () => {
  const r = rig()
  const dir = worktreeDir()
  const ticket = r.ticketIn(dir)
  await r.close(ticket)
  assert.deepEqual(r.calls.removed, [dir])
  assert.deepEqual(r.calls.archived, [`s-${ticket.key}-1`, `s-${ticket.key}-2`])
  const events = r.kinds(ticket)
  assert.deepEqual(events.map((e) => e.kind), ['workspace_archived'])
  assert.equal(events[0].payload.sessionsArchived, 2)
  // Running the step again changes nothing: no second removal, no second event.
  r.engine.postClose(r.store.getTicket(ticket.id))
  await r.engine.settlePostClose()
  assert.equal(r.calls.removed.length, 1)
  assert.equal(r.kinds(ticket).length, 1)
})

test('approve archives too, and discard only when the mode covers it', async () => {
  const done = rig({ mode: 'done' })
  const approved = done.ticketIn(worktreeDir())
  for (const phase of ['implement', 'review', 'verify']) {
    done.store.transitionTicket(approved.id, { phase }, { actor: 'engine', reason: 'seed' })
  }
  await done.engine.approve(approved.id, 'ship it')
  await done.engine.settlePostClose()
  assert.equal(done.calls.removed.length, 1)

  const discarded = done.ticketIn(worktreeDir())
  await done.close(discarded, 'discard')
  assert.equal(done.calls.removed.length, 1, 'mode done leaves a discarded ticket alone')
  assert.deepEqual(done.kinds(discarded), [])

  const both = rig({ mode: 'done_and_discarded' })
  const gone = both.ticketIn(worktreeDir())
  await both.close(gone, 'discard')
  assert.equal(both.calls.removed.length, 1)
  assert.deepEqual(both.kinds(gone).map((e) => e.kind), ['workspace_archived'])
})

test('config off: nothing is removed or archived and no event is written', async () => {
  const r = rig({ mode: 'off' })
  const ticket = r.ticketIn(worktreeDir())
  await r.close(ticket)
  assert.deepEqual(r.calls, { removed: [], archived: [] })
  assert.deepEqual(r.kinds(ticket), [])
})

for (const [name, answer] of [
  ['dirty', { removed: false, refused: true, code: 'unsaved-work', reason: '3 uncommitted path(s)' }],
  ['unpushed', { removed: false, refused: true, code: 'unsaved-work', reason: '1 unpushed commit(s)' }],
  ['unreadable', { removed: false, refused: true, code: 'unverified', reason: 'could not verify' }],
]) {
  test(`a ${name} copy is refused: nothing archived, the ticket still closes, the event says why`, async () => {
    const r = rig({ service: { removeForPath: async () => answer } })
    const dir = worktreeDir()
    const ticket = r.ticketIn(dir)
    const done = await r.close(ticket)
    assert.equal(done.column, 'done')
    assert.deepEqual(r.calls.archived, [])
    const [event] = r.kinds(ticket)
    assert.equal(event.kind, 'workspace_archive_skipped')
    assert.equal(event.payload.reason, 'removal_refused')
    assert.equal(event.payload.code, answer.code)
    assert.equal(event.payload.detail, answer.reason)
  })
}

test('a second open ticket on the same workspace blocks removal; so does its open session', async () => {
  const r = rig()
  const dir = worktreeDir()
  const first = r.ticketIn(dir)
  const second = r.ticketIn(dir)
  await r.close(first)
  assert.deepEqual(r.calls, { removed: [], archived: [] })
  assert.equal(r.kinds(first)[0].payload.reason, 'shared_with_open_ticket')
  await r.close(second)
  assert.deepEqual(r.calls.removed, [dir], 'once the sharer closes too, the last one out clears the copy')
})

test('a ticket without a worktree, or outside .dsh-worktrees, is untouched and silent', async () => {
  const r = rig()
  const plain = r.ticketIn(null)
  const checkout = r.ticketIn(join(ROOT, 'production-checkout'))
  await r.close(plain)
  await r.close(checkout)
  assert.deepEqual(r.calls, { removed: [], archived: [] })
  assert.deepEqual(r.kinds(plain), [])
  assert.deepEqual(r.kinds(checkout), [])
})

test('a live checkout is never cleared even when it sits under a .dsh-worktrees directory', async () => {
  const dir = worktreeDir()
  const r = rig({ config: { liveCheckouts: [dir] } })
  const ticket = r.ticketIn(dir)
  await r.close(ticket)
  assert.deepEqual(r.calls, { removed: [], archived: [] })
  assert.equal(r.kinds(ticket)[0].payload.reason, 'live_checkout')
})

test('without the removal export (an older worktree plugin) the copy stays and the reason is recorded', async () => {
  const r = rig({ service: {} })
  const ticket = r.ticketIn(worktreeDir())
  await r.close(ticket)
  assert.deepEqual(r.calls.archived, [])
  assert.equal(r.kinds(ticket)[0].payload.reason, 'worktree_service_unavailable')
})

test('removal that throws does not fail markDone, discard or approve', async () => {
  const boom = { removeForPath: async () => { throw new Error('disk on fire') } }
  const r = rig({ mode: 'done_and_discarded', service: boom })
  const a = r.ticketIn(worktreeDir())
  const b = r.ticketIn(worktreeDir())
  const c = r.ticketIn(worktreeDir())
  for (const phase of ['implement', 'review', 'verify']) r.store.transitionTicket(c.id, { phase }, { actor: 'engine', reason: 'seed' })
  assert.equal((await r.close(a)).column, 'done')
  assert.equal((await r.close(b, 'discard')).column, 'discarded')
  assert.equal((await r.engine.approve(c.id)).column, 'done')
  await r.engine.settlePostClose()
  for (const ticket of [a, b, c]) {
    const [event] = r.kinds(ticket)
    assert.equal(event.kind, 'workspace_archive_skipped')
    assert.equal(event.payload.reason, 'error')
    assert.match(event.payload.detail, /disk on fire/)
  }
})

test('archiveSession throwing does not fail the close; unknown sessions are tolerated, others retried then reported', async () => {
  const attempts = new Map()
  const archive = async (id) => {
    attempts.set(id, (attempts.get(id) ?? 0) + 1)
    if (id.endsWith('-1')) throw Object.assign(new Error('no such session'), { name: 'WorkspaceUnknownSessionError' })
    throw new Error('registry offline')
  }
  const r = rig({ archive })
  const ticket = r.ticketIn(worktreeDir())
  const done = await r.close(ticket)
  assert.equal(done.column, 'done')
  const [event] = r.kinds(ticket)
  assert.equal(event.kind, 'workspace_archived')
  assert.equal(event.payload.sessionsUnknown, 1)
  assert.equal(event.payload.sessionsArchived, 0)
  assert.equal(event.payload.sessionsFailed.length, 1)
  assert.match(event.payload.sessionsFailed[0].error, /registry offline/)
  assert.equal(attempts.get(`s-${ticket.key}-1`), 1, 'an unknown session is not retried')
  assert.equal(attempts.get(`s-${ticket.key}-2`), 3, 'other errors are retried a few times')
})

test('a transient archive failure succeeds on retry', async () => {
  let failures = 1
  const archived = []
  const archive = async (id) => {
    if (failures-- > 0) throw new Error('blip')
    archived.push(id)
  }
  const r = rig({ archive })
  const ticket = r.ticketIn(worktreeDir())
  await r.close(ticket)
  assert.equal(archived.length, 2)
  assert.equal(r.kinds(ticket)[0].payload.sessionsFailed.length, 0)
})

test('a copy an earlier attempt already removed still gets its sessions archived, once', async () => {
  const r = rig({ service: { removeForPath: async () => ({ removed: false, refused: false, code: 'not-managed', reason: 'not a managed working copy' }) } })
  const dir = worktreeDir()
  const ticket = r.ticketIn(dir)
  rmSync(dir, { recursive: true, force: true })
  await r.close(ticket)
  assert.equal(r.calls.archived.length, 2)
  assert.equal(r.kinds(ticket)[0].kind, 'workspace_archived')
})

test('a path the worktree plugin does not own, still on disk, is left alone', async () => {
  const r = rig({ service: { removeForPath: async () => ({ removed: false, refused: false, code: 'not-managed', reason: 'not a managed working copy' }) } })
  const ticket = r.ticketIn(worktreeDir())
  await r.close(ticket)
  assert.deepEqual(r.calls.archived, [])
  assert.equal(r.kinds(ticket)[0].payload.reason, 'not_removed')
})
