// dsh-better-git-worktree: repository facts and the working-copy status read.
//
// One status read is a handful of fast local git commands (no network). The
// result is the single source for both the session-list indicator and the
// header pill, so they can never disagree. The folding of git's output into the
// status vocabulary is in status.mjs; this file only runs git.

import { gitText } from './git-runner.mjs'
import { needsRebase, parseLeftRight, parsePorcelain, worktreeState } from './status.mjs'

/** Absolute repository root for a working directory, or undefined outside a repo. */
export function repoRoot(cwd) {
  return gitText(cwd, ['rev-parse', '--show-toplevel'])
}

/** Current branch name, or undefined for a detached HEAD. */
export async function currentBranch(cwd) {
  const name = await gitText(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (name === undefined) return undefined
  return name === 'HEAD' ? undefined : name
}

/** Current HEAD commit, or undefined on an unborn branch. */
export function headOid(cwd) {
  return gitText(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
}

/**
 * The repository's default branch name (not a ref).
 * Prefers `origin/HEAD`, then the usual candidates, then the branch the repo
 * currently has checked out in its main worktree.
 */
export async function defaultBranch(cwd) {
  const symbolic = await gitText(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  if (symbolic !== undefined && symbolic.startsWith('refs/remotes/origin/')) {
    return symbolic.slice('refs/remotes/origin/'.length)
  }
  for (const candidate of ['main', 'master', 'trunk', 'develop']) {
    const remote = await gitText(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`])
    if (remote !== undefined) return candidate
  }
  for (const candidate of ['main', 'master', 'trunk', 'develop']) {
    const local = await gitText(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`])
    if (local !== undefined) return candidate
  }
  return undefined
}

/** Resolve the comparison ref for "the default branch on origin". */
export async function baseRefFor(cwd, branch) {
  if (branch === undefined) {
    for (const candidate of ['main', 'master']) {
      if ((await gitText(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`])) !== undefined) {
        return `origin/${candidate}`
      }
    }
    return undefined
  }
  const remote = await gitText(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
  if (remote !== undefined) return `origin/${branch}`
  const local = await gitText(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return local === undefined ? undefined : branch
}

/**
 * Commits on HEAD that exist nowhere else: not reachable from any remote-tracking
 * ref of this repository, nor from any ref of the repository whose objects it
 * borrows through `objects/info/alternates` (`--alternate-refs`). A fresh working
 * copy has no remote-tracking refs at all until its first fetch, so the second
 * source is what keeps its starting history from counting as unpublished.
 * Undefined when git cannot answer.
 */
export async function countUnpublished(path) {
  const text = await gitText(path, ['rev-list', '--count', 'HEAD', '--not', '--remotes', '--alternate-refs'])
  if (text === undefined) return undefined
  const count = Number(text)
  return Number.isFinite(count) ? count : undefined
}

/**
 * Read one working copy's complete status.
 * @param path - working copy root (this is where git runs).
 * @param options.baseBranch - repository default branch name.
 * @returns a plain JSON status object; `error` is set when the path is not a usable repo.
 */
export async function readWorktreeStatus(path, options = {}) {
  const branch = await currentBranch(path)
  if (branch === undefined && (await headOid(path)) === undefined) {
    return {
      branch: undefined,
      state: 'unknown',
      needsRebase: false,
      dirty: 0,
      error: 'the worktree has no commit to inspect (unborn HEAD)',
      files: [],
    }
  }

  const [oid, statusText, upstreamName, subjectLine] = await Promise.all([
    headOid(path),
    gitText(path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    gitText(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    gitText(path, ['log', '-1', '--format=%h%x1f%s']),
  ])
  const changes = parsePorcelain(statusText ?? '')

  let upstream
  let aheadUpstream
  let behindUpstream
  if (upstreamName !== undefined && upstreamName !== '') {
    upstream = upstreamName
    const counts = parseLeftRight(await gitText(path, ['rev-list', '--left-right', '--count', `${upstreamName}...HEAD`]))
    if (counts !== undefined) {
      behindUpstream = counts.left
      aheadUpstream = counts.right
    }
  }

  const baseBranch = options.baseBranch
  const baseRef = await baseRefFor(path, baseBranch)
  let aheadBase
  let behindBase
  if (baseRef !== undefined) {
    const counts = parseLeftRight(await gitText(path, ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`]))
    if (counts !== undefined) {
      behindBase = counts.left
      aheadBase = counts.right
    }
  }

  const [shortOid, subject] = (subjectLine ?? '').split('\x1f')
  const unpublished = await countUnpublished(path)

  return {
    branch,
    oid,
    shortOid: shortOid || undefined,
    subject: subject || undefined,
    upstream,
    aheadUpstream,
    behindUpstream,
    baseBranch,
    baseRef,
    aheadBase,
    behindBase,
    needsRebase: needsRebase({ aheadBase, behindBase }),
    unpublished,
    dirty: changes.dirty,
    staged: changes.staged,
    unstaged: changes.unstaged,
    untracked: changes.untracked,
    files: changes.files,
    state: worktreeState({ upstream, aheadUpstream, behindUpstream, baseRef, aheadBase, behindBase }),
    error: undefined,
  }
}
