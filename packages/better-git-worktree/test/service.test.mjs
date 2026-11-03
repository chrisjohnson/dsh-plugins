// The service against a real temp repository and a registry file in the v1 shape,
// with fake agents and a fake session factory standing in for dsh.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { commitFile, git, makeRepo, quietLog, tempDir } from './helpers.mjs'
import { REGISTRY_FILE, WorktreeRegistry } from '../src/registry.mjs'
import { gitFetch } from '../src/git-runner.mjs'
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
    assert.deepEqual(entry.archive, { prompt: true, dirty: 0, unpushed: 0, stashes: 0, unknown: false, reasons: [], ignored: { count: 0, examples: [] }, operations: [] })
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

// ------------------------------------------------------- KAN-18 the lazy worktree seam
//
// Kanban asks two questions of this plugin when a plan session starts: "cut a
// copy from the current upstream" and "is the copy this ticket already points at
// still just an empty shell of the base it came from?". Both need a repository
// whose origin has moved past it, because that is the only arrangement that can
// tell the fetched upstream apart from wherever the checkout happens to sit.

function lazySetup({ fetchFails = false } = {}) {
  const { dir, cleanup } = tempDir('bgw-lazy-')
  const { repo, origin } = makeRepo(dir, { remote: true })
  const base = git(repo, 'rev-parse', 'HEAD')
  const tip = commitFile(repo, 'upstream.txt', 'newer\n', 'upstream work')
  git(repo, 'push', '-q', 'origin', 'main')
  // Put the checkout back: now origin/main is `tip` and local HEAD is `base`.
  git(repo, 'reset', '-q', '--hard', base)
  mkdirSync(join(dir, 'state'), { recursive: true })
  const registry = new WorktreeRegistry(join(dir, 'state', REGISTRY_FILE))
  const { log, calls } = quietLog()
  const fetches = []
  const service = createService({
    registry,
    log,
    home: join(dir, 'home'),
    getAgent: () => undefined,
    workspaceRegistry: () => undefined,
    createSession: async () => ({}),
    overrides: {
      gitFetch: async (root) => {
        fetches.push(root)
        if (fetchFails) {
          return { ok: false, code: 128, stdout: '', stderr: 'fatal: could not read from remote repository\n', timedOut: false }
        }
        return gitFetch(root)
      },
    },
  })
  /**
   * Move the remote forward without moving this checkout: commit on top of what
   * origin already has, push that, and leave `main` sitting where it was.
   */
  const advance = (file = 'more.txt', text = 'more\n') => {
    git(repo, 'fetch', '-q', 'origin')
    git(repo, 'checkout', '-q', '-B', 'upstream', 'origin/main')
    const oid = commitFile(repo, file, text, `upstream: ${file}`)
    git(repo, 'push', '-q', 'origin', 'upstream:main')
    git(repo, 'checkout', '-q', 'main')
    git(repo, 'branch', '-q', '-D', 'upstream')
    return oid
  }
  return { dir, repo, origin, base, tip, registry, service, calls, fetches, advance, cleanup }
}

test('createForPath with fetchFirst + baseOnRemote cuts the copy at the fetched upstream head', async () => {
  const t = lazySetup()
  try {
    const created = await t.service.createForPath(t.repo, { title: 'lazy', fetchFirst: true, baseOnRemote: true })
    assert.deepEqual(t.fetches, [t.repo], 'the fetch is awaited before the copy is cut')
    assert.equal(created.baseOid, t.tip, 'the base is the remote head, not local HEAD')
    assert.equal(git(created.managedRoot, 'rev-parse', 'HEAD'), t.tip)
    assert.equal(readFileSync(join(created.managedRoot, 'upstream.txt'), 'utf8'), 'newer\n')
    assert.equal(t.registry.findByRoot(created.managedRoot).baseOid, t.tip)
  } finally {
    t.cleanup()
  }
})

