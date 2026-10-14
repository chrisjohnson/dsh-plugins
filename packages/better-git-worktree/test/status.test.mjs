import test from 'node:test'
import assert from 'node:assert/strict'

import {
  archivePlan,
  checkoutName,
  decorationOf,
  needsRebase,
  parseLeftRight,
  parsePorcelain,
  stateLabel,
  statusSummary,
  worktreeState,
} from '../src/status.mjs'

test('worktreeState: no upstream, or commits ahead of it, is progressing', () => {
  assert.equal(worktreeState({}), 'progressing')
  assert.equal(worktreeState({ upstream: '' }), 'progressing')
  assert.equal(worktreeState({ upstream: 'origin/x', aheadUpstream: 2 }), 'progressing')
})

test('worktreeState: the upstream moved on and the branch has nothing of its own is behind', () => {
  assert.equal(worktreeState({ upstream: 'origin/x', aheadUpstream: 0, behindUpstream: 3 }), 'behind')
})

test('worktreeState: in step with the upstream is up_to_date, or in_sync when identical to the default branch', () => {
  const inStep = { upstream: 'origin/x', aheadUpstream: 0, behindUpstream: 0 }
  assert.equal(worktreeState({ ...inStep, baseRef: 'origin/main', aheadBase: 1, behindBase: 0 }), 'up_to_date')
  assert.equal(worktreeState({ ...inStep, baseRef: 'origin/main', aheadBase: 0, behindBase: 2 }), 'up_to_date')
  assert.equal(worktreeState({ ...inStep, baseRef: 'origin/main', aheadBase: 0, behindBase: 0 }), 'in_sync')
  assert.equal(worktreeState({ ...inStep }), 'up_to_date', 'no default branch to compare with is never in_sync')
})

test('needsRebase: the branch has its own commits and the default branch moved on', () => {
  assert.equal(needsRebase({ aheadBase: 1, behindBase: 1 }), true)
  assert.equal(needsRebase({ aheadBase: 0, behindBase: 4 }), false)
  assert.equal(needsRebase({ aheadBase: 3, behindBase: 0 }), false)
  assert.equal(needsRebase({}), false)
})

test('parsePorcelain counts staged, modified and untracked paths and skips a rename\'s second path', () => {
  const text = ['M  staged.txt', ' M modified.txt', 'MM both.txt', '?? new.txt', 'R  new-name.txt', 'old-name.txt', ''].join('\0')
  const parsed = parsePorcelain(text)
  assert.equal(parsed.staged, 3)
  assert.equal(parsed.unstaged, 2)
  assert.equal(parsed.untracked, 1)
  assert.equal(parsed.dirty, 6)
  assert.deepEqual(parsed.files.map((f) => f.path), ['staged.txt', 'modified.txt', 'both.txt', 'new.txt', 'new-name.txt'])
  assert.deepEqual(parsePorcelain(''), { staged: 0, unstaged: 0, untracked: 0, files: [], dirty: 0 })
})

test('parseLeftRight reads two counts and refuses anything else', () => {
  assert.deepEqual(parseLeftRight('3\t5\n'), { left: 3, right: 5 })
  assert.equal(parseLeftRight(undefined), undefined)
  assert.equal(parseLeftRight('3'), undefined)
  assert.equal(parseLeftRight('a b'), undefined)
})

test('statusSummary is two lines: which checkout, then how it stands', () => {
  const summary = statusSummary(
    { branch: 'dsh/brave-otter', state: 'progressing', aheadBase: 2, baseRef: 'origin/main', staged: 1, unstaged: 0, untracked: 2 },
    { petName: 'brave-otter', managedRoot: '/work/project/.dsh-worktrees/brave-otter' },
  )
  const [head, body] = summary.split('\n')
  assert.equal(head, 'Worktree brave-otter · branch dsh/brave-otter · at /work/project/.dsh-worktrees/brave-otter')
  assert.match(body, /Progressing: 2 commits ahead of origin\/main, nothing published yet/)
  assert.match(body, /Working tree: 1 staged, 2 untracked/)
  assert.match(body, /2 commits ahead of origin\/main, not merged/)
})

