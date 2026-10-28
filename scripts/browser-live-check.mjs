#!/usr/bin/env node
// Live check for dsh-browser against a real dsh process and a real Browserless.
// Not part of `npm run check` (it needs a dsh install and a reachable
// Browserless); run it by hand before a release.
//
// What it proves, in order:
//   1. module identity  the controller file dsh-browser patches is the file the
//                       original plugin's tools load (same realpath);
//   2. isolation        two sessions calling the ORIGINAL browser_* tools get two
//                       contexts on ONE Browserless connection (/pressure +1);
//   3. reconnect        killing that connection on the Browserless side is
//                       survived: the next calls reconnect and say so;
//   4. session end      disposing a session closes its context, and the idle
//                       connection is released when the last one goes;
//   5. fallback         an unreachable Browserless falls back to a local Chromium
//                       and the tool result says so.
//
// It boots its own dsh with a throwaway DSH_HOME and HOME, drives it through
// scripts/live/driver.mjs (real agents and the real tool runtime, no model), and
// removes everything it started. It only talks to Browserless over HTTP
// (/pressure, /sessions, /kill/<id>) and websocket, and it only kills a
// Browserless session that appeared after it started and is the only new one.
//
// Prepare an install once (any directory; pnpm or npm):
//   <dir>/package.json depends on @deepseek-ai/dsh, dsh-playwright-browser@0.1.3
//   and dsh-browser (a file: path to packages/browser copies it the way a git
//   install does; use a hoisted node_modules).
//
// Usage:
//   node scripts/browser-live-check.mjs \
//     --install-dir /path/to/install \
//     --browserless http://127.0.0.1:13100 \
//     [--fallback-chrome "/path/to/chrome"] [--port 3199] [--driver-port 3198]

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const installDir = resolve(arg('install-dir', process.env.DSH_BROWSER_LIVE_INSTALL ?? ''))
const browserless = (arg('browserless', process.env.BROWSERLESS_HTTP ?? '')).replace(/\/$/, '')
const fallbackChrome = arg('fallback-chrome', process.env.FALLBACK_CHROME)
const port = Number(arg('port', '3199'))
const driverPort = Number(arg('driver-port', '3198'))
const driverPath = join(import.meta.dirname, 'live', 'browser-driver.mjs')

