// What the archive dialog may say about work that Remove would destroy, against
// real temporary git repositories: every kind of unsaved work is counted, and a
// git failure is "unknown", never "clean".

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { commitFile, git, makeRepo, tempDir } from './helpers.mjs'
import { createWorktree } from '../src/working-copy.mjs'
import { countStashes, countUnpublished, readWorktreeStatus } from '../src/repository.mjs'
import { runGit } from '../src/git-runner.mjs'
import { archivePlan } from '../src/status.mjs'

async function freshCopy(options = {}) {
  const t = tempDir('bgw-unsaved-')
  const { repo } = makeRepo(t.dir, { remote: options.remote ?? true })
  if (options.detachSource) git(repo, 'checkout', '-q', '--detach')
  const created = await createWorktree({ repoRoot: repo, home: t.dir })
  return { ...t, repo, created, copy: created.managedRoot }
}

const planOf = async (copy, created, extra = {}) => {
  const status = await readWorktreeStatus(copy, { baseBranch: 'main', baseOid: created.baseOid, ...extra })
  return { status, plan: archivePlan({ ...status, managedRoot: copy }) }
}

test('a fresh copy has nothing unsaved', async () => {
  const t = await freshCopy()
  try {
    const { plan } = await planOf(t.copy, t.created)
    assert.deepEqual(plan, { prompt: true, dirty: 0, unpushed: 0, stashes: 0, unknown: false, reasons: [] })
  } finally {
    t.cleanup()
  }
})

test('a fresh copy of a source that sits on a detached HEAD is not "unpushed" when the base commit is known', async () => {
  const t = await freshCopy({ detachSource: true })
  try {
    // The source's detached commit is in no ref the alternate can list.
    commitFile(t.repo, 'detached.txt', 'd\n', 'detached work')
    const second = await createWorktree({ repoRoot: t.repo, home: t.dir })
    const { plan } = await planOf(second.managedRoot, second)
    assert.equal(plan.unpushed, 0, 'the base commit the copy started from is not its own work')
    assert.equal(plan.unknown, false)
    // A record from before the base was stored has no baseOid: the old, conservative count.
    const legacy = await readWorktreeStatus(second.managedRoot, { baseBranch: 'main' })
    assert.equal(legacy.unpublished, 1)
  } finally {
    t.cleanup()
  }
})

test('a commit on another branch of the copy counts after HEAD is detached away from it', async () => {
  const t = await freshCopy()
  try {
    commitFile(t.copy, 'on-branch.txt', 'b\n', 'only on the branch')
    git(t.copy, 'checkout', '-q', '--detach', 'HEAD~1')
    const { plan } = await planOf(t.copy, t.created)
    assert.equal(plan.unpushed, 1)
    assert.equal(plan.unknown, false)
  } finally {
    t.cleanup()
  }
})

test('a commit on a detached HEAD itself counts', async () => {
  const t = await freshCopy()
  try {
    git(t.copy, 'checkout', '-q', '--detach')
    commitFile(t.copy, 'loose.txt', 'l\n', 'detached commit')
    assert.equal((await planOf(t.copy, t.created)).plan.unpushed, 1)
  } finally {
    t.cleanup()
  }
})

test('a commit reachable only from a tag counts', async () => {
  const t = await freshCopy()
  try {
    commitFile(t.copy, 'tagged.txt', 't\n', 'tagged work')
    git(t.copy, 'tag', 'keep-me')
    git(t.copy, 'reset', '-q', '--hard', 'HEAD~1')
    assert.equal((await planOf(t.copy, t.created)).plan.unpushed, 1)
  } finally {
    t.cleanup()
  }
})

test('a stash alone is reported, separately from commits and files', async () => {
  const t = await freshCopy()
  try {
    writeFileSync(join(t.copy, 'tracked.txt'), 'stashed away\n')
    git(t.copy, 'stash', 'push', '-q')
    const { plan } = await planOf(t.copy, t.created)
    assert.equal(plan.dirty, 0)
    assert.equal(plan.unpushed, 0)
    assert.equal(plan.stashes, 1)
    assert.equal(plan.unknown, false)
    assert.deepEqual(await countStashes(t.copy), { count: 1 })
  } finally {
    t.cleanup()
  }
})

