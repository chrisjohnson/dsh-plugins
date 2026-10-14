// dsh-better-git-worktree: repository facts and the working-copy status read.
//
// One status read is a handful of fast local git commands (no network). The
// result is the single source for both the session-list indicator and the
// header pill, so they can never disagree. The folding of git's output into the
// status vocabulary is in status.mjs; this file only runs git.

import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
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

function realpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Whether `path` is the root of a git repository of its own, with its own git
 * directory at `<path>/.git`. A managed copy is nested inside its source
 * checkout (or under a home directory that may itself be a repository), and git
 * walks up from a directory whose `.git` is missing, empty or has an invalid HEAD
 * until it finds the enclosing repository: every read would then describe the
 * SOURCE (its branch, its counts, an empty status because the copy is ignored)
 * and call the copy clean while it still holds user files.
 *
 * @returns {Promise<string | undefined>} a problem description, or undefined when the copy is its own repository.
 */
export async function checkOwnRepository(path, options = {}) {
  const run = options.run ?? runGit
  const own = realpath(path)
  const top = await run(path, ['rev-parse', '--show-toplevel'], { timeoutMs: options.timeoutMs })
  if (!top.ok) return failure(`git cannot read ${path} as a repository`, top)
  const resolved = top.stdout.trim()
  if (realpath(resolved) !== own) {
    return `${path} is not a git checkout of its own (git resolves it to ${resolved}), so its status cannot be trusted`
  }
  const dir = await run(path, ['rev-parse', '--absolute-git-dir'], { timeoutMs: options.timeoutMs })
  if (!dir.ok) return failure(`git cannot find the git directory of ${path}`, dir)
  if (realpath(dir.stdout.trim()) !== realpath(join(own, '.git'))) {
    return `${path} does not own its git directory (git uses ${dir.stdout.trim()}), so its status cannot be trusted`
  }
  return undefined
}

/**
 * Files and directories the copy's ignore rules hide from status, and which
 * removing the copy deletes all the same (`.env`, local config, build output).
 * Fully ignored directories are reported as one entry, so this stays cheap.
 * @returns {Promise<{count: number, examples: string[]} | {error: string}>}
 */
export async function summarizeIgnored(path, options = {}) {
  const run = options.run ?? runGit
  const result = await run(
    path,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory', '-z'],
    { timeoutMs: options.timeoutMs },
  )
  if (!result.ok) return { error: failure('could not list ignored files', result) }
  const names = result.stdout.split('\0').filter((name) => name !== '')
  return { count: names.length, examples: names.slice(0, IGNORED_EXAMPLES) }
}

const IGNORED_EXAMPLES = 5

/** Git operations left half-done in the copy, from the marker files git keeps in its directory. */
export function inProgressOperations(path) {
  const markers = [
    ['MERGE_HEAD', 'a merge is in progress'],
    ['rebase-merge', 'a rebase is in progress'],
    ['rebase-apply', 'a rebase or patch application is in progress'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick is in progress'],
    ['REVERT_HEAD', 'a revert is in progress'],
    ['BISECT_LOG', 'a bisect is in progress'],
    ['index.lock', 'a git command is running or crashed (index.lock exists)'],
  ]
  return markers.filter(([name]) => existsSync(join(path, '.git', name))).map(([, text]) => text)
}

/**
 * Read one working copy's complete status.
 * @param path - working copy root (this is where git runs).
 * @param options.baseBranch - repository default branch name.
 * @returns a plain JSON status object; `error` is set when the path is not a usable repo.
 */
export async function readWorktreeStatus(path, options = {}) {
  if (options.requireOwnRepo === true) {
    const problem = await checkOwnRepository(path, options)
    if (problem !== undefined) {
      return {
        branch: undefined,
        state: 'unknown',
        needsRebase: false,
        dirty: 0,
        error: problem,
        unverified: [problem],
        files: [],
      }
    }
  }
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
  const ignoredResult = await summarizeIgnored(path, safety)
  if (ignoredResult.error !== undefined) unverified.push(ignoredResult.error)
  const operations = inProgressOperations(path)

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
    ignored: ignoredResult.error === undefined ? { count: ignoredResult.count, examples: ignoredResult.examples } : undefined,
    operations,
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
