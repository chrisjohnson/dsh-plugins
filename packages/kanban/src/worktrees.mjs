// dsh-kanban: the ticket working copies, cut and cleared by this plugin.
//
// A ticket that owns its checkout is a ticket that cannot step on the live
// deployment or on another ticket's work, so the board cuts one when planning
// starts and clears it when the ticket closes. This module is that whole
// lifecycle. It shells out to plain `git` — no library, no long-lived process,
// every call bounded by a timeout and run with prompts disabled so a missing
// credential can never wedge the host — and it keeps its state in git itself
// rather than in a registry of its own:
//
//   * a copy is a *linked* worktree (`git worktree add`) in the native pool
//     `<repo>/.agents/worktrees/<pet-name>`, on branch `dsh/<pet-name>`;
//   * the pool holds a `.gitignore` containing `*`, so a copy never shows up as
//     an untracked path in the checkout that hosts it;
//   * "is this one of ours" is answered by the path shape and "what is it based
//     on" by `git merge-base`, so nothing has to be recorded anywhere and a copy
//     someone made by hand in the same pool is treated identically.
//
// A linked worktree keeps its index and its refs in the source repository's
// `.git`, outside the copy's own directory. That is fine here and is the point:
// kanban build sessions run with full access, so git may write there on their
// behalf, and the copy shares the object store instead of duplicating it.
//
// The one invariant that outranks every other decision in this file: a
// `git fetch` that fails throws. Planning on a base nobody could bring up to
// date is exactly what the worktree switch exists to prevent, so the ticket
// parks in needs-attention carrying git's own reason instead of quietly
// reading yesterday's code.
//
// The pool path and the branch prefix are the harness's own native convention
// (the Forge panel's worktree service uses the same pool), so a ticket copy and
// a panel copy are the same kind of object to every surface that looks at one.
//
// Pure: no dsh imports, so every decision in here is testable on its own.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';

/** Pool directory, relative to a repository root, that holds every managed copy. */
export const WORKTREE_POOL_SEGMENTS = ['.agents', 'worktrees'];
/** Branch prefix a copy's branch carries: `dsh/brave-otter`. */
export const BRANCH_PREFIX = 'dsh/';

const GIT_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_MS = 60000;
const WORKTREE_TIMEOUT_MS = 300000;
/** Default-branch candidates tried when `origin/HEAD` is not set. */
const DEFAULT_CANDIDATES = ['main', 'master', 'trunk', 'develop'];

// --------------------------------------------------------------- git plumbing

/** Base environment for every git call: no prompts, no optional locks, no pager. */
function gitEnv() {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
  };
}

/**
 * Run one git command. Never throws for a non-zero exit: the caller decides
 * whether a failure is fatal (a fetch is, a status read is not).
 * @returns {Promise<{ok: boolean, code: number, stdout: string, stderr: string}>}
 */
export function runGit(cwd, args, options = {}) {
  return new Promise((r) => {
    execFile(
      'git',
      ['-C', cwd, '-c', 'color.ui=false', '-c', 'core.quotepath=false', '--no-pager', ...args],
      {
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        env: gitEnv(),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '');
        const err = String(stderr ?? '');
        if (error === null || error === undefined) {
          r({ ok: true, code: 0, stdout: out, stderr: err });
          return;
        }
        const timedOut = error.killed === true || error.signal === 'SIGTERM';
        r({
          ok: false,
          code: typeof error.code === 'number' ? error.code : 1,
          stdout: out,
          stderr: timedOut ? `git ${String(args[0] ?? '')} timed out` : err || String(error.message ?? error),
        });
      },
    );
  });
}

/** Run git and return trimmed stdout, or undefined on any failure. */
async function gitText(cwd, args, options) {
  const result = await runGit(cwd, args, options);
  return result.ok ? result.stdout.replace(/\n$/, '') : undefined;
}

