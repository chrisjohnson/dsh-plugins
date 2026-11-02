import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GRANT_DENYLIST,
  PLAN_READY_PREFIX,
  countGrants,
  escalationMode,
  hasGrants,
  isDenylisted,
  isPlanReady,
  makeGrantApprover,
  matchGrant,
  planReadyReason,
  validateSandbox,
} from '../src/grants.mjs'

// ---------------------------------------------------------------- denylist --

test('every denylist token is caught as the first token', () => {
  for (const token of GRANT_DENYLIST) {
    assert.equal(isDenylisted(`${token} restart dsh`), true, token)
    assert.equal(isDenylisted(`/usr/bin/${token} restart dsh`), true, `${token} via full path`)
  }
})

test('wrappers are seen through', () => {
  assert.equal(isDenylisted('sudo systemctl restart dsh'), true)
  assert.equal(isDenylisted('bash -c "systemctl restart dsh"'), true)
  assert.equal(isDenylisted('sh -c "rm -rf /"'), true)
  assert.equal(isDenylisted('env FOO=1 systemctl stop nginx'), true)
  assert.equal(isDenylisted('nohup kill -9 1234'), true)
  assert.equal(isDenylisted('timeout 10 bash -lc "pkill node"'), true)
})

test('the rm -rf / substrings are caught anywhere in the line', () => {
  assert.equal(isDenylisted('echo hi && rm -rf /'), true)
  assert.equal(isDenylisted('echo hi && rm -fr /'), true)
  assert.equal(isDenylisted('true; rm -rf /tmp'), true)
})

test('ordinary commands are not denylisted', () => {
  assert.equal(isDenylisted('git push origin main'), false)
  assert.equal(isDenylisted('npm run check'), false)
  assert.equal(isDenylisted('node scripts/lab.sh up --name kan30'), false)
  assert.equal(isDenylisted('grep -r rm -n .'), false)
  assert.equal(isDenylisted('echo "the rm -rf / rule"'), true) // substring wins, on purpose
  assert.equal(isDenylisted(''), false)
  assert.equal(isDenylisted(undefined), false)
})

// ----------------------------------------------------------------- matcher --

test('bash grants match by token prefix at word boundaries', () => {
  const grants = { commands: ['git push', 'gh pr create'] }
  assert.equal(matchGrant({ grants, toolName: 'bash', arguments: { command: 'git push origin main' } }), 'git push')
  assert.equal(matchGrant({ grants, toolName: 'bash', arguments: { command: 'gh pr create --fill' } }), 'gh pr create')
  assert.equal(matchGrant({ grants, toolName: 'bash', arguments: { command: 'git pushfoo' } }), null)
  assert.equal(matchGrant({ grants, toolName: 'bash', arguments: { command: 'sudo git push' } }), null)
  assert.equal(matchGrant({ grants, toolName: 'bash', arguments: { command: 'git pull' } }), null)
  assert.equal(matchGrant({ grants, toolName: 'bash', arguments: { command: 'git push && rm -rf /' } }), null)
})

test('write and edit grants match by path-segment containment', () => {
  const grants = { paths: ['/a/b'] }
  assert.equal(matchGrant({ grants, toolName: 'write', arguments: { file_path: '/a/b/c.txt' } }), '/a/b')
  assert.equal(matchGrant({ grants, toolName: 'edit', arguments: { file_path: '/a/b' } }), '/a/b')
  assert.equal(matchGrant({ grants, toolName: 'write', arguments: { file_path: '/a/bc' } }), null)
  assert.equal(matchGrant({ grants, toolName: 'write', arguments: { file_path: '/a/b/../bc/x' } }), null)
  assert.equal(matchGrant({ grants, toolName: 'write', arguments: { file_path: '/x/y' } }), null)
  assert.equal(matchGrant({ grants, toolName: 'write', arguments: {} }), null)
})

test('a denylisted command never matches even if a grant covers it', () => {
  const grants = { commands: ['rm', 'dd'] }
  assert.equal(matchGrant({ grants, toolName: 'bash', arguments: { command: 'rm -rf /tmp/x' } }), null)
  assert.equal(matchGrant({ grants, toolName: 'bash', arguments: { command: 'dd if=/dev/zero of=/dev/sda' } }), null)
})

test('matchGrant tolerates missing input', () => {
  assert.equal(matchGrant({ grants: null, toolName: 'bash', arguments: { command: 'x' } }), null)
  assert.equal(matchGrant({ grants: { commands: ['x'] }, toolName: 'bash', arguments: null }), null)
  assert.equal(matchGrant({ grants: { paths: ['/a'] }, toolName: 'browser', arguments: { file_path: '/a/b' } }), null)
})

// ------------------------------------------------------------- escalation ---

test('escalationMode parses the mode out of the core reason line', () => {
  assert.equal(escalationMode('escalate sandbox to danger-full-access: because'), 'danger-full-access')
  assert.equal(escalationMode('escalate sandbox to workspace-write'), 'workspace-write')
  assert.equal(escalationMode('the user rejected escalating'), null)
  assert.equal(escalationMode(undefined), null)
})

