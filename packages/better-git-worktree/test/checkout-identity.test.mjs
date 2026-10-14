// A copy must be judged by its own repository. These reproduce the failure where
// git, finding no usable `.git` in the copy, walks up to the enclosing repository
// and describes that instead, so a copy that still holds user files reads clean.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { git, makeRepo, tempDir } from './helpers.mjs'
import { createWorktree } from '../src/working-copy.mjs'
import { TtlCache } from '../src/git-runner.mjs'
import { checkOwnRepository, inProgressOperations, readWorktreeStatus } from '../src/repository.mjs'
import { archivePlan } from '../src/status.mjs'

async function nestedCopy() {
  const t = tempDir('bgw-identity-')
  const { repo } = makeRepo(t.dir, { remote: true })
  const created = await createWorktree({ repoRoot: repo, home: t.dir })
  writeFileSync(join(created.managedRoot, 'precious.txt'), 'user work\n')
  return { ...t, repo, created, copy: created.managedRoot }
}

const planOf = async (copy, options = {}) => {
  const status = await readWorktreeStatus(copy, { baseBranch: 'main', requireOwnRepo: true, ...options })
  return { status, plan: archivePlan({ ...status, managedRoot: copy }) }
}

const BREAKAGES = [
  ['a missing .git', (copy) => rmSync(join(copy, '.git'), { recursive: true, force: true })],
  ['an empty .git directory', (copy) => {
    rmSync(join(copy, '.git'), { recursive: true, force: true })
    mkdirSync(join(copy, '.git'))
  }],
  ['an invalid .git/HEAD', (copy) => writeFileSync(join(copy, '.git', 'HEAD'), 'this is not a ref\n')],
]

for (const [label, breakIt] of BREAKAGES) {
  test(`${label}: the unguarded read describes the SOURCE as clean (the reproduction), the guarded one is unknown`, async () => {
    const t = await nestedCopy()
    try {
      assert.equal((await planOf(t.copy)).plan.unknown, false, 'sound before it is broken')
      breakIt(t.copy)
      // Reproduction: without the identity check git walks up to the source checkout.
      const unguarded = await readWorktreeStatus(t.copy, { baseBranch: 'main' })
      assert.equal(unguarded.branch, 'main', 'git described the source repository')
      assert.equal(unguarded.dirty, 0, 'and saw nothing, because the copy is ignored there')
      assert.deepEqual([unguarded.unpublished, unguarded.stashes], [0, 0], 'every count read zero (only the later ignored-files listing happened to trip over the walk-up)')
      assert.equal(unguarded.unverified.some((reason) => /status|unpublished|stash/.test(reason)), false, 'nothing about the checks that matter was flagged')
      assert.equal(existsSync(join(t.copy, 'precious.txt')), true)

      const { status, plan } = await planOf(t.copy)
      assert.equal(plan.unknown, true)
      assert.match(plan.reasons.join('\n'), /not a git checkout of its own|does not own its git directory|cannot read/)
      assert.equal(status.state, 'unknown')
    } finally {
      t.cleanup()
    }
  })
}

test('a copy under a home directory that is itself a repository is not mistaken for it', async () => {
  const t = tempDir('bgw-identity-home-')
  try {
    const { repo: home } = makeRepo(t.dir, { name: 'home' })
    const copy = join(home, '.dsh-worktrees', 'brave-otter')
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(copy, 'precious.txt'), 'x\n')
    const { plan } = await planOf(copy)
    assert.equal(plan.unknown, true)
    assert.match(plan.reasons.join('\n'), /not a git checkout of its own/)
  } finally {
    t.cleanup()
  }
})

test('checkOwnRepository accepts a sound copy and reports a vanished directory', async () => {
  const t = await nestedCopy()
  try {
    assert.equal(await checkOwnRepository(t.copy), undefined)
    assert.match(await checkOwnRepository(join(t.dir, 'nowhere')), /cannot read/)
  } finally {
    t.cleanup()
  }
})

