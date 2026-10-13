// Decision tests over session events shaped like dsh 0.2.0-rc.2 (format V4):
// a user/message event's data IS the message, so its source is `data.source`
// (@deepseek-ai/dsh-session types.d.ts `'user/message': UserMessage`), tool
// calls are `type: 'tool-call'` blocks (@deepseek-ai/dsh-llm types.d.ts), and
// turn/end carries `data.reason.kind`.

import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeTail, boundSummary, decide, PLUGIN_SOURCE_KIND } from '../src/decide.mjs'
import { DEFAULT_CONFIG } from '../src/config.mjs'

const settings = { ...DEFAULT_CONFIG, cooldownMs: 0, maxConsecutiveKicks: 3 }

let turn = 0
const userMessage = (kind, extra = {}) => ({
  type: 'user/message',
  data: { id: `m${++turn}`, role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind, ...extra } },
})
const kickMessage = () => userMessage(PLUGIN_SOURCE_KIND, { form: 'notice', summary: 'Auto-resumed' })
const turnStart = () => ({ type: 'turn/start', data: { turn: ++turn } })
const turnEnd = (kind) => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const assistant = (content) => ({
  type: 'assistant/message',
  data: { turn, step: 1, message: { role: 'assistant', content, source: { kind: 'model' } }, stream: [] },
})
const text = (t) => ({ type: 'text', text: t })
const reasoning = (t) => ({ type: 'reasoning', text: t })

const maxTokensTurn = () => [turnStart(), assistant([reasoning('thinking'), text('partial')]), turnEnd('max-tokens')]
const completedTurn = () => [turnStart(), assistant([text('done')]), turnEnd('completed')]

const base = { settings, consecutive: 0, lastKickAt: 0, now: 1_000_000, isSubagent: false }

test('a max-tokens halt kicks once, with the plugin-owned V4 source kind in the text/summary', () => {
  const events = [userMessage('user'), ...maxTokensTurn()]
  const first = decide({ ...base, events })
  assert.equal(first.action, 'kick')
  assert.equal(first.flavor, 'max-tokens')
  assert.equal(first.consecutive, 1)
  assert.equal(first.text, settings.maxTokensKickText)
  assert.match(first.summary, /1\/3/)

  // Once the kick sits at the tail awaiting its result, the next analysis does nothing.
  const second = decide({ ...base, events: [...events, kickMessage()], consecutive: first.consecutive, lastKickAt: base.now, now: base.now + 5 })
  assert.equal(second.action, 'skip')
  assert.match(second.why, /plugin kick awaiting/)
})

test('three kicks with no progress, then the runaway guard stops', () => {
  let events = [userMessage('user'), ...maxTokensTurn()]
  let consecutive = 0
  let now = base.now
  const actions = []
  for (let i = 0; i < 4; i++) {
    const d = decide({ ...base, events, consecutive, now, lastKickAt: 0 })
    actions.push(d.action)
    consecutive = d.consecutive
    if (d.action !== 'kick') break
    now += 10
    // The kick lands and the model hits the wall again.
    events = [...events, kickMessage(), ...maxTokensTurn()]
  }
  assert.deepEqual(actions, ['kick', 'kick', 'kick', 'stop'])
  assert.equal(consecutive, 3)
})

test('a genuine user message resets the counter', () => {
  const events = [...maxTokensTurn(), userMessage('user')]
  const d = decide({ ...base, events, consecutive: 3 })
  assert.equal(d.action, 'skip')
  assert.equal(d.consecutive, 0)

  // And the guard is lifted for the next halt.
  const next = decide({ ...base, events: [...events, ...maxTokensTurn()], consecutive: d.consecutive })
  assert.equal(next.action, 'kick')
})

