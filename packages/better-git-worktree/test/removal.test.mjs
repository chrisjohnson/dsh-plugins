import test from 'node:test'
import assert from 'node:assert/strict'

import { assertRemovable, removalBases } from '../src/removal.mjs'

const HOME = '/home-of-test'
const REPO = '/work/project'

test('removalBases: the nested root, the home fallback, and the legacy plugin-named segment', () => {
  assert.deepEqual(removalBases(REPO, HOME), [
    '/work/project/.dsh-worktrees',
    '/home-of-test/.dsh-worktrees',
    '/home-of-test/.dsh-worktrees/dsh-better-git-worktree',
  ])
})

test('a copy in the current nested layout may be removed', () => {
  assert.equal(assertRemovable('/work/project/.dsh-worktrees/brave-otter', REPO, HOME), '/work/project/.dsh-worktrees/brave-otter')
})

test('a copy under the home fallback may be removed', () => {
  assert.equal(assertRemovable('/home-of-test/.dsh-worktrees/brave-otter', REPO, HOME), '/home-of-test/.dsh-worktrees/brave-otter')
})

test('a copy made under the older, longer layout is still recognized', () => {
  const legacy = '/work/project/.dsh-worktrees/dsh-better-git-worktree/project-brave-otter'
  assert.equal(assertRemovable(legacy, REPO, HOME), legacy)
  const legacyHome = '/home-of-test/.dsh-worktrees/dsh-better-git-worktree/project-brave-otter'
  assert.equal(assertRemovable(legacyHome, REPO, HOME), legacyHome)
})

test('a corrupted record can never turn the removal into an arbitrary rm -rf', () => {
  for (const hostile of [
    '/',
    '/work/project',
    '/work/project/src',
    '/work/project/.dsh-worktrees',
    '/home-of-test',
    '/home-of-test/.dsh-worktrees',
    '/work/project/.dsh-worktrees/../src',
    '/work/project/.dsh-worktrees-other/x',
    '/etc/passwd',
  ]) {
    assert.throws(() => assertRemovable(hostile, REPO, HOME), /refusing to remove/, hostile)
  }
})

test('the refusal names the roots it would have accepted', () => {
  assert.throws(() => assertRemovable('/etc', REPO, HOME), /outside the managed worktree roots \/work\/project\/\.dsh-worktrees, /)
})
