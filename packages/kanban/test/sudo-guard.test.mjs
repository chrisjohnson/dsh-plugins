// KAN-59: the sudo dead end a sandboxed build cannot grant its way out of.
//
// Two halves. The pure detector recognises sudo's own `no_new_privs` refusal in
// a turn's tool results and says nothing about any other sudo failure — a broken
// sudoers rule is the ticket's problem, the sandbox wall is the human's. The
// engine half turns a hit into a park that names the ticket's write mode and the
// one change that lifts it, instead of the generic "ended without submitting".
// The prompt half pins that the planner and the builder are actually told.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { render } from '../src/prompts.mjs'
import {
  DEFAULT_WRITE_MODE,
  FULL_ACCESS_MODE,
  SUDO_PARK_PREFIX,
  detectNoNewPrivsSudo,
  isFullAccessMode,
  isNoNewPrivsSudoText,
  sudoDeadEnd,
  sudoParkReason,
} from '../src/sudo-guard.mjs'
import { pickedUp, setup } from './support/engine-harness.mjs'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

/** sudo's real two-line refusal, as printed on this box by sudo 1.9.17p2. */
const SUDO_REFUSAL = [
  'sudo: The "no new privileges" flag is set, which prevents sudo from running as root.',
  'sudo: If sudo is running in a container, you may need to adjust the container configuration to disable the flag.',
].join('\n')

/** One `tool/result` event shaped the way the harness session log shapes it. */
function toolResult(text, extra = {}) {
  return { type: 'tool/result', time: Date.now(), data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text }], isError: false }, ...extra } }
}

// ------------------------------------------------------------------ detector

test('the detector matches sudo no_new_privs refusal', () => {
  const hit = detectNoNewPrivsSudo([toolResult(`=== sudo -n docker ps ===\n${SUDO_REFUSAL}\nEXIT=1`)])
  assert.ok(hit, 'the refusal is recognised')
  assert.match(hit.text, /no new privileges/, 'the reported line is the refusal itself')
})

test('either half of the refusal is enough on its own', () => {
  assert.ok(isNoNewPrivsSudoText('The "no new privileges" flag is set'))
  assert.ok(isNoNewPrivsSudoText('which prevents sudo from running as root'))
  assert.equal(isNoNewPrivsSudoText('The "No New Privileges" Flag Is Set'), true, 'matching is case-insensitive')
})

test('an ordinary sudo failure is not the sandbox wall', () => {
  for (const text of [
    'sudo: a password is required',
    'sudo: user is not allowed to run sudo on local-ai-machine.',
    'sudo: /run/current-system/sw/bin/dockerstat: command not found',
    'sudo: 3 incorrect password attempts',
    'permission denied: not in the docker group',
  ]) {
    assert.equal(detectNoNewPrivsSudo([toolResult(text)]), null, `${text} must not match`)
  }
})

test('the detector reads tool results only, and nothing else', () => {
  assert.equal(detectNoNewPrivsSudo([]), null)
  assert.equal(detectNoNewPrivsSudo(undefined), null)
  assert.equal(detectNoNewPrivsSudo(null), null)
  // Prose in an assistant message that quotes the message is not evidence it ran.
  assert.equal(detectNoNewPrivsSudo([{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: SUDO_REFUSAL }] } } }]), null)
  // A string content block, the other shape a tool result arrives in.
  assert.ok(detectNoNewPrivsSudo([{ type: 'tool/result', data: { message: { content: SUDO_REFUSAL } } }]))
  // An error carried on the event rather than in the message content.
  assert.ok(detectNoNewPrivsSudo([{ type: 'tool/result', data: { error: SUDO_REFUSAL } }]))
})

test('the reported line is clipped, not a wall of output', () => {
  const long = `${'x'.repeat(400)} The "no new privileges" flag is set ${'y'.repeat(400)}`
  const hit = detectNoNewPrivsSudo([toolResult(long)])
  assert.ok(hit.text.length <= 240, `clipped to 240, got ${hit.text.length}`)
})

// -------------------------------------------------------------------- reason

test('the park reason names the mode and the one change that lifts it', () => {
  const reason = sudoParkReason('workspace-write')
  assert.ok(reason.startsWith(SUDO_PARK_PREFIX))
  assert.match(reason, /'workspace-write'/, 'the mode the build actually ran under')
  assert.match(reason, /no_new_privs/)
  assert.match(reason, /write mode to Full access/)
  assert.match(reason, /Retry/)
  assert.match(reason, new RegExp(FULL_ACCESS_MODE), 'the exact mode value a human has to pick')
})

test('a ticket with no write mode is parked as the default sandbox', () => {
  assert.match(sudoParkReason(null), new RegExp(`'${DEFAULT_WRITE_MODE}'`))
  assert.equal(isFullAccessMode(null), false)
  assert.equal(isFullAccessMode('workspace-write'), false)
  assert.equal(isFullAccessMode(FULL_ACCESS_MODE), true)
})

