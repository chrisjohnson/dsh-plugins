// Path grants cover bash calls that stay inside the granted path, and the
// harness that proves the approver records which kind of grant answered.

import test from 'node:test'
import assert from 'node:assert/strict'

import { grantAdvisory, makeGrantApprover, matchGrant, matchGrantDetail } from '../src/grants.mjs'
import { commandPaths } from '../src/command-paths.mjs'

const WORK = '/srv/scratch/work'
const STORE = '/var/cache/pkgstore'
const TICKET_WS = '/srv/live-checkout/.agents/worktrees/kan12-ticket'
const PATH_GRANTS = { paths: [WORK, STORE], commands: [] }
const viaPath = (command, extra = {}) =>
  matchGrantDetail({ grants: PATH_GRANTS, toolName: 'bash', arguments: { command }, workspaceRoot: TICKET_WS, home: '/home/user', ...extra })

const REAL_COMMANDS = [
  'cd /srv/scratch/work/repos/project && git fetch origin 2>&1 | tail -3 && git log --oneline -1 origin/main',
  'cd /srv/scratch/work/repos/project && git checkout -B fix/widget-button origin/main 2>&1 && git log --oneline -1',
  'cd /srv/scratch/work/repos/project && grep -n \'"check"\\|"verify"\\|"test"\' package.json | head',
  'cd /srv/scratch/work/repos/project && npm run check >/tmp/check-run.log 2>&1; echo "EXIT=$?"; grep -E \'tests|fail\' /tmp/check-run.log | tail -5',
]
const LIVE_INSPECTION =
  'cd /srv/live-checkout && ls /srv/scratch/work/ 2>/dev/null; echo "=== project status ==="; scripts/project-ctl status 2>&1 | head -30'

test('the four real build commands inside the granted work path are covered by the path grant', () => {
  for (const command of REAL_COMMANDS) {
    assert.deepEqual(viaPath(command), { grant: WORK, kind: 'path' }, command)
    assert.equal(matchGrant({ grants: PATH_GRANTS, toolName: 'bash', arguments: { command }, workspaceRoot: TICKET_WS, home: '/home/user' }), WORK)
  }
})

test('the live-checkout inspection command is not covered by the work grant alone', () => {
  assert.equal(viaPath(LIVE_INSPECTION), null)
})

test('a command grant wins over a path grant and reports kind command', () => {
  const grants = { paths: [WORK], commands: ['git fetch'] }
  assert.deepEqual(matchGrantDetail({ grants, toolName: 'bash', arguments: { command: 'git fetch origin' }, workspaceRoot: TICKET_WS }), { grant: 'git fetch', kind: 'command' })
})

test('write and edit report kind path', () => {
  assert.deepEqual(matchGrantDetail({ grants: PATH_GRANTS, toolName: 'edit', arguments: { file_path: `${WORK}/x.txt` } }), { grant: WORK, kind: 'path' })
})

test('a bash call that writes outside every grant is not covered', () => {
  assert.equal(viaPath(`cd ${WORK}/repos && echo x > /etc/motd`), null)
  assert.equal(viaPath(`cd ${WORK} && cp a.txt /etc/hosts`), null)
  assert.equal(viaPath('cd /etc && cat hosts'), null)
})

test('one absolute path outside every grant spoils a command that also names one inside', () => {
  assert.equal(viaPath(`cd ${WORK} && cp /srv/live-checkout/package.json .`), null)
  assert.equal(viaPath(`cat ${WORK}/a /home/user/.ssh/id_ed25519`), null)
  assert.equal(viaPath(`cd ${WORK} && git -C /srv/live-checkout status`), null)
})

test('denylisted words are never covered by a path grant', () => {
  assert.equal(viaPath(`cd ${WORK} && sudo make install`), null)
  assert.equal(viaPath(`cd ${WORK} && rm -r build`), null)
  assert.equal(viaPath(`cd ${WORK} && kill 123`), null)
  assert.equal(viaPath(`cd ${WORK} && systemctl restart dsh`), null)
})

test('a command that names no absolute path is not covered', () => {
  assert.equal(viaPath('git fetch origin'), null)
  assert.equal(viaPath('npm run check'), null)
  assert.equal(viaPath('cat src/index.mjs'), null)
  // Naming the workspace and /tmp is not naming a granted path.
  assert.equal(viaPath(`cat ${TICKET_WS}/a /tmp/b`), null)
})

test('path-prefix tricks do not match the granted path', () => {
  assert.equal(viaPath('cd /srv/scratch/work-evil && ls'), null)
  assert.equal(viaPath(`cd ${WORK}/../work-evil && ls`), null)
  assert.equal(viaPath(`cd ${WORK} && cat ../../.ssh/config`), null)
  assert.equal(viaPath(`ls ${WORK}/../../.ssh`), null)
})

test('relative words are resolved against the directory the cd put the command in', () => {
  assert.deepEqual(viaPath(`cd ${WORK}/repos && ls src`), { grant: WORK, kind: 'path' })
  assert.equal(viaPath(`cd ${WORK} && ls ../..`), null)
  // With no cd the command runs in the ticket workspace, which is allowed but not granted.
  assert.deepEqual(viaPath(`ls src ${WORK}/repos`), { grant: WORK, kind: 'path' })
})

