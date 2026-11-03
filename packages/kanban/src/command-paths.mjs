// dsh-kanban: the absolute paths a bash command line names.
//
// A text rule shared by the grant matcher and the checkout guard: split the line
// into shell segments, follow `cd` the way a shell would, and report every path
// the command names, resolved against the directory it runs in. It reads the
// text of the line and nothing else: it cannot see inside a script, an
// interpreter, a variable or a symlink, and it says so by refusing (`ok: false`)
// the forms it cannot read (command substitution, subshells, nested `sh -c`
// strings, an unresolvable variable) rather than guessing.
//
// Pure: no dsh imports.

import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';

/** Expand a leading `~`, `$HOME` or `${HOME}`; any other `~user` or variable is left as is. */
export function expandHome(token, home) {
  if (token === '~' || token.startsWith('~/')) return join(home, token.slice(1));
  const braced = /^\$\{HOME\}(?=\/|$)/.exec(token);
  if (braced !== null) return join(home, token.slice(braced[0].length));
  const plain = /^\$HOME(?=\/|$)/.exec(token);
  if (plain !== null) return join(home, token.slice(plain[0].length));
  return token;
}

/** Resolve one path token against `cwd`, expanding the home spellings. */
export function resolvePathToken(token, cwd, home) {
  const expanded = expandHome(token, home);
  return isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded);
}

/** Whitespace words of one segment, outer quotes stripped. */
export function segmentWords(segment) {
  return segment.trim().split(/\s+/).map((w) => w.replace(/^["']|["']$/g, '')).filter(Boolean);
}

/** The shell segments of a line: `&&`, `||`, `;`, `|` and newlines separate them. */
export function splitSegments(command) {
  return String(command).split(/&&|\|\||[;|\n\r]/).map((s) => s.trim()).filter(Boolean);
}

const HOME_PREFIX = /^\$(?:\{HOME\}|HOME)(?=\/|$)/;
const REDIRECT_PREFIX = /^(?:\d*|&)(?:>>?|<)&?/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/;
const NESTED_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const NESTED_EXEC = new Set(['eval', 'exec', 'source', '.', 'xargs']);

/**
 * The path-looking part of one word, or null when it names no path. A word
 * names a path when it contains `/` or starts with `~` or `$HOME`, after a
 * redirect operator, an option's `=value` or an `NAME=value` assignment is
 * peeled off.
 */
function pathCandidate(word) {
  let w = word.replace(REDIRECT_PREFIX, '');
  if (w === '') return null;
  const assignment = ASSIGNMENT.exec(w);
  if (assignment !== null) w = assignment[1];
  else if (w.startsWith('-')) {
    const eq = w.indexOf('=');
    if (eq !== -1) w = w.slice(eq + 1);
    else {
      const slash = w.indexOf('/');
      w = slash === -1 ? '' : w.slice(slash);
    }
  }
  w = w.replace(/^["']+|["',;]+$/g, '');
  if (w === '') return null;
  if (w.includes('/') || w.startsWith('~') || HOME_PREFIX.test(w)) return w;
  return null;
}

/**
 * Every path a command line names.
 *
 * @param {string} command
 * @param {{cwd?: string|null, home?: string}} [options] - `cwd` is the directory the line starts in.
 * @returns {{ok: boolean, reason?: string, paths: Array<{path: string, explicit: boolean, cd: boolean}>}}
 *   `explicit` marks a path written absolutely (or with `~`/`$HOME`), or the target of a
 *   `cd`; a relative word resolved against the running directory is not explicit. `ok` is
 *   false when the line uses a form this reader will not interpret.
 */
export function commandPaths(command, { cwd = null, home = homedir() } = {}) {
  const text = String(command ?? '');
  const out = [];
  if (/\$\(|`|<\(|>\(|[()]/.test(text)) return { ok: false, reason: 'subshell or command substitution', paths: out };
  let dir = typeof cwd === 'string' && cwd !== '' ? cwd : null;
  for (const raw of splitSegments(text)) {
    const words = segmentWords(raw);
    if (words.length === 0) continue;
    let head = 0;
    while (head < words.length && ASSIGNMENT.test(words[head]) && !words[head].includes('/')) head += 1;
    const command0 = (words[head] ?? '').split('/').pop();
    if (NESTED_EXEC.has(command0)) return { ok: false, reason: `${command0} runs text this reader cannot see`, paths: out };
    if (NESTED_SHELLS.has(command0) && words.slice(head + 1).some((w) => /^-\w*c\w*$/.test(w))) {
      return { ok: false, reason: 'nested shell string', paths: out };
    }
    if (words[head] === 'cd' || words[head] === 'pushd') {
      const target = words[head + 1];
      if (target === undefined) {
        dir = home;
        out.push({ path: home, explicit: true, cd: true });
        continue;
      }
      if (target === '-' || (target.includes('$') && !HOME_PREFIX.test(target))) {
        return { ok: false, reason: 'cd target is not a literal path', paths: out };
      }
      const absolute = isAbsolute(expandHome(target, home));
      if (!absolute && dir === null) return { ok: false, reason: 'relative cd with no known working directory', paths: out };
      if (target.startsWith('~') && target !== '~' && !target.startsWith('~/')) return { ok: false, reason: 'cd to another user home', paths: out };
      dir = resolvePathToken(target, dir ?? '/', home);
      out.push({ path: dir, explicit: true, cd: true });
      continue;
    }
    for (const word of words.slice(head)) {
      const candidate = pathCandidate(word);
      if (candidate === null) continue;
      if (/\$/.test(candidate.replace(HOME_PREFIX, ''))) return { ok: false, reason: 'path contains a variable', paths: out };
      if (candidate.startsWith('~') && candidate !== '~' && !candidate.startsWith('~/')) return { ok: false, reason: 'path names another user home', paths: out };
      const explicit = isAbsolute(expandHome(candidate, home));
      if (!explicit && dir === null) return { ok: false, reason: 'relative path with no known working directory', paths: out };
      out.push({ path: resolvePathToken(candidate, dir ?? '/', home), explicit, cd: false });
    }
  }
  return { ok: true, paths: out };
}