test('a plugin-sourced message does not reset the counter', () => {
  const kick = decide({ ...base, events: [...maxTokensTurn(), kickMessage()], consecutive: 3 })
  assert.equal(kick.consecutive, 3)
  assert.equal(analyzeTail([kickMessage()], settings).genuineUserActivity, false)

  const other = decide({ ...base, events: [...maxTokensTurn(), userMessage('goal')], consecutive: 2 })
  assert.equal(other.consecutive, 2, 'a user-role message from another producer is not the human')
  const legacy = decide({ ...base, events: [...maxTokensTurn(), userMessage('plugin', { plugin: 'continue-kicker' })], consecutive: 2 })
  assert.equal(legacy.consecutive, 2, 'the retired bare plugin kind is not genuine either')
})

test('a completed turn resets the counter; the reset applies even when the session is excluded', () => {
  const d = decide({ ...base, events: [...maxTokensTurn(), kickMessage(), ...completedTurn()], consecutive: 2 })
  assert.equal(d.consecutive, 0)
  const sub = decide({ ...base, events: completedTurn(), consecutive: 2, isSubagent: true })
  assert.equal(sub.action, 'skip')
  assert.equal(sub.scopeSkipped, true)
  assert.equal(sub.consecutive, 0)
})

test('empty-completion: reasoning-only completed turn kicks; tool-call blocks count as real content', () => {
  const long = 'x'.repeat(DEFAULT_CONFIG.emptyCompletionMinReasoningChars)
  const empty = [turnStart(), assistant([reasoning(long)]), turnEnd('completed')]
  assert.equal(decide({ ...base, events: empty }).flavor, 'empty-completion')

  const withTool = [turnStart(), assistant([reasoning(long), { type: 'tool-call', id: 'c1', name: 'bash', arguments: {} }]), turnEnd('completed')]
  assert.equal(decide({ ...base, events: withTool }).action, 'skip')

  const short = [turnStart(), assistant([reasoning('brief')]), turnEnd('completed')]
  assert.equal(decide({ ...base, events: short }).action, 'skip')
})

test('interrupted kicks but is not counted; aborted, error and unknown kinds do not kick', () => {
  const interrupted = decide({ ...base, events: [turnStart(), turnEnd('interrupted')] })
  assert.equal(interrupted.flavor, 'interrupted')
  assert.equal(interrupted.consecutive, 0)
  for (const kind of ['aborted', 'error', 'blocked', 'forked']) {
    assert.equal(decide({ ...base, events: [turnStart(), turnEnd(kind)] }).action, 'skip', kind)
  }
})

test('cooldown, per-kind switches and subagent scope are honoured', () => {
  const events = maxTokensTurn()
  assert.match(decide({ ...base, events, settings: { ...settings, cooldownMs: 60000 }, lastKickAt: base.now - 1000 }).why, /cooldown/)
  assert.equal(decide({ ...base, events, settings: { ...settings, kickOnMaxTokens: false } }).action, 'skip')
  assert.equal(decide({ ...base, events, isSubagent: true }).action, 'skip')
  assert.equal(decide({ ...base, events, isSubagent: true, settings: { ...settings, includeSubagents: true } }).action, 'kick')
})

test('maxConsecutiveKicks 0 skips quietly instead of raising the runaway error', () => {
  const d = decide({ ...base, events: maxTokensTurn(), settings: { ...settings, maxConsecutiveKicks: 0 } })
  assert.equal(d.action, 'skip')
  assert.match(d.why, /disabled/)
})

test('summaries are bounded to 120 characters', () => {
  assert.equal(boundSummary('short'), 'short')
  const long = boundSummary('x'.repeat(300))
  assert.equal(long.length, 120)
  assert.ok(long.endsWith('…'))
  const d = decide({ ...base, events: maxTokensTurn(), settings: { ...settings, maxConsecutiveKicks: 10 ** 120 } })
  assert.ok(d.summary.length <= 120)
})

test('a configured kick text replaces the built-in one', () => {
  const d = decide({ ...base, events: maxTokensTurn(), settings: { ...settings, maxTokensKickText: 'go on' } })
  assert.equal(d.text, 'go on')
})
