// Real git, real temp repositories: the creation, change-move, status and review
// logic shells out to git, so these tests do too.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { commitFile, git, makeRepo, tempDir } from './helpers.mjs'
import {
  branchReview,
  createWorktree,
  ensureWorktreesIgnored,
  managedRootBase,
  moveWorkingTreeChanges,
  worktreeExists,
  worktreesIgnored,
} from '../src/working-copy.mjs'
import { baseRefFor, defaultBranch, readWorktreeStatus } from '../src/repository.mjs'
import { archivePlan } from '../src/status.mjs'

test('createWorktree makes a self-contained copy that reads the source objects through an alternate', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const { repo, origin } = makeRepo(dir, { remote: true })
    const head = git(repo, 'rev-parse', 'HEAD')
    const created = await createWorktree({ repoRoot: repo, home: dir })
    assert.equal(created.repoRoot, repo)
    assert.equal(created.managedRoot.startsWith(join(repo, '.dsh-worktrees') + '/'), true)
    assert.match(created.petName, /^[a-z]+-[a-z]+(-\d+)?$/)
    assert.equal(created.branch, `dsh/${created.petName}`)
    assert.equal(created.baseOid, head)

    const copy = created.managedRoot
    assert.equal(git(copy, 'rev-parse', '--abbrev-ref', 'HEAD'), created.branch)
    assert.equal(git(copy, 'rev-parse', 'HEAD'), head)
    assert.equal(readFileSync(join(copy, 'tracked.txt'), 'utf8'), 'one\n')
    assert.equal(git(copy, 'status', '--porcelain'), '')
    assert.equal(readFileSync(join(copy, '.git', 'objects', 'info', 'alternates'), 'utf8'), `${join(repo, '.git', 'objects')}\n`)
    assert.equal(git(copy, 'remote', 'get-url', 'origin'), origin)
    // Self-contained: it owns its git directory, so it is not a linked worktree of the source.
    assert.equal(git(copy, 'rev-parse', '--absolute-git-dir'), join(copy, '.git'))
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1)
    // Everything git writes lands inside the copy.
    writeFileSync(join(copy, 'new.txt'), 'x\n')
    git(copy, 'add', 'new.txt')
    git(copy, 'commit', '-q', '-m', 'inside the copy')
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'the source checkout is untouched')
    assert.equal(worktreeExists({ managedRoot: copy }), true)
  } finally {
    cleanup()
  }
})

test('creating a copy keeps it out of the checkout\'s git status, via the local exclude file only', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const { repo } = makeRepo(dir)
    assert.equal(worktreesIgnored(repo), false)
    await createWorktree({ repoRoot: repo, home: dir })
    assert.equal(worktreesIgnored(repo), true)
    assert.equal(git(repo, 'status', '--porcelain'), '')
    assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.dsh-worktrees\/$/m)
    assert.equal(ensureWorktreesIgnored(repo), false, 'idempotent')
  } finally {
    cleanup()
  }
})

test('two copies from one checkout get different names and directories', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const { repo } = makeRepo(dir)
    const a = await createWorktree({ repoRoot: repo, home: dir })
    const b = await createWorktree({ repoRoot: repo, home: dir })
    assert.notEqual(a.managedRoot, b.managedRoot)
    assert.notEqual(a.branch, b.branch)
  } finally {
    cleanup()
  }
})

test('a repository with no commit cannot host a copy, and nothing is left behind', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const repo = join(dir, 'empty')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    await assert.rejects(createWorktree({ repoRoot: repo, home: dir }), /no commit yet \(unborn HEAD\)/)
    assert.equal(existsSync(join(repo, '.dsh-worktrees')), false)
  } finally {
    cleanup()
  }
})

test('a checkout that cannot host the nested root falls back to the flat layout under the home directory', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const home = join(dir, 'home')
    mkdirSync(home)
    assert.equal(await managedRootBase(join(dir, 'does', 'not', 'exist', '\0bad'), home), join(home, '.dsh-worktrees'))
    assert.equal(await managedRootBase(dir, home), join(dir, '.dsh-worktrees'))
  } finally {
    cleanup()
  }
})

