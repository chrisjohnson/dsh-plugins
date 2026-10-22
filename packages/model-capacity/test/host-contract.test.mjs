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

test('the plugin registers a gate and a guard, never a model tool', async () => {
  const files = await sources()
  for (const [name, text] of Object.entries(files)) {
    assert.equal(/tools\.register\s*\(/.test(text), false, `${name} registers a tool`)
    assert.equal(/registerTool\s*\(/.test(text), false, `${name} registers a tool`)
  }
  assert.match(files['host.mjs'], /llm\/stream/)
  assert.match(files['host.mjs'], /tools\.guard\(/)
})

test('routes live under the authenticated /api fence', async () => {
  const host = (await sources())['host.mjs']
  assert.match(host, /const API_BASE = '\/api\/modelCapacity'/)
  assert.match(host, /connection\.fetch\.register/)
  assert.equal(/webServer\.register/.test(host), false)
})

test('no credentials, endpoints or provider wire code', async () => {
  const files = await sources()
  for (const [name, text] of Object.entries(files)) {
    assert.equal(/apiKey\s*[:=]/.test(text), false, `${name} contains an API key field`)
    assert.equal(/baseURL\s*[:=]/.test(text), false, `${name} contains a provider endpoint`)
    assert.equal(/Authorization\s*:/.test(text), false, `${name} writes an auth header`)
  }
})