if (!existsSync(join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')) || browserless === '') {
  console.error('usage: live-check.mjs --install-dir <dsh install> --browserless http://host:port [--fallback-chrome <path>]')
  process.exit(2)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const showLog = process.argv.includes('--show-log')
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`)
}

async function json(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const pressure = async () => (await json(`${browserless}/pressure`)).pressure
const sessionIds = async () => (await json(`${browserless}/sessions`)).map((session) => session.id)

async function waitFor(what, test, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await test()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

/** Boot one dsh with the given dsh-browser config; returns handles to drive and stop it. */
async function boot(label, browserConfig) {
  // The profile has to live inside the install: dsh resolves a profile's plugin
  // names by walking up from the profile directory, so a profile elsewhere
  // composes but fails to import.
  mkdirSync(join(installDir, '.live-check'), { recursive: true })
  const root = mkdtempSync(join(installDir, '.live-check', `${label}-`))
  const home = mkdtempSync(join(tmpdir(), `dsh-browser-live-home-${label}-`))
  const dshHome = join(root, 'dsh-home')
  const profile = join(dshHome, 'profiles', 'web')
  mkdirSync(home, { recursive: true })
  mkdirSync(profile, { recursive: true })
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'dsh-playwright-browser': '0.1.3', 'dsh-browser': '*' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-playwright-browser', 'dsh-browser'] } },
    }),
  )
  const yaml = (value) => JSON.stringify(value)
  const lines = [
    '- id: playwright-browser',
    '  config:',
    '    viewportWidth: 1024',
    '    viewportHeight: 768',
    '    actionTimeoutMs: 15000',
    '    navigationTimeoutMs: 30000',
    '    maxSnapshotChars: 40000',
    `    screenshotDir: ${yaml(join(root, 'shots'))}`,
    '- id: browser',
    '  config:',
    ...Object.entries({ ...browserConfig, logToStderr: true }).map(([key, value]) => `    ${key}: ${yaml(value)}`),
    '- insert:',
    '    - id: live-driver',
    `      name: ${yaml(driverPath)}`,
    '      config:',
    `        port: ${driverPort}`,
    `        cwd: ${yaml(root)}`,
  ]
  writeFileSync(join(profile, 'cordis.patch.yml'), `${lines.join('\n')}\n`)

  const logPath = join(root, 'dsh.log')
  const logFd = (await import('node:fs')).openSync(logPath, 'w')
  const child = spawn(
    process.execPath,
    ['--expose-internals', join(installDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'],
    { cwd: installDir, env: { ...process.env, DSH_HOME: dshHome, HOME: home }, stdio: ['ignore', logFd, logFd] },
  )
  const driver = `http://127.0.0.1:${driverPort}`
  await waitFor('the dsh driver to answer', async () => {
    if (child.exitCode !== null) throw new Error(`dsh exited early (code ${child.exitCode}); see ${logPath}`)
    try {
      return (await fetch(`${driver}/health`)).ok
    } catch {
      return false
    }
  }, 120000)

  const readLog = () => readFileSync(logPath, 'utf8').replace(/token=[A-Za-z0-9_-]+/g, 'token=***')
  return {
    root,
    readLog,
    createAgent: (id) => json(`${driver}/agents`, { method: 'POST', body: JSON.stringify({ id }) }),
    disposeAgent: (id) => json(`${driver}/agents/${id}`, { method: 'DELETE' }),
    call: (agent, name, args = {}) => json(`${driver}/call`, { method: 'POST', body: JSON.stringify({ agent, name, arguments: args }) }),
    async stop() {
      if (showLog) console.log(`--- ${label} dsh log ---\n${readLog()}`)
      child.kill('SIGTERM')
      await waitFor('dsh to exit', () => child.exitCode !== null || child.signalCode !== null, 30000).catch(() => child.kill('SIGKILL'))
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
}

const lastCount = (log) => {
  const matches = [...log.matchAll(/contexts=(\d+)/g)]
  return matches.length === 0 ? 0 : Number(matches.at(-1)[1])
}
const noUndefined = (result) => !JSON.stringify(result).includes('undefined')

// ---------------------------------------------------------------- remote run
const baseline = await pressure()
const baselineSessions = new Set(await sessionIds())
console.log(`browserless baseline: running=${baseline.running} of ${baseline.maxConcurrent}, sessions=${baselineSessions.size}`)

let remote
try {
  remote = await boot('remote', { connectUrl: browserless.replace(/^http/, 'ws') + '/chromium/playwright' })

  // 1. module identity
  {
    // The patcher resolves the controller from its own location; the original
    // plugin's row is resolved by dsh from the install root.
    const fromPlugin = createRequire(join(installDir, 'node_modules', 'dsh-browser', 'package.json'))
    const fromRoot = createRequire(join(installDir, 'package.json'))
    const fromPatcher = realpathSync(fromPlugin.resolve('dsh-playwright-browser/controller'))
    const originalPackage = dirname(realpathSync(fromRoot.resolve('dsh-playwright-browser/package.json')))
    const fromOriginalIndex = realpathSync(join(originalPackage, 'lib', 'browser-controller.js'))
    record('module identity: patcher and original plugin resolve one controller file', fromPatcher === fromOriginalIndex, fromPatcher)
  }

  // 2. isolation on one connection
  await remote.createAgent('sess-a')
  await remote.createAgent('sess-b')
  const openA = await remote.call('sess-a', 'browser_open', { url: 'https://example.com' })
  const openB = await remote.call('sess-b', 'browser_open', { url: 'about:blank' })
  const tabsA = await remote.call('sess-a', 'browser_tabs', { action: 'list' })
  const tabsB = await remote.call('sess-b', 'browser_tabs', { action: 'list' })
  const urlsA = (tabsA.value ?? []).map((tab) => tab.url)
  const urlsB = (tabsB.value ?? []).map((tab) => tab.url)
  record('isolation: session A sees only its own tab', urlsA.length === 1 && urlsA[0].startsWith('https://example.com'), JSON.stringify(urlsA))
  record('isolation: session B does not see A\'s tab', urlsB.length === 1 && urlsB[0] === 'about:blank', JSON.stringify(urlsB))
  const afterOpen = await pressure()
  const newSessions = (await sessionIds()).filter((id) => !baselineSessions.has(id))
  record('one Browserless slot for two sessions', afterOpen.running - baseline.running === 1 && newSessions.length === 1, `running ${baseline.running} -> ${afterOpen.running}, new server sessions=${newSessions.length}`)
  record('two contexts open', lastCount(remote.readLog()) === 2, `contexts=${lastCount(remote.readLog())}`)
  record('healthy results carry no connection notice and no undefined', ![openA, openB, tabsA, tabsB].some((r) => r.text.includes('dsh-browser:')) && [openA, openB, tabsA, tabsB].every(noUndefined) && [openA, openB, tabsA, tabsB].every((r) => r.isError === false))

  // 3. reconnect after the server drops the connection
  if (newSessions.length === 1) {
    await json(`${browserless}/kill/${newSessions[0]}`)
    await waitFor('browserless to drop the connection', async () => (await pressure()).running === baseline.running)
    const afterKillA = await remote.call('sess-a', 'browser_tabs', { action: 'list' })
    const reopenA = await remote.call('sess-a', 'browser_open', { url: 'https://example.com' })
    const afterKillB = await remote.call('sess-b', 'browser_tabs', { action: 'list' })
    const reconnected = await pressure()
    record('reconnect: next call after the kill succeeds on a fresh context', afterKillA.isError === false && (afterKillA.value ?? []).length === 0 && reopenA.isError === false)
    record('reconnect: result tells the model the connection was re-established', afterKillA.text.includes('dsh-browser:') && afterKillA.text.includes('re-established'))
    record('reconnect: both sessions recover on one new connection', afterKillB.isError === false && reconnected.running - baseline.running === 1, `running=${reconnected.running}`)
    record('reconnect: the drop was noticed', /was closed by the browser/.test(remote.readLog()))
  } else {
    record('reconnect: could not isolate this run\'s Browserless session; kill skipped', false, `new sessions=${newSessions.length}`)
  }

  // 4. session end
  await remote.disposeAgent('sess-a')
  await waitFor('session A context to close', () => lastCount(remote.readLog()) === 1)
  record('session end: disposing A closes its context', lastCount(remote.readLog()) === 1, `contexts=${lastCount(remote.readLog())}`)
  const stillOpen = await pressure()
  await remote.disposeAgent('sess-b')
  await waitFor('Browserless to release the connection', async () => (await pressure()).running === baseline.running)
  record('session end: last session releases the Browserless slot', stillOpen.running - baseline.running === 1 && (await pressure()).running === baseline.running, `running ${stillOpen.running} -> ${(await pressure()).running}`)
} catch (error) {
  record('remote run completed', false, error instanceof Error ? error.message : String(error))
  if (remote) console.log(remote.readLog().split('\n').slice(-20).join('\n'))
} finally {
  await remote?.stop()
}

// ---------------------------------------------------------------- fallback run
let fallback
try {
  fallback = await boot('fallback', {
    connectUrl: 'ws://127.0.0.1:1/chromium/playwright',
    connectTimeoutMs: 3000,
    ...(fallbackChrome === undefined ? {} : { fallbackExecutablePath: fallbackChrome }),
  })
  await fallback.createAgent('sess-f')
  const first = await fallback.call('sess-f', 'browser_open', { url: 'about:blank' })
  const second = await fallback.call('sess-f', 'browser_tabs', { action: 'list' })
  record('fallback: unreachable Browserless still yields a working browser', first.isError === false && second.isError === false, first.isError ? first.text.slice(0, 160) : '')
  record('fallback: the result says it is a LOCAL fallback', /LOCAL fallback/.test(first.text) && /unreachable/.test(first.text))
  record('fallback: every later result says so too', /LOCAL fallback/.test(second.text))
  record('fallback: the Browserless endpoint is shown without credentials', !/token=|:\/\/[^/]*@/.test(first.text))
  await fallback.disposeAgent('sess-f')
  await waitFor('fallback context to close', () => /closed context for session sess-f \(contexts=0\)/.test(fallback.readLog()))
  record('fallback: session end closes the local context', true, 'contexts=0')
} catch (error) {
  record('fallback run completed', false, error instanceof Error ? error.message : String(error))
  if (fallback) console.log(fallback.readLog().split('\n').slice(-20).join('\n'))
} finally {
  await fallback?.stop()
}

const final = await pressure()
record('cleanup: Browserless is back to its baseline', final.running === baseline.running, `running=${final.running}`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