test('createForPath without the options keeps the old behavior: local HEAD, no fetch', async () => {
  const t = lazySetup()
  try {
    const created = await t.service.createForPath(t.repo, { title: 'plain' })
    assert.equal(t.fetches.length, 0)
    assert.equal(created.baseOid, t.base)
    assert.equal(existsSync(join(created.managedRoot, 'upstream.txt')), false)
  } finally {
    t.cleanup()
  }
})

test('a failed fetch throws out of createForPath instead of cutting a stale copy', async () => {
  const t = lazySetup({ fetchFails: true })
  try {
    await assert.rejects(
      () => t.service.createForPath(t.repo, { title: 'lazy', fetchFirst: true, baseOnRemote: true }),
      /git fetch failed .*could not read from remote repository/,
    )
    assert.equal(t.registry.list().length, 0, 'nothing was created or recorded')
  } finally {
    t.cleanup()
  }
})

test('baseOnRemote falls back to local HEAD when the remote ref cannot be resolved', async () => {
  const t = lazySetup()
  try {
    // No origin at all: `fetchFirst` has nothing to fetch and skips it, and the
    // copy is based on HEAD because there is no upstream to base it on instead.
    const { repo } = makeRepo(t.dir, { remote: false, name: 'no-origin' })
    const head = git(repo, 'rev-parse', 'HEAD')
    const created = await t.service.createForPath(repo, { title: 'local only', fetchFirst: true, baseOnRemote: true })
    assert.equal(created.baseOid, head)
  } finally {
    t.cleanup()
  }
})

test('refreshManagedCopy says nothing about a path it does not own', async () => {
  const t = lazySetup()
  try {
    assert.deepEqual(await t.service.refreshManagedCopy(t.repo), { managed: false, path: t.repo })
    assert.equal(t.fetches.length, 0, 'an unmanaged path is not fetched for')
  } finally {
    t.cleanup()
  }
})

test('a pristine managed copy is fast-forwarded to the fetched default branch and the record follows', async () => {
  const t = lazySetup()
  try {
    const created = await t.service.createForPath(t.repo, { title: 'pristine' })
    assert.equal(created.baseOid, t.base)
    const newer = t.advance('later.txt', 'later\n')
    const result = await t.service.refreshManagedCopy(created.managedRoot, { fetchFirst: true })
    assert.equal(result.managed, true)
    assert.equal(result.updated, true)
    assert.equal(result.alreadyCurrent, false)
    assert.equal(result.baseOid, newer)
    assert.equal(git(created.managedRoot, 'rev-parse', 'HEAD'), newer, 'the copy moved')
    assert.equal(t.registry.findByRoot(created.managedRoot).baseOid, newer, 'the record moved with it')
    assert.equal(git(t.repo, 'rev-parse', 'HEAD'), t.base, 'the source checkout was never touched')
  } finally {
    t.cleanup()
  }
})

test('refreshing a copy that is already current says so and changes nothing', async () => {
  const t = lazySetup()
  try {
    const created = await t.service.createForPath(t.repo, { title: 'current', fetchFirst: true, baseOnRemote: true })
    const before = git(created.managedRoot, 'rev-parse', 'HEAD')
    const result = await t.service.refreshManagedCopy(created.managedRoot, { fetchFirst: true })
    assert.equal(result.updated, true)
    assert.equal(result.alreadyCurrent, true)
    assert.equal(result.baseOid, before)
    assert.equal(git(created.managedRoot, 'rev-parse', 'HEAD'), before)
  } finally {
    t.cleanup()
  }
})

test('an untracked file is enough to leave a copy alone', async () => {
  const t = lazySetup()
  try {
    const created = await t.service.createForPath(t.repo, { title: 'dirty' })
    t.advance('later.txt', 'later\n')
    writeFileSync(join(created.managedRoot, 'scratch.txt'), 'someone is working here\n')
    const result = await t.service.refreshManagedCopy(created.managedRoot, { fetchFirst: true })
    assert.equal(result.updated, false)
    assert.equal(result.reason, 'dirty')
    assert.equal(result.dirty, 1)
    assert.equal(git(created.managedRoot, 'rev-parse', 'HEAD'), t.base, 'the copy did not move under the work')
    assert.equal(t.registry.findByRoot(created.managedRoot).baseOid, t.base, 'and the record still says where it is')
  } finally {
    t.cleanup()
  }
})