// ------------------------------------------------------------ grant approver --

function harness({ ticket = { id: 't1', column: 'working', phase: 'implement', needsAttentionReason: null }, plan = null, calls = [] } = {}) {
  const events = []
  const store = {
    findSession: (sessionId) => (sessionId === 'session-1' ? { ticketId: 't1' } : undefined),
    getTicket: (ticketId) => (ticketId === 't1' ? ticket : undefined),
    latestArtifact: (ticketId, kind) => (ticketId === 't1' && kind === 'plan' && plan !== null ? { content: JSON.stringify(plan) } : undefined),
    appendEvent: (ticketId, kind, options) => {
      events.push({ ticketId, kind, ...options })
    },
  }
  const agent = {
    id: 'session-1',
    session: {
      snapshotEvents: () => [
        { type: 'tool/call', data: { callId: 'call-other', name: 'read', arguments: '{}' } },
        ...calls.map((call) => ({ type: 'tool/call', data: { callId: call.callId, name: call.name, arguments: JSON.stringify(call.arguments) } })),
      ],
    },
  }
  const approver = makeGrantApprover({ store, log: { warn() {} } })
  const fell = Symbol('fell-through')
  const next = () => fell
  const ask = (callId, toolName, reason = 'escalate sandbox to danger-full-access: need it') =>
    approver({ agent, toolName, callId, reason }, next)
  return { ask, events, fell, store, agent }
}

const GRANT_PLAN = {
  summary: 's',
  conditions: [],
  planVersion: 3,
  sandbox: { grants: { paths: ['/home/dsh/dsh-lab/kan30-grant'], commands: ['git push'] }, checks: [] },
}

test('a covered write is allowed-once and records grant_applied', () => {
  const h = harness({ plan: GRANT_PLAN, calls: [{ callId: 'c1', name: 'write', arguments: { file_path: '/home/dsh/dsh-lab/kan30-grant/out.txt' } }] })
  assert.equal(h.ask('c1', 'write'), 'allowed-once')
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].kind, 'grant_applied')
  assert.deepEqual(h.events[0].payload, {
    toolName: 'write',
    callId: 'c1',
    grant: '/home/dsh/dsh-lab/kan30-grant',
    mode: 'danger-full-access',
    target: '/home/dsh/dsh-lab/kan30-grant/out.txt',
  })
})

test('a covered bash call is allowed-once', () => {
  const h = harness({ plan: GRANT_PLAN, calls: [{ callId: 'c2', name: 'bash', arguments: { command: 'git push origin main' } }] })
  assert.equal(h.ask('c2', 'bash'), 'allowed-once')
  assert.equal(h.events[0].payload.grant, 'git push')
})

test('an uncovered path falls through to the human', () => {
  const h = harness({ plan: GRANT_PLAN, calls: [{ callId: 'c3', name: 'write', arguments: { file_path: '/home/dsh/dsh-lab/other/out.txt' } }] })
  assert.equal(h.ask('c3', 'write'), h.fell)
  assert.equal(h.events.length, 0)
})

test('a denylisted command falls through even when a grant covers it', () => {
  const plan = { sandbox: { grants: { paths: [], commands: ['rm'] } } }
  const h = harness({ plan, calls: [{ callId: 'c4', name: 'bash', arguments: { command: 'rm -rf /tmp/x' } }] })
  assert.equal(h.ask('c4', 'bash'), h.fell)
})

test('non-escalation reasons pass straight through', () => {
  const h = harness({ plan: GRANT_PLAN, calls: [{ callId: 'c5', name: 'write', arguments: { file_path: '/home/dsh/dsh-lab/kan30-grant/x' } }] })
  assert.equal(h.ask('c5', 'write', 'the user asked for confirmation'), h.fell)
})

test('missing or malformed callId falls through', () => {
  const h = harness({ plan: GRANT_PLAN })
  assert.equal(h.ask(undefined, 'write'), h.fell)
  assert.equal(h.ask('', 'write'), h.fell)
  assert.equal(h.ask('no-such-call', 'write'), h.fell)
})

test('a session with no ticket, no plan, or no grants falls through', () => {
  const noTicket = harness({ plan: GRANT_PLAN, calls: [{ callId: 'c', name: 'write', arguments: { file_path: '/home/dsh/dsh-lab/kan30-grant/x' } }] })
  noTicket.store.findSession = () => undefined
  assert.equal(noTicket.ask('c', 'write'), noTicket.fell)

  const noPlan = harness({ plan: null })
  assert.equal(noPlan.ask('c', 'write'), noPlan.fell)

  const noGrants = harness({ plan: { summary: 'plain', conditions: [] } })
  assert.equal(noGrants.ask('c', 'write'), noGrants.fell)
})

test('a terminal ticket falls through', () => {
  for (const column of ['done', 'discarded']) {
    const h = harness({
      ticket: { id: 't1', column, phase: 'closed', needsAttentionReason: null },
      plan: GRANT_PLAN,
      calls: [{ callId: 'c', name: 'write', arguments: { file_path: '/home/dsh/dsh-lab/kan30-grant/x' } }],
    })
    assert.equal(h.ask('c', 'write'), h.fell, column)
  }
})

