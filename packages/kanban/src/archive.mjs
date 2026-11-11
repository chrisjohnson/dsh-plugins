// Archiving a closed ticket's workspace: the decisions, with no dsh imports.
//
// When a ticket closes, its managed working copy (the linked git worktree this
// plugin cut for it) and its sessions are clutter. Whether it is safe to clear
// them away is a pure question over the ticket, the other tickets and the
// configuration; the engine does the effects.

import { isAbsolute, normalize } from 'node:path';

import { TERMINAL_COLUMNS } from './lifecycle.mjs';
import { isInsideLiveCheckout } from './live-checkout.mjs';
import { isPoolPath } from './worktrees.mjs';

export const ARCHIVE_MODES = ['off', 'done', 'done_and_discarded'];

/** Canonical form of an absolute path for comparison: normalized, no trailing slash. */
export function canonicalPath(path) {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return null;
  return normalize(path).replace(/\/+$/, '') || '/';
}

/** Whether the mode asks for archiving a ticket that closed in `column`. */
export function archivesColumn(mode, column) {
  if (mode === 'done') return column === 'done';
  if (mode === 'done_and_discarded') return column === 'done' || column === 'discarded';
  return false;
}

/**
 * Whether a path sits inside a managed-worktree pool. The pool is two segments
 * deep (`<repo>/.agents/worktrees/<name>`), so the suffix test has to match both
 * segments and something after them.
 */
export function isManagedWorktreePath(path) {
  return isPoolPath(path);
}

/**
 * Why this ticket's workspace must not be archived, or null when it may.
 *
 * `silent: true` marks the cases that are simply "this ticket never had a
 * managed copy" — nothing was skipped, so nothing is worth a ticket event.
 *
 * @param {object} input
 * @param {object} input.ticket - the closed ticket.
 * @param {object[]} input.tickets - every ticket.
 * @param {{ticketId: string}[]} input.openSessions - every open session.
 * @param {string[]} [input.liveCheckouts] - absolute live checkout roots.
 */
export function archiveSkipReason({ ticket, tickets, openSessions, liveCheckouts = [] }) {
  const path = canonicalPath(ticket.workspaceCwd);
  if (path === null) return { reason: 'no_workspace', silent: true };
  if (!isManagedWorktreePath(path)) return { reason: 'not_a_managed_worktree', silent: true };
  for (const live of liveCheckouts) {
    const root = canonicalPath(live);
    if (root !== null && isInsideLiveCheckout(root, path)) return { reason: 'live_checkout', silent: false };
  }
  const openByTicket = new Set(openSessions.map((session) => session.ticketId));
  for (const other of tickets) {
    if (other.id === ticket.id) continue;
    if (canonicalPath(other.workspaceCwd) !== path) continue;
    if (!TERMINAL_COLUMNS.includes(other.column) || openByTicket.has(other.id)) {
      return { reason: 'shared_with_open_ticket', silent: false, detail: other.key };
    }
  }
  return null;
}

/**
 * Whether the removal's answer means the copy is gone, so the sessions may be
 * archived. A refusal never does; "nothing to remove" does only when the
 * directory really is absent (an earlier attempt removed it).
 */
export function copyIsGone(result, pathExists) {
  if (result === null || typeof result !== 'object') return false;
  if (result.removed === true) return true;
  if (result.refused === true) return false;
  if (result.code === 'already-gone') return true;
  return result.code === 'not-managed' && !pathExists;
}
