// Configuration resolution for dsh-scheduled-queue — no dsh imports.
//
// Nothing is required: with no config the plugin runs with the defaults below.

export const DEFAULT_CONFIG = {
  // How often due items are looked for. A scheduled message is minutes away, so
  // a few seconds of slack is invisible; the floor stops a typo from spinning.
  scanIntervalMs: 5000,
  // How long one delivery may take before it counts as failed and is retried. A
  // hung delivery would otherwise hold up every item behind it.
  deliveryTimeoutMs: 60000,
}

const BOUNDS = {
  scanIntervalMs: [1000, 60000],
  deliveryTimeoutMs: [1000, 600000],
}

/**
 * Where the queue file lives: `<dsh home>/storages/scheduled-queue.json`, where the
 * dsh home is `$DSH_HOME` (a leading `~` expanded), else `<os home>/.dsh` — the same
 * resolution the harness uses. The location is part of the persisted format: items
 * queued by earlier versions are found here.
 */
export function resolveQueueFile(env, osHome, sep = '/') {
  const trim = (value) => (typeof value === 'string' ? value.trim() : '')
  const joinPath = (...parts) => parts.join(sep).replace(/[\\/]+/g, sep)
  let home = trim(env && env.DSH_HOME)
  if (home === '~') home = osHome
  else if (home.startsWith('~/') || home.startsWith('~\\')) home = joinPath(osHome, home.slice(2))
  if (home === '') home = joinPath(osHome, '.dsh')
  return `${home.replace(/[\\/]+$/, '')}${sep}storages${sep}scheduled-queue.json`
}

/**
 * @returns `{ settings, warnings }`. A bad value never throws; it falls back to
 *   the default and says which key it was.
 */
export function resolveSettings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const warnings = []
  const settings = { ...DEFAULT_CONFIG }

  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_CONFIG)) warnings.push(`ignoring unknown config key "${key}" (known: ${Object.keys(DEFAULT_CONFIG).join(', ')})`)
  }

  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    if (raw[key] === undefined) continue
    const n = Number(raw[key])
    if (!Number.isFinite(n)) {
      warnings.push(`${key} must be a number of milliseconds; using ${DEFAULT_CONFIG[key]}`)
      continue
    }
    const clamped = Math.min(max, Math.max(min, Math.round(n)))
    if (clamped !== n) warnings.push(`${key} ${n} is outside ${min}..${max}; using ${clamped}`)
    settings[key] = clamped
  }

  return { settings, warnings }
}