test('statusSummary spells out the rebase need, a clean tree, and a detached head', () => {
  const summary = statusSummary({ state: 'up_to_date', upstream: 'origin/x', needsRebase: true, baseRef: 'origin/main', behindBase: 1 })
  assert.match(summary, /^branch \(detached HEAD\)\n/)
  assert.match(summary, /Up to date with origin\/x/)
  assert.match(summary, /Working tree: clean/)
  assert.match(summary, /Needs rebasing: origin\/main has 1 commit this branch does not have/)
})

test('statusSummary: in sync and behind', () => {
  assert.match(statusSummary({ state: 'in_sync', upstream: 'origin/x', baseRef: 'origin/main', aheadBase: 0, behindBase: 0 }), /In sync with origin\/x.*Same commit as origin\/main/)
  assert.match(statusSummary({ state: 'behind', upstream: 'origin/x', behindUpstream: 2 }), /Behind origin\/x by 2 commits/)
})

test('labels and names', () => {
  assert.equal(stateLabel('up_to_date'), 'Up To Date')
  assert.equal(stateLabel('nonsense'), 'Unknown')
  assert.equal(checkoutName({ petName: 'brave-otter', branch: 'dsh/brave-otter' }), 'brave-otter')
  assert.equal(checkoutName({ branch: 'main' }), 'main')
  assert.equal(checkoutName({}), undefined)
  assert.equal(checkoutName(undefined), undefined)
})

test('decorationOf: a normal status carries state, word, glow, tooltip and the pill title', () => {
  assert.deepEqual(
    decorationOf({ state: 'behind', needsRebase: false, tooltip: 'two lines\nhere', petName: 'brave-otter' }),
    { state: 'behind', label: 'Behind', needsRebase: false, tooltip: 'two lines\nhere', name: 'brave-otter', title: 'brave-otter - Behind' },
  )
  const glowing = decorationOf({ state: 'progressing', needsRebase: true, tooltip: 't', branch: 'main' })
  assert.equal(glowing.needsRebase, true)
  assert.equal(glowing.title, 'main - Progressing')
})

test('decorationOf: a missing copy reads Missing on the badge and Unknown on the pill; no checkout is "No repository"', () => {
  const missing = decorationOf({ missing: true, state: 'unknown', tooltip: '', petName: 'gone' })
  assert.equal(missing.label, 'Missing')
  assert.equal(missing.title, 'gone - Unknown')
  assert.match(missing.tooltip, /no longer exists on disk/)
  const unknown = decorationOf({ state: 'unknown', tooltip: 'could not be inspected' })
  assert.equal(unknown.label, 'Unknown')
  assert.equal(unknown.title, 'No repository - Unknown')
  assert.equal(unknown.tooltip, 'could not be inspected')
  assert.equal(decorationOf(undefined), undefined)
  assert.equal(decorationOf(null), undefined)
})

test('archivePlan: only a session with a live managed working copy asks what to do with it', () => {
  assert.deepEqual(archivePlan(undefined), { prompt: false, dirty: 0, unpushed: 0, stashes: 0, unknown: false, reasons: [] })
  assert.deepEqual(archivePlan({ path: '/work/project' }), { prompt: false, dirty: 0, unpushed: 0, stashes: 0, unknown: false, reasons: [] }, 'a plain checkout session archives straight away')
  assert.equal(archivePlan({ managedRoot: '/w/c', missing: true }).prompt, false, 'a copy that is already gone has nothing to remove')
  assert.deepEqual(archivePlan({ managedRoot: '/w/c', dirty: 3, aheadUpstream: 2, aheadBase: 9 }), { prompt: true, dirty: 3, unpushed: 2, stashes: 0, unknown: false, reasons: [] })
})

test('archivePlan: unpushed commits fall back to the count ahead of the default branch when there is no upstream', () => {
  assert.deepEqual(archivePlan({ managedRoot: '/w/c', aheadBase: 4 }), { prompt: true, dirty: 0, unpushed: 4, stashes: 0, unknown: false, reasons: [] })
  assert.deepEqual(archivePlan({ managedRoot: '/w/c' }), { prompt: true, dirty: 0, unpushed: 0, stashes: 0, unknown: false, reasons: [] })
})