test('ignored files are summarized (bounded) so deleting .env and build output is not a surprise', async () => {
  const t = await nestedCopy()
  try {
    writeFileSync(join(t.copy, '.git', 'info', 'exclude'), '.env\nnode_modules/\n*.log\n')
    writeFileSync(join(t.copy, '.env'), 'SECRET=1\n')
    mkdirSync(join(t.copy, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(t.copy, 'node_modules', 'pkg', 'index.js'), 'x\n')
    for (let i = 0; i < 8; i += 1) writeFileSync(join(t.copy, `debug-${i}.log`), 'x\n')
    const { plan } = await planOf(t.copy)
    assert.equal(plan.unknown, false)
    assert.equal(plan.ignored.count, 10, 'a fully ignored directory is one entry')
    assert.equal(plan.ignored.examples.length, 5, 'only the first few names are carried')
    assert.ok(plan.ignored.examples.every((name) => typeof name === 'string'))
    assert.ok([...plan.ignored.examples].some((name) => name === '.env' || name === 'node_modules/' || name.endsWith('.log')))
    assert.equal(plan.dirty, 1, 'ignored files do not count as uncommitted paths (precious.txt does)')
  } finally {
    t.cleanup()
  }
})

test('half-done git operations are reported', async () => {
  const t = await nestedCopy()
  try {
    assert.deepEqual(inProgressOperations(t.copy), [])
    writeFileSync(join(t.copy, '.git', 'MERGE_HEAD'), `${git(t.copy, 'rev-parse', 'HEAD')}\n`)
    mkdirSync(join(t.copy, '.git', 'rebase-merge'))
    writeFileSync(join(t.copy, '.git', 'index.lock'), '')
    const { plan } = await planOf(t.copy)
    assert.deepEqual(plan.operations, [
      'a merge is in progress',
      'a rebase is in progress',
      'a git command is running or crashed (index.lock exists)',
    ])
  } finally {
    t.cleanup()
  }
})

test('a forced cache read never returns a stale value when the loader throws', async () => {
  const cache = new TtlCache()
  assert.equal(await cache.get('k', async () => 'old', { ttlMs: 60000 }), 'old')
  await assert.rejects(cache.get('k', async () => { throw new Error('boom') }, { ttlMs: 60000, force: true }), /boom/)
  // Nor does the failed forced read leave the stale value for the next reader within the TTL.
  assert.equal(await cache.get('k', async () => 'fresh', { ttlMs: 60000 }), 'fresh')
  // An unforced read still degrades to the old value on failure.
  assert.equal(await cache.get('k', async () => { throw new Error('boom') }, { ttlMs: 0 }), 'fresh')
})

test('a forced read during an in-flight read waits for it and then reads again', async () => {
  const cache = new TtlCache()
  let calls = 0
  let release
  const slowOld = cache.get('k', () => new Promise((resolve) => { calls += 1; release = () => resolve('started-before-the-change') }), { ttlMs: 60000 })
  const forced = cache.get('k', async () => { calls += 1; return 'after-the-change' }, { ttlMs: 60000, force: true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls, 1, 'the forced read has not started: it is waiting for the in-flight one')
  release()
  assert.equal(await slowOld, 'started-before-the-change', 'an unforced caller still shares the in-flight read')
  assert.equal(await forced, 'after-the-change', 'the forced caller got a read that started after it asked')
  assert.equal(calls, 2)
})

test('a forced read also rereads when the in-flight read fails', async () => {
  const cache = new TtlCache()
  let release
  const failing = cache.get('k', () => new Promise((_resolve, reject) => { release = () => reject(new Error('first failed')) }), { ttlMs: 60000 })
  const forced = cache.get('k', async () => 'second', { ttlMs: 60000, force: true })
  release()
  await assert.rejects(failing, /first failed/)
  assert.equal(await forced, 'second')
})
