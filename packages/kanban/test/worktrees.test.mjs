// The ticket working-copy lifecycle: the pure decisions first, then the real
// thing against git on a scratch repository.
//
// The pure half is what the board's other modules ask ("is this path one of
// ours?", "why was this copy left alone?", "is this name free?"). The git half
// is the contract the rest of the plugin relies on and cannot fake: a linked
// worktree in the native pool, cut from the fetched default branch, refreshed
// only when it holds nothing of its own, removed only when it holds nothing at
// all — and a fetch that fails throwing, because a ticket planned against
// yesterday's code is the failure this whole feature exists to prevent.
//
// No dsh imports anywhere in the module under test, so none are needed here.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  allocateName,
  branchFor,
  createWorktree,
  describeWorktree,
  isGitCheckout,
  isPoolPath,
  poolNameOf,
  poolRootFor,
  randomPetName,
  refreshReason,
  refreshWorktree,
  removeWorktree,
  resolveBase,
  resolveRepository,
} from '../src/worktrees.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

/** A repository with one commit on `main`, plus a clone of it that has an origin. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kanban-worktrees-'))
  const seed = join(root, 'seed')
  mkdirSync(seed, { recursive: true })
  git(seed, 'init', '-q', '-b', 'main')
  git(seed, 'config', 'user.email', 'test@example.com')
  git(seed, 'config', 'user.name', 'test')
  writeFileSync(join(seed, 'README.md'), 'seed\n')
  git(seed, 'add', 'README.md')
  git(seed, 'commit', '-q', '-m', 'seed')
  const work = join(root, 'work')
  execFileSync('git', ['clone', '-q', seed, work], { stdio: 'ignore' })
  git(work, 'config', 'user.email', 'test@example.com')
  git(work, 'config', 'user.name', 'test')
  return { root, seed, work, seedHead: git(seed, 'rev-parse', 'HEAD') }
}

let advances = 0
/** One more commit on the seed's main, so a copy can be behind it. */
function advance(seed) {
  advances += 1
  writeFileSync(join(seed, 'more.md'), `more ${advances}\n`)
  git(seed, 'add', 'more.md')
  git(seed, 'commit', '-q', '-m', `more ${advances}`)
  return git(seed, 'rev-parse', 'HEAD')
}

