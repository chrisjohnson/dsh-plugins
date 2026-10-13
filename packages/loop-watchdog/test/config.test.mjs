// Configuration resolution: what a profile gets when it sets nothing, and what a
// misconfigured key says instead of silently doing nothing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { DEFAULT_CONFIG, chatCompletionsUrl, displayUrl, dshHome, resolveSettings } from '../src/config.mjs'

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
  assert.equal(dshHome({ DSH_HOME: '/x/' }, '/home/u'), '/x')
  assert.equal(dshHome({ DSH_HOME: '~/lab' }, '/home/u'), join('/home/u', 'lab'), 'tilde is expanded like the harness does')
  assert.equal(dshHome({ DSH_HOME: '~' }, '/home/u'), '/home/u')
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
    displayUrl: 'http://127.0.0.1:4000/v1/chat/completions',
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

test('relative paths resolve against the dsh home, never the working directory', () => {
  const { settings } = resolve({
    ledgerFile: 'storages/semantic-loop-kicker/evaluations.jsonl',
    modeFile: 'profiles/web/watchdog-mode.json',
    logFilePath: '../elsewhere/w.log',
  })
  assert.equal(settings.ledgerFile, join('/srv/dsh', 'storages/semantic-loop-kicker/evaluations.jsonl'))
  assert.equal(settings.modeFile, join('/srv/dsh', 'profiles/web/watchdog-mode.json'))
  assert.equal(settings.logFilePath, '/srv/elsewhere/w.log')
})

test('relative paths with DSH_HOME unset use ~/.dsh; a lab-style home moves them with it', () => {
  const unset = resolveSettings({ modeFile: 'profiles/web/watchdog-mode.json' }, { env: {}, home: '/home/u' })
  assert.equal(unset.settings.modeFile, join('/home/u', '.dsh', 'profiles/web/watchdog-mode.json'))
  const lab = resolveSettings({ modeFile: 'profiles/web/watchdog-mode.json' }, { env: { DSH_HOME: '/work/.lab/home' }, home: '/home/u' })
  assert.equal(lab.settings.modeFile, '/work/.lab/home/profiles/web/watchdog-mode.json')
})

test('absolute and tilde paths are used as given', () => {
  const { settings } = resolveSettings({ ledgerFile: '/data/l.jsonl', logFilePath: '~/w.log' }, { env, home: '/home/u' })
  assert.equal(settings.ledgerFile, '/data/l.jsonl')
  assert.equal(settings.logFilePath, join('/home/u', 'w.log'))
})

test('timeouts and token budgets must be above zero', () => {
  const { settings, warnings } = resolve({ watchdogTimeoutMs: 0, llmMaxTokens: 0, cooldownMs: 0 })
  assert.equal(settings.watchdogTimeoutMs, DEFAULT_CONFIG.watchdogTimeoutMs)
  assert.equal(settings.llmMaxTokens, DEFAULT_CONFIG.llmMaxTokens)
  assert.equal(settings.cooldownMs, 0, 'a zero cooldown is legitimate')
  assert.equal(warnings.filter((w) => /watchdogTimeoutMs|llmMaxTokens/.test(w)).length, 2)
})

test('the logged endpoint carries no credentials or query; a query in the base URL warns', () => {
  assert.equal(displayUrl('https://user:pw@h.example/v1/chat/completions?key=abc#x'), 'https://h.example/v1/chat/completions')
  const { llm, warnings } = resolve({ llmBaseUrl: 'https://user:pw@h.example/v1?key=abc', llmModel: 'm' })
  assert.doesNotMatch(llm.displayUrl, /pw|abc|user/)
  assert.match(warnings.join('\n'), /query string/)
})

test('the defaults equal the values the original deployment row set explicitly', () => {
  assert.deepEqual(
    { ...DEFAULT_CONFIG },
    {
      cooldownMs: 30000, maxTranscriptLines: 6, includeSubagents: false, interventionEnabled: false,
      watchdogTimeoutMs: 25000, fpWindowEvents: 60, busyYieldMs: 15000, bandStuck: 90, bandWatch: 70,
      logConsole: false, logFile: true, logDsh: false, logDshErrors: true, llmMaxTokens: 128,
    },
  )
})