test('moveWorkingTreeChanges moves modified and untracked work into the copy and keeps a backup stash', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const { repo } = makeRepo(dir)
    const created = await createWorktree({ repoRoot: repo, home: dir })
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n')
    writeFileSync(join(repo, 'untracked.txt'), 'fresh\n')
    const moved = await moveWorkingTreeChanges(repo, created.managedRoot, 'label')
    assert.equal(moved.moved, true)
    assert.equal(moved.files, 2)
    assert.match(moved.stashRef, /^[0-9a-f]{40}$/)
    assert.equal(moved.stashEntry, 'stash@{0}')
    assert.equal(readFileSync(join(created.managedRoot, 'tracked.txt'), 'utf8'), 'changed\n')
    assert.equal(readFileSync(join(created.managedRoot, 'untracked.txt'), 'utf8'), 'fresh\n')
    assert.equal(git(repo, 'status', '--porcelain'), '', 'the source checkout is clean again')
    assert.match(git(repo, 'stash', 'list'), /label/, 'the backup stash is kept')
  } finally {
    cleanup()
  }
})

test('moveWorkingTreeChanges with nothing uncommitted moves nothing', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const { repo } = makeRepo(dir)
    const created = await createWorktree({ repoRoot: repo, home: dir })
    assert.deepEqual(await moveWorkingTreeChanges(repo, created.managedRoot, 'label'), { moved: false, stashRef: undefined, files: 0 })
    assert.equal(git(repo, 'stash', 'list'), '')
  } finally {
    cleanup()
  }
})

test('status folds git into the shared vocabulary: progressing, behind, up to date, in sync, with the rebase overlay', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const { repo, origin } = makeRepo(dir, { remote: true })
    const created = await createWorktree({ repoRoot: repo, home: dir })
    const copy = created.managedRoot
    // A new copy has only its own branch: origin's refs arrive with its first fetch
    // (the header menu's git fetch, or the agent's), as they always have.
    git(copy, 'fetch', '-q', 'origin')
    const options = { baseBranch: await defaultBranch(repo) }
    assert.equal(options.baseBranch, 'main')
    assert.equal(await baseRefFor(copy, 'main'), 'origin/main')

    // The branch has no upstream yet and is level with main.
    let status = await readWorktreeStatus(copy, options)
    assert.equal(status.state, 'progressing')
    assert.equal(status.branch, created.branch)
    assert.equal(status.dirty, 0)

    // Dirty tree is counted.
    writeFileSync(join(copy, 'tracked.txt'), 'edited\n')
    writeFileSync(join(copy, 'other.txt'), 'x\n')
    status = await readWorktreeStatus(copy, options)
    assert.deepEqual([status.unstaged, status.untracked, status.dirty], [1, 1, 2])
    git(copy, 'add', '-A')
    git(copy, 'commit', '-q', '-m', 'work')
    assert.equal((await readWorktreeStatus(copy, options)).aheadBase, 1)

    // Pushed and in step with its upstream, but not identical to main: up to date.
    git(copy, 'push', '-q', '-u', 'origin', created.branch)
    status = await readWorktreeStatus(copy, options)
    assert.equal(status.state, 'up_to_date')
    assert.equal(status.upstream, `origin/${created.branch}`)
    assert.equal(status.needsRebase, false)

    // main moves on while the branch has its own commit: the rebase overlay.
    commitFile(repo, 'main-only.txt', 'm\n')
    git(repo, 'push', '-q', 'origin', 'main')
    git(copy, 'fetch', '-q', 'origin')
    status = await readWorktreeStatus(copy, options)
    assert.equal(status.state, 'up_to_date')
    assert.equal(status.behindBase, 1)
    assert.equal(status.needsRebase, true)

    // The upstream gets a commit the branch lacks: behind.
    const other = join(dir, 'other-clone')
    git(dir, 'clone', '-q', origin, other)
    git(other, 'checkout', '-q', created.branch)
    commitFile(other, 'upstream.txt', 'u\n')
    git(other, 'push', '-q', 'origin', created.branch)
    git(copy, 'fetch', '-q', 'origin')
    assert.equal((await readWorktreeStatus(copy, options)).state, 'behind')

    // A branch that is the default branch itself, pushed and level: in sync.
    const level = await createWorktree({ repoRoot: repo, home: dir })
    git(level.managedRoot, 'push', '-q', '-u', 'origin', level.branch)
    git(repo, 'pull', '-q', '--ff-only')
    git(level.managedRoot, 'fetch', '-q', 'origin')
    git(level.managedRoot, 'reset', '-q', '--hard', 'origin/main')
    git(level.managedRoot, 'push', '-q', '-f', 'origin', level.branch)
    git(level.managedRoot, 'fetch', '-q', 'origin')
    status = await readWorktreeStatus(level.managedRoot, options)
    assert.equal(status.state, 'in_sync')
  } finally {
    cleanup()
  }
})

