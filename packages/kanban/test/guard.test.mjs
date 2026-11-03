import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import { resolveConfig } from '../src/config.mjs'
import {
  clonePrefix,
  cloneNames,
  evaluateGuard,
  isWithin,
  makeGuardApprover,
  resolveLiveCheckouts,
  ticketNumber,
} from '../src/guard.mjs'

const LIVE = '/srv/live/dsh-deploy'
const HOME = '/home/tester'
const A = { key: 'KAN-5', column: 'working', phase: 'implement', workspaceCwd: '/w/kan5' }
const B = { key: 'KAN-6', column: 'working', phase: 'implement', workspaceCwd: '/w/kan6' }
const C = { key: 'KAN-7', column: 'done', phase: 'closed', workspaceCwd: '/w/kan7' }
const D = { key: 'KAN-8', column: 'backlog', phase: 'plan', workspaceCwd: null }
const TICKETS = [A, B, C, D]

const judge = (toolName, args, extra = {}) =>
  evaluateGuard({ ticket: A, tickets: TICKETS, toolName, arguments: args, cwd: A.workspaceCwd, liveCheckouts: [LIVE], home: HOME, ...extra })
const bash = (command, extra) => judge('bash', { command }, extra)
const write = (file_path, extra) => judge('write', { file_path }, extra)

// ----------------------------------------------------------- naming helpers --

test('ticket keys map to the clone convention', () => {
  assert.equal(ticketNumber('KAN-12'), 12)
  assert.equal(ticketNumber('nonsense'), null)
  assert.equal(clonePrefix('KAN-12'), 'kan12')
  assert.deepEqual(cloneNames('KAN-12'), { plugins: 'kan12-plugins', deploy: 'kan12-deploy' })
  assert.equal(cloneNames('x'), null)
})

test('isWithin respects segment boundaries', () => {
  assert.equal(isWithin('/a/b', '/a/b'), true)
  assert.equal(isWithin('/a/b', '/a/b/c'), true)
  assert.equal(isWithin('/a/b', '/a/bc'), false)
  assert.equal(isWithin('/a/b/', '/a/b/../b/c'), true)
  assert.equal(isWithin('', '/a'), false)
})

// ------------------------------------------------------------ cross-ticket --

test('a write into another open ticket workspace is denied naming the owner', () => {
  const verdict = write('/w/kan6/src/x.mjs')
  assert.equal(verdict.deny, true)
  assert.equal(verdict.kind, 'cross_ticket')
  assert.equal(verdict.owner, 'KAN-6')
  assert.match(verdict.message, /KAN-6/)
  assert.match(verdict.message, /still open/)
})

test('the session own workspace and own clones pass', () => {
  assert.equal(write('/w/kan5/src/x.mjs').deny, false)
  assert.equal(write('/lab/.dsh-worktrees/kan5-plugins/src/x.mjs').deny, false)
  assert.equal(bash('cd /lab/.dsh-worktrees/kan5-deploy && git status').deny, false)
})

test('clones named for another open ticket are denied wherever they live', () => {
  for (const path of ['/lab/.dsh-worktrees/kan6-plugins/x', '/lab/.dsh-worktrees/kan6-deploy', '/anywhere/kan6/y', '/lab/KAN6-plugins/x']) {
    const verdict = write(path)
    assert.equal(verdict.deny, true, path)
    assert.equal(verdict.owner, 'KAN-6', path)
  }
})

test('a backlog ticket without a workspace still owns its named clones', () => {
  assert.equal(write('/lab/.dsh-worktrees/kan8-plugins/x').owner, 'KAN-8')
})

test('a closed ticket workspace and clones stay accessible', () => {
  assert.equal(write('/w/kan7/notes.txt').deny, false)
  assert.equal(write('/lab/.dsh-worktrees/kan7-plugins/x').deny, false)
  assert.equal(bash('cat /w/kan7/README.md /lab/.dsh-worktrees/kan7-deploy/package.json').deny, false)
})

test('a clone name for a ticket that does not exist is not anyones', () => {
  assert.equal(write('/lab/.dsh-worktrees/kan99-plugins/x').deny, false)
  assert.equal(write('/lab/kanban/x').deny, false)
  assert.equal(write('/lab/kan6x/x').deny, false)
})

test('bash commands that reach another open ticket are denied in each spelling', () => {
  for (const command of [
    'cat /w/kan6/secret',
    'git -C /lab/.dsh-worktrees/kan6-plugins status',
    'cd /w/kan6 && ls',
    'cd /lab && cd .dsh-worktrees/kan6-deploy && ls',
    'cp /w/kan5/a /w/kan6/a',
    'ls ../kan6',
    'ls "/w/kan6/dir"',
  ]) {
    const verdict = bash(command)
    assert.equal(verdict.deny, true, command)
    assert.equal(verdict.owner, 'KAN-6', command)
  }
})

test('relative paths resolve against the session cwd', () => {
  assert.equal(write('../kan6/x', { cwd: '/w/kan5' }).owner, 'KAN-6')
  assert.equal(write('src/x', { cwd: '/w/kan5' }).deny, false)
})

