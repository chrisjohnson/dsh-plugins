// Decision tests over session events shaped like dsh 0.2.0-rc.2 (format V4):
// a user/message event's data IS the message, so its source is `data.source`
// (@deepseek-ai/dsh-session types.d.ts `'user/message': UserMessage`), tool
// calls are `type: 'tool-call'` blocks (@deepseek-ai/dsh-llm types.d.ts), and
// turn/end carries `data.reason.kind`.

import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeTail, boundSummary, countConsecutiveKicks, decide, PLUGIN_SOURCE_KIND } from '../src/decide.mjs'
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

// Real V4 shapes: TurnEndReasonMap in @deepseek-ai/dsh-session types.d.ts;
// error carries an LlmFailure ({ message, code }, @deepseek-ai/dsh-llm types.d.ts);
// aborted carries an AgentCancelCause.
const errorEnd = () => ({
  type: 'turn/end',
  data: { turn, reason: { kind: 'error', error: { message: 'litellm.APIConnectionError: Connection error.', code: 'UNKNOWN' } } },
})
const abortedEnd = (cause = { kind: 'user' }) => ({ type: 'turn/end', data: { turn, reason: { kind: 'aborted', reason: cause } } })
const errorTurn = () => [turnStart(), assistant([text('partial')]), errorEnd()]

const maxTokensTurn = () => [turnStart(), assistant([reasoning('thinking'), text('partial')]), turnEnd('max-tokens')]
const completedTurn = () => [turnStart(), assistant([text('done')]), turnEnd('completed')]

const base = { settings, lastKickAt: 0, now: 1_000_000, isSubagent: false }

test('a max-tokens halt kicks once, with the plugin-owned V4 source kind in the text/summary', () => {
  const events = [userMessage('user'), ...maxTokensTurn()]
  const first = decide({ ...base, events })
  assert.equal(first.action, 'kick')
  assert.equal(first.flavor, 'max-tokens')
  assert.equal(first.consecutive, 1)
  assert.equal(first.text, settings.maxTokensKickText)
  assert.match(first.summary, /1\/3/)

  // Once the kick sits at the tail awaiting its result, the next analysis does nothing.
  const second = decide({ ...base, events: [...events, kickMessage()], lastKickAt: base.now, now: base.now + 5 })
  assert.equal(second.action, 'skip')
  assert.match(second.why, /plugin kick awaiting/)
})

test('three kicks with no progress, then the runaway guard stops', () => {
  let events = [userMessage('user'), ...maxTokensTurn()]
  let now = base.now
  const actions = []
  let last
  for (let i = 0; i < 4; i++) {
    const d = decide({ ...base, events, now, lastKickAt: 0 })
    actions.push(d.action)
    last = d
    if (d.action !== 'kick') break
    now += 10
    // The kick lands and the model hits the wall again.
    events = [...events, kickMessage(), ...maxTokensTurn()]
  }
  assert.deepEqual(actions, ['kick', 'kick', 'kick', 'stop'])
  assert.equal(last.consecutive, 3)
})

const kicked = (n, halt = maxTokensTurn) => Array.from({ length: n }, () => [kickMessage(), ...halt()]).flat()

test('a genuine user message resets the counter live: the tail is the halting turn, not the user message', () => {
  // Cap reached, then the human sends a new prompt and that turn halts too.
  const events = [userMessage('user'), ...maxTokensTurn(), ...kicked(3), userMessage('user'), ...maxTokensTurn()]
  assert.equal(countConsecutiveKicks(events, settings), 0)
  const d = decide({ ...base, events })
  assert.equal(d.action, 'kick')
  assert.equal(d.consecutive, 1)
  // Without the new prompt the same history is capped.
  assert.equal(decide({ ...base, events: [userMessage('user'), ...maxTokensTurn(), ...kicked(3)] }).action, 'stop')
})

test('a plugin-sourced message does not reset the counter; a non-kick plugin message is not counted', () => {
  const base3 = [userMessage('user'), ...maxTokensTurn(), ...kicked(2)]
  assert.equal(countConsecutiveKicks([...base3, kickMessage()], settings), 3)
  assert.equal(analyzeTail([kickMessage()], settings).action, 'none')

  assert.equal(countConsecutiveKicks([...base3, userMessage('goal')], settings), 2, 'another producer neither resets nor counts')
  assert.equal(countConsecutiveKicks([...base3, userMessage('plugin:other-plugin')], settings), 2)
  assert.equal(countConsecutiveKicks([...base3, userMessage('plugin', { plugin: 'other' })], settings), 2)
})