test('status of a directory with no commit reports unknown instead of throwing', async () => {
  const { dir, cleanup } = tempDir()
  try {
    git(dir, 'init', '-q', '-b', 'main')
    const status = await readWorktreeStatus(dir, {})
    assert.equal(status.state, 'unknown')
    assert.match(status.error, /unborn HEAD/)
  } finally {
    cleanup()
  }
})

test('branchReview lists the commits and files on the branch against the default branch', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const { repo } = makeRepo(dir, { remote: true })
    const created = await createWorktree({ repoRoot: repo, home: dir })
    const copy = created.managedRoot
    git(copy, 'fetch', '-q', 'origin')
    commitFile(copy, 'feature.txt', 'f\n', 'add feature')
    const status = await readWorktreeStatus(copy, { baseBranch: 'main' })
    const review = await branchReview(copy, status)
    assert.equal(review.baseRef, 'origin/main')
    assert.deepEqual(review.commits.map((c) => c.subject), ['add feature'])
    assert.deepEqual(review.files, [{ status: 'A', path: 'feature.txt' }])
    assert.match(review.diffstat, /feature\.txt/)
    assert.match(review.note, /up to date with origin\/main/)
  } finally {
    cleanup()
  }
})

test('branchReview with no default branch to compare against says so', async () => {
  const review = await branchReview('/nowhere', { baseRef: undefined })
  assert.deepEqual(review.commits, [])
  assert.match(review.note, /nothing to compare against/)
})

test('unpublished commits are counted without origin refs: a fresh copy is clean, a local commit warns, a pushed one does not', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const { repo } = makeRepo(dir, { remote: true })
    const created = await createWorktree({ repoRoot: repo, home: dir })
    const copy = created.managedRoot
    const options = { baseBranch: 'main' }

    // Fresh copy: no remote-tracking refs, no upstream, nothing of its own.
    let status = await readWorktreeStatus(copy, options)
    assert.equal(status.baseRef, undefined)
    assert.equal(status.upstream, undefined)
    assert.equal(status.unpublished, 0)
    assert.equal(archivePlan({ ...status, managedRoot: copy }).unpushed, 0, 'its starting history is not "unpushed"')

    // One local commit plus one dirty file: both are reported.
    commitFile(copy, 'local.txt', 'l\n', 'local work')
    writeFileSync(join(copy, 'tracked.txt'), 'dirty\n')
    status = await readWorktreeStatus(copy, options)
    assert.equal(status.unpublished, 1)
    assert.deepEqual(archivePlan({ ...status, managedRoot: copy }), { prompt: true, dirty: 1, unpushed: 1, stashes: 0, unknown: false, reasons: [], ignored: { count: 0, examples: [] }, operations: [] })

    // Pushed (no upstream configured, then fetched): the remote-tracking ref has it, so no false warning.
    git(copy, 'checkout', '-q', 'tracked.txt')
    git(copy, 'push', '-q', 'origin', `${created.branch}:refs/heads/${created.branch}`)
    git(copy, 'fetch', '-q', 'origin')
    status = await readWorktreeStatus(copy, options)
    assert.equal(status.upstream, undefined)
    assert.equal(status.unpublished, 0)
    assert.equal(archivePlan({ ...status, managedRoot: copy }).unpushed, 0)

    // And with an upstream the ahead count still rules.
    git(copy, 'push', '-q', '-u', 'origin', created.branch)
    commitFile(copy, 'more.txt', 'm\n', 'more')
    status = await readWorktreeStatus(copy, options)
    assert.equal(archivePlan({ ...status, managedRoot: copy }).unpushed, 1)
  } finally {
    cleanup()
  }
})
