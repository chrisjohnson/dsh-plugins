// Shared test helpers: throwaway temp directories and real git repositories.
//
// The plugin's own git subprocesses inherit this process's environment, so the
// identity and config isolation is set here for both sides: nothing in a
// developer's global git config (signing, hooks, default branch) can change a
// test's outcome.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_AUTHOR_NAME = 'Test'
process.env.GIT_AUTHOR_EMAIL = 'test@example.com'
process.env.GIT_COMMITTER_NAME = 'Test'
process.env.GIT_COMMITTER_EMAIL = 'test@example.com'

/** Run git in `cwd` and return trimmed stdout. */
export function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A fresh temp directory (real path, so comparisons survive /tmp symlinks), plus its cleanup. */
export function tempDir(prefix = 'bgw-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * A repository with one commit on `main`. With `remote: true` it also has a bare
 * `origin`, main pushed, and `refs/remotes/origin/main` set, the way a clone is.
 */
export function makeRepo(root, { remote = false, name = 'project' } = {}) {
  const repo = join(root, name)
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  writeFileSync(join(repo, 'tracked.txt'), 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'initial')
  let origin
  if (remote) {
    origin = join(root, `${name}-origin.git`)
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
  }
  return { repo, origin }
}

/** Commit a file in `repo` and return the new HEAD. */
export function commitFile(repo, file, text, message = `edit ${file}`) {
  writeFileSync(join(repo, file), text)
  git(repo, 'add', file)
  git(repo, 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

/** The quiet logger the plugin takes. */
export function quietLog() {
  const calls = { info: [], warn: [], error: [] }
  const log = {
    info: (...args) => calls.info.push(args.join(' ')),
    warn: (...args) => calls.warn.push(args.join(' ')),
    error: (...args) => calls.error.push(args.join(' ')),
    debug: () => {},
  }
  return { log, calls }
}