test('the retired bare plugin kind counts only with this plugin name and a known kick text', () => {
  const legacy = (text, plugin = 'continue-kicker') => ({
    type: 'user/message',
    data: { id: 'l', role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin } },
  })
  const head = [userMessage('user'), ...maxTokensTurn()]
  assert.equal(countConsecutiveKicks([...head, legacy(DEFAULT_CONFIG.maxTokensKickText)], settings), 1)
  assert.equal(countConsecutiveKicks([...head, legacy('some other text')], settings), 0)
  assert.equal(countConsecutiveKicks([...head, legacy(DEFAULT_CONFIG.maxTokensKickText, 'other')], settings), 0)
})

test('a normally completed turn resets the counter; the reset applies even when the session is excluded', () => {
  const events = [userMessage('user'), ...maxTokensTurn(), ...kicked(2), kickMessage(), ...completedTurn()]
  assert.equal(countConsecutiveKicks(events, settings), 0)
  const sub = decide({ ...base, events, isSubagent: true })
  assert.equal(sub.scopeSkipped, true)
  assert.equal(sub.consecutive, 0)
})

test('a reasoning-only completion is a halt, not progress: it does not reset', () => {
  const long = 'x'.repeat(DEFAULT_CONFIG.emptyCompletionMinReasoningChars)
  const emptyEnd = () => [turnStart(), assistant([reasoning(long)]), turnEnd('completed')]
  const events = [userMessage('user'), ...emptyEnd(), ...kicked(2, emptyEnd)]
  assert.equal(countConsecutiveKicks(events, settings), 2)
  assert.equal(decide({ ...base, events }).consecutive, 3)
})

test('the cap counts every flavor together, interrupted included', () => {
  const interruptedTurn = () => [turnStart(), turnEnd('interrupted')]
  const events = [userMessage('user'), ...interruptedTurn(), kickMessage(), ...maxTokensTurn(), kickMessage(), ...interruptedTurn()]
  assert.equal(countConsecutiveKicks(events, settings), 2)
  const capped = decide({ ...base, events: [...events, kickMessage(), ...interruptedTurn()] })
  assert.equal(capped.action, 'stop')
})

