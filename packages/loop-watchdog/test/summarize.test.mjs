// Event reading against real V4 shapes (see fixtures.mjs for where each comes from).

import test from 'node:test'
import assert from 'node:assert/strict'

import { eventMessage, extractCalls, fingerprintReport, isSubstantive, summarizeEvent, toolResultText } from '../src/summarize.mjs'
import { assistantToolCall, round, toolCall, toolResult, userMessage } from './fixtures.mjs'

test('tool results are matched to their call by message.toolCallId and carry their real text', () => {
  const events = [...round('c1', 'grep', { q: 'x' }, 'hit: a.js:3'), ...round('c2', 'grep', { q: 'y' }, 'hit: b.js:9')]
  const calls = extractCalls(events)
  assert.deepEqual(
    calls.map((c) => [c.id, c.name, c.result]),
    [
      ['c1', 'grep', 'hit: a.js:3'],
      ['c2', 'grep', 'hit: b.js:9'],
    ],
  )
})

test('the same call with different results is progress, not a loop', () => {
  // With the pre-V4 reader every result came back empty, so three identical calls
  // always read as "same call, one distinct result" and fired a false LOOP.
  const events = [
    ...round('c1', 'read_file', { path: 'a' }, 'line 1'),
    ...round('c2', 'read_file', { path: 'a' }, 'line 1 line 2'),
    ...round('c3', 'read_file', { path: 'a' }, 'line 1 line 2 line 3'),
  ]
  const report = fingerprintReport(events)
  assert.equal(report.calls, 3)
  assert.equal(report.stuck.length, 0)
  assert.equal(report.groups[0].distinctResults, 3)
})

test('the same call with the same result three times is stuck', () => {
  const events = [
    ...round('c1', 'search', { q: 'needle' }, 'no matches'),
    ...round('c2', 'search', { q: 'needle' }, 'no matches'),
    ...round('c3', 'search', { q: 'needle' }, 'no matches'),
  ]
  const { stuck } = fingerprintReport(events)
  assert.equal(stuck.length, 1)
  assert.equal(stuck[0].count, 3)
  assert.equal(stuck[0].distinctResults, 1)
})

test('five repeats with at most two distinct results is stuck; with three it is not', () => {
  const run = (texts) => fingerprintReport(texts.flatMap((t, i) => round(`c${i}`, 'poll', { id: 1 }, t))).stuck.length
  assert.equal(run(['a', 'b', 'a', 'b', 'a']), 1)
  assert.equal(run(['a', 'b', 'c', 'a', 'b']), 0)
})

test('whitespace in arguments does not split a fingerprint group', () => {
  const events = [
    toolCall('c1', 'bash', { cmd: 'ls  -la' }),
    toolResult('c1', 'x'),
    { type: 'tool/call', data: { callId: 'c2', name: 'bash', arguments: '{"cmd":"ls  -la"}' } },
  ]
  assert.equal(fingerprintReport(events).groups.length, 1)
})

test('a result for an unknown call id is ignored, and a call with no result reads as (empty)', () => {
  const events = [toolCall('c1', 'bash', {}), toolResult('other', 'stray')]
  assert.equal(extractCalls(events)[0].result, '')
  assert.equal(fingerprintReport(events).groups[0].distinctResults, 1)
})

test('a multi-block tool result joins its text blocks and names the rest', () => {
  const message = { role: 'tool', content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] }
  assert.equal(toolResultText(message), 'one [image] two')
})

test('summarizeEvent renders tool-role entries with their real text', () => {
  const line = summarizeEvent(toolResult('c1', 'Error: ENOENT no such file'))
  assert.equal(line, '[Role: tool] Error: ENOENT no such file')
  assert.doesNotMatch(line, /non-text event|empty/)
})

test('summarizeEvent marks a failed tool result and bounds a long one', () => {
  assert.match(summarizeEvent(toolResult('c1', 'boom', { isError: true })), /^\[Role: tool\] \[error\] boom$/)
  const long = summarizeEvent(toolResult('c1', 'x'.repeat(1000)))
  assert.ok(long.endsWith('...'))
  assert.ok(long.length < 340)
})

test('summarizeEvent reads a V4 user/message, whose data is the message', () => {
  assert.equal(summarizeEvent(userMessage('please fix the build')), '[Role: user] please fix the build')
})

test('summarizeEvent renders an assistant tool call with its raw JSON arguments', () => {
  assert.equal(summarizeEvent(assistantToolCall('c1', 'grep', { q: 'x' })), '[Role: assistant] grep({"q":"x"})')
})

test('summarizeEvent compacts turn boundaries and survives junk', () => {
  assert.equal(summarizeEvent({ type: 'turn/start', data: { turn: 4 } }), '[turn/start #4]')
  assert.equal(summarizeEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), '[turn/end reason=completed]')
  assert.equal(summarizeEvent(null), '[raw] null')
  assert.match(summarizeEvent({ type: 'request/header', data: {} }), /non-text event/)
})

test('isSubstantive: messages and tool results count, lifecycle noise and bare call records do not', () => {
  assert.equal(isSubstantive(userMessage('hi')), true)
  assert.equal(isSubstantive(assistantToolCall('c1', 'grep', {})), true)
  assert.equal(isSubstantive(toolResult('c1', '')), true, 'an empty tool result is itself a signal')
  assert.equal(isSubstantive(toolCall('c1', 'grep', {})), false)
  assert.equal(isSubstantive({ type: 'turn/end', data: {} }), false)
  assert.equal(isSubstantive({ type: 'agent/inbox/spliced', data: {} }), false)
  assert.equal(isSubstantive(userMessage('   ')), false)
})

test('eventMessage: user/message data is the message, the others nest it', () => {
  const u = userMessage('hi')
  assert.equal(eventMessage(u), u.data)
  const t = toolResult('c1', 'x')
  assert.equal(eventMessage(t), t.data.message)
  assert.equal(eventMessage(toolCall('c1', 'x', {})), null)
})
