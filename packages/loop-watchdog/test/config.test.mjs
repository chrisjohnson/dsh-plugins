// Configuration resolution: what a profile gets when it sets nothing, and what a
// misconfigured key says instead of silently doing nothing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { DEFAULT_CONFIG, chatCompletionsUrl, dshHome, resolveSettings } from '../src/config.mjs'

const env = { DSH_HOME: '/srv/dsh' }
const resolve = (config, e = env) => resolveSettings(config, { env: e, home: '/home/nobody' })

test('no config: working, log-only, model adjudication off with one warning that names the keys', () => {
  const { settings, llm, warnings } = resolve({})
  assert.equal(settings.interventionEnabled, false)
  assert.equal(settings.cooldownMs, DEFAULT_CONFIG.cooldownMs)
  assert.equal(llm, undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /llmBaseUrl/)
  assert.match(warnings[0], /llmModel/)
})

test('default paths live under $DSH_HOME/storages/loop-watchdog', () => {
  const { settings } = resolve({})
  const dir = join('/srv/dsh', 'storages', 'loop-watchdog')
  assert.equal(settings.ledgerFile, join(dir, 'evaluations.jsonl'))
  assert.equal(settings.modeFile, join(dir, 'mode.json'))
  assert.equal(settings.logFilePath, join(dir, 'watchdog.log'))
})

test('DSH_HOME falls back to ~/.dsh, and a blank value counts as unset', () => {
  assert.equal(dshHome({}, '/home/u'), join('/home/u', '.dsh'))
  assert.equal(dshHome({ DSH_HOME: '   ' }, '/home/u'), join('/home/u', '.dsh'))
  assert.equal(dshHome({ DSH_HOME: ' /x ' }, '/home/u'), '/x')
})

test('explicit paths win over the defaults', () => {
  const { settings } = resolve({ ledgerFile: '/data/old/evaluations.jsonl', modeFile: '/data/mode.json', logFilePath: '/var/log/w.log' })
  assert.equal(settings.ledgerFile, '/data/old/evaluations.jsonl')
  assert.equal(settings.modeFile, '/data/mode.json')
  assert.equal(settings.logFilePath, '/var/log/w.log')
})

test('a complete model block resolves; the API key is only ever a variable NAME', () => {
  const { llm, warnings } = resolve(
    {
      llmBaseUrl: 'http://127.0.0.1:4000/v1/',
      llmModel: 'small',
      llmApiKeyEnv: 'MY_KEY',
      llmExtraBody: { chat_template_kwargs: { enable_thinking: false } },
    },
    { ...env, MY_KEY: 'secret' },
  )
  assert.deepEqual(llm, {
    url: 'http://127.0.0.1:4000/v1/chat/completions',
    model: 'small',
    apiKeyEnv: 'MY_KEY',
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
    maxTokens: 128,
  })
  assert.deepEqual(warnings, [])
  assert.doesNotMatch(JSON.stringify(llm), /secret/)
})

test('an API-key variable that is empty in the environment is called out', () => {
  const { llm, warnings } = resolve({ llmBaseUrl: 'http://h/v1', llmModel: 'm', llmApiKeyEnv: 'NOPE' })
  assert.ok(llm)
  assert.match(warnings.join('\n'), /NOPE.*empty/)
})

test('half a model block keeps adjudication off and says which half is missing', () => {
  assert.match(resolve({ llmBaseUrl: 'http://h/v1' }).warnings.join('\n'), /llmModel is not/)
  assert.match(resolve({ llmModel: 'm' }).warnings.join('\n'), /llmBaseUrl is not/)
  assert.equal(resolve({ llmModel: 'm' }).llm, undefined)
})

test('a non-http base URL is rejected', () => {
  const { llm, warnings } = resolve({ llmBaseUrl: 'ftp://h/v1', llmModel: 'm' })
  assert.equal(llm, undefined)
  assert.match(warnings.join('\n'), /not an http\(s\) URL/)
  assert.equal(chatCompletionsUrl('not a url'), undefined)
  assert.equal(chatCompletionsUrl('https://api.example/v1'), 'https://api.example/v1/chat/completions')
})

test('wrongly typed values warn and fall back to the default', () => {
  const { settings, warnings } = resolve({ cooldownMs: '30000', interventionEnabled: 'yes', bandStuck: -1, llmExtraBody: [] })
  assert.equal(settings.cooldownMs, DEFAULT_CONFIG.cooldownMs)
  assert.equal(settings.interventionEnabled, false)
  assert.equal(settings.bandStuck, DEFAULT_CONFIG.bandStuck)
  const text = warnings.join('\n')
  assert.match(text, /cooldownMs/)
  assert.match(text, /interventionEnabled/)
  assert.match(text, /bandStuck/)
  assert.match(text, /llmExtraBody/)
})

test('unknown keys are named, and every documented key is honoured', () => {
  const { warnings } = resolve({ cooldwonMs: 1 })
  assert.match(warnings.join('\n'), /unknown config key "cooldwonMs"/)
  const full = {
    cooldownMs: 1, maxTranscriptLines: 1, includeSubagents: true, interventionEnabled: true, watchdogTimeoutMs: 1,
    fpWindowEvents: 1, busyYieldMs: 1, bandStuck: 90, bandWatch: 70, logConsole: true, logFile: false, logDsh: true,
    logDshErrors: false, llmMaxTokens: 1, llmBaseUrl: 'http://h/v1', llmModel: 'm', llmApiKeyEnv: 'K', llmExtraBody: {},
    ledgerFile: '/a', modeFile: '/b', logFilePath: '/c',
  }
  const { warnings: w } = resolve(full, { ...env, K: 'x' })
  assert.deepEqual(w, [])
})

test('an inverted band pair warns', () => {
  assert.match(resolve({ bandStuck: 60, bandWatch: 80 }).warnings.join('\n'), /watch band is empty/)
})
