import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

async function sources() {
  const names = (await readdir(SRC)).filter((name) => name.endsWith('.mjs'))
  const out = {}
  for (const name of names) out[name] = await readFile(join(SRC, name), 'utf8')
  return out
}

test('the plugin registers a gate and no tool path of any kind', async () => {
  const files = await sources()
  for (const [name, text] of Object.entries(files)) {
    assert.equal(/tools\.register\s*\(/.test(text), false, `${name} registers a tool`)
    assert.equal(/registerTool\s*\(/.test(text), false, `${name} registers a tool`)
  }
  assert.match(files['host.mjs'], /llm\/stream/)
  // No preflight: a subagent dispatch is not intercepted anywhere, so there is
  // no tool guard and no guard module to install one.
  assert.equal(/tools\.guard\(/.test(files['host.mjs']), false, 'host.mjs installs a tool guard')
  assert.equal('guard.mjs' in files, false, 'a guard module exists')
})

test('routes live under the authenticated /api fence', async () => {
  const host = (await sources())['host.mjs']
  assert.match(host, /const API_BASE = '\/api\/modelCapacity'/)
  assert.match(host, /connection\.fetch\.register/)
  assert.equal(/webServer\.register/.test(host), false)
})

test('the host pushes snapshots over a streaming route and does no idle polling of its own', async () => {
  const host = (await sources())['host.mjs']
  assert.match(host, /STREAM_ENDPOINT/)
  assert.match(host, /feed\.subscribe/)
  // Session metadata is refreshed on demand when a snapshot is read, not on a
  // timer that runs whether or not anyone is looking.
  assert.equal(/setInterval\(\(\) => void this\.refreshSessionMeta/.test(host), false)
  assert.match(host, /#touchMeta/)
})

test('the snapshot carries each provider\'s trailing 60 s of output buckets', async () => {
  const host = (await sources())['host.mjs']
  // The Activity graphs draw one series per provider, so the frame has to ship it:
  // a named 60-second window read on the same clock as the rest of the snapshot
  // and attached to that provider's own rates object.
  assert.match(host, /const HISTORY_SECONDS = 60/)
  assert.match(host, /this\.rates\.providerHistory\(provider\.name, HISTORY_SECONDS, snap\.asOf\)/)
  // A provider with no meter keeps a null rates object rather than an invented one.
  assert.match(host, /rates: rates === null \? null : \{ \.\.\.rates, history60: history60 \?\? \[\] \}/)
  // The all-providers summary the aggregate figures come from is untouched.
  assert.match(host, /rates: this\.rates\.summary\(snap\.asOf\)/)
})

test('no credentials, endpoints or provider wire code', async () => {
  const files = await sources()
  for (const [name, text] of Object.entries(files)) {
    assert.equal(/apiKey\s*[:=]/.test(text), false, `${name} contains an API key field`)
    assert.equal(/baseURL\s*[:=]/.test(text), false, `${name} contains a provider endpoint`)
    assert.equal(/Authorization\s*:/.test(text), false, `${name} writes an auth header`)
  }
})
