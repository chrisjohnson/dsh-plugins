// dsh-kanban: plan-time sandbox grants (KAN-30).
//
// A plan may declare, next to its conditions, the sandbox escalations its
// build session will need beyond its standing write mode: absolute paths it
// must write outside the workspace, and token-prefix commands the standing
// sandbox would deny. The human approving the plan is the one-time grant;
// from then on an agent-scoped `approval/request` waterfall listener answers
// `allowed-once` for exactly the covered asks and falls through to the human
// for everything else.
//
// The listener is a pure decision module: no dsh imports, everything it reads
// (the store, the session log) is passed in, so the whole matrix is testable
// on a bare clone.
//
// Two invariants hold no matter what a plan declares:
//
// - The denylist is never claimable. A service restart, a `sudo`, an `rm` can
//   never be auto-approved by a grant, even one a human approved — those asks
//   always reach the human. The grant mechanism can therefore never restart a
//   service or delete outside the sandbox's own rules.
// - Every miss, malformed input, or exception calls `next()`: the human stays
//   the answerer of last resort. A broken grant path fails open to a prompt,
//   never closed to a silent denial.

import { isAbsolute, normalize, resolve } from 'node:path';

/**
 * First command tokens that may never be covered by a grant, whatever the plan
 * declared and whatever the human approved. `rm` is here because a granted
 * `rm` outside the workspace is a deletion the sandbox was built to make the
 * human decide; the `rm -rf /` substrings below catch the compound spellings.
 */
export const GRANT_DENYLIST = Object.freeze(['systemctl', 'service', 'launchctl', 'sudo', 'kill', 'pkill', 'rm', 'dd']);

/** Substrings that mark a command destructive no matter where they appear in it. */
export const GRANT_DENYLIST_SUBSTRINGS = Object.freeze(['rm -rf /', 'rm -fr /']);

/**
 * Wrappers whose real command is the token after them (`sudo X`, `env X=1 Y`)
 * or after a `-c`-style flag (`sh -c "..."`, `timeout 5 bash -lc "..."`).
 * The denylist looks through these so `bash -c "systemctl restart dsh"` is
 * caught the same as `systemctl restart dsh`.
 */
const DENYLIST_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'env', 'nohup', 'timeout', 'nice', 'time', 'command']);

/**
 * Split a command line into whitespace-delimited tokens. Quote characters are
 * stripped from each token rather than honoured as grouping: this is a denylist
 * backstop, and `bash -c "systemctl restart dsh"` must read as the tokens
 * `systemctl restart dsh` no matter how the shell quoting arrived.
 */
