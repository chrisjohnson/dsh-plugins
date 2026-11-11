// dsh-kanban: checkout isolation between tickets and protection of the live
// checkout.
//
// Two rules, both applied to sandbox-escalation asks a build session raises:
//
// - Cross-ticket access. A session that belongs to ticket A is denied, not
//   prompted, when an escalation targets the workspace, worktree or clone of
//   another OPEN ticket B. Ownership comes from two sources: B's recorded
//   workspace, and the naming convention every build follows for the clones it
//   cuts: a path segment `kan<number>` or `kan<number>-<name>` (for example
//   `kan12-plugins`, `kan12-deploy`) belongs to ticket KAN-<number>. Reading a
//   closed (done or discarded) ticket's workspace is not blocked.
// - Live checkout. Paths named in configuration are the live deployment
//   checkouts. A write there is denied, except the approval-phase pre-stage:
//   `git pull --ff-only`, `pnpm install` and `pnpm run check`, run from the
//   checkout root or its `.dsh/profiles/web` directory, from a ticket in the
//   approval phase. Read-only commands pass through untouched. Managed working
//   copies under a live checkout's `.agents/worktrees` directory are clones, not
//   the live checkout, and are not protected by this rule.
//
// "Deny" means the ask resolves `rejected` without a human being asked. A pass
// means `next()`: the grant approver and then the human decide exactly as
// before. This module can only ever remove an auto-approval or a prompt, never
// add an approval. Like the grant matcher it is a text rule, not a sandbox: it
// cannot see inside an interpreter or a script the build wrote.
//
// Pure: no dsh imports, everything it reads is passed in.

import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

import { resolvePathToken as resolvePath, segmentWords as words, splitSegments } from './command-paths.mjs';
import { callArguments, escalationMode } from './grants.mjs';
import { isInsideLiveCheckout } from './live-checkout.mjs';

const OPEN_COLUMNS = new Set(['backlog', 'working']);
const SEGMENT = /^kan(\d+)(?:-.+)?$/i;

/** The numeric part of a ticket key: `KAN-12` is 12; null when it has none. */
export function ticketNumber(key) {
  const match = /^[A-Za-z]+-(\d+)$/.exec(String(key ?? ''));
  return match === null ? null : Number(match[1]);
}

/** The clone-name prefix a ticket's builds use: `KAN-12` is `kan12`. */
export function clonePrefix(key) {
  const number = ticketNumber(key);
  return number === null ? null : `kan${number}`;
}

/** The names a build's plugin and deploy clones take: `kan12-plugins`, `kan12-deploy`. */
export function cloneNames(key) {
  const prefix = clonePrefix(key);
  return prefix === null ? null : { plugins: `${prefix}-plugins`, deploy: `${prefix}-deploy` };
}

/** Whether `path` is `root` or lives under it at a segment boundary. */
export function isWithin(root, path) {
  if (typeof root !== 'string' || typeof path !== 'string' || root === '' || path === '') return false;
  const r = normalize(root).replace(/\/+$/, '') || '/';
  const p = normalize(path).replace(/\/+$/, '') || '/';
  return p === r || p.startsWith(r === '/' ? '/' : `${r}/`);
}

/** The open-ticket test: only Backlog and Working tickets own their checkouts. */
export function isOpen(ticket) {
  return OPEN_COLUMNS.has(ticket?.column);
}

const READ_ONLY_COMMANDS = new Set([
  'cat', 'ls', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'grep', 'egrep', 'fgrep', 'rg', 'diff',
  'tree', 'du', 'df', 'pwd', 'echo', 'printf', 'test', '[', 'realpath', 'readlink', 'basename', 'dirname',
  'find', 'which', 'sha256sum', 'md5sum', 'cut', 'sort', 'uniq', 'true',
]);
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-remote', 'describe', 'blame', 'cat-file', 'rev-list', 'shortlog']);
const FIND_WRITES = new Set(['-delete', '-exec', '-execdir', '-ok', '-fprint', '-fprintf', '-fls']);

// `git fetch` only updates remote-tracking refs and FETCH_HEAD. These flags keep
// it that way; a refspec (anything with `:`), `--force`, `--prune` and the like
// can reach local branches or delete refs, so they are not read-only.
const FETCH_FLAGS = new Set(['-q', '--quiet', '-v', '--verbose', '--tags', '--no-tags', '--all', '--dry-run']);