test('a copy with commits of its own is left alone', async () => {
  const t = lazySetup()
  try {
    const created = await t.service.createForPath(t.repo, { title: 'work in progress' })
    t.advance('later.txt', 'later\n')
    writeFileSync(join(created.managedRoot, 'feature.txt'), 'work\n')
    git(created.managedRoot, 'add', 'feature.txt')
    git(created.managedRoot, 'commit', '-q', '-m', 'my own commit')
    const result = await t.service.refreshManagedCopy(created.managedRoot, { fetchFirst: true })
    assert.equal(result.updated, false)
    assert.equal(result.reason, 'has-own-commits')
    assert.equal(result.ownCommits, 1)
    assert.match(git(created.managedRoot, 'log', '-1', '--format=%s'), /my own commit/)
  } finally {
    t.cleanup()
  }
})

test('a copy whose base is not on the default branch cannot be fast-forwarded, and is reported', async () => {
  const t = lazySetup()
  try {
    const created = await t.service.createForPath(t.repo, { title: 'diverged' })
    // Give the remote a history the copy is not standing on: an orphan root.
    git(t.repo, 'checkout', '-q', '--orphan', 'elsewhere')
    const orphan = commitFile(t.repo, 'elsewhere.txt', 'a history of its own\n', 'unrelated')
    git(t.repo, 'push', '-q', '-f', 'origin', 'elsewhere:main')
    git(t.repo, 'checkout', '-q', 'main')
    const result = await t.service.refreshManagedCopy(created.managedRoot, { fetchFirst: true })
    assert.equal(result.updated, false)
    assert.equal(result.reason, 'diverged')
    assert.equal(git(created.managedRoot, 'rev-parse', 'HEAD'), t.base, 'nothing moved')
    assert.notEqual(orphan, t.base)
  } finally {
    t.cleanup()
  }
})

