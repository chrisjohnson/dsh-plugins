// The host wired against a fake context: a real agent/pre-step listener, real V4
// event shapes, a real ledger file in a temp directory. Needs
// @deepseek-ai/dsh-llm (the plugin imports createUserMessage from it); on a bare
// clone without a dsh installation these tests skip rather than fail.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { round, userMessage } from './fixtures.mjs'

let host
let llmPkg
try {
  llmPkg = await import('@deepseek-ai/dsh-llm')
  host = (await import('../src/host.mjs')).default
} catch {
  host = undefined
}
const skip = host === undefined ? 'no @deepseek-ai/dsh-llm installed' : false

const noop = () => {}
const fakeLogger = { info: noop, warn: noop, error: noop, debug: noop }

function mount(config) {
  const listeners = {}
  const ctx = {
    logger: () => fakeLogger,
    on: (name, fn) => (listeners[name] = fn),
    inject: noop,
  }
  host(ctx, config)
  return listeners['agent/pre-step']
}

function agentWith(events, steered, header = {}) {
  return {
    id: 'session-1',
    session: { header, snapshotEvents: () => events },
    steer: (m) => steered.push(m),
  }
}

async function ledgerAfter(file, count) {
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      if (lines.length >= count) return lines.map((l) => JSON.parse(l))
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

const loop = () => [
  userMessage('find it'),
  ...round('c1', 'search', { q: 'needle' }, 'no matches'),
  ...round('c2', 'search', { q: 'needle' }, 'no matches'),
  ...round('c3', 'search', { q: 'needle' }, 'no matches'),
]

function setup(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-watchdog-'))
  const config = {
    ledgerFile: join(dir, 'evaluations.jsonl'),
    modeFile: join(dir, 'mode.json'),
    logFilePath: join(dir, 'w.log'),
    cooldownMs: 0,
    logFile: false,
    ...extra,
  }
  return { dir, config }
}

test('a repeated call with identical V4 results is a deterministic LOOP, ledgered, log-only by default', { skip }, async () => {
  const { dir, config } = setup()
  try {
    const steered = []
    const preStep = mount(config)
    await preStep({ agent: agentWith(loop(), steered) }, async () => ({ kind: 'enter' }))
    const [record] = await ledgerAfter(config.ledgerFile, 1)
    assert.equal(record.v, 2)
    assert.equal(record.source, 'fingerprint')
    assert.equal(record.verdict, 'LOOP')
    assert.equal(record.band, 'stuck')
    assert.equal(record.mode, 'log')
    assert.equal(record.code.stuck, true)
    assert.equal(record.code.calls, 3)
    assert.match(record.window, /\[Role: tool\] no matches/)
    assert.equal(steered.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the mode file switches to act; the second sustained stuck check steers once, with the V4 source kind', { skip }, async () => {
  const { dir, config } = setup()
  try {
    writeFileSync(config.modeFile, '{"interventionEnabled":true}')
    const steered = []
    const preStep = mount(config)
    const agent = agentWith(loop(), steered)
    const next = async () => ({ kind: 'enter' })
    await preStep({ agent }, next)
    await ledgerAfter(config.ledgerFile, 1)
    await preStep({ agent }, next)
    const records = await ledgerAfter(config.ledgerFile, 2)
    assert.deepEqual(records.map((r) => [r.streak, r.mode, r.outcome]), [[1, 'act', 'logged'], [2, 'act', 'intervened']])
    assert.equal(steered.length, 1)
    assert.equal(steered[0].role, 'user')
    assert.equal(steered[0].source.kind, 'plugin:loop-watchdog')
    assert.equal(steered[0].source.form, 'notice')
    assert.ok(steered[0].source.summary.length <= llmPkg.CONTEXT_SUMMARY_MAX_CHARS)

    await preStep({ agent }, next)
    await ledgerAfter(config.ledgerFile, 3)
    assert.equal(steered.length, 1, 'one nudge per stuck streak')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('with no model configured an ambiguous window is a no-llm skip, recorded once', { skip }, async () => {
  const { dir, config } = setup()
  try {
    const events = [userMessage('go'), ...round('c1', 'read', { p: 'a' }, 'one'), ...round('c2', 'read', { p: 'b' }, 'two')]
    const preStep = mount(config)
    const agent = agentWith(events, [])
    await preStep({ agent }, async () => ({ kind: 'enter' }))
    await preStep({ agent }, async () => ({ kind: 'enter' }))
    const records = await ledgerAfter(config.ledgerFile, 1)
    await new Promise((r) => setTimeout(r, 50))
    const all = await ledgerAfter(config.ledgerFile, 1)
    assert.equal(all.length, 1)
    assert.equal(records[0].skip, 'no-llm')
    assert.equal(records[0].code.ran, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an ambiguous window goes to the configured model, keyed from the named env var', { skip }, async () => {
  const { dir, config } = setup({ llmBaseUrl: 'http://llm.test/v1', llmModel: 'judge', llmApiKeyEnv: 'LW_TEST_KEY', llmExtraBody: { extra: 1 } })
  const realFetch = globalThis.fetch
  const seen = []
  process.env.LW_TEST_KEY = 'k-123'
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'PROGRESS:80' } }] }), { status: 200 })
  }
  try {
    const events = [userMessage('go'), ...round('c1', 'read', { p: 'a' }, 'one'), ...round('c2', 'read', { p: 'b' }, 'two')]
    const preStep = mount(config)
    await preStep({ agent: agentWith(events, []) }, async () => ({ kind: 'enter' }))
    const [record] = await ledgerAfter(config.ledgerFile, 1)
    assert.equal(seen[0].url, 'http://llm.test/v1/chat/completions')
    assert.equal(seen[0].init.headers.Authorization, 'Bearer k-123')
    const body = JSON.parse(seen[0].init.body)
    assert.equal(body.model, 'judge')
    assert.equal(body.extra, 1)
    assert.match(body.messages[1].content, /\[Role: tool\] one/, 'the model sees real tool output')
    assert.equal(record.source, 'llm')
    assert.equal(record.verdict, 'PROGRESS')
    assert.equal(record.band, 'noise', 'a confident PROGRESS is not a stuck band')
  } finally {
    globalThis.fetch = realFetch
    delete process.env.LW_TEST_KEY
    rmSync(dir, { recursive: true, force: true })
  }
})

test('subagent sessions are skipped unless includeSubagents is set', { skip }, async () => {
  const { dir, config } = setup()
  try {
    const preStep = mount(config)
    await preStep({ agent: agentWith(loop(), [], { origin: 'subagent' }) }, async () => ({ kind: 'enter' }))
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(existsSync(config.ledgerFile), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the listener returns the waterfall decision untouched', { skip }, async () => {
  const { dir, config } = setup()
  try {
    const preStep = mount(config)
    const decision = { kind: 'enter', messages: [] }
    assert.equal(await preStep({ agent: agentWith([], []) }, async () => decision), decision)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
