// The service against a real temp repository and a registry file in the v1 shape,
// with fake agents and a fake session factory standing in for dsh.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { git, makeRepo, quietLog, tempDir } from './helpers.mjs'
import { REGISTRY_FILE, WorktreeRegistry } from '../src/registry.mjs'
import { createService } from '../src/service.mjs'

function setup({ remote = true, registryContent } = {}) {
  const { dir, cleanup } = tempDir('bgw-service-')
  const { repo } = makeRepo(dir, { remote })
  const file = join(dir, 'state', REGISTRY_FILE)
  if (registryContent !== undefined) {
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(file, registryContent)
  }
  const registry = new WorktreeRegistry(file)
  const agents = new Map()
  const addAgent = (id, cwd, extra = {}) => agents.set(id, { id, session: { id, header: { cwd } }, ...extra })
  const created = []
  const workspaces = { resolved: [], deleted: [] }
  const { log, calls } = quietLog()
  const service = createService({
    registry,
    log,
    home: join(dir, 'home'),
    getAgent: (id) => agents.get(id),
    workspaceRegistry: () => ({
      resolveByPath: async (path) => {
        workspaces.resolved.push(path)
        return { id: 'workspace-1', path }
      },
      delete: async (id) => workspaces.deleted.push(id),
    }),
    createSession: async (source, record) => {
      created.push({ source: source.id, cwd: record.managedRoot })
      return { sessionId: 'session-continued', carried: true }
    },
    overrides: { gitFetch: async () => ({ ok: false }), findOpener: () => ({ command: 'xdg-open', args: [] }) },
  })
  return { dir, repo, file, registry, agents, addAgent, created, workspaces, calls, service, cleanup }
}

const rpc = (service, endpoint, payload) => service.handleRpc(endpoint, payload)

test('prepare creates the copy for the source session\'s repository and registers it under the target session', async () => {
  const t = setup()
  try {
    t.addAgent('session-blank', t.repo)
    const result = await rpc(t.service, 'prepare', { sourceSessionId: 'session-blank', targetSessionId: 'session-target' })
    assert.equal(result.ok, true)
    assert.equal(result.value.reused, false)
    const record = t.registry.get('session-target')
    assert.equal(record.origin, 'pre-session')
    assert.equal(record.sourceSessionId, 'session-blank')
    assert.equal(record.repoRoot, t.repo)
    assert.equal(record.baseBranch, 'main')
    assert.equal(record.baseRef, 'origin/main')
    assert.equal(record.activated, false)
    assert.equal(existsSync(record.managedRoot), true)
    assert.equal(result.value.worktree.managedRoot, record.managedRoot)
    assert.equal(result.value.worktree.decoration.state, 'progressing')
    assert.equal(result.value.worktree.archive.prompt, true)
    // The record is on disk in the v1 shape.
    const onDisk = JSON.parse(readFileSync(t.file, 'utf8'))
    assert.equal(onDisk.version, 1)
    assert.equal(onDisk.worktrees['session-target'].managedRoot, record.managedRoot)

    const again = await rpc(t.service, 'prepare', { sourceSessionId: 'session-blank', targetSessionId: 'session-target' })
    assert.equal(again.value.reused, true)
    assert.equal(t.registry.list().length, 1)
  } finally {
    t.cleanup()
  }
})

test('prepare refuses bad requests, a session that is already a worktree session, and a non-repository', async () => {
  const t = setup()
  try {
    assert.equal((await rpc(t.service, 'prepare', { sourceSessionId: 'x' })).error.code, 'bad-request')
    t.addAgent('session-blank', t.repo)
    await rpc(t.service, 'prepare', { sourceSessionId: 'session-blank', targetSessionId: 'session-target' })
    t.addAgent('session-target', t.registry.get('session-target').managedRoot)
    const nested = await rpc(t.service, 'prepare', { sourceSessionId: 'session-target', targetSessionId: 'session-other' })
    assert.equal(nested.error.code, 'already-a-worktree-session')

    const outside = join(t.dir, 'plain')
    mkdirSync(outside)
    t.addAgent('session-plain', outside)
    await assert.rejects(rpc(t.service, 'prepare', { sourceSessionId: 'session-plain', targetSessionId: 'session-p2' }), /is not inside a git repository/)
    t.addAgent('session-nocwd', '')
    await assert.rejects(rpc(t.service, 'prepare', { sourceSessionId: 'session-nocwd', targetSessionId: 'session-p3' }), /has no working directory/)
    assert.equal(t.registry.list().length, 1)
  } finally {
    t.cleanup()
  }
})

