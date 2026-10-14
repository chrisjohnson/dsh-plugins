// Which directories this plugin may delete. Removing a working copy is an
// `rm -rf`, and the path comes out of a JSON file, so the registry's record is
// not trusted by itself: a path must still sit under a root this plugin has
// written to, or the removal is refused.

import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** Directory name that holds every managed working copy of a checkout. */
export const WORKTREES_DIR = '.dsh-worktrees'

/**
 * Every root this plugin has ever written to. The current layout is
 * `<base>/<pet-name>`, where `<base>` is `<repo>/.dsh-worktrees`, or the same
 * name under the home directory for a checkout that cannot host one. Copies made
 * before that layout carry this plugin's name as an extra segment, one level
 * deeper inside a base this list already covers.
 */
export function removalBases(repoRoot, home = homedir()) {
  return [
    resolve(join(repoRoot, WORKTREES_DIR)),
    resolve(join(home, WORKTREES_DIR)),
    resolve(join(home, WORKTREES_DIR, 'dsh-better-git-worktree')),
  ]
}

/**
 * The resolved directory to delete for a registry record.
 * @throws when the path is outside every managed root.
 */
export function assertRemovable(managedRoot, repoRoot, home = homedir()) {
  const resolved = resolve(managedRoot)
  const bases = removalBases(repoRoot, home)
  if (!bases.some((base) => resolved.startsWith(`${base}${sep}`))) {
    throw new Error(`refusing to remove ${resolved}: it is outside the managed worktree roots ${bases.join(', ')}`)
  }
  return resolved
}
