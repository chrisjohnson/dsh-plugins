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

test('the plugin registers no tools: role sessions have no board mutation surface', async () => {
  const files = await sources()
  for (const [name, text] of Object.entries(files)) {
    assert.equal(/\.tools\.register\s*\(/.test(text), false, `${name} registers a tool`)
    assert.equal(/registerTool\s*\(/.test(text), false, `${name} registers a tool`)
  }
})

test('every HTTP route is under the authenticated /api fence', async () => {
  const host = (await sources())['host.mjs']
  assert.match(host, /const API_BASE = '\/api\/kanban'/)
  assert.match(host, /connection\.fetch\.register/)
  assert.equal(/webServer\.register/.test(host), false)
})

test('no credentials, provider endpoints or provider wire code', async () => {
  const files = await sources()
  for (const [name, text] of Object.entries(files)) {
    assert.equal(/apiKey\s*[:=]/.test(text), false, `${name} contains an API key field`)
    assert.equal(/baseURL\s*[:=]/.test(text), false, `${name} contains a provider endpoint`)
    assert.equal(/\bfetch\s*\(\s*['"`]https?:/.test(text), false, `${name} performs provider HTTP`)
    assert.equal(/Authorization\s*:/.test(text), false, `${name} writes an auth header`)
  }
})

test('role allow-lists are the documented sets and never name the board', async () => {
  const { DEFAULT_TOOLS } = await import('../src/config.mjs')
  for (const [role, tools] of Object.entries(DEFAULT_TOOLS)) {
    for (const name of tools) {
      assert.equal(/kanban|ticket|board|budget|lease/i.test(name), false, `${role} may call ${name}`)
    }
  }
  assert.ok(DEFAULT_TOOLS.implementer.includes('edit'))
  assert.equal(DEFAULT_TOOLS.reviewer.includes('bash'), false)
  assert.equal(DEFAULT_TOOLS.griller.includes('write'), false)
  assert.deepEqual(DEFAULT_TOOLS.orchestrator, [])
})