/** The first non-empty line of git's stderr, or a bare exit code. */
function firstLine(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------- names (pure)

const ADJECTIVES = [
  'amber', 'brave', 'brisk', 'calm', 'clever', 'coral', 'cosmic', 'crisp',
  'daring', 'eager', 'fleet', 'gentle', 'glad', 'golden', 'hardy', 'hazel',
  'humble', 'ivory', 'jolly', 'keen', 'lively', 'lucid', 'mellow', 'merry',
  'nimble', 'noble', 'placid', 'polar', 'proud', 'quiet', 'rapid', 'ready',
  'rustic', 'silent', 'sleek', 'solar', 'steady', 'sunny', 'swift', 'tidy',
  'vivid', 'warm', 'witty', 'zesty',
];

const NOUNS = [
  'acorn', 'alder', 'aspen', 'badger', 'beacon', 'birch', 'bison', 'brook',
  'cedar', 'cinder', 'clover', 'comet', 'crane', 'delta', 'dune', 'ember',
  'falcon', 'fern', 'finch', 'forge', 'garnet', 'glacier', 'harbor', 'heron',
  'juniper', 'kestrel', 'lantern', 'lark', 'lichen', 'lupine', 'marlin', 'meadow',
  'mesa', 'mosaic', 'otter', 'pelican', 'pine', 'quarry', 'raven', 'reef',
  'ridge', 'rowan', 'salmon', 'sedge', 'sparrow', 'summit', 'thistle', 'tundra',
  'walnut', 'willow',
];

/** One random two-part pet name, e.g. `brave-otter`. */
export function randomPetName(random = Math.random) {
  const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length) % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(random() * NOUNS.length) % NOUNS.length];
  return `${adjective}-${noun}`;
}

/**
 * A pet name whose directory and branch are both free.
 *
 * @param {object} input
 * @param {(name: string) => boolean} input.exists - whether a copy of that name is already there.
 * @param {(name: string) => boolean | Promise<boolean>} input.hasBranch - whether `dsh/<name>` already exists.
 * @param {() => number} [input.random]
 * @param {number} [input.attempts]
 */
export async function allocateName({ exists, hasBranch, random = Math.random, attempts = 40 }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const name = randomPetName(random);
    if (exists(name)) continue;
    if (await hasBranch(name)) continue;
    return name;
  }
  // Deterministic fallback: a name plus a short suffix, so this can never spin.
  const base = randomPetName(random);
  for (let index = 2; index < 100; index += 1) {
    const name = `${base}-${index}`;
    if (!exists(name) && !(await hasBranch(name))) return name;
  }
  throw new Error('could not allocate a free worktree name');
}

// --------------------------------------------------------- paths (pure)

/** Canonical form of an absolute path: normalized, no trailing slash. */
export function canonicalPath(path) {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return null;
  return normalize(path).replace(/\/+$/, '') || '/';
}

/** The pool directory for a repository root. */
export function poolRootFor(repoRoot) {
  return join(repoRoot, ...WORKTREE_POOL_SEGMENTS);
}

/**
 * Whether `path` sits inside a `.agents/worktrees` pool: the two segments have
 * to be consecutive and something has to follow them, so `/r/.agents/worktrees`
 * on its own and `/r/.agents/worktrees-x/otter` are not copies.
 */
export function isPoolPath(path) {
  const canonical = canonicalPath(path);
  if (canonical === null) return false;
  const parts = canonical.split('/');
  for (let at = parts.length - 3; at >= 0; at -= 1) {
    if (parts[at] === WORKTREE_POOL_SEGMENTS[0] && parts[at + 1] === WORKTREE_POOL_SEGMENTS[1]) return true;
  }
  return false;
}

/**
 * The pet name of a copy that sits *directly* in a pool — `<pool>/<name>` and
 * nothing deeper — or null. The name is what the branch is made of, so a deeper
 * path (a subdirectory of a copy) is deliberately not one.
 */
export function poolNameOf(path) {
  const canonical = canonicalPath(path);
  if (canonical === null) return null;
  const parts = canonical.split('/');
  const at = parts.length - 3;
  if (at < 0) return null;
  if (parts[at] !== WORKTREE_POOL_SEGMENTS[0] || parts[at + 1] !== WORKTREE_POOL_SEGMENTS[1]) return null;
  const name = parts[at + 2];
  return name === '' || name === '.' || name === '..' ? null : name;
}

/** The branch a pet name maps to. */
export function branchFor(petName) {
  return `${BRANCH_PREFIX}${petName}`;
}

// ----------------------------------------------------- refresh (pure matrix)

/**
 * Why a managed copy is left where it is, or null when it may be moved.
 *
 * Only a copy with nothing of its own in it is ever moved: a clean tree
 * *including untracked paths*, and no commit that the upstream default branch
 * does not already have. Anything else is somebody's work, and moving it would
 * be a mutation nobody asked for, so it is reported instead.
 *
 * @param {object} measured
 * @param {boolean} measured.exists - the copy is still on disk.
 * @param {boolean} measured.hasRepository - git still answers for it.
 * @param {number} measured.dirty - changed paths, untracked included.
 * @param {number} measured.ownCommits - commits on its HEAD the upstream does not have.
 * @param {boolean} measured.hasRemoteBase - an upstream default branch was resolved.
 * @param {boolean} [measured.alreadyCurrent] - HEAD already is that commit.
 * @param {boolean} [measured.ffFailed] - `merge --ff-only` refused.
 * @returns {string | null} the reason, or null when the copy may be fast-forwarded.
 */