test('a nested path of the own workspace is not another tickets even if its parent is', () => {
  const nested = { ...A, workspaceCwd: '/w/kan6/inner' }
  const verdict = evaluateGuard({ ticket: nested, tickets: [nested, B], toolName: 'write', arguments: { file_path: '/w/kan6/inner/x' }, cwd: nested.workspaceCwd })
  assert.equal(verdict.deny, false)
})

// ------------------------------------------------------------ live checkout --

test('writes to the live checkout are denied', () => {
  assert.equal(write(`${LIVE}/package.json`).kind, 'live_checkout')
  assert.equal(judge('edit', { file_path: `${LIVE}/.dsh/profiles/web/package.json` }).deny, true)
  assert.equal(bash(`echo x > ${LIVE}/f`).deny, true)
  assert.equal(bash(`rm -rf ${LIVE}/node_modules`).deny, true)
  assert.equal(bash(`git -C ${LIVE} checkout main`).deny, true)
  assert.equal(bash(`cd ${LIVE} && git commit -am x`).deny, true)
  assert.equal(bash(`cd ${LIVE} && sed -i s/a/b/ package.json`).deny, true)
  assert.equal(bash(`cd ${LIVE}/.dsh/profiles/web && pnpm add x`).deny, true)
  assert.match(bash(`touch ${LIVE}/f`).message, /pre-stage/)
})

test('the pre-stage is allowed from the approval phase only', () => {
  const verify = { ...A, phase: 'verify' }
  const as = (command) => evaluateGuard({ ticket: verify, tickets: [verify, B], toolName: 'bash', arguments: { command }, cwd: verify.workspaceCwd, liveCheckouts: [LIVE], home: HOME })
  assert.equal(as(`cd ${LIVE} && git pull --ff-only`).deny, false)
  assert.equal(as(`git -C ${LIVE} pull --ff-only origin main`).deny, false)
  assert.equal(as(`cd ${LIVE} && pnpm install`).deny, false)
  assert.equal(as(`cd ${LIVE}/.dsh/profiles/web && pnpm install --frozen-lockfile`).deny, false)
  assert.equal(as(`cd ${LIVE} && pnpm run check`).deny, false)
  assert.equal(as(`pnpm --dir ${LIVE} install`).deny, false)
  assert.equal(as(`cd ${LIVE} && git pull --ff-only && pnpm install && cd .dsh/profiles/web && pnpm install && cd ../../.. && pnpm run check`).deny, false)
  // Anything beyond the pre-stage is still refused in that phase.
  assert.equal(as(`cd ${LIVE} && git pull --rebase`).deny, true)
  assert.equal(as(`cd ${LIVE} && git pull --ff-only --force`).deny, true)
  assert.equal(as(`cd ${LIVE} && pnpm install left-pad`).deny, true)
  assert.equal(as(`cd ${LIVE} && pnpm add left-pad`).deny, true)
  assert.equal(as(`cd ${LIVE}/packages && pnpm install`).deny, true)
  assert.equal(as(`cd ${LIVE} && git pull --ff-only && rm -rf dist`).deny, true)
  assert.equal(as(`cd ${LIVE} && pnpm run check > out.txt`).deny, true)
  assert.equal(as(`cd ${LIVE} && pnpm run build`).deny, true)
})

test('the pre-stage is refused outside the approval phase', () => {
  for (const phase of ['plan', 'implement', 'review']) {
    const ticket = { ...A, phase }
    const verdict = evaluateGuard({ ticket, tickets: [ticket], toolName: 'bash', arguments: { command: `cd ${LIVE} && git pull --ff-only` }, cwd: '/w/kan5', liveCheckouts: [LIVE] })
    assert.equal(verdict.deny, true, phase)
  }
})

test('reading the live checkout is not denied', () => {
  assert.equal(bash(`cat ${LIVE}/package.json`).deny, false)
  assert.equal(bash(`cd ${LIVE} && git status && git log --oneline | head -3`).deny, false)
  assert.equal(bash(`git -C ${LIVE} diff`).deny, false)
  assert.equal(bash(`ls -la ${LIVE}/.dsh`).deny, false)
  assert.equal(bash(`find ${LIVE} -name '*.json'`).deny, false)
  assert.equal(bash(`find ${LIVE} -name '*.tmp' -delete`).deny, true)
  assert.equal(bash(`cat ${LIVE}/a | tee ${LIVE}/b`).deny, true)
})

test('home-relative live paths are expanded', () => {
  const live = `${HOME}/dsh-deploy`
  assert.equal(bash('touch ~/dsh-deploy/f', { liveCheckouts: [live] }).deny, true)
  assert.equal(bash('touch $HOME/dsh-deploy/f', { liveCheckouts: [live] }).deny, true)
  assert.equal(bash('touch ~/other/f', { liveCheckouts: [live] }).deny, false)
})

test('with no live checkout configured the live rule is off', () => {
  assert.equal(bash(`touch ${LIVE}/f`, { liveCheckouts: [] }).deny, false)
  assert.equal(bash(`touch ${LIVE}/f`, { liveCheckouts: undefined }).deny, false)
})

