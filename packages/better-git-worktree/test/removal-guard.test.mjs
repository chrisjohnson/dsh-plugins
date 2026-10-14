// The host is the last guard before `rm -rf`: whatever the browser showed, a
// remove request is judged against a forced server-side read of the copy.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { commitFile, git, makeRepo, quietLog, tempDir } from './helpers.mjs'
import { REGISTRY_FILE, WorktreeRegistry } from '../src/registry.mjs'
import { createService } from '../src/service.mjs'

async function setup() {
  const { dir, cleanup } = tempDir('bgw-guard-')
  const { repo } = makeRepo(dir)
  const registry = new WorktreeRegistry(join(dir, 'state', REGISTRY_FILE))
  const agents = new Map([['session-blank', { id: 'session-blank', session: { id: 'session-blank', header: { cwd: repo } } }]])
  const removed = []
  const service = createService({
    registry,
    log: quietLog().log,
    home: join(dir, 'home'),
    getAgent: (id) => agents.get(id),
    workspaceRegistry: () => ({ resolveByPath: async (path) => ({ id: 'ws', path }), delete: async (id) => removed.push(id) }),
    createSession: async () => ({ sessionId: 'session-continued', carried: true }),
    overrides: { gitFetch: async () => ({ ok: false }) },
  })
  const prepared = await service.handleRpc('prepare', { sourceSessionId: 'session-blank', targetSessionId: 'session-wt' })
  assert.equal(prepared.ok, true)
  const record = registry.get('session-wt')
  return { dir, repo, registry, service, record, copy: record.managedRoot, removed, cleanup }
}

const remove = (t, payload) => t.service.handleRpc('remove', { sessionId: 'session-wt', ...payload })

test('a clean copy is removed without any confirmation', async () => {
  const t = await setup()
  try {
    const result = await remove(t, {})
    assert.equal(result.ok, true)
    assert.equal(existsSync(t.copy), false)
  } finally {
    t.cleanup()
  }
})

test('a direct request cannot remove a dirty copy', async () => {
  const t = await setup()
  try {
    writeFileSync(join(t.copy, 'precious.txt'), 'x\n')
    const result = await remove(t, {})
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'unsaved-work')
    assert.deepEqual([result.error.details.plan.dirty, result.error.details.plan.unpushed], [1, 0])
    assert.equal(existsSync(join(t.copy, 'precious.txt')), true)
    assert.notEqual(t.registry.get('session-wt'), undefined)
    // A malformed or empty confirmation is no confirmation.
    for (const confirmedPlan of [undefined, null, 'yes', {}, { dirty: 0, unpushed: 0, stashes: 0 }]) {
      assert.equal((await remove(t, { confirmedPlan })).error.code, 'unsaved-work')
    }
    assert.equal(existsSync(t.copy), true)
  } finally {
    t.cleanup()
  }
})

test('a confirmation that matches the fresh server-side plan removes the dirty copy ("Remove anyway")', async () => {
  const t = await setup()
  try {
    writeFileSync(join(t.copy, 'precious.txt'), 'x\n')
    commitFile(t.copy, 'work.txt', 'w\n', 'local work')
    writeFileSync(join(t.copy, 'more.txt'), 'x\n')
    const result = await remove(t, { confirmedPlan: { dirty: 2, unpushed: 1, stashes: 0 } })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(existsSync(t.copy), false)
    assert.deepEqual(t.removed, ['ws'])
  } finally {
    t.cleanup()
  }
})

test('a confirmation for less than is now at risk is refused: the work got worse after the dialog', async () => {
  const t = await setup()
  try {
    writeFileSync(join(t.copy, 'one.txt'), 'x\n')
    // The dialog showed one dirty path and the user confirmed it; then more work arrived.
    const shown = { dirty: 1, unpushed: 0, stashes: 0 }
    writeFileSync(join(t.copy, 'two.txt'), 'x\n')
    commitFile(t.copy, 'three.txt', 'x\n', 'late commit')
    const result = await remove(t, { confirmedPlan: shown })
    assert.equal(result.error.code, 'unsaved-work')
    assert.equal(existsSync(join(t.copy, 'two.txt')), true)
    // The host read the present: the cached status from before the change was not used.
    assert.equal(result.error.details.plan.unpushed, 1)
  } finally {
    t.cleanup()
  }
})