export function refreshReason({ exists, hasRepository, dirty, ownCommits, hasRemoteBase, alreadyCurrent, ffFailed }) {
  if (exists !== true) return 'missing';
  if (hasRepository !== true) return 'no-repository';
  if (Number(dirty) > 0) return 'dirty';
  if (Number(ownCommits) > 0) return 'has-own-commits';
  if (hasRemoteBase !== true) return 'no-remote-base';
  if (alreadyCurrent === true) return null;
  if (ffFailed === true) return 'diverged';
  return null;
}

// ------------------------------------------------------------- git queries

/** Whether `path` is inside a git working tree at all (the new-ticket default). */
export async function isGitCheckout(path) {
  if (typeof path !== 'string' || path.trim() === '') return false;
  return (await gitText(path, ['rev-parse', '--is-inside-work-tree'])) === 'true';
}

/** The toplevel of the checkout `path` lives in, or null. */
export async function resolveRepository(path) {
  if (typeof path !== 'string' || path.trim() === '') return null;
  const top = await gitText(path, ['rev-parse', '--show-toplevel']);
  return top === undefined || top === '' ? null : top;
}

/**
 * The root of the repository a copy belongs to. A linked worktree's own
 * toplevel is the copy; the shared `.git` — and so the pool's host — is found
 * through the common dir.
 */
export async function repositoryRootOf(path) {
  const canonical = canonicalPath(path);
  if (canonical === null) return null;
  const common = await gitText(canonical, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common === undefined || common === '') return null;
  const absolute = isAbsolute(common) ? common : resolve(canonical, common);
  return basename(absolute) === '.git' ? dirname(absolute) : null;
}

async function hasOrigin(root) {
  const url = await gitText(root, ['remote', 'get-url', 'origin']);
  return url !== undefined && url !== '';
}

/** `git fetch origin`, throwing git's own reason on failure. Never silent. */
export async function fetchOrigin(root) {
  const result = await runGit(root, ['fetch', '--quiet', '--no-tags', 'origin'], { timeoutMs: FETCH_TIMEOUT_MS });
  if (!result.ok) {
    throw new Error(`git fetch origin failed in ${root}: ${firstLine(result.stderr) || `exit ${result.code}`}`);
  }
}

/** The default branch name (not a ref), or null when nothing names one. */
export async function defaultBranchOf(root) {
  const symbolic = await gitText(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolic !== undefined && symbolic.startsWith('refs/remotes/origin/')) {
    return symbolic.slice('refs/remotes/origin/'.length);
  }
  for (const candidate of DEFAULT_CANDIDATES) {
    if ((await gitText(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`])) !== undefined) {
      return candidate;
    }
  }
  return null;
}

/**
 * What a copy should be cut from, or what a copy should be brought up to.
 *
 * `from` is the default branch name, or null when there is nothing to name: no
 * origin at all (a scratch or offline repo — there is nothing to be stale
 * against, so no fetch is attempted), or an origin whose default nobody can
 * resolve. `baseCommit` is the commit to stand on.
 */
export async function resolveBase(root) {
  const head = await gitText(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head === undefined) {
    throw new Error(`${root} has no commit yet (unborn HEAD); commit once before creating a worktree`);
  }
  if (!(await hasOrigin(root))) return { from: null, baseRef: 'HEAD', baseCommit: head, origin: false };
  const from = (await defaultBranchOf(root)) ?? 'main';
  const remote = await gitText(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${from}`]);
  if (remote === undefined) return { from: null, baseRef: 'HEAD', baseCommit: head, origin: true };
  return { from, baseRef: `origin/${from}`, baseCommit: remote, origin: true };
}

/** Changed paths in a working tree, untracked ones included; -1 when git cannot say. */
export async function dirtyCount(path) {
  const status = await gitText(path, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status === undefined) return -1;
  return status.split('\n').filter((line) => line !== '').length;
}

/** Every worktree git knows about for `root`, as `{ path, branch }`. */
export async function listWorktrees(root) {
  const text = await gitText(root, ['worktree', 'list', '--porcelain']);
  if (text === undefined) return [];
  const out = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current !== null) out.push(current);
      current = { path: line.slice('worktree '.length), branch: null };
    } else if (line.startsWith('branch ') && current !== null) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  if (current !== null) out.push(current);
  return out;
}