test('convert moves uncommitted work into a new copy and continues the conversation in a new session', async () => {
  const t = setup()
  try {
    t.addAgent('session-live', t.repo)
    writeFileSync(join(t.repo, 'tracked.txt'), 'in progress\n')
    const result = await rpc(t.service, 'convert', { sessionId: 'session-live' })
    assert.equal(result.ok, true)
    assert.equal(result.value.targetSessionId, 'session-continued')
    assert.equal(result.value.conversationCarried, true)
    assert.equal(result.value.moved.moved, true)
    assert.deepEqual(t.created, [{ source: 'session-live', cwd: t.registry.get('session-live').managedRoot }])
    const record = t.registry.get('session-live')
    assert.equal(record.origin, 'converted')
    assert.equal(record.targetSessionId, 'session-continued')
    assert.equal(record.activated, false, 'the client opens the continuation and then marks it active')
    assert.equal(record.stashEntry, 'stash@{0}')
    assert.equal(readFileSync(join(record.managedRoot, 'tracked.txt'), 'utf8'), 'in progress\n')
    // A session already in a copy cannot be converted again.
    await assert.rejects(rpc(t.service, 'convert', { sessionId: 'session-live' }), /already a worktree session/)
    assert.equal((await rpc(t.service, 'activate', { sessionId: 'session-live' })).ok, true)
    assert.equal(t.registry.get('session-live').activated, true)
  } finally {
    t.cleanup()
  }
})

test('convert with moveChanges:false leaves the uncommitted work where it is', async () => {
  const t = setup()
  try {
    t.addAgent('session-live', t.repo)
    writeFileSync(join(t.repo, 'tracked.txt'), 'stay\n')
    const result = await rpc(t.service, 'convert', { sessionId: 'session-live', moveChanges: false })
    assert.equal(result.value.moved.moved, false)
    assert.equal(readFileSync(join(t.repo, 'tracked.txt'), 'utf8'), 'stay\n')
  } finally {
    t.cleanup()
  }
})