test('a stash is at risk too, and must be confirmed', async () => {
  const t = await setup()
  try {
    writeFileSync(join(t.copy, 'tracked.txt'), 'stash me\n')
    git(t.copy, 'stash', 'push', '-q')
    assert.equal((await remove(t, {})).error.code, 'unsaved-work')
    assert.equal((await remove(t, { confirmedPlan: { dirty: 0, unpushed: 0, stashes: 1 } })).ok, true)
  } finally {
    t.cleanup()
  }
})

test('a copy that cannot be verified is never removed, confirmed or not', async () => {
  const t = await setup()
  try {
    writeFileSync(join(t.copy, 'precious.txt'), 'x\n')
    rmSync(join(t.copy, '.git'), { recursive: true, force: true })
    for (const confirmedPlan of [undefined, { dirty: 0, unpushed: 0, stashes: 0 }, { dirty: 1, unpushed: 0, stashes: 0 }]) {
      const result = await remove(t, { confirmedPlan })
      assert.equal(result.error.code, 'unverified')
      assert.match(result.error.message, /could not verify/)
    }
    assert.equal(existsSync(join(t.copy, 'precious.txt')), true, 'the user files survive')
  } finally {
    t.cleanup()
  }
})

test('a converted copy can be removed by either session; the record is keyed by the source', async () => {
  const t = await setup()
  try {
    // Re-key the record the way a conversion does: keyed by the source, pointing at the continuation.
    t.registry.remove('session-wt')
    t.registry.put({ ...t.record, sessionId: 'session-src', targetSessionId: 'session-new', origin: 'converted' })
    const viaTarget = await t.service.handleRpc('remove', { sessionId: 'session-new' })
    assert.equal(viaTarget.ok, true, JSON.stringify(viaTarget))
    assert.equal(existsSync(t.copy), false)
    assert.equal(t.registry.get('session-src'), undefined, 'the record under the source key is gone')
  } finally {
    t.cleanup()
  }
})

test('removal by the source key works as before', async () => {
  const t = await setup()
  try {
    t.registry.remove('session-wt')
    t.registry.put({ ...t.record, sessionId: 'session-src', targetSessionId: 'session-new' })
    assert.equal((await t.service.handleRpc('remove', { sessionId: 'session-src' })).ok, true)
    assert.equal((await t.service.handleRpc('remove', { sessionId: 'session-nobody' })).error.code, 'not-a-worktree-session')
  } finally {
    t.cleanup()
  }
})

test('a copy whose directory is already gone is just forgotten, with no guard in the way', async () => {
  const t = await setup()
  try {
    rmSync(t.copy, { recursive: true, force: true })
    const result = await remove(t, {})
    assert.equal(result.ok, true)
    assert.equal(result.value.removed, false)
    assert.equal(t.registry.get('session-wt'), undefined)
  } finally {
    t.cleanup()
  }
})

test('the snapshot reports the ignored-file summary and in-progress operations in the plan', async () => {
  const t = await setup()
  try {
    writeFileSync(join(t.copy, '.git', 'info', 'exclude'), '.env\n')
    writeFileSync(join(t.copy, '.env'), 'S=1\n')
    mkdirSync(join(t.copy, '.git', 'rebase-apply'))
    const snapshot = await t.service.handleRpc('snapshot', { force: true })
    const plan = snapshot.value.worktrees[0].archive
    assert.deepEqual(plan.ignored, { count: 1, examples: ['.env'] })
    assert.deepEqual(plan.operations, ['a rebase or patch application is in progress'])
  } finally {
    t.cleanup()
  }
})