/**
 * Ensure the pool exists and is ignored by the checkout that hosts it.
 *
 * The `.gitignore` with a single `*` is the native convention: it keeps every
 * copy — and the file itself — out of the hosting checkout's `git status`, which
 * matters because a dirty source checkout is a checkout refresh and archive
 * both refuse to touch.
 */
export function ensurePool(repoRoot) {
  const pool = poolRootFor(repoRoot);
  mkdirSync(pool, { recursive: true });
  const ignore = join(pool, '.gitignore');
  let text = '';
  try {
    text = readFileSync(ignore, 'utf8');
  } catch {
    text = '';
  }
  if (!text.split('\n').some((line) => line.trim() === '*')) {
    writeFileSync(ignore, text === '' ? '*\n' : `${text.endsWith('\n') ? '' : '\n'}*\n`);
  }
  return pool;
}

// ---------------------------------------------------------------- lifecycle

/**
 * Cut one linked worktree for a ticket and return what the Forge panel needs
 * to know about it.
 *
 * @param {object} input
 * @param {string} input.path - any path inside the repository to cut from.
 * @returns {Promise<{path: string, name: string, branch: string, from: string | null, baseCommit: string, repositoryRoot: string}>}
 * @throws when the path is not a repository, when `git fetch origin` fails, or
 *   when `git worktree add` refuses.
 */
