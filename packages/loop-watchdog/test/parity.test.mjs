// Parity with the harness's own constructors: messages built by the real
// @deepseek-ai/dsh-llm must read exactly like the hand-written fixtures. Skips
// on a bare clone without a dsh installation.

import test from 'node:test'
import assert from 'node:assert/strict'

import { boundSummary, interventionSource } from '../src/decide.mjs'
import { extractCalls, summarizeEvent } from '../src/summarize.mjs'

let llm
try {
  llm = await import('@deepseek-ai/dsh-llm')
} catch {
  llm = undefined
}
const skip = llm === undefined ? 'no @deepseek-ai/dsh-llm installed' : false

test('a tool-role message from createToolResultMessage is read by call id and by text', { skip }, () => {
  const message = llm.createToolResultMessage({ callId: 'call-9', content: [{ type: 'text', text: 'real output' }], isError: false })
  const event = { type: 'tool/result', data: { turn: 1, step: 1, message } }
  assert.equal(summarizeEvent(event), '[Role: tool] real output')
  const call = { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-9', name: 'bash', arguments: '{"cmd":"ls"}' } }
  assert.equal(extractCalls([call, event])[0].result, 'real output')
})

test('a user message from createUserMessage is read from event.data', { skip }, () => {
  const message = llm.createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  assert.equal(summarizeEvent({ type: 'user/message', data: message }), '[Role: user] hello')
})

test('the bound on the notice summary matches the harness', { skip }, () => {
  const long = 'q'.repeat(400)
  assert.equal(boundSummary(long), llm.boundContextSummary(long))
  assert.equal(llm.CONTEXT_SUMMARY_MAX_CHARS, 120)
})

test('the steering message is a valid user message with the plugin-owned kind', { skip }, () => {
  const message = llm.createUserMessage({ content: [{ type: 'text', text: 'note' }], source: interventionSource() })
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'plugin:loop-watchdog')
})
