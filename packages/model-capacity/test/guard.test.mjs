import test from 'node:test'
import assert from 'node:assert/strict'

import { checkSubagentCapacity, freeRoutes, intendedRoute } from '../src/guard.mjs'
import { CapacityManager } from '../src/semaphore.mjs'

const catalog = [
  { provider: 'gpu-a', models: [{ id: 'big-moe' }, { id: 'small-moe' }] },
  { provider: 'gpu-b', models: [{ id: 'other-moe' }] },
]

function manager() {
  return new CapacityManager({ defaultLimit: 1, limits: [{ provider: 'gpu-a', maxConcurrent: 1 }, { provider: 'gpu-b', maxConcurrent: 2 }] })
}

function execution(args, overrides = {}) {
  return {
    name: 'subagent',
    callId: 'call-1',
    arguments: args,
    agent: {
      id: 'parent-session',
      options: { provider: 'gpu-a', model: 'big-moe' },
      session: { requestHeader: () => ({ config: { provider: 'gpu-a', model: 'big-moe' } }) },
    },
    ...overrides,
  }
}

test('explicit and inherited routes resolve', () => {
  assert.deepEqual(intendedRoute(execution({ provider: 'gpu-b', model: 'other-moe' })), { provider: 'gpu-b', model: 'other-moe' })
  assert.deepEqual(intendedRoute(execution({})), { provider: 'gpu-a', model: 'big-moe' })
})

test('a full provider returns an actionable error with a free route', async () => {
  const m = manager()
  await m.acquire({ provider: 'gpu-a', sessionId: 'busy' })
  const message = checkSubagentCapacity(execution({}), m, { enabled: true, subagentTools: ['subagent'] }, catalog)
  assert.match(message, /provider "gpu-a" is at its limit/)
  assert.match(message, /Cannot dispatch "subagent" on "big-moe"/)
  assert.match(message, /Free now: gpu-b\/other-moe/)
  assert.match(message, /does not queue/)
})

test('a free provider reserves and lets the call through', () => {
  const m = manager()
  assert.equal(checkSubagentCapacity(execution({ provider: 'gpu-b', model: 'other-moe' }), m, { enabled: true, subagentTools: ['subagent'] }, catalog), undefined)
  assert.equal(m.used('gpu-b'), 1)
  assert.equal(m.snapshot().providers.find((p) => p.name === 'gpu-b').reservations.length, 1)
})

test('tools outside the configured list are not preflighted', async () => {
  const m = manager()
  await m.acquire({ provider: 'gpu-a', sessionId: 'busy' })
  assert.equal(checkSubagentCapacity(execution({}, { name: 'workflow' }), m, { enabled: true, subagentTools: ['subagent'] }, catalog), undefined)
})

test('a disabled plugin never rejects', async () => {
  const m = manager()
  await m.acquire({ provider: 'gpu-a', sessionId: 'busy' })
  assert.equal(checkSubagentCapacity(execution({}), m, { enabled: false, subagentTools: ['subagent'] }, catalog), undefined)
})

test('half-specified routes are left to the tool to reject', () => {
  assert.equal(intendedRoute(execution({ provider: 'gpu-a' })), null)
  assert.equal(checkSubagentCapacity(execution({ provider: 'gpu-a' }), manager(), { enabled: true, subagentTools: ['subagent'] }, catalog), undefined)
})

test('freeRoutes is detached and limits suggestions', async () => {
  const m = manager()
  assert.deepEqual(freeRoutes(m, catalog, 'gpu-a'), ['gpu-b/other-moe'])
  await m.acquire({ provider: 'gpu-a', sessionId: 'busy' })
  assert.deepEqual(freeRoutes(m, catalog, 'gpu-a'), ['gpu-b/other-moe'])
  assert.deepEqual(freeRoutes(m, catalog, 'gpu-b'), [])
})