test('a Full-access build is never parked on the sandbox wall', () => {
  const turn = { sudoBlocked: { text: SUDO_REFUSAL } }
  assert.equal(sudoDeadEnd(turn, FULL_ACCESS_MODE), null, 'nothing to tell a human who already did it')
  assert.deepEqual(sudoDeadEnd(turn, 'workspace-write'), { text: SUDO_REFUSAL })
  assert.equal(sudoDeadEnd({ sudoBlocked: null }, 'read-only'), null)
  assert.equal(sudoDeadEnd({}, 'read-only'), null)
})

// -------------------------------------------------------------------- engine

test('a build that ends on the sudo wall parks with the fix, not the generic failure', async () => {
  const { store, engine } = setup({
    implement: [{ text: '', events: [toolResult(`$ sudo -n docker ps\n${SUDO_REFUSAL}\nEXIT=1`)] }],
  })
  const ticket = pickedUp(store)
  await engine.plan(store.getTicket(ticket.id))
  const result = await engine.implement(store.getTicket(ticket.id))
  assert.equal(result.kind, 'needs_attention')
  const parked = store.getTicket(ticket.id)
  assert.ok(parked.needsAttentionReason.startsWith(SUDO_PARK_PREFIX), `parked on the sudo wall, got: ${parked.needsAttentionReason}`)
  assert.match(parked.needsAttentionReason, /'workspace-write'/, 'the ticket had no write mode, so the build ran workspace-write')
  assert.equal(parked.needsAttentionReason.includes('implementer ended without calling'), false)
  const event = store.listEvents(ticket.id).filter((e) => e.kind === 'needs_attention').pop()
  assert.equal(event.payload.writeMode, 'workspace-write', 'the mode the build actually ran under is recorded, defaulted like the wording')
  assert.match(event.payload.sudoBlocked, /no new privileges/)
})

test('a Full-access ticket that somehow matches keeps the generic explanation', async () => {
  const { store, engine } = setup({
    implement: [{ text: '', events: [toolResult(SUDO_REFUSAL)] }],
  })
  const ticket = pickedUp(store, { writeMode: FULL_ACCESS_MODE })
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'implementer ended without calling kanban_submit_implementation')
})

test('a build that ends without submitting and never touched sudo is unchanged', async () => {
  const { store, engine } = setup({ implement: [{ text: '', events: [toolResult('npm ERR! 404 Not Found')] }] })
  const ticket = pickedUp(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).needsAttentionReason, 'implementer ended without calling kanban_submit_implementation')
})

test('a build that submits normally is untouched by the guard', async () => {
  const { store, engine } = setup({
    implement: [{ type: 'implementation', value: { status: 'complete', summary: 'done', changed_files: [], done_when: [{ id: 'notes', met: true, confidence: 0.95, evidence: 'notes.txt:1' }] } }],
  })
  const ticket = pickedUp(store)
  await engine.plan(store.getTicket(ticket.id))
  await engine.implement(store.getTicket(ticket.id))
  assert.equal(store.getTicket(ticket.id).phase, 'review')
})

// ------------------------------------------------------------------- prompts

const REAL_PROMPTS = {
  'plan-self': { write_mode: 'workspace-write' },
  'plan-human': { write_mode: 'danger-full-access' },
  implement: { write_mode: 'workspace-write' },
  rework: { write_mode: 'workspace-write' },
}

test('every prompt that runs a sandboxed role tells it about the sudo wall', () => {
  for (const [name, vars] of Object.entries(REAL_PROMPTS)) {
    const body = readFileSync(join(PACKAGE_DIR, 'prompts', `${name}.md`), 'utf8')
    const rendered = render(body, {
      ticket_state: 'state', acceptance: '(none)', key: 'KAN-1', title: 't', plan: 'p', done_when: 'd',
      review: 'r', submission_contract: 'c', clone_names: 'n', release_scope: 's', question_note: 'q',
      cwd: '/tmp/x', ...vars,
    })
    assert.equal(rendered.includes('{{'), false, `${name} has an unresolved placeholder`)
    assert.match(rendered, /no_new_privs/, `${name} names the mechanism`)
    assert.match(rendered, /write mode to Full access/, `${name} names the fix`)
  }
})

test('the planning prompt keys the sudo rule on the mode the build will run in', () => {
  const body = readFileSync(join(PACKAGE_DIR, 'prompts', 'plan-self.md'), 'utf8')
  assert.match(body, /\{\{write_mode\}\}/, 'the rule is stated against the ticket mode, not in the abstract')
  const sandboxed = render(body, { write_mode: 'workspace-write', cwd: '/tmp/x', ticket_state: 's' })
  assert.match(sandboxed, /Unless `workspace-write` is `danger-full-access`/)
  const full = render(body, { write_mode: FULL_ACCESS_MODE, cwd: '/tmp/x', ticket_state: 's' })
  assert.equal(full.includes('Unless `workspace-write`'), false, 'a Full-access plan is not told it is sandboxed')
})
