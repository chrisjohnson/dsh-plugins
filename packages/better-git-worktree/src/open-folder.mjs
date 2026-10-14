// Hand a directory to the desktop's own file manager.
//
// Mirrors how the harness's own open-in-app row launches things: detached,
// stdio-less, with credential-shaped variables stripped from the environment,
// and success decoupled from process lifetime (a file manager stays in the
// foreground for as long as its window is open).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** The openers worth trying on a platform, in preference order. */
export function folderOpenersFor(platform) {
  if (platform === 'darwin') return [{ command: 'open', args: [] }]
  if (platform === 'win32') return [{ command: 'explorer', args: [] }]
  return [
    { command: 'xdg-open', args: [] },
    { command: 'gio', args: ['open'] },
    { command: 'nautilus', args: [] },
    { command: 'dolphin', args: [] },
    { command: 'thunar', args: [] },
    { command: 'nemo', args: [] },
    { command: 'pcmanfm', args: [] },
  ]
}

/** The first installed opener (a PATH lookup, no shell involved), or undefined. */
export function findOpener(options = {}) {
  const platform = options.platform ?? process.platform
  const pathValue = options.path ?? process.env.PATH ?? ''
  const exists = options.exists ?? existsSync
  for (const candidate of folderOpenersFor(platform)) {
    for (const dir of pathValue.split(delimiter)) {
      if (dir !== '' && exists(join(dir, candidate.command))) return candidate
    }
  }
  return undefined
}

/** The environment passed to an opener: everything but credential-shaped variables. */
export function openerEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => value !== undefined && !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(key)),
  )
}

/**
 * Open `path` in the file manager.
 * @throws when the path is gone, no opener is installed, or the opener fails.
 */
export async function openFolder(path, options = {}) {
  const exists = options.exists ?? existsSync
  if (!exists(path)) throw new Error(`${path} no longer exists`)
  const platform = options.platform ?? process.platform
  const resolved = findOpener(options)
  if (resolved === undefined) {
    throw new Error(
      `no folder opener is installed on this host (tried ${folderOpenersFor(platform).map((entry) => entry.command).join(', ')})`,
    )
  }
  const opener = resolved.command
  const openerArgs = [...resolved.args, path]
  const env = openerEnvironment(options.env ?? process.env)
  const launch = options.spawn ?? spawn
  return new Promise((resolve, reject) => {
    let settled = false
    const child = launch(opener, openerArgs, { detached: true, stdio: 'ignore', env })
    const settle = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.unref?.()
      outcome()
    }
    const timer = setTimeout(() => settle(resolve), options.settleMs ?? 1500)
    child.on('error', (error) => settle(() => reject(new Error(`${opener} is unavailable: ${error.message}`))))
    child.on('exit', (code) => settle(() => (code === 0 ? resolve() : reject(new Error(`${opener} exited with ${code}`)))))
  })
}