function tokenize(command) {
  return String(command)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/["'`]/g, ''))
    .filter(Boolean);
}

/** The basename of a possible path-shaped token: `/usr/bin/sudo` counts as `sudo`. */
function baseToken(token) {
  const slash = token.lastIndexOf('/');
  return slash === -1 ? token : token.slice(slash + 1);
}

/**
 * Whether a command line is denylisted: a denylisted first token (looking
 * through common wrappers like `sudo`, `env`, `timeout`, `bash -c`), or a
 * denylisted substring anywhere in it.
 *
 * @param {unknown} command
 * @returns {boolean}
 */
export function isDenylisted(command) {
  if (typeof command !== 'string' || command.trim() === '') return false;
  const text = command.trim();
  const lower = text.toLowerCase();
  for (const pattern of GRANT_DENYLIST_SUBSTRINGS) if (lower.includes(pattern)) return true;
  const tokens = tokenize(text);
  let i = 0;
  // Walk the wrapper chain: `sudo env FOO=1 systemctl ...`, `timeout 10 bash -c "..."`.
  for (let hop = 0; hop < 8 && i < tokens.length; hop += 1) {
    const token = baseToken(tokens[i]);
    if (GRANT_DENYLIST.includes(token)) return true;
    if (!DENYLIST_WRAPPERS.has(token)) return false;
    i += 1;
    // Skip the wrapper's own flags, assignments and numeric arguments to reach
    // the command it runs. A `-c`-style flag hands the rest to the shell.
    while (i < tokens.length && (/^-\w*c\w*$/.test(tokens[i]) || tokens[i].includes('=') || /^\d+(\.\d+)?$/.test(tokens[i]))) {
      if (/^-\w*c\w*$/.test(tokens[i])) {
        const script = tokens.slice(i + 1).join(' ');
        if (script !== '' && isDenylisted(script)) return true;
      }
      i += 1;
    }
  }
  return false;
}

/**
 * Whether `command` starts with the grant's tokens, at word boundaries:
 * grant `git push` matches `git push origin main`, never `git pushfoo`.
 */
function commandMatches(grant, command) {
  const grantTokens = tokenize(grant);
  const commandTokens = tokenize(command);
  if (grantTokens.length === 0 || commandTokens.length < grantTokens.length) return false;
  for (let i = 0; i < grantTokens.length; i += 1) if (grantTokens[i] !== commandTokens[i]) return false;
  return true;
}

/**
 * Whether `filePath` is `root` itself or lives under it at a path-segment
 * boundary: `/a/b` grants `/a/b/c.txt` but never `/a/bc`.
 */
function pathMatches(root, filePath) {
  if (typeof root !== 'string' || typeof filePath !== 'string' || root === '' || filePath === '') return false;
  const normalizedRoot = normalize(root);
  const normalizedPath = normalize(filePath);
  if (normalizedPath === normalizedRoot) return true;
  return normalizedPath.startsWith(normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`);
}

/** True when a plan's sandbox section declares at least one grant. */
export function hasGrants(sandbox) {
  const grants = sandbox?.grants;
  if (grants === null || typeof grants !== 'object') return false;
  return (Array.isArray(grants.paths) && grants.paths.length > 0) || (Array.isArray(grants.commands) && grants.commands.length > 0);
}

/** How many grants a sandbox section declares (paths + commands). */
export function countGrants(sandbox) {
  const grants = sandbox?.grants;
  if (grants === null || typeof grants !== 'object') return 0;
  return (Array.isArray(grants.paths) ? grants.paths.length : 0) + (Array.isArray(grants.commands) ? grants.commands.length : 0);
}

/**
 * The matcher: given a plan's grants and one tool call, decide whether the
 * call is covered. Returns the matched grant string, or null.
 *
 * - `bash`: a command grant matches by token prefix.
 * - `write` / `edit`: a path grant matches by path-segment containment of
 *   `file_path` under the granted root.
 *
 * The denylist is applied here too — a covered call whose command is
 * denylisted is never a match, even if a human approved a plan declaring it.
 *
 * @param {{grants: {paths?: string[], commands?: string[]}|null, toolName: string, arguments: object|null}} input
 * @returns {string|null}
 */
export function matchGrant({ grants, toolName, arguments: args }) {
  if (grants === null || grants === undefined || typeof grants !== 'object') return null;
  if (args === null || args === undefined || typeof args !== 'object') return null;
  if (toolName === 'bash') {
    const command = typeof args.command === 'string' ? args.command : '';
    if (command === '' || isDenylisted(command)) return null;
    for (const grant of Array.isArray(grants.commands) ? grants.commands : []) {
      if (typeof grant === 'string' && commandMatches(grant, command)) return grant;
    }
    return null;
  }
  if (toolName === 'write' || toolName === 'edit') {
    const filePath = typeof args.file_path === 'string' ? args.file_path : '';
    if (filePath === '') return null;
    for (const grant of Array.isArray(grants.paths) ? grants.paths : []) {
      if (typeof grant === 'string' && pathMatches(grant, filePath)) return grant;
    }
    return null;
  }
  return null;
}

/** The escalation reason prefix the sandbox approval service stamps on every ask. */
export const ESCALATION_REASON_PREFIX = 'escalate sandbox to ';

/** Parse the mode out of an escalation reason; null when it is not one. */
export function escalationMode(reason) {
  if (typeof reason !== 'string' || !reason.startsWith(ESCALATION_REASON_PREFIX)) return null;
  const rest = reason.slice(ESCALATION_REASON_PREFIX.length);
  const colon = rest.indexOf(':');
  const mode = colon === -1 ? rest : rest.slice(0, colon);
  return mode.trim() === '' ? null : mode.trim();
}

/**
 * The tool/call arguments for one callId, read from the session's durable log.
 * The approval request carries only tool name and call id; the exact paths and
 * commands live in the `tool/call` event the agent loop appended for the call
 * being escalated.
 */
function callArguments(agent, callId) {
  const events = agent?.session?.snapshotEvents?.();
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'tool/call') continue;
    if (event.data?.callId !== callId) continue;
    const raw = event.data?.arguments;
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The grants of the ticket's latest plan artifact, or null when there are none. */
function grantsForTicket(store, ticketId) {
  const artifact = store.latestArtifact(ticketId, 'plan');
  if (artifact === undefined || artifact === null || typeof artifact.content !== 'string') return null;
  let plan;
  try {
    plan = JSON.parse(artifact.content);
  } catch {
    return null;
  }
  const grants = plan?.sandbox?.grants;
  if (grants === null || grants === undefined || typeof grants !== 'object') return null;
  if (!hasGrants(plan?.sandbox)) return null;
  return grants;
}

/**
 * Build the `approval/request` waterfall listener for one build session.
 *
 * Registered on the agent scope (so it only ever sees its own agent's asks)
 * with `prepend`, so a covered ask is answered before the human bridge is
 * reached. On a match it records a `grant_applied` ticket event and returns
 * `'allowed-once'`; on every miss it returns `next()` and the human answers.
 *
 * @param {{store: object, log?: object}} deps - the board store and a logger.
 * @returns {(req: object, next: () => unknown) => unknown}
 */
export function makeGrantApprover({ store, log }) {
  const warn = (fmt, ...args) => {
    try {
      log?.warn?.(fmt, ...args);
    } catch {
      // A broken logger must never change an approval outcome.
    }
  };
  return function grantApprover(req, next) {
    try {
      const mode = escalationMode(req?.reason);
      if (mode === null) return next();
      const callId = req?.callId;
      const toolName = req?.toolName;
      const agent = req?.agent;
      const sessionId = agent?.id;
      if (typeof callId !== 'string' || callId === '') return next();
      if (typeof toolName !== 'string' || toolName === '') return next();
      if (typeof sessionId !== 'string' || sessionId === '') return next();
      const session = store.findSession(sessionId);
      const ticketId = session?.ticketId ?? null;
      if (ticketId === null || ticketId === undefined) return next();
      const ticket = store.getTicket(ticketId);
      if (ticket === undefined || ticket === null) return next();
      if (ticket.column === 'done' || ticket.column === 'discarded') return next();
      // Grants are only live once the human has approved the plan: a ticket
      // still parked on the Plan-ready reason has an answerer waiting — the
      // human — and nothing may escalate ahead of that decision.
      if (typeof ticket.needsAttentionReason === 'string' && ticket.needsAttentionReason.startsWith(PLAN_READY_PREFIX)) return next();
      const grants = grantsForTicket(store, ticketId);
      if (grants === null) return next();
      const args = callArguments(agent, callId);
      if (args === null) return next();
      const grant = matchGrant({ grants, toolName, arguments: args });
      if (grant === null) return next();
      const target = toolName === 'bash' ? args.command : args.file_path;
      try {
        store.appendEvent(ticketId, 'grant_applied', {
          actor: 'engine',
          phaseFrom: ticket.phase,
          phaseTo: ticket.phase,
          payload: { toolName, callId, grant, mode, target },
        });
      } catch (error) {
        // The audit event is the point of the grant; if it cannot be written,
        // do not answer silently — let the human decide instead.
        warn('kanban grants: could not record grant_applied for %s: %s', ticketId, String(error?.message ?? error));
        return next();
      }
      warn('kanban grants: %s auto-approved %s call %s under grant "%s" (%s)', ticketId, toolName, callId, grant, mode);
      return 'allowed-once';
    } catch (error) {
      warn('kanban grants: approver failed open to the human: %s', String(error?.stack ?? error));
      return next();
    }
  };
}

/** The needs-attention prefix that marks a plan awaiting the human's approval. */
export const PLAN_READY_PREFIX = 'Plan ready:';

/** The park reason a plan with grants leaves behind, for the human to approve. */
export function planReadyReason(count) {
  return `${PLAN_READY_PREFIX} ${count} sandbox grant(s) declared — approve the plan to start the build, or submit a new plan.`;
}

/** True when a park reason is the Plan-ready park. */
export function isPlanReady(reason) {
  return typeof reason === 'string' && reason.startsWith(PLAN_READY_PREFIX);
}

/**
 * Validate and normalize one plan's `sandbox` section. Returns
 * `{sandbox: object|null, errors: string[]}`; `sandbox` is null when the plan
 * declared none, and errors name every rejected entry.
 */
export function validateSandbox(sandbox) {
  const errors = [];
  if (sandbox === undefined || sandbox === null) return { sandbox: null, errors };
  if (typeof sandbox !== 'object' || Array.isArray(sandbox)) {
    return { sandbox: null, errors: ['sandbox must be an object with grants and/or checks'] };
  }
  const out = {};
  const grants = sandbox.grants;
  if (grants !== undefined && grants !== null) {
    if (typeof grants !== 'object' || Array.isArray(grants)) {
      errors.push('sandbox.grants must be an object with paths and/or commands');
    } else {
      const paths = [];
      const commands = [];
      if (grants.paths !== undefined && grants.paths !== null) {
        if (!Array.isArray(grants.paths)) errors.push('sandbox.grants.paths must be an array of absolute paths');
        else {
          grants.paths.forEach((path, index) => {
            if (typeof path !== 'string' || path.trim() === '') {
              errors.push(`sandbox.grants.paths[${index}] must be a non-empty string`);
              return;
            }
            if (!isAbsolute(path)) {
              errors.push(`sandbox.grants.paths[${index}] "${path}" must be an absolute path`);
              return;
            }
            // A stored grant root never carries a trailing slash (except the
            // root itself), so the artifact shows one canonical spelling.
            paths.push(normalize(path).replace(/\/+$/, '') || '/');
          });
        }
      }
      if (grants.commands !== undefined && grants.commands !== null) {
        if (!Array.isArray(grants.commands)) errors.push('sandbox.grants.commands must be an array of command prefixes');
        else {
          grants.commands.forEach((command, index) => {
            if (typeof command !== 'string' || command.trim() === '') {
              errors.push(`sandbox.grants.commands[${index}] must be a non-empty string`);
              return;
            }
            if (isDenylisted(command)) {
              errors.push(`sandbox.grants.commands[${index}] "${command.trim()}" is denylisted and can never be granted`);
              return;
            }
            commands.push(command.trim());
          });
        }
      }
      out.grants = { paths, commands };
    }
  }
  const checks = sandbox.checks;
  if (checks !== undefined && checks !== null) {
    if (!Array.isArray(checks)) errors.push('sandbox.checks must be an array of {path, check, observed}');
    else {
      const rows = [];
      checks.forEach((row, index) => {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) {
          errors.push(`sandbox.checks[${index}] must be an object with path, check and observed`);
          return;
        }
        if (typeof row.path !== 'string' || row.path.trim() === '') errors.push(`sandbox.checks[${index}].path is required`);
        if (typeof row.check !== 'string' || row.check.trim() === '') errors.push(`sandbox.checks[${index}].check is required`);
        if (typeof row.observed !== 'string' || row.observed.trim() === '') errors.push(`sandbox.checks[${index}].observed is required`);
        rows.push({ path: String(row.path ?? ''), check: String(row.check ?? ''), observed: String(row.observed ?? '') });
      });
      out.checks = rows;
    }
  }
  if (out.grants === undefined && out.checks === undefined) return { sandbox: null, errors };
  return { sandbox: out, errors };
}

/** Resolve a path for display in prompts and errors (pure, no fs access). */
export function displayPath(cwd, path) {
  if (typeof path !== 'string' || path === '') return String(path ?? '');
  return isAbsolute(path) ? normalize(path) : resolve(cwd ?? '.', path);
}
