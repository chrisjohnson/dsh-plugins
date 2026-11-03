// Read-only inspection from a live checkout, and how a policy denial reaches the
// model instead of reading as a human refusal.

import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { migrate } from '../src/db.mjs'
import { KanbanStore } from '../src/store.mjs'
import { resolveConfig } from '../src/config.mjs'
import { denialNote, evaluateGuard, makeGuardApprover, resolveReadOnlyCommands } from '../src/guard.mjs'

const LIVE = '/srv/live-checkout'
const TICKET = { key: 'KAN-5', column: 'working', phase: 'implement', workspaceCwd: '/w/kan5' }

const judge = (command, extra = {}) =>
  evaluateGuard({ ticket: TICKET, tickets: [TICKET], toolName: 'bash', arguments: { command }, cwd: TICKET.workspaceCwd, liveCheckouts: [LIVE], home: '/home/user', ...extra })

const INSPECTION =
  'cd /srv/live-checkout && ls /srv/scratch/work/ 2>/dev/null; echo "=== project status ==="; scripts/project-ctl status 2>&1 | head -30'

test('git fetch from a live checkout is allowed; ref-moving fetches are not', () => {
  assert.equal(judge(`cd ${LIVE} && git fetch origin 2>&1 | tail -3`).deny, false)
  assert.equal(judge(`git -C ${LIVE} fetch --tags origin`).deny, false)
  assert.equal(judge(`cd ${LIVE} && git fetch origin main:main`).deny, true)
  assert.equal(judge(`cd ${LIVE} && git fetch --force origin`).deny, true)
  assert.equal(judge(`cd ${LIVE} && git fetch --prune`).deny, true)
  assert.equal(judge(`cd ${LIVE} && git pull`).deny, true)
})

test('stderr folding and /dev/null redirects do not make a read-only command a write', () => {
  assert.equal(judge(`cd ${LIVE} && ls . 2>/dev/null`).deny, false)
  assert.equal(judge(`cd ${LIVE} && git status 2>&1 | head`).deny, false)
  assert.equal(judge(`cd ${LIVE} && cat package.json > out.txt`).deny, true)
  assert.equal(judge(`cd ${LIVE} && ls >> /srv/live-checkout/log`).deny, true)
})

test('a project command is denied from the live checkout unless the configuration lists it', () => {
  assert.equal(judge(INSPECTION).deny, true)
  assert.equal(judge(INSPECTION, { readOnlyCommands: ['scripts/project-ctl status'] }).deny, false)
})

test('a configured prefix allows only that prefix, at word boundaries', () => {
  const readOnlyCommands = ['scripts/project-ctl status', 'scripts/project-ctl logs']
  assert.equal(judge(`cd ${LIVE} && scripts/project-ctl logs --lines 20`, { readOnlyCommands }).deny, false)
  assert.equal(judge(`cd ${LIVE} && scripts/project-ctl up`, { readOnlyCommands }).deny, true)
  assert.equal(judge(`cd ${LIVE} && scripts/project-ctl statusfoo`, { readOnlyCommands }).deny, true)
  assert.equal(judge(`cd ${LIVE} && scripts/project-ctl status > /srv/live-checkout/s.txt`, { readOnlyCommands }).deny, true)
  assert.equal(judge(`cd ${LIVE} && scripts/project-ctl status && rm -rf x`, { readOnlyCommands }).deny, true)
  assert.equal(judge(`cd ${LIVE} && scripts/project-ctl status; touch x`, { readOnlyCommands }).deny, true)
})

test('the configured list changes nothing outside a live checkout', () => {
  assert.equal(judge('cd /w/kan5 && scripts/project-ctl up').deny, false)
})

test('resolveReadOnlyCommands keeps non-empty strings and the config validates the key', () => {
  assert.deepEqual(resolveReadOnlyCommands({ liveCheckoutReadOnlyCommands: [' a b ', '', 3, 'c'] }), ['a b', 'c'])
  assert.deepEqual(resolveReadOnlyCommands({}), [])
  assert.deepEqual(resolveConfig({}).config.liveCheckoutReadOnlyCommands, [])
  assert.deepEqual(resolveConfig({ liveCheckoutReadOnlyCommands: ['x status'] }).config.liveCheckoutReadOnlyCommands, ['x status'])
  assert.throws(() => resolveConfig({ liveCheckoutReadOnlyCommands: [''] }), /liveCheckoutReadOnlyCommands/)
  assert.throws(() => resolveConfig({ liveCheckoutReadOnlyCommands: 'x' }), /liveCheckoutReadOnlyCommands/)
})

// ---------------------------------------------------------------- steering --

function listener({ steer, readOnlyCommands = [] }) {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const own = store.createTicket({ title: 'own', column: 'working', workspaceCwd: '/w/kan1' })
  store.attachSession({ ticketId: own.id, dshSessionId: 'sess-own', role: 'implementer', purpose: 'build' })
  const approver = makeGuardApprover({
    store,
    log: { warn() {} },
    getLiveCheckouts: () => [LIVE],
    getReadOnlyCommands: () => readOnlyCommands,
    steer,
  })
  const agent = {
    id: 'sess-own',
    session: { snapshotEvents: () => [{ type: 'tool/call', data: { callId: 'c1', arguments: JSON.stringify({ command: `cd ${LIVE} && touch x` }) } }] },
  }
  const ask = (reason = 'escalate sandbox to danger-full-access: need it') => approver({ reason, toolName: 'bash', callId: 'c1', agent }, () => 'passed-on')
  return { ask, agent, own, store }
}

test('a denial steers a policy explanation into the denied session', () => {
  const steered = []
  const { ask, agent } = listener({ steer: (target, note) => steered.push({ target, note }) })
  assert.equal(ask(), 'rejected')
  assert.equal(steered.length, 1)
  assert.equal(steered[0].target, agent)
  const text = steered[0].note.text
  assert.match(text, /policy rule, not by a person/)
  assert.match(text, /live-checkout protection/)
  assert.ok(text.includes(LIVE), 'it names the path')
  assert.match(text, /do not ask the human/)
  assert.match(text, /kan1-<name>/)
  assert.match(text, /your approved plan grants/)
  assert.ok(steered[0].note.summary.length <= 120)
})

test('nothing is steered for an ask that is not denied or not an escalation', () => {
  const steered = []
  const { ask } = listener({ steer: (target, note) => steered.push(note), readOnlyCommands: [] })
  assert.equal(ask('some other reason'), 'passed-on')
  assert.equal(steered.length, 0)
})

test('a steer that throws never changes the rejection', () => {
  const { ask } = listener({ steer: () => { throw new Error('no inbox') } })
  assert.equal(ask(), 'rejected')
})

test('the denial note names the clone prefix of the ticket', () => {
  const text = denialNote({ kind: 'cross_ticket', path: '/w/kan2/x', message: 'KAN-9 may not use /w/kan2/x' }, { key: 'KAN-9' })
  assert.match(text, /cross-ticket isolation/)
  assert.match(text, /kan9-<name>/)
  assert.match(text, /KAN-9 may not use/)
})