test('malformed input never denies', () => {
  for (const input of [
    { ticket: undefined },
    { arguments: null },
    { arguments: {} },
    { toolName: 'bash', arguments: { command: 5 } },
    { toolName: 'read', arguments: { file_path: '/w/kan6/x' } },
    { toolName: 'write', arguments: { file_path: '' } },
  ]) {
    assert.equal(judge(input.toolName ?? 'write', input.arguments === undefined ? {} : input.arguments, input.ticket === undefined && 'ticket' in input ? { ticket: undefined } : {}).deny, false)
  }
})

// ------------------------------------------------------------- configuration --

test('live checkouts come from configuration and the environment, absolute only', () => {
  assert.deepEqual(resolveLiveCheckouts({ liveCheckouts: ['/a/b/'] }, { DSH_KANBAN_LIVE_CHECKOUTS: '/c:rel:/a/b' }), ['/a/b', '/c'])
  assert.deepEqual(resolveLiveCheckouts({}, {}), [])
  assert.deepEqual(resolveLiveCheckouts(undefined, undefined), [])
})

test('the liveCheckouts config key validates absolute paths', () => {
  assert.deepEqual(resolveConfig({ liveCheckouts: ['/srv/live'] }).config.liveCheckouts, ['/srv/live'])
  assert.throws(() => resolveConfig({ liveCheckouts: ['relative'] }), /liveCheckouts/)
  assert.throws(() => resolveConfig({ liveCheckouts: 'nope' }), /liveCheckouts/)
  assert.deepEqual(resolveConfig({}).config.liveCheckouts, [])
})

// ----------------------------------------------------------------- listener --

function listenerSetup({ liveCheckouts = [LIVE] } = {}) {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const mk = (title, column, workspaceCwd) => store.getTicket(store.createTicket({ title, workspaceCwd, column }).id)
  const own = mk('own', 'working', '/w/kan1')
  const other = mk('other', 'working', '/w/kan2')
  const closed = mk('closed', 'working', '/w/kan3')
  for (const phase of ['implement', 'review', 'verify']) store.transitionTicket(closed.id, { phase }, { actor: 'human' })
  store.transitionTicket(closed.id, { column: 'done', phase: 'closed' }, { actor: 'human' })
  store.attachSession({ ticketId: own.id, dshSessionId: 'sess-own', role: 'implementer', purpose: 'build' })
  const warnings = []
  const log = { warn: (...a) => warnings.push(a) }
  const approver = makeGuardApprover({ store, log, getLiveCheckouts: () => liveCheckouts })
  const req = (command, over = {}) => ({
    reason: 'escalate sandbox to danger-full-access: need it',
    toolName: 'bash',
    callId: 'c1',
    agent: {
      id: 'sess-own',
      session: { snapshotEvents: () => [{ type: 'tool/call', data: { callId: 'c1', arguments: JSON.stringify({ command }) } }] },
    },
    ...over,
  })
  return { store, own, other, closed, approver, req, warnings }
}

test('the listener rejects a cross-ticket ask, records why, and never calls next', () => {
  const { store, own, approver, req } = listenerSetup()
  let nexted = 0
  const result = approver(req('cat /w/kan2/secret'), () => { nexted += 1; return 'passed-on' })
  assert.equal(result, 'rejected')
  assert.equal(nexted, 0)
  const event = store.listEvents(own.id, { limit: 50 }).find((e) => e.kind === 'guard_denied')
  assert.ok(event, 'a guard_denied event is recorded')
  assert.equal(event.payload.kind, 'cross_ticket')
  assert.equal(event.payload.owner, store.listTickets().find((t) => t.title === 'other').key)
  assert.match(event.payload.message, /belongs to/)
})

test('the listener passes everything it does not deny to the next approver', () => {
  const { approver, req } = listenerSetup()
  const next = () => 'passed-on'
  assert.equal(approver(req('cat /w/kan1/ok'), next), 'passed-on')
  assert.equal(approver(req('cat /w/kan3/closed-is-readable'), next), 'passed-on')
  assert.equal(approver(req('cat /w/kan2/x', { reason: 'something else' }), next), 'passed-on')
  assert.equal(approver(req('cat /w/kan2/x', { agent: { id: 'unknown' } }), next), 'passed-on')
  assert.equal(approver(req('cat /w/kan2/x', { callId: 'missing' }), next), 'passed-on')
  assert.equal(approver(null, next), 'passed-on')
})

test('the listener denies a live checkout write and a broken store fails open', () => {
  const { approver, req } = listenerSetup()
  assert.equal(approver(req(`touch ${LIVE}/f`), () => 'passed-on'), 'rejected')
  const broken = makeGuardApprover({ store: { findSession() { throw new Error('boom') } }, log: { warn() {} }, getLiveCheckouts: () => [LIVE] })
  assert.equal(broken(req('cat /w/kan2/x'), () => 'passed-on'), 'passed-on')
})