test('restart simulation: fresh process state, same events, still capped; cooldown state is not needed', () => {
  const events = [userMessage('user'), ...maxTokensTurn(), ...kicked(3)]
  for (let restart = 0; restart < 6; restart++) {
    const d = decide({ ...base, events, lastKickAt: 0, now: base.now + restart * 1e6 })
    assert.equal(d.action, 'stop')
    assert.equal(d.consecutive, 3)
  }
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
  assert.equal(interrupted.consecutive, 1, 'interrupted kicks count toward the cap')
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

// The `continueKicker` kick service asks for one recovery kick right after it
// watched a turn fail, which is always inside the cooldown a previous kick
// started. bypassCooldown opens only that gate.
test('bypassCooldown skips the cooldown gate and nothing else', () => {
  const events = maxTokensTurn()
  const cooled = { ...settings, cooldownMs: 60000 }
  const inCooldown = { ...base, events, settings: cooled, lastKickAt: base.now - 1000 }
  assert.equal(decide(inCooldown).action, 'skip')
  assert.match(decide(inCooldown).why, /cooldown/)
  const forced = decide({ ...inCooldown, bypassCooldown: true })
  assert.equal(forced.action, 'kick')
  assert.equal(forced.flavor, 'max-tokens')
  assert.equal(forced.consecutive, 1)
  // Explicit false behaves exactly like omitting it.
  assert.equal(decide({ ...inCooldown, bypassCooldown: false }).action, 'skip')

  // Every other gate still holds while the cooldown is bypassed.
  assert.equal(decide({ ...base, events, settings: { ...cooled, kickOnMaxTokens: false }, bypassCooldown: true }).action, 'skip')
  assert.equal(decide({ ...base, events, isSubagent: true, bypassCooldown: true }).action, 'skip')
  assert.equal(decide({ ...base, events, settings: { ...cooled, maxConsecutiveKicks: 0 }, bypassCooldown: true }).action, 'skip')
  const exhausted = [userMessage('user'), ...maxTokensTurn(), kickMessage(), ...maxTokensTurn(), kickMessage(), ...maxTokensTurn(), kickMessage(), ...maxTokensTurn()]
  const stopped = decide({ ...base, events: exhausted, settings: cooled, lastKickAt: base.now - 1000, bypassCooldown: true })
  assert.equal(stopped.action, 'stop')
  assert.match(stopped.why, /runaway guard/)

  // A tail that is not a kickable halt is still not a kick, cooldown or not.
  assert.equal(decide({ ...base, events: completedTurn(), bypassCooldown: true }).action, 'skip')
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

const withError = { ...settings, kickOnError: true }

test('error halt with kickOnError off (the default) does not kick', () => {
  assert.equal(DEFAULT_CONFIG.kickOnError, false)
  const d = decide({ ...base, events: errorTurn() })
  assert.equal(d.action, 'skip')
  assert.match(d.why, /kickOnError disabled/)
})

test('error halt with kickOnError on kicks once, with the error text and a bounded summary', () => {
  const events = [userMessage('user'), ...errorTurn()]
  const d = decide({ ...base, events, settings: withError })
  assert.equal(d.action, 'kick')
  assert.equal(d.flavor, 'error')
  assert.equal(d.consecutive, 1)
  assert.equal(d.text, DEFAULT_CONFIG.errorKickText)
  assert.ok(d.summary.length <= 120)
  const again = decide({ ...base, events: [...events, kickMessage()], settings: withError, lastKickAt: base.now, now: base.now + 5 })
  assert.equal(again.action, 'skip')
})

test('errors after three kicks stop at the cap', () => {
  let events = [userMessage('user'), ...errorTurn()]
  const actions = []
  for (let i = 0; i < 4; i++) {
    const d = decide({ ...base, events, settings: withError, lastKickAt: 0 })
    actions.push(d.action)
    if (d.action !== 'kick') {
      assert.match(d.why, /runaway guard/)
      break
    }
    events = [...events, kickMessage(), ...errorTurn()]
  }
  assert.deepEqual(actions, ['kick', 'kick', 'kick', 'stop'])
})

test('aborted turns never kick, whatever the cause', () => {
  for (const cause of [{ kind: 'user' }, { kind: 'parent' }, { kind: 'hook', reason: 'x' }, { kind: 'disposed' }, { kind: 'legacy' }]) {
    const d = decide({ ...base, events: [turnStart(), abortedEnd(cause)], settings: withError })
    assert.equal(d.action, 'skip', cause.kind)
  }
  assert.equal(decide({ ...base, events: [turnStart(), turnEnd('blocked')], settings: withError }).action, 'skip')
})

test('error kicks honour the cooldown and the subagent scope', () => {
  const events = errorTurn()
  assert.match(decide({ ...base, events, settings: { ...withError, cooldownMs: 60000 }, lastKickAt: base.now - 1000 }).why, /cooldown/)
  assert.equal(decide({ ...base, events, settings: withError, isSubagent: true }).scopeSkipped, true)
})

test('mixed flavors share one counter', () => {
  const afterMaxTokens = decide({ ...base, events: [userMessage('user'), ...maxTokensTurn()], settings: withError })
  assert.equal(afterMaxTokens.consecutive, 1)
  const afterError = decide({ ...base, events: [userMessage('user'), ...maxTokensTurn(), kickMessage(), ...errorTurn()], settings: withError })
  assert.equal(afterError.flavor, 'error')
  assert.equal(afterError.consecutive, 2)
  const capped = decide({ ...base, events: [userMessage('user'), ...errorTurn(), kickMessage(), ...maxTokensTurn()], settings: { ...withError, maxConsecutiveKicks: 1 } })
  assert.equal(capped.action, 'stop')
})

test('a genuine user message resets the counter after error kicks', () => {
  const events = [userMessage('user'), ...errorTurn(), ...kicked(3, errorTurn), userMessage('user'), ...errorTurn()]
  const d = decide({ ...base, events, settings: withError })
  assert.equal(d.action, 'kick')
  assert.equal(d.consecutive, 1)
})