test('pushed and fetched work does not warn, on any branch', async () => {
  const t = await freshCopy()
  try {
    commitFile(t.copy, 'shared.txt', 's\n', 'shared')
    git(t.copy, 'push', '-q', 'origin', `${t.created.branch}:refs/heads/${t.created.branch}`)
    git(t.copy, 'fetch', '-q', 'origin')
    git(t.copy, 'checkout', '-q', '--detach', 'HEAD~1')
    const { plan } = await planOf(t.copy, t.created)
    assert.equal(plan.unpushed, 0)
    assert.equal(plan.unknown, false)
  } finally {
    t.cleanup()
  }
})

test('a source that has moved (broken alternates) makes the status unknown, not clean', async () => {
  const t = await freshCopy()
  try {
    commitFile(t.copy, 'work.txt', 'w\n', 'unsaved commit')
    writeFileSync(join(t.copy, 'dirty.txt'), 'x\n')
    writeFileSync(join(t.copy, '.git', 'objects', 'info', 'alternates'), `${join(t.dir, 'moved-away', '.git', 'objects')}\n`)
    const { status, plan } = await planOf(t.copy, t.created)
    assert.equal(plan.prompt, true)
    assert.equal(plan.unknown, true, JSON.stringify(status.unverified))
    assert.ok(plan.reasons.length > 0)
    assert.notDeepEqual([plan.dirty, plan.unpushed, plan.unknown], [0, 0, false])
  } finally {
    t.cleanup()
  }
})

test('a git call that times out makes the status unknown', async () => {
  const t = await freshCopy()
  try {
    // The runner reports a kill by timeout exactly like this (see runGit); a real
    // 1 ms timeout would be a race, so the result is injected.
    const timedOut = (what) => (cwd, args, options) => (
      what(args)
        ? Promise.resolve({ ok: false, code: 1, stdout: '', stderr: `git ${args[0]} timed out after 15000ms`, timedOut: true })
        : runGit(cwd, args, options)
    )
    for (const [label, which] of [['status', (a) => a[0] === 'status'], ['commit count', (a) => a[0] === 'rev-list'], ['stash list', (a) => a[0] === 'stash']]) {
      const { status, plan } = await planOf(t.copy, t.created, { run: timedOut(which) })
      assert.equal(plan.unknown, true, label)
      assert.match(status.unverified.join('\n'), /timed out/, label)
    }
    const count = await countUnpublished(t.copy, { run: timedOut(() => true) })
    assert.match(count.error, /could not count unpublished commits: timed out/)
  } finally {
    t.cleanup()
  }
})

test('a git without --alternate-refs (unknown option) makes the status unknown', async () => {
  const t = await freshCopy()
  try {
    const oldGit = (cwd, args, options) => {
      if (args.includes('--alternate-refs')) {
        return Promise.resolve({ ok: false, code: 129, stdout: '', stderr: 'error: unknown option `alternate-refs\'\n', timedOut: false })
      }
      return runGit(cwd, args, options)
    }
    const { status, plan } = await planOf(t.copy, t.created, { run: oldGit })
    assert.equal(plan.unknown, true)
    assert.match(status.unverified.join('\n'), /could not count unpublished commits: error: unknown option/)
    assert.equal(status.unpublished, undefined)
  } finally {
    t.cleanup()
  }
})

test('a status that could not be read at all is unknown too', async () => {
  const t = await freshCopy()
  try {
    mkdirSync(join(t.dir, 'not-a-repo'))
    const status = await readWorktreeStatus(join(t.dir, 'not-a-repo'), {})
    const plan = archivePlan({ ...status, managedRoot: join(t.dir, 'not-a-repo') })
    assert.equal(plan.unknown, true)
  } finally {
    t.cleanup()
  }
})
