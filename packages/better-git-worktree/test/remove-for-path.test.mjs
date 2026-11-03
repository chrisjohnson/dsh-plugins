// removeForPath: a finished workflow removes its own working copy by root, over a
// real repository and a real copy cut by the service itself.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { commitFile, git, makeRepo, quietLog, tempDir } from './helpers.mjs'
import { REGISTRY_FILE, WorktreeRegistry } from '../src/registry.mjs'
import { createService } from '../src/service.mjs'

function setup() {
  const { dir, cleanup } = tempDir('bgw-rfp-')
  const { repo } = makeRepo(dir, { remote: true })
  const registry = new WorktreeRegistry(join(dir, 'state', REGISTRY_FILE))
  const deleted = []
  const { log } = quietLog()
  const service = createService({
    registry,
    log,
    home: join(dir, 'home'),
    getAgent: () => undefined,
    workspaceRegistry: () => ({
      resolveByPath: async (path) => ({ id: 'workspace-1', path }),
      delete: async (id) => deleted.push(id),
    }),
    createSession: async () => ({ sessionId: 'unused', carried: false }),
    overrides: { gitFetch: async () => ({ ok: false }), findOpener: () => undefined },
  })
  return { repo, registry, service, deleted, cleanup }
}

test('removes a clean pending copy found by its root, drops the record and the workspace registration', async () => {
  const t = setup()
  try {
    const created = await t.service.createForPath(t.repo, { title: 'finished' })
    assert.equal(existsSync(created.managedRoot), true)
    assert.deepEqual(await t.service.removeForPath(created.managedRoot), { removed: true, refused: false })
    assert.equal(existsSync(created.managedRoot), false)
    assert.equal(t.registry.findByRoot(created.managedRoot), undefined)
    assert.deepEqual(t.deleted, ['workspace-1'])
    assert.equal(existsSync(join(t.repo, 'README.md')), true, 'the source checkout is untouched')
    const again = await t.service.removeForPath(created.managedRoot)
    assert.equal(again.removed, false)
    assert.equal(again.refused, false)
  } finally {
    t.cleanup()
  }
})

test('refuses a copy with uncommitted work and removes nothing', async () => {
  const t = setup()
  try {
    const created = await t.service.createForPath(t.repo, { title: 'dirty' })
    writeFileSync(join(created.managedRoot, 'scratch.txt'), 'unsaved\n')
    const result = await t.service.removeForPath(created.managedRoot)
    assert.equal(result.removed, false)
    assert.equal(result.refused, true)
    assert.equal(result.code, 'unsaved-work')
    assert.equal(existsSync(join(created.managedRoot, 'scratch.txt')), true)
    assert.ok(t.registry.findByRoot(created.managedRoot))
    assert.deepEqual(t.deleted, [])
  } finally {
    t.cleanup()
  }
})

test('refuses a copy with an unpushed commit', async () => {
  const t = setup()
  try {
    const created = await t.service.createForPath(t.repo, { title: 'ahead' })
    commitFile(created.managedRoot, 'feature.txt', 'work\n')
    const result = await t.service.removeForPath(created.managedRoot)
    assert.equal(result.refused, true)
    assert.equal(result.code, 'unsaved-work')
    assert.equal(existsSync(created.managedRoot), true)
  } finally {
    t.cleanup()
  }
})

test('refuses a copy with a stash entry', async () => {
  const t = setup()
  try {
    const created = await t.service.createForPath(t.repo, { title: 'stashed' })
    writeFileSync(join(created.managedRoot, 'tracked.txt'), 'changed\n')
    git(created.managedRoot, 'stash', 'push', '-q')
    const result = await t.service.removeForPath(created.managedRoot)
    assert.equal(result.refused, true)
    assert.equal(existsSync(created.managedRoot), true)
  } finally {
    t.cleanup()
  }
})

test('refuses a copy whose state cannot be read, and never throws', async () => {
  const t = setup()
  try {
    const created = await t.service.createForPath(t.repo, { title: 'broken' })
    rmSync(join(created.managedRoot, '.git'), { recursive: true, force: true })
    const result = await t.service.removeForPath(created.managedRoot)
    assert.equal(result.removed, false)
    assert.equal(result.refused, true)
    assert.equal(existsSync(created.managedRoot), true)
  } finally {
    t.cleanup()
  }
})

test('ignores a path it does not own, and refuses a record pointing outside the managed roots', async () => {
  const t = setup()
  try {
    assert.equal((await t.service.removeForPath(t.repo)).code, 'not-managed')
    assert.equal((await t.service.removeForPath('')).removed, false)
    t.registry.put({ sessionId: 'bad', repoRoot: t.repo, managedRoot: t.repo, branch: 'x', pending: true })
    const result = await t.service.removeForPath(t.repo)
    assert.equal(result.removed, false)
    assert.equal(result.refused, true)
    assert.match(result.reason, /refusing to remove/)
    assert.equal(existsSync(join(t.repo, 'README.md')), true)
  } finally {
    t.cleanup()
  }
})