function gitFetchReadOnly(args) {
  return args.every((arg) => (arg.startsWith('-') ? FETCH_FLAGS.has(arg) : !arg.includes(':')));
}

/**
 * Whether the segment starts with one of the configured read-only command
 * prefixes (token prefix at word boundaries). The deployment, not this plugin,
 * says which of its own commands only inspect.
 */
function configuredReadOnly(tokens, prefixes) {
  for (const prefix of prefixes) {
    const want = String(prefix).trim().split(/\s+/).filter(Boolean);
    if (want.length === 0 || tokens.length < want.length) continue;
    if (want.every((token, index) => tokens[index] === token)) return true;
  }
  return false;
}

// Redirects that write nowhere: stderr folded into stdout, or output to /dev/null.
const BENIGN_REDIRECT_WORD = /^(?:\d*>&\d+|&?\d*>>?\/dev\/null)$/;
const BENIGN_REDIRECT = /\d*>&\d+|&?\d*>>?\s*\/dev\/null/g;

function readOnlySegment(tokens, rawSegment, extraPrefixes = []) {
  if (/[<>]|\$\(|`/.test(rawSegment.replace(BENIGN_REDIRECT, ''))) return false;
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  if (configuredReadOnly(tokens.slice(i).filter((t) => !BENIGN_REDIRECT_WORD.test(t)), extraPrefixes)) return true;
  const head = (tokens[i] ?? '').split('/').pop();
  if (head === 'git') {
    let j = i + 1;
    while (j < tokens.length && tokens[j].startsWith('-')) j += tokens[j] === '-C' ? 2 : 1;
    if (tokens[j] === 'fetch') return gitFetchReadOnly(tokens.slice(j + 1).filter((t) => !BENIGN_REDIRECT_WORD.test(t)));
    return READ_ONLY_GIT.has(tokens[j] ?? '');
  }
  if (head === 'find') return !tokens.some((t) => FIND_WRITES.has(t));
  return READ_ONLY_COMMANDS.has(head);
}

/**
 * Whether one command segment, run in `cwd`, is the approval-phase pre-stage of
 * a live checkout rooted at `live`: `git pull --ff-only`, `pnpm install`,
 * `pnpm run check`, from the root or its web profile directory.
 */
function prestageSegment(tokens, cwd, live) {
  if (tokens.some((t) => /[<>]/.test(t))) return false;
  const base = [live, join(live, '.dsh/profiles/web')];
  const atBase = (dir) => base.includes(normalize(dir));
  const first = tokens[0];
  if (first === 'git') {
    let dir = cwd;
    let j = 1;
    if (tokens[j] === '-C' && tokens[j + 1] !== undefined) {
      dir = tokens[j + 1];
      j += 2;
    }
    if (tokens[j] !== 'pull' || tokens[j + 1] !== '--ff-only') return false;
    if (tokens.slice(j + 2).some((t) => t.startsWith('-'))) return false;
    return normalize(dir) === live;
  }
  if (first === 'pnpm') {
    let dir = cwd;
    let j = 1;
    if ((tokens[j] === '--dir' || tokens[j] === '-C') && tokens[j + 1] !== undefined) {
      dir = tokens[j + 1];
      j += 2;
    }
    const rest = tokens.slice(j);
    const install = rest[0] === 'install' && rest.slice(1).every((t) => t === '--frozen-lockfile');
    const check = rest.length === 2 && rest[0] === 'run' && rest[1] === 'check';
    return (install || check) && atBase(dir);
  }
  return false;
}

/**
 * Decide one escalation ask. Returns `{deny: false}` to let the ask continue to
 * the grant approver and the human, or `{deny: true, kind, message, path, owner?}`.
 *
 * @param {object} input
 * @param {{key: string, phase: string, workspaceCwd?: string|null}} input.ticket - the session's own ticket.
 * @param {Array<{key: string, column: string, workspaceCwd?: string|null}>} input.tickets - every ticket.
 * @param {string} input.toolName
 * @param {object|null} input.arguments
 * @param {string} input.cwd - the session's working directory.
 * @param {string[]} [input.liveCheckouts] - absolute live checkout roots.
 * @param {string[]} [input.readOnlyCommands] - command prefixes the deployment treats as read-only inspection in a live checkout.
 * @param {string} [input.home]
 */
export function evaluateGuard({ ticket, tickets, toolName, arguments: args, cwd, liveCheckouts = [], readOnlyCommands = [], home = homedir() }) {
  const pass = { deny: false };
  if (ticket === undefined || ticket === null || args === null || args === undefined || typeof args !== 'object') return pass;
  const lives = (Array.isArray(liveCheckouts) ? liveCheckouts : [])
    .filter((p) => typeof p === 'string' && isAbsolute(p))
    .map((p) => normalize(p).replace(/\/+$/, '') || '/');
  const selfNumber = ticketNumber(ticket.key);
  const selfRoot = typeof ticket.workspaceCwd === 'string' && ticket.workspaceCwd !== '' ? ticket.workspaceCwd : null;
  const others = (Array.isArray(tickets) ? tickets : []).filter((t) => t.key !== ticket.key);
  const base = typeof cwd === 'string' && cwd !== '' ? cwd : '/';

  const crossTicket = (path) => {
    // The session's own workspace wins over any name its path happens to carry.
    if (selfRoot !== null && isWithin(selfRoot, path)) return null;
    for (const other of others) {
      if (!isOpen(other)) continue;
      if (typeof other.workspaceCwd === 'string' && other.workspaceCwd !== '' && isWithin(other.workspaceCwd, path)) return other;
    }
    for (const segment of normalize(path).split('/')) {
      const match = SEGMENT.exec(segment);
      if (match === null) continue;
      const number = Number(match[1]);
      if (number === selfNumber) continue;
      const owner = others.find((t) => ticketNumber(t.key) === number);
      if (owner !== undefined && isOpen(owner)) return owner;
    }
    return null;
  };
  const crossDeny = (owner, path) => ({
    deny: true,
    kind: 'cross_ticket',
    owner: owner.key,
    path,
    message: `${ticket.key} may not use ${path}: it belongs to ${owner.key}, which is still open. Work only in your own workspace and in clones named ${clonePrefix(ticket.key) ?? 'kan<number>'}-<name>.`,
  });
  const liveOf = (path) => lives.find((l) => isInsideLiveCheckout(l, path)) ?? null;

  if (toolName === 'write' || toolName === 'edit') {
    if (typeof args.file_path !== 'string' || args.file_path === '') return pass;
    const path = resolvePath(args.file_path, base, home);
    const owner = crossTicket(path);
    if (owner !== null) return crossDeny(owner, path);
    if (liveOf(path) !== null) {
      return { deny: true, kind: 'live_checkout', path, message: `${ticket.key} may not write to the live checkout (${path}). Make the change in a ticket worktree.` };
    }
    return pass;
  }

  if (toolName !== 'bash' || typeof args.command !== 'string' || args.command.trim() === '') return pass;

  let dir = base;
  for (const raw of splitSegments(args.command)) {
    const tokens = words(raw);
    if (tokens.length === 0) continue;
    const paths = tokens
      .filter((t) => t.includes('/') || t.startsWith('~') || t.startsWith('$HOME') || /^kan\d+/i.test(t))
      .map((t) => t.replace(/^[^/~$.A-Za-z0-9]+/, '').replace(/[,;)]+$/, ''))
      .filter(Boolean)
      .map((t) => resolvePath(t, dir, home));
    if (tokens[0] === 'cd' && tokens[1] !== undefined) {
      const target = resolvePath(tokens[1], dir, home);
      const owner = crossTicket(target);
      if (owner !== null) return crossDeny(owner, target);
      dir = target;
      continue;
    }
    for (const path of [...paths, dir]) {
      const owner = crossTicket(path);
      if (owner !== null) return crossDeny(owner, path);
    }
    const touched = [...paths, dir].map(liveOf).find((l) => l !== null) ?? null;
    if (touched === null) continue;
    const resolved = tokens.map((t, i) => (i > 0 && (t.startsWith('/') || t.startsWith('~')) ? resolvePath(t, dir, home) : t));
    const staged = ticket.phase === 'verify' && prestageSegment(resolved, dir, touched);
    if (staged || readOnlySegment(tokens, raw, readOnlyCommands)) continue;
    return {
      deny: true,
      kind: 'live_checkout',
      path: touched,
      message: `${ticket.key} may not modify the live checkout (${touched}). Read-only inspection (including git fetch and any command listed in liveCheckoutReadOnlyCommands) and the approval-phase pre-stage (git pull --ff-only, pnpm install, pnpm run check) are allowed there.`,
    };
  }
  return pass;
}

const RULE_NAMES = Object.freeze({
  cross_ticket: 'cross-ticket isolation',
  live_checkout: 'live-checkout protection',
});

/**
 * The note steered into a denied session. The approval service reports a
 * rejection to the model as the bare "the user rejected escalating this ..." and
 * nothing more, which reads as a human saying no; a session that believes that
 * stops to ask the human why. This says what actually happened and what to do.
 */
export function denialNote(decision, ticket) {
  const prefix = clonePrefix(ticket?.key) ?? 'kan<number>';
  return [
    `That escalation was refused by a policy rule, not by a person: ${RULE_NAMES[decision.kind] ?? decision.kind}, path ${decision.path}.`,
    'Nobody reviewed or rejected it, so do not ask the human about it and do not retry it.',
    `Do the work in your ticket's own worktree, or in a clone named ${prefix}-<name>, or use a command your approved plan grants.`,
    decision.message,
  ].join(' ');
}

/** The configured read-only command prefixes: non-empty strings only. */
export function resolveReadOnlyCommands(config) {
  const list = Array.isArray(config?.liveCheckoutReadOnlyCommands) ? config.liveCheckoutReadOnlyCommands : [];
  return list.filter((c) => typeof c === 'string' && c.trim() !== '').map((c) => c.trim());
}

/** Live checkout roots from configuration and the environment, absolute only, deduplicated. */
export function resolveLiveCheckouts(config, env = process.env) {
  const fromConfig = Array.isArray(config?.liveCheckouts) ? config.liveCheckouts : [];
  const fromEnv = typeof env?.DSH_KANBAN_LIVE_CHECKOUTS === 'string' ? env.DSH_KANBAN_LIVE_CHECKOUTS.split(':') : [];
  const out = [];
  for (const p of [...fromConfig, ...fromEnv]) {
    if (typeof p !== 'string' || !isAbsolute(p)) continue;
    const n = normalize(p).replace(/\/+$/, '') || '/';
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Build the `approval/request` waterfall listener. Registered after (so it runs
 * before) the grant approver: a deny can never be overridden by a grant.
 * Every miss, malformed input or exception calls `next()`.
 */
export function makeGuardApprover({ store, log, getLiveCheckouts = () => [], getReadOnlyCommands = () => [], steer = null }) {
  const warn = (fmt, ...a) => {
    try {
      log?.warn?.(fmt, ...a);
    } catch {
      // A broken logger never changes an outcome.
    }
  };
  return function guardApprover(req, next) {
    try {
      if (escalationMode(req?.reason) === null) return next();
      const agent = req?.agent;
      const session = store.findSession(agent?.id);
      const ticketId = session?.ticketId ?? null;
      if (ticketId === null) return next();
      const ticket = store.getTicket(ticketId);
      if (ticket === undefined || ticket === null) return next();
      if (ticket.column === 'done' || ticket.column === 'discarded') return next();
      const args = callArguments(agent, req?.callId);
      if (args === null) return next();
      const decision = evaluateGuard({
        ticket,
        tickets: store.listTickets(),
        toolName: req.toolName,
        arguments: args,
        cwd: ticket.workspaceCwd ?? agent?.session?.meta?.cwd ?? process.cwd(),
        liveCheckouts: getLiveCheckouts(),
        readOnlyCommands: getReadOnlyCommands(),
      });
      if (!decision.deny) return next();
      try {
        store.appendEvent(ticketId, 'guard_denied', {
          actor: 'engine',
          phaseFrom: ticket.phase,
          phaseTo: ticket.phase,
          payload: { kind: decision.kind, toolName: req.toolName, callId: req.callId, path: decision.path, owner: decision.owner ?? null, message: decision.message },
        });
      } catch (error) {
        warn('kanban guard: could not record guard_denied for %s: %s', ticketId, String(error?.message ?? error));
      }
      warn('kanban guard: %s', decision.message);
      // The rejection alone reads to the model as a human refusal. Steer the
      // reason into the session; a failure here must never change the outcome.
      if (typeof steer === 'function') {
        try {
          steer(agent, { text: denialNote(decision, ticket), summary: `Policy denial (${RULE_NAMES[decision.kind] ?? decision.kind}), not a human decision` });
        } catch (error) {
          warn('kanban guard: could not steer the denial reason into %s: %s', ticketId, String(error?.message ?? error));
        }
      }
      return 'rejected';
    } catch (error) {
      warn('kanban guard: failed open to the next approver: %s', String(error?.stack ?? error));
      return next();
    }
  };
}