export async function createWorktree({ path } = {}) {
  if (typeof path !== 'string' || path.trim() === '') throw new Error('createWorktree needs a repository path');
  const root = await resolveRepository(path);
  if (root === null) throw new Error(`${path} is not inside a git repository`);
  if (await hasOrigin(root)) await fetchOrigin(root);
  const base = await resolveBase(root);
  const pool = ensurePool(root);
  const known = new Set((await listWorktrees(root)).map((entry) => canonicalPath(entry.path)));
  const name = await allocateName({
    exists: (candidate) => existsSync(join(pool, candidate)) || known.has(canonicalPath(join(pool, candidate))),
    hasBranch: async (candidate) =>
      (await gitText(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchFor(candidate)}`])) !== undefined,
  });
  const dest = join(pool, name);
  const added = await runGit(
    root,
    ['worktree', 'add', '-b', branchFor(name), dest, base.baseCommit],
    { timeoutMs: WORKTREE_TIMEOUT_MS },
  );
  if (!added.ok) {
    throw new Error(`git worktree add failed: ${firstLine(added.stderr) || `exit ${added.code}`}`);
  }
  return {
    path: dest,
    name,
    branch: branchFor(name),
    from: base.from,
    baseCommit: base.baseCommit,
    repositoryRoot: root,
  };
}

/**
 * Bring one managed copy up to the latest default branch, or say exactly why it
 * was left alone.
 *
 * @param {object} input
 * @param {string} input.path - the copy to inspect.
 * @returns {Promise<object>} `{ managed: false, path }` for anything that is not
 *   one of ours; otherwise `{ managed: true, updated, ... }`, where `updated:
 *   false` always carries a `reason` from {@link refreshReason}.
 * @throws when the fetch it asks for fails — the caller parks the ticket.
 */
export async function refreshWorktree({ path } = {}) {
  const canonical = canonicalPath(path);
  if (canonical === null || !isPoolPath(canonical)) return { managed: false, path };
  const name = poolNameOf(canonical);
  const facts = {
    managed: true,
    managedRoot: canonical,
    path: canonical,
    name,
    branch: name === null ? null : branchFor(name),
  };
  if (!existsSync(canonical)) return { ...facts, updated: false, reason: 'missing' };
  const root = await repositoryRootOf(canonical);
  if (root === null) return { ...facts, updated: false, reason: 'no-repository' };
  if (await hasOrigin(root)) await fetchOrigin(root);
  const base = await resolveBase(root);
  const dirty = await dirtyCount(canonical);
  const head = await gitText(canonical, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  facts.baseOid = head ?? null;
  facts.repositoryRoot = root;
  if (dirty === -1 || head === undefined) {
    return { ...facts, updated: false, reason: 'no-repository', detail: 'git could not read the working tree' };
  }
  let ownCommits = 0;
  if (base.from !== null) {
    const counted = await gitText(canonical, ['rev-list', '--count', `${base.baseCommit}..HEAD`]);
    ownCommits = counted === undefined ? 1 : Number(counted);
    if (!Number.isFinite(ownCommits)) ownCommits = 1;
  }
  const alreadyCurrent = base.from !== null && base.baseCommit === head;
  const reason = refreshReason({
    exists: true,
    hasRepository: true,
    dirty,
    ownCommits,
    hasRemoteBase: base.from !== null,
    alreadyCurrent,
  });
  if (reason !== null) return { ...facts, updated: false, reason, dirty, ownCommits };
  if (alreadyCurrent) {
    return { ...facts, updated: true, alreadyCurrent: true, dirty, ownCommits, baseOid: head };
  }
  const merged = await runGit(canonical, ['merge', '--ff-only', base.baseCommit], { timeoutMs: WORKTREE_TIMEOUT_MS });
  if (!merged.ok) {
    return {
      ...facts,
      updated: false,
      reason: 'diverged',
      detail: firstLine(merged.stderr) || `exit ${merged.code}`,
      dirty,
      ownCommits,
    };
  }
  const newHead = (await gitText(canonical, ['rev-parse', '--verify', '--quiet', 'HEAD'])) ?? base.baseCommit;
  return { ...facts, updated: true, alreadyCurrent: false, baseOid: newHead, dirty, ownCommits };
}

/**
 * Remove one managed copy and delete its branch.
 *
 * A copy with uncommitted work is refused and left exactly as it is: the ticket
 * is closed, but the work is somebody's. The branch is deleted with `-d`, so an
 * unmerged branch — work that never landed — survives its checkout on purpose.
 * Never throws.
 *
 * @param {object} input
 * @param {string} input.path - the copy to remove.
 * @returns {Promise<{removed: boolean, refused: boolean, code?: string, reason?: string}>}
 *   `removed: false, refused: false` means there was nothing to do.
 */
export async function removeWorktree({ path } = {}) {
  try {
    const canonical = canonicalPath(path);
    if (canonical === null || !isPoolPath(canonical)) {
      return { removed: false, refused: false, code: 'not-managed', reason: 'not a kanban worktree' };
    }
    const root = await repositoryRootOf(canonical);
    if (!existsSync(canonical)) {
      if (root !== null) await runGit(root, ['worktree', 'prune']);
      return { removed: false, refused: false, code: 'already-gone', reason: 'the directory is already gone' };
    }
    if (root === null) return { removed: false, refused: true, code: 'no-repository', reason: `${canonical} is not a git working tree` };
    const dirty = await dirtyCount(canonical);
    if (dirty === -1) {
      return { removed: false, refused: true, code: 'no-repository', reason: 'git could not read the working tree' };
    }
    if (dirty > 0) {
      return {
        removed: false,
        refused: true,
        code: 'dirty',
        reason: `${canonical} has ${dirty} uncommitted change${dirty === 1 ? '' : 's'}`,
      };
    }
    const removed = await runGit(root, ['worktree', 'remove', canonical], { timeoutMs: WORKTREE_TIMEOUT_MS });
    if (!removed.ok) {
      return { removed: false, refused: true, code: 'remove-failed', reason: firstLine(removed.stderr) || `exit ${removed.code}` };
    }
    const name = poolNameOf(canonical);
    let branchDeleted = false;
    if (name !== null) {
      branchDeleted = (await runGit(root, ['branch', '-d', branchFor(name)], { timeoutMs: GIT_TIMEOUT_MS })).ok;
    }
    return { removed: true, refused: false, branchDeleted };
  } catch (error) {
    return { removed: false, refused: true, code: 'error', reason: reasonOf(error) };
  }
}

/**
 * The facts about a managed copy, in the shape the Forge panel's worktree
 * record carries. Used to announce a ticket's copy to the panel for a session
 * that was created in it — including one this process did not cut.
 *
 * `baseCommit` is the merge base with the upstream default branch, which is the
 * commit the branch started from for a copy with no commits of its own and the
 * point it diverged from for one that has.
 *
 * @returns {Promise<{path: string, branch: string, from: string | null, baseCommit: string, repositoryRoot: string} | null>}
 *   null when the path is not a copy this convention owns, or git cannot say.
 */
export async function describeWorktree(path) {
  const canonical = canonicalPath(path);
  if (canonical === null || poolNameOf(canonical) === null) return null;
  if (!existsSync(canonical)) return null;
  const root = await repositoryRootOf(canonical);
  if (root === null) return null;
  const branch = await gitText(canonical, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === undefined || branch === '' || branch === 'HEAD') return null;
  const head = await gitText(canonical, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head === undefined) return null;
  const from = (await hasOrigin(root)) ? ((await defaultBranchOf(root)) ?? 'main') : null;
  const remote = from === null
    ? undefined
    : await gitText(canonical, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${from}`]);
  if (remote === undefined) return { path: canonical, branch, from: null, baseCommit: head, repositoryRoot: root };
  const mergeBase = await gitText(canonical, ['merge-base', remote, 'HEAD']);
  return { path: canonical, branch, from, baseCommit: mergeBase ?? head, repositoryRoot: root };
}