/** Whether a ref resolves — `--quiet` exits 1 for a missing one, so git throws. */
function refExists(cwd, ref) {
  try {
    return git(cwd, 'rev-parse', '--verify', '--quiet', ref) !== ''
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ pure: names

test('a pet name is two lowercase words, and the branch is that name under dsh/', () => {
  assert.match(randomPetName(), /^[a-z]+-[a-z]+$/)
  assert.equal(branchFor('brave-otter'), 'dsh/brave-otter')
})

test('allocateName skips every name that is taken, by directory or by branch', async () => {
  const first = await allocateName({ exists: () => false, hasBranch: () => false })
  assert.match(first, /^[a-z]+-[a-z]+$/)
  let tries = 0
  const picked = await allocateName({
    exists: () => {
      tries += 1
      return tries <= 40 // every random name is taken; the numbered fallback is not
    },
    hasBranch: () => false,
  })
  assert.equal(tries, 41, 'forty random tries, then the first numbered one')
  assert.match(picked, /^[a-z]+-[a-z]+-\d+$/)
  const byBranch = await allocateName({ exists: () => false, hasBranch: (name) => name === first })
  assert.notEqual(byBranch, first, 'a name whose branch exists is not free')
})

// -------------------------------------------------------------- pure: pool paths

test('the pool is .agents/worktrees, two segments under the repository root', () => {
  assert.equal(poolRootFor('/r/repo'), join('/r/repo', '.agents', 'worktrees'))
  assert.equal(isPoolPath('/r/repo/.agents/worktrees/brave-otter'), true)
  assert.equal(isPoolPath('/r/repo/.agents/worktrees/brave-otter/src/x.mjs'), true)
  assert.equal(isPoolPath('/r/repo/.agents/worktrees'), false, 'the pool itself is not a copy')
  assert.equal(isPoolPath('/r/repo/.agents'), false, 'one segment of the pool is not the pool')
  assert.equal(isPoolPath('/r/repo/.agents/worktrees-x/otter'), false)
  assert.equal(isPoolPath('/r/repo/x/.agents/worktrees/otter'), true, 'a nested checkout has a pool of its own')
  assert.equal(isPoolPath('relative/.agents/worktrees/otter'), false)
  assert.equal(isPoolPath(null), false)
})

test('poolNameOf names only a copy sitting directly in a pool', () => {
  assert.equal(poolNameOf('/r/repo/.agents/worktrees/brave-otter'), 'brave-otter')
  assert.equal(poolNameOf('/r/repo/.agents/worktrees/brave-otter/'), 'brave-otter')
  assert.equal(poolNameOf('/r/repo/.agents/worktrees/brave-otter/src'), null, 'a subdirectory is not a copy')
  assert.equal(poolNameOf('/r/repo/.agents/worktrees'), null)
})

// ------------------------------------------------------------- pure: refresh why

test('refreshReason: only a clean copy with nothing of its own may be moved', () => {
  const ok = { exists: true, hasRepository: true, dirty: 0, ownCommits: 0, hasRemoteBase: true }
  assert.equal(refreshReason(ok), null)
  assert.equal(refreshReason({ ...ok, alreadyCurrent: true }), null, 'already current is not a refusal')
  assert.equal(refreshReason({ ...ok, exists: false }), 'missing')
  assert.equal(refreshReason({ ...ok, hasRepository: false }), 'no-repository')
  assert.equal(refreshReason({ ...ok, dirty: 2 }), 'dirty', 'untracked paths count as dirty')
  assert.equal(refreshReason({ ...ok, ownCommits: 1 }), 'has-own-commits')
  assert.equal(refreshReason({ ...ok, hasRemoteBase: false }), 'no-remote-base')
  assert.equal(refreshReason({ ...ok, ffFailed: true }), 'diverged')
  assert.equal(
    refreshReason({ exists: true, hasRepository: true, dirty: 3, ownCommits: 2, hasRemoteBase: false }),
    'dirty',
    'the first thing worth telling the planner wins',
  )
})

// ------------------------------------------------------------------ the real git

test('a copy is a linked worktree in the pool, cut from the fetched default branch', async () => {
  const { seed, work, seedHead } = fixture()
  const created = await createWorktree({ path: work })
  assert.equal(created.repositoryRoot, git(work, 'rev-parse', '--show-toplevel'))
  assert.equal(created.path, join(poolRootFor(work), created.name))
  assert.equal(created.branch, `dsh/${created.name}`)
  assert.equal(created.from, 'main', 'the clone names origin/HEAD')
  assert.equal(created.baseCommit, seedHead)
  assert.ok(existsSync(join(created.path, 'README.md')), 'the files are there')
  assert.equal(git(created.path, 'rev-parse', 'HEAD'), seedHead)
  assert.ok(git(work, 'worktree', 'list').includes(created.path), 'git lists it as a worktree of the checkout')
  assert.equal(git(work, 'status', '--porcelain'), '', 'the pool is ignored, so the source checkout stays clean')
  assert.equal(readFileSync(join(poolRootFor(work), '.gitignore'), 'utf8').trim(), '*')
})

test('a copy cut from a repository with no origin stands on local HEAD and says so', async () => {
  const { seed } = fixture()
  const created = await createWorktree({ path: seed })
  assert.equal(created.from, null, 'nothing upstream to name')
  assert.equal(created.baseCommit, git(seed, 'rev-parse', 'HEAD'))
  assert.ok(existsSync(created.path))
})

test('a dead origin throws out of create, and nothing is left behind', async () => {
  const { work } = fixture()
  git(work, 'remote', 'set-url', 'origin', join(tmpdir(), 'kanban-worktrees-does-not-exist'))
  await assert.rejects(() => createWorktree({ path: work }), /git fetch origin failed/)
  assert.equal(git(work, 'worktree', 'list').split('\n').length, 1, 'only the checkout itself')
})

test('refresh brings a pristine copy to the new default branch and leaves the rest alone', async () => {
  const { seed, work } = fixture()
  const created = await createWorktree({ path: work })
  assert.equal((await refreshWorktree({ path: created.path })).updated, true, 'nothing moved yet')

  const moved = advance(seed)
  const refreshed = await refreshWorktree({ path: created.path })
  assert.equal(refreshed.updated, true, JSON.stringify(refreshed))
  assert.equal(git(created.path, 'rev-parse', 'HEAD'), moved, 'the copy fetched and fast-forwarded')

  // A copy with untracked work is somebody's work: it is reported, not moved.
  writeFileSync(join(created.path, 'scratch.txt'), 'keep me\n')
  const dirty = await refreshWorktree({ path: created.path })
  assert.equal(dirty.updated, false)
  assert.equal(dirty.reason, 'dirty')
  assert.ok(dirty.dirty >= 1)
  rmSync(join(created.path, 'scratch.txt'), { force: true })

  // A copy with commits of its own is never fast-forwarded under its owner.
  writeFileSync(join(created.path, 'work.txt'), 'mine\n')
  git(created.path, 'add', 'work.txt')
  git(created.path, 'commit', '-q', '-m', 'own work')
  advance(seed)
  const own = await refreshWorktree({ path: created.path })
  assert.equal(own.updated, false)
  assert.equal(own.reason, 'has-own-commits')
  assert.equal(own.ownCommits, 1)

  // A path outside the pool is not ours at all: no fetch, no note, no opinion.
  assert.deepEqual(await refreshWorktree({ path: work }), { managed: false, path: work })
  assert.equal((await refreshWorktree({ path: '/r/nope/.agents/worktrees/ghost' })).reason, 'missing')
})

test('remove takes a clean copy and its branch away, and refuses a dirty one', async () => {
  const { work } = fixture()
  const created = await createWorktree({ path: work })
  writeFileSync(join(created.path, 'dirty.txt'), 'unsaved\n')
  const refused = await removeWorktree({ path: created.path })
  assert.equal(refused.refused, true)
  assert.equal(refused.code, 'dirty')
  assert.ok(existsSync(created.path), 'nothing is deleted on a refusal')

  rmSync(join(created.path, 'dirty.txt'), { force: true })
  const gone = await removeWorktree({ path: created.path })
  assert.equal(gone.removed, true, JSON.stringify(gone))
  assert.equal(gone.branchDeleted, true)
  assert.equal(existsSync(created.path), false)
  assert.equal(git(work, 'worktree', 'list').split('\n').length, 1, 'git forgot the copy too')
  assert.equal(refExists(work, `refs/heads/${created.branch}`), false, 'the branch went with it')
  // Idempotent: a second ask says there was nothing to do, and never refuses.
  const again = await removeWorktree({ path: created.path })
  assert.equal(again.removed, false)
  assert.equal(again.refused, false)
  assert.equal(again.code, 'already-gone')
  assert.equal((await removeWorktree({ path: work })).code, 'not-managed')
})

test('describeWorktree answers with exactly the panel record fields', async () => {
  const { work } = fixture()
  const created = await createWorktree({ path: work })
  const described = await describeWorktree(created.path)
  assert.deepEqual(Object.keys(described).sort(), ['baseCommit', 'branch', 'from', 'path', 'repositoryRoot'])
  assert.deepEqual(described, {
    path: created.path,
    branch: created.branch,
    from: created.from,
    baseCommit: created.baseCommit,
    repositoryRoot: created.repositoryRoot,
  })
  assert.equal(await describeWorktree(work), null, 'the checkout itself is not a copy')
  assert.equal(await describeWorktree('/nowhere/.agents/worktrees/ghost'), null)
})

test('isGitCheckout and resolveRepository answer for a checkout and not for a directory', async () => {
  const { work } = fixture()
  mkdirSync(join(work, 'sub'))
  const plain = mkdtempSync(join(tmpdir(), 'kanban-worktrees-plain-'))
  assert.equal(await isGitCheckout(work), true)
  assert.equal(await isGitCheckout(join(work, 'no-such-directory')), false)
  assert.equal(await isGitCheckout(plain), false)
  assert.equal(await isGitCheckout(''), false)
  assert.equal(await resolveRepository(join(work, 'sub')), git(work, 'rev-parse', '--show-toplevel'))
  assert.equal(await resolveRepository(plain), null)
})

test('resolveBase names the default branch, and falls back to HEAD when there is none', async () => {
  const { work, seedHead } = fixture()
  assert.deepEqual(await resolveBase(work), { from: 'main', baseRef: 'origin/main', baseCommit: seedHead, origin: true })
  const { seed } = fixture()
  assert.equal((await resolveBase(seed)).from, null)
})
