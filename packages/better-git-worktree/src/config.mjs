// Configuration resolution for dsh-better-git-worktree. No dsh imports: what the
// plugin does when an operator sets (or forgets) a key is plugin behaviour, and
// it gets tested like the rest.
//
// Nothing is required. The one key is `stateDir`, the directory that holds the
// session -> working-copy registry; unset, it is `plugins/dsh-better-git-worktree`
// under the dsh home, which is where earlier releases of this plugin kept it, so
// an existing registry is found without any configuration.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The registry's directory name under `<dsh home>/plugins`. */
export const STATE_DIR_NAME = 'dsh-better-git-worktree'

const HONOURS = ['stateDir']

/** Expand a leading `~`, `~/` or `~\\` against the OS home, as the harness does. */
function expandHome(path, home) {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/**
 * The dsh home directory, resolved the way the harness's own `resolveDshHome`
 * does: `$DSH_HOME` when it has non-blank content, else `~/.dsh`; a leading `~`
 * is expanded and the result is made absolute.
 */
export function dshHome(env = process.env, home = homedir()) {
  const fromEnv = env.DSH_HOME
  const chosen = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(home, '.dsh')
  return resolve(expandHome(chosen, home))
}

/**
 * A configured path: absolute values are used verbatim, `~` is expanded, and a
 * relative value resolves against the dsh home (never the working directory),
 * so one row can name a directory the same way on every machine.
 */
export function resolveConfiguredPath(value, env, home = homedir()) {
  return resolve(dshHome(env, home), expandHome(value, home))
}

/** The default registry directory: `<dsh home>/plugins/dsh-better-git-worktree`. */
export function defaultStateDir(env, home) {
  return join(dshHome(env, home), 'plugins', STATE_DIR_NAME)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Turn a raw patch-row `config:` object into the settings the plugin runs on.
 * Every way an operator can get a key wrong produces a warning, returned rather
 * than logged so this stays free of a logger.
 *
 * @param {Record<string, unknown>} config
 * @param {{env?: Record<string, string | undefined>, home?: string}} [options]
 * @returns {{stateDir: string, dshHome: string, warnings: string[]}}
 */
export function resolveSettings(config = {}, options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const warnings = []
  const given = config.stateDir
  let stateDir = defaultStateDir(env, home)
  if (given !== undefined) {
    const chosen = nonEmptyString(given)
    if (chosen === undefined) {
      warnings.push(`stateDir ${JSON.stringify(given)} is not a non-empty path; using ${stateDir}`)
    } else {
      stateDir = resolveConfiguredPath(chosen, env, home)
    }
  }
  for (const key of Object.keys(config)) {
    if (!HONOURS.includes(key)) {
      warnings.push(`unknown config key "${key}" is ignored; this plugin honours ${HONOURS.join(', ')}`)
    }
  }
  return { stateDir, dshHome: dshHome(env, home), warnings }
}