test('when the session handoff fails the copy and the moved work stay and the failure is reported', async () => {
  const t = setup()
  try {
    const { dir, repo } = t
    t.addAgent('session-live', repo)
    const failing = createService({
      registry: t.registry,
      log: quietLog().log,
      home: join(dir, 'home'),
      getAgent: (id) => t.agents.get(id),
      createSession: async () => {
        throw new Error('ctx.agentLoop is unavailable')
      },
      overrides: { gitFetch: async () => ({ ok: false }) },
    })
    const result = await failing.handleRpc('convert', { sessionId: 'session-live' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'session-handoff-failed')
    assert.match(result.error.message, /agentLoop is unavailable/)
    assert.equal(existsSync(result.error.details.managedRoot), true)
    assert.equal(t.registry.get('session-live').targetSessionId, undefined)
  } finally {
    t.cleanup()
  }
})

test('convert of a session that is not live is refused', async () => {
  const t = setup()
  try {
    await assert.rejects(rpc(t.service, 'convert', { sessionId: 'session-ghost' }), /is not live/)
  } finally {
    t.cleanup()
  }
})

test('snapshot reports every recorded copy with its decoration, archive plan and what this host can do', async () => {
  const t = setup()
  try {
    t.addAgent('session-blank', t.repo)
    await rpc(t.service, 'prepare', { sourceSessionId: 'session-blank', targetSessionId: 'session-target' })
    const snapshot = await rpc(t.service, 'snapshot', {})
    assert.equal(snapshot.ok, true)
    const [entry] = snapshot.value.worktrees
    assert.equal(entry.sessionId, 'session-target')
    assert.equal(entry.nested, true)
    assert.equal(entry.ignored, true)
    assert.equal(entry.decoration.label, 'Progressing')
    assert.match(entry.decoration.tooltip, /Worktree .* · branch dsh\//)
    assert.deepEqual(entry.archive, { prompt: true, dirty: 0, unpushed: 0 })
    assert.deepEqual(snapshot.value.capabilities, { folderOpener: 'xdg-open' })
    assert.deepEqual(snapshot.value.registry, { writable: true, problem: null })
  } finally {
    t.cleanup()
  }
})

test('status works for a plain checkout session too, and is null for an unknown one', async () => {
  const t = setup()
  try {
    t.addAgent('session-plain', t.repo)
    const plain = (await rpc(t.service, 'status', { sessionId: 'session-plain' })).value.status
    assert.equal(plain.path, t.repo)
    assert.equal(plain.branch, 'main')
    assert.equal(plain.archive.prompt, false)
    assert.equal(plain.decoration.name, 'main')
    assert.equal((await rpc(t.service, 'status', { sessionId: 'nobody' })).value.status, null)
    assert.equal((await rpc(t.service, 'status', {})).error.code, 'bad-request')
  } finally {
    t.cleanup()
  }
})

test('a recorded copy whose directory is gone reads Missing and does not ask about removal', async () => {
  const t = setup()
  try {
    t.registry.put({ sessionId: 'session-gone', managedRoot: join(t.dir, 'vanished'), repoRoot: t.repo, petName: 'gone' })
    const status = (await rpc(t.service, 'status', { sessionId: 'session-gone' })).value.status
    assert.equal(status.missing, true)
    assert.equal(status.decoration.label, 'Missing')
    assert.equal(status.archive.prompt, false)
  } finally {
    t.cleanup()
  }
})

test('remove deletes the copy, drops the record and retires the workspace registration', async () => {
  const t = setup()
  try {
    t.addAgent('session-blank', t.repo)
    await rpc(t.service, 'prepare', { sourceSessionId: 'session-blank', targetSessionId: 'session-target' })
    const { managedRoot } = t.registry.get('session-target')
    const result = await rpc(t.service, 'remove', { sessionId: 'session-target' })
    assert.deepEqual(result.value, { removed: true, managedRoot, workspaceRemoved: true })
    assert.equal(existsSync(managedRoot), false)
    assert.equal(t.registry.get('session-target'), undefined)
    assert.deepEqual(t.workspaces.resolved, [managedRoot], 'the registration was resolved before the directory went')
    assert.deepEqual(t.workspaces.deleted, ['workspace-1'])
    assert.equal(existsSync(t.repo), true)
    assert.equal((await rpc(t.service, 'remove', { sessionId: 'session-target' })).error.code, 'not-a-worktree-session')
  } finally {
    t.cleanup()
  }
})

test('remove of a copy whose directory is already gone just drops the record', async () => {
  const t = setup()
  try {
    t.registry.put({ sessionId: 'session-gone', managedRoot: join(t.dir, 'vanished'), repoRoot: t.repo })
    const result = await rpc(t.service, 'remove', { sessionId: 'session-gone' })
    assert.equal(result.value.removed, false)
    assert.equal(t.registry.get('session-gone'), undefined)
  } finally {
    t.cleanup()
  }
})

test('remove refuses a record that points outside the managed roots and deletes nothing', async () => {
  const t = setup()
  try {
    t.registry.put({ sessionId: 'session-bad', managedRoot: t.repo, repoRoot: t.repo })
    await assert.rejects(rpc(t.service, 'remove', { sessionId: 'session-bad' }), /refusing to remove/)
    assert.equal(existsSync(join(t.repo, 'README.md')), true)
    assert.notEqual(t.registry.get('session-bad'), undefined)
  } finally {
    t.cleanup()
  }
})

test('a registry that could not be read refuses to create a copy it could not record, and the file is untouched', async () => {
  const garbage = '{ not json'
  const t = setup({ registryContent: garbage })
  try {
    t.addAgent('session-blank', t.repo)
    await assert.rejects(
      rpc(t.service, 'prepare', { sourceSessionId: 'session-blank', targetSessionId: 'session-target' }),
      /registry cannot be written .* not creating a working copy/,
    )
    assert.equal(existsSync(join(t.repo, '.dsh-worktrees')), false)
    assert.equal(readFileSync(t.file, 'utf8'), garbage)
    const snapshot = await rpc(t.service, 'snapshot', {})
    assert.equal(snapshot.value.registry.writable, false)
    assert.match(snapshot.value.registry.problem, /not valid JSON/)
  } finally {
    t.cleanup()
  }
})

test('branchReview, workingTree, fetch, ignore, open, forget and unknown endpoints', async () => {
  const t = setup()
  try {
    t.addAgent('session-blank', t.repo)
    await rpc(t.service, 'prepare', { sourceSessionId: 'session-blank', targetSessionId: 'session-target' })
    const review = await rpc(t.service, 'branchReview', { sessionId: 'session-target' })
    assert.equal(review.ok, true)
    assert.ok(review.value.review.note, 'a fresh copy has not fetched yet, so the review explains there is nothing to compare')
    const tree = await rpc(t.service, 'workingTree', { sessionId: 'session-target' })
    assert.equal(tree.value.status.dirty, 0)
    assert.match(tree.value.summary, /Working tree: clean/)
    const fetched = await rpc(t.service, 'fetch', { sessionId: 'session-target' })
    assert.equal(fetched.ok, true)
    assert.equal((await rpc(t.service, 'ignore', { sessionId: 'session-target' })).value.ignored, true)
    assert.equal((await rpc(t.service, 'forget', { sessionId: 'session-target' })).value.removed, true)
    assert.equal((await rpc(t.service, 'forget', { sessionId: 'session-target' })).value.removed, false)
    assert.equal((await rpc(t.service, 'nonsense', {})).error.code, 'unknown-endpoint')
    assert.equal((await rpc(t.service, 'open', { sessionId: 'nobody' })).error.code, 'no-session')
    assert.equal((await rpc(t.service, 'fetch', { sessionId: 'nobody' })).error.code, 'no-repository')
  } finally {
    t.cleanup()
  }
})

test('open hands the checkout to the folder opener and reports its failure', async () => {
  const t = setup()
  try {
    t.addAgent('session-plain', t.repo)
    const opened = []
    const ok = createService({
      registry: t.registry, log: quietLog().log, getAgent: (id) => t.agents.get(id), createSession: async () => ({}),
      overrides: { openFolder: async (path) => opened.push(path) },
    })
    assert.equal((await ok.handleRpc('open', { sessionId: 'session-plain' })).value.opened, t.repo)
    assert.deepEqual(opened, [t.repo])
    const broken = createService({
      registry: t.registry, log: quietLog().log, getAgent: (id) => t.agents.get(id), createSession: async () => ({}),
      overrides: { openFolder: async () => { throw new Error('no folder opener is installed on this host') } },
    })
    assert.equal((await broken.handleRpc('open', { sessionId: 'session-plain' })).error.code, 'no-folder-opener')
  } finally {
    t.cleanup()
  }
})