test('a fetch failure inside refreshManagedCopy throws with git reason', async () => {
  const t = lazySetup()
  try {
    const created = await t.service.createForPath(t.repo, { title: 'pristine' })
    const broken = createService({
      registry: t.registry,
      log: quietLog().log,
      home: join(t.dir, 'home'),
      getAgent: () => undefined,
      createSession: async () => ({}),
      overrides: {
        gitFetch: async () => ({ ok: false, code: 128, stdout: '', stderr: 'fatal: unable to access origin: Connection refused\n', timedOut: false }),
      },
    })
    await assert.rejects(
      () => broken.refreshManagedCopy(created.managedRoot, { fetchFirst: true }),
      /git fetch failed .*Connection refused/,
    )
    assert.equal(git(created.managedRoot, 'rev-parse', 'HEAD'), t.base, 'a failed fetch mutates nothing')
  } finally {
    t.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Request budget: what one page costs this host, and when it costs nothing.
// ---------------------------------------------------------------------------

import { readWorktreeStatus } from '../src/repository.mjs'

/** A service whose status reads are counted, over a real repository with two prepared copies. */
async function countedSetup() {
  const { dir, cleanup } = tempDir('bgw-budget-')
  const { repo } = makeRepo(dir, { remote: true })
  const registry = new WorktreeRegistry(join(dir, 'state', REGISTRY_FILE))
  const agents = new Map()
  const reads = []
  const { log } = quietLog()
  const service = createService({
    registry,
    log,
    home: join(dir, 'home'),
    getAgent: (id) => agents.get(id),
    workspaceRegistry: () => ({ resolveByPath: async (path) => ({ id: 'w', path }), delete: async () => {} }),
    createSession: async () => ({ sessionId: 'continued', carried: true }),
    overrides: {
      gitFetch: async () => ({ ok: false }),
      findOpener: () => undefined,
      readWorktreeStatus: (path, options) => {
        reads.push(path)
        return readWorktreeStatus(path, options)
      },
    },
  })
  for (const n of ['a', 'b']) {
    agents.set(`src-${n}`, { id: `src-${n}`, session: { id: `src-${n}`, header: { cwd: repo } } })
    await service.handleRpc('prepare', { sourceSessionId: `src-${n}`, targetSessionId: `wt-${n}` })
  }
  agents.set('plain', { id: 'plain', session: { id: 'plain', header: { cwd: repo } } })
  reads.length = 0
  service.cache.invalidatePrefix('status:')
  return { dir, repo, service, reads, cleanup }
}

test('snapshot answers for the session on screen in the same response, and only when asked', async () => {
  const t = await countedSetup()
  try {
    const plain = await t.service.handleRpc('snapshot', {})
    assert.equal('current' in plain.value, false, 'nothing extra unless asked')
    const asked = await t.service.handleRpc('snapshot', { statusSessionId: 'plain' })
    assert.equal(asked.value.current.path, t.repo)
    assert.equal(asked.value.current.branch, 'main')
    const copy = await t.service.handleRpc('snapshot', { statusSessionId: 'wt-a' })
    assert.equal(copy.value.current.sessionId, 'wt-a')
    assert.deepEqual(copy.value.worktrees.map((w) => w.sessionId), ['wt-a', 'wt-b'], 'registry order is kept')
    const unknown = await t.service.handleRpc('snapshot', { statusSessionId: 'nobody' })
    assert.equal(unknown.value.current, null)
  } finally {
    t.cleanup()
  }
})

test('the combined answer matches what the separate status call returns', async () => {
  const t = await countedSetup()
  try {
    const separate = (await t.service.handleRpc('status', { sessionId: 'plain' })).value.status
    const combined = (await t.service.handleRpc('snapshot', { statusSessionId: 'plain' })).value.current
    assert.deepEqual(combined, separate)
  } finally {
    t.cleanup()
  }
})

test('a poll costs one status read per copy plus one for a plain session on screen; the copy on screen is not read twice', async () => {
  const t = await countedSetup()
  try {
    await t.service.handleRpc('snapshot', { statusSessionId: 'wt-a' })
    assert.equal(t.reads.length, 2, 'two copies, the one on screen included')
    t.reads.length = 0
    t.service.cache.invalidatePrefix('status:')
    await t.service.handleRpc('snapshot', { statusSessionId: 'plain' })
    assert.equal(t.reads.length, 3, 'two copies and the plain checkout')
  } finally {
    t.cleanup()
  }
})

test('two pages polling at once share the reads', async () => {
  const t = await countedSetup()
  try {
    await Promise.all([t.service.handleRpc('snapshot', {}), t.service.handleRpc('snapshot', {}), t.service.handleRpc('snapshot', {})])
    assert.equal(t.reads.length, 2, 'one read per copy however many callers')
  } finally {
    t.cleanup()
  }
})

test('the periodic warm-up does nothing once pages go quiet, and resumes when one asks again', async (ctx) => {
  const t = await countedSetup()
  try {
    // Setup talked to the service; ten quiet minutes later nobody is attached.
    const real = Date.now
    const clock = ctx.mock.method(Date, 'now', () => real() + 10 * 60 * 1000)
    assert.equal(t.service.warmIfWatched(), false)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(t.reads.length, 0, 'no page, no reads')
    // A page asks: it is attached again, and the copies are kept warm for it.
    await t.service.handleRpc('snapshot', {})
    t.reads.length = 0
    t.service.cache.invalidatePrefix('status:')
    assert.equal(t.service.warmIfWatched(), true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(t.reads.length, 2, 'a page is attached: copies are kept warm')
    // And it goes quiet again.
    t.reads.length = 0
    t.service.cache.invalidatePrefix('status:')
    clock.mock.mockImplementation(() => real() + 20 * 60 * 1000)
    assert.equal(t.service.warmIfWatched(), false)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(t.reads.length, 0)
  } finally {
    t.cleanup()
  }
})
