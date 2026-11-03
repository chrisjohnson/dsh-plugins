// dsh-kanban: the sudo dead end a sandboxed build cannot see its way out of.
//
// A build session that is not in Full access runs under the harness file
// sandbox, whose Landlock launcher sets `no_new_privs` on every confined child
// (mandatory for an unprivileged restrict). sudo checks that flag before it ever
// consults sudoers and refuses outright, so a ticket whose work needs sudo fails
// in a sandboxed build with a message that reads like a broken sudoers file and
// is not one — and no plan grant can lift it, because the grant denylist
// word-denies `sudo`. This module recognises that message in a turn's tool
// results and turns it into a park a human can act on: set the ticket's write
// mode to Full access, Retry. No dsh imports, no store: plain values in,
// decision out.

/** The sandbox mode a build has to be in for sudo to run at all. */
export const FULL_ACCESS_MODE = 'danger-full-access';

/** The default write mode when a ticket has no opinion (the engine's own default). */
export const DEFAULT_WRITE_MODE = 'workspace-write';

/**
 * Fragments of sudo's own refusal, matched case-insensitively. Either one is
 * specific enough to be the signature on its own: the first is the line sudo
 * prints, the second is the clause that names the tool it is refusing.
 */
const SIGNATURES = ['the "no new privileges" flag is set', 'prevents sudo from running as root'];

/** The board-facing prefix of a park raised here, so it is recognisable like the question park is. */
export const SUDO_PARK_PREFIX = 'sudo cannot run in this sandbox';

/** True when this write mode is the one that lets a build run sudo. */
export function isFullAccessMode(writeMode) {
  return writeMode === FULL_ACCESS_MODE;
}

/**
 * True when this text is sudo's `no_new_privs` refusal.
 *
 * An ordinary sudo failure — a missing rule, a password prompt in `-n` mode, a
 * bad path — says something else entirely and must not match: those are the
 * ticket's own problem, not the sandbox's.
 */
export function isNoNewPrivsSudoText(text) {
  if (typeof text !== 'string' || text === '') return false;
  const haystack = text.toLowerCase();
  return SIGNATURES.some((needle) => haystack.includes(needle));
}

/** The text one `tool/result` event carries, flattened the way a human read it. */
function resultText(event) {
  const data = event?.data;
  if (data === null || typeof data !== 'object') return '';
  const parts = [];
  const content = data.message?.content;
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block !== null && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  if (typeof data.error === 'string') parts.push(data.error);
  else if (data.error !== null && typeof data.error === 'object' && typeof data.error.message === 'string') parts.push(data.error.message);
  return parts.join('\n');
}

/**
 * The first `no_new_privs` sudo refusal in one turn's events, or null.
 *
 * Only `tool/result` events are read: that is where the command's own output
 * lands, and a refusal quoted in prose is not evidence that it happened.
 *
 * @param {Array<{type: string, data?: object}>} events the turn's session events
 * @returns {{text: string}|null} the matching result text, clipped
 */
export function detectNoNewPrivsSudo(events) {
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    if (event?.type !== 'tool/result') continue;
    const text = resultText(event);
    if (!isNoNewPrivsSudoText(text)) continue;
    const line = text.split('\n').find((l) => isNoNewPrivsSudoText(l)) ?? text;
    const clipped = line.trim();
    return { text: clipped.length > 240 ? `${clipped.slice(0, 237)}...` : clipped };
  }
  return null;
}

/**
 * The needs-attention reason for a build that hit the wall: it names the mode
 * the session actually ran under, so the fix is one click, not an investigation.
 */
export function sudoParkReason(writeMode) {
  const mode = typeof writeMode === 'string' && writeMode !== '' ? writeMode : DEFAULT_WRITE_MODE;
  return `${SUDO_PARK_PREFIX}: a session in the '${mode}' sandbox runs under no_new_privs, `
    + 'which sudo refuses to run under before it reads sudoers (the rules are not the problem). '
    + `Set this ticket's write mode to Full access ('${FULL_ACCESS_MODE}') and Retry to let the build run sudo.`;
}

/**
 * Whether a turn's result should park the ticket here instead of on the generic
 * "ended without submitting" failure. A Full-access build has no wall to hit, so
 * a match there is something else wearing the same words and the generic path
 * keeps its explanation.
 *
 * @param {{sudoBlocked?: {text: string}|null}} turn the settled turn
 * @param {string|null|undefined} writeMode the ticket's write mode
 */
export function sudoDeadEnd(turn, writeMode) {
  if (isFullAccessMode(writeMode)) return null;
  const hit = turn?.sudoBlocked ?? null;
  return hit === null || hit === undefined ? null : hit;
}