test('grants are not live while the plan still awaits its approval', () => {
  const h = harness({
    ticket: { id: 't1', column: 'working', phase: 'plan', needsAttentionReason: planReadyReason(2) },
    plan: GRANT_PLAN,
    calls: [{ callId: 'c', name: 'write', arguments: { file_path: '/home/dsh/dsh-lab/kan30-grant/x' } }],
  })
  assert.equal(h.ask('c', 'write'), h.fell)
})

test('a malformed plan artifact or a throwing store fails open to the human', () => {
  const h = harness({ plan: GRANT_PLAN, calls: [{ callId: 'c', name: 'write', arguments: { file_path: '/home/dsh/dsh-lab/kan30-grant/x' } }] })
  h.store.latestArtifact = () => { throw new Error('db gone') }
  assert.equal(h.ask('c', 'write'), h.fell)

  const h2 = harness({ calls: [{ callId: 'c', name: 'write', arguments: { file_path: '/home/dsh/dsh-lab/kan30-grant/x' } }] })
  h2.store.latestArtifact = () => ({ content: '{not json' })
  assert.equal(h2.ask('c', 'write'), h2.fell)
})

test('a grant that cannot be audited is not applied', () => {
  const h = harness({ plan: GRANT_PLAN, calls: [{ callId: 'c', name: 'write', arguments: { file_path: '/home/dsh/dsh-lab/kan30-grant/x' } }] })
  h.store.appendEvent = () => { throw new Error('write failed') }
  assert.equal(h.ask('c', 'write'), h.fell)
})

test('tool/call arguments may be an object already', () => {
  const events = []
  const store = {
    findSession: () => ({ ticketId: 't1' }),
    getTicket: () => ({ id: 't1', column: 'working', phase: 'implement' }),
    latestArtifact: () => ({ content: JSON.stringify(GRANT_PLAN) }),
    appendEvent: (ticketId, kind, options) => events.push({ kind, ...options }),
  }
  const agent = {
    id: 'session-1',
    session: { snapshotEvents: () => [{ type: 'tool/call', data: { callId: 'c', name: 'write', arguments: { file_path: '/home/dsh/dsh-lab/kan30-grant/x' } } }] },
  }
  const approver = makeGrantApprover({ store, log: {} })
  assert.equal(approver({ agent, toolName: 'write', callId: 'c', reason: 'escalate sandbox to workspace-write: x' }, () => 'fell'), 'allowed-once')
  assert.equal(events[0].kind, 'grant_applied')
})

// ------------------------------------------------------------- plan ready ----

test('planReadyReason carries the count and the prefix the board matches', () => {
  assert.ok(isPlanReady(planReadyReason(2)))
  assert.ok(planReadyReason(2).startsWith(PLAN_READY_PREFIX))
  assert.match(planReadyReason(2), /2 sandbox grant\(s\)/)
  assert.equal(isPlanReady('Awaiting human approval'), false)
  assert.equal(isPlanReady(null), false)
})

test('hasGrants and countGrants read the sandbox section', () => {
  assert.equal(hasGrants(undefined), false)
  assert.equal(hasGrants({}), false)
  assert.equal(hasGrants({ grants: { paths: [], commands: [] } }), false)
  assert.equal(hasGrants({ grants: { paths: ['/a'] } }), true)
  assert.equal(countGrants({ grants: { paths: ['/a', '/b'], commands: ['git push'] } }), 3)
})

// ---------------------------------------------------------- validateSandbox --

test('validateSandbox rejects relative paths and blank commands', () => {
  const out = validateSandbox({ grants: { paths: ['relative/dir', ''], commands: ['  '] } })
  assert.ok(out.errors.some((e) => /absolute path/.test(e)))
  assert.ok(out.errors.some((e) => /paths\[1\]/.test(e)))
  assert.ok(out.errors.some((e) => /commands\[0\]/.test(e)))
})

test('validateSandbox rejects a denylisted command with the explicit message', () => {
  const out = validateSandbox({ grants: { commands: ['systemctl restart dsh'] } })
  assert.ok(out.errors.some((e) => /can never be granted/.test(e)))
})

test('validateSandbox normalizes a valid section and passes checks through', () => {
  const out = validateSandbox({
    grants: { paths: ['/home/dsh/dsh-lab/kan30-grant/'], commands: [' git push '] },
    checks: [{ path: '/home/dsh/dsh-lab/kan30-grant', check: 'test -w /home/dsh/dsh-lab/kan30-grant', observed: 'writable' }],
  })
  assert.deepEqual(out.errors, [])
  assert.deepEqual(out.sandbox.grants, { paths: ['/home/dsh/dsh-lab/kan30-grant'], commands: ['git push'] })
  assert.equal(out.sandbox.checks.length, 1)
})

test('validateSandbox says nothing when there is no section', () => {
  assert.deepEqual(validateSandbox(undefined), { sandbox: null, errors: [] })
  assert.deepEqual(validateSandbox(null), { sandbox: null, errors: [] })
})
