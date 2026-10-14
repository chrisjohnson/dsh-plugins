// dsh-better-git-worktree: repository facts and the working-copy status read.
//
// One status read is a handful of fast local git commands (no network). The
// result is the single source for both the session-list indicator and the
// header pill, so they can never disagree. The folding of git's output into the
// status vocabulary is in status.mjs; this file only runs git.

import { gitText, runGit } from './git-runner.mjs'
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

/** Why a git call failed, for the "could not verify" message. */
function failure(what, result) {
  const detail = result.timedOut ? 'timed out' : (result.stderr.trim().split('\n')[0] || `exit ${result.code}`)
  return `${what}: ${detail}`
}

/**
 * Commits that exist nowhere else: reachable from HEAD, any local branch or any
 * tag, but from no remote-tracking ref of this repository and no ref of the
 * repository whose objects it borrows through `objects/info/alternates`
 * (`--alternate-refs`), nor from `baseOid`, the commit the copy was started from
 * (which the source repository keeps whether or not any of its refs name it, e.g.
 * when it sat on a detached HEAD). A fresh copy has no remote-tracking refs until
 * its first fetch, so the alternate refs and the base are what keep its starting
 * history from counting. Walking every branch and tag, not only HEAD, keeps work
 * on a branch that is no longer checked out in the count.
 *
 * Never throws and never guesses: a failed call is returned as `error`, so the
 * caller can say "could not verify" instead of "nothing to lose".
 *
 * @returns {Promise<{count: number} | {error: string}>}
 */
export async function countUnpublished(path, options = {}) {
  const run = options.run ?? runGit
  const args = ['rev-list', '--count', 'HEAD', '--branches', '--tags', '--not', '--remotes', '--alternate-refs']
  if (typeof options.baseOid === 'string' && options.baseOid !== '') args.push(options.baseOid)
  const result = await run(path, args, { timeoutMs: options.timeoutMs })
  if (!result.ok) return { error: failure('could not count unpublished commits', result) }
  const count = Number(result.stdout.trim())
  return Number.isFinite(count) ? { count } : { error: 'could not count unpublished commits: unexpected output' }
}

/** Number of stash entries in the copy's own repository, or `{error}`. */
export async function countStashes(path, options = {}) {
  const run = options.run ?? runGit
  const result = await run(path, ['stash', 'list'], { timeoutMs: options.timeoutMs })
  if (!result.ok) return { error: failure('could not list stash entries', result) }
  return { count: result.stdout.split('\n').filter((line) => line !== '').length }
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
      unverified: ['the worktree has no commit to inspect (it could be unborn, or git could not read it)'],
      files: [],
    }
  }

  const run = options.run ?? runGit
  const [oid, statusResult, upstreamName, subjectLine] = await Promise.all([
    headOid(path),
    run(path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { timeoutMs: options.timeoutMs }),
    gitText(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    gitText(path, ['log', '-1', '--format=%h%x1f%s']),
  ])
  // What the archive dialog may say "nothing to lose" about must have been read
  // successfully; a failed read is recorded, never folded into zero.
  const unverified = []
  if (!statusResult.ok) unverified.push(failure('could not read the working tree', statusResult))
  const changes = parsePorcelain(statusResult.ok ? statusResult.stdout : '')

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
  const safety = { run, timeoutMs: options.timeoutMs }
  const unpublishedResult = await countUnpublished(path, { ...safety, baseOid: options.baseOid })
  if (unpublishedResult.error !== undefined) unverified.push(unpublishedResult.error)
  const stashResult = await countStashes(path, safety)
  if (stashResult.error !== undefined) unverified.push(stashResult.error)

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
    unpublished: unpublishedResult.count,
    stashes: stashResult.count,
    unverified,
    dirty: changes.dirty,
    staged: changes.staged,
    unstaged: changes.unstaged,
    untracked: changes.untracked,
    files: changes.files,
    state: worktreeState({ upstream, aheadUpstream, behindUpstream, baseRef, aheadBase, behindBase }),
    error: undefined,
  }
}