test('home spellings resolve before the comparison', () => {
  const grants = { paths: ['/home/user/scratch/work', '/home/user/pkgstore'], commands: [] }
  const via = (command) => matchGrantDetail({ grants, toolName: 'bash', arguments: { command }, workspaceRoot: TICKET_WS, home: '/home/user' })
  assert.deepEqual(via('cd ~/scratch/work/repos && ls'), { grant: '/home/user/scratch/work', kind: 'path' })
  assert.deepEqual(via('cd $HOME/scratch/work && ls'), { grant: '/home/user/scratch/work', kind: 'path' })
  assert.deepEqual(via('cat ~/pkgstore/store/x'), { grant: '/home/user/pkgstore', kind: 'path' })
  assert.equal(via('cd ~/.ssh && ls'), null)
  assert.equal(via('cd ~root && ls'), null)
  assert.equal(via('cd $HOMEX/scratch/work && ls'), null)
})

test('forms the reader cannot interpret are not covered', () => {
  for (const command of [
    `cd ${WORK} && $(echo /etc/passwd)`,
    `cd ${WORK} && cat \`echo /etc/passwd\``,
    `(cd ${WORK} && ls)`,
    `cd ${WORK} && bash -c "cat /etc/passwd"`,
    `cd ${WORK} && eval "$CMD"`,
    `cd ${WORK} && xargs cat`,
    `cd $DIR && ls ${WORK}`,
    `cd ${WORK} && cat $OTHER/file`,
    `cd - && ls ${WORK}`,
  ]) {
    assert.equal(viaPath(command), null, command)
  }
})

test('option values and assignments naming a path are checked', () => {
  assert.equal(viaPath(`cd ${WORK} && make --prefix=/etc/x`), null)
  assert.deepEqual(viaPath(`cd ${WORK} && make --prefix=${WORK}/out`), { grant: WORK, kind: 'path' })
  assert.equal(viaPath(`cd ${WORK} && OUT=/etc/x make`), null)
})

test('bash path coverage needs a granted absolute path, and a known workspace for relative words', () => {
  assert.equal(matchGrant({ grants: { paths: [], commands: [] }, toolName: 'bash', arguments: { command: `cd ${WORK} && ls` } }), null)
  assert.equal(matchGrant({ grants: { paths: [WORK] }, toolName: 'bash', arguments: { command: `ls ${WORK} src/x` }, workspaceRoot: null }), null)
  assert.equal(matchGrant({ grants: { paths: [WORK] }, toolName: 'bash', arguments: { command: `cd ${WORK} && ls src` }, workspaceRoot: null }), WORK)
})

test('commandPaths reports what a line names, in order, with cd tracking', () => {
  const parsed = commandPaths('cd /a/b && cat c.txt ../d >/tmp/out', { cwd: '/w', home: '/h' })
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.paths.map((p) => p.path), ['/a/b', '/a/b/c.txt'.replace('c.txt', '') .replace(/\/$/, '') && '/a/d', '/tmp/out'].filter(Boolean))
})

function approverHarness(plan, calls, cwd) {
  const events = []
  const store = {
    findSession: () => ({ ticketId: 't1' }),
    getTicket: () => ({ id: 't1', column: 'working', phase: 'implement', needsAttentionReason: null }),
    latestArtifact: () => ({ content: JSON.stringify(plan) }),
    appendEvent: (ticketId, kind, options) => events.push({ ticketId, kind, ...options }),
  }
  const agent = {
    id: 'session-1',
    session: {
      meta: { cwd },
      snapshotEvents: () => calls.map((call) => ({ type: 'tool/call', data: { callId: call.callId, name: call.name, arguments: JSON.stringify(call.arguments) } })),
    },
  }
  const approver = makeGrantApprover({ store, log: { warn() {} } })
  const fell = Symbol('fell')
  const ask = (callId, toolName) => approver({ agent, toolName, callId, reason: 'escalate sandbox to danger-full-access: need it' }, () => fell)
  return { events, ask, fell }
}

test('the approver covers a bash call under a path grant and records kind path', () => {
  const h = approverHarness(
    { summary: 's', conditions: [], planVersion: 1, sandbox: { grants: { paths: [WORK], commands: [] }, checks: [] } },
    [
      { callId: 'b1', name: 'bash', arguments: { command: REAL_COMMANDS[0] } },
      { callId: 'b2', name: 'bash', arguments: { command: 'git fetch origin' } },
    ],
    TICKET_WS,
  )
  assert.equal(h.ask('b1', 'bash'), 'allowed-once')
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].kind, 'grant_applied')
  assert.equal(h.events[0].payload.kind, 'path')
  assert.equal(h.events[0].payload.grant, WORK)
  assert.equal(h.events[0].payload.target, REAL_COMMANDS[0])
  assert.equal(h.ask('b2', 'bash'), h.fell, 'a command naming no absolute path falls through to the human')
  assert.equal(h.events.length, 1)
})

test('grantAdvisory flags path grants with no command grants only', () => {
  assert.match(grantAdvisory({ grants: { paths: [WORK], commands: [] } }), /network commands/)
  assert.equal(grantAdvisory({ grants: { paths: [WORK], commands: ['git fetch'] } }), null)
  assert.equal(grantAdvisory({ grants: { paths: [], commands: ['git fetch'] } }), null)
  assert.equal(grantAdvisory(null), null)
})
