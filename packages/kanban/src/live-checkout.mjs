// The one rule for "is this path inside a live checkout", shared by the checkout
// guard and the archive decision. No dsh imports.
//
// Managed working copies (ticket worktrees and plugin clones) may sit inside the
// live checkout's directory, under its managed-worktree directory. They are
// clones, not the live checkout: only the live root itself and everything else
// under it stays protected.

import { normalize } from 'node:path';

/** Directory name, directly under a root, that holds every managed working copy. */
export const MANAGED_WORKTREES_DIR = '.dsh-worktrees';

function canon(path) {
  return normalize(path).replace(/\/+$/, '') || '/';
}

function within(root, path) {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
}

/**
 * Whether `path` is inside the live checkout `root`: within the root, and not
 * within `<root>/.dsh-worktrees` (the managed-worktree directory itself counts
 * as inside; a copy under it does not).
 */
export function isInsideLiveCheckout(root, path) {
  if (typeof root !== 'string' || typeof path !== 'string' || root === '' || path === '') return false;
  const r = canon(root);
  const p = canon(path);
  if (!within(r, p)) return false;
  const managed = r === '/' ? `/${MANAGED_WORKTREES_DIR}` : `${r}/${MANAGED_WORKTREES_DIR}`;
  return !p.startsWith(`${managed}/`);
}
