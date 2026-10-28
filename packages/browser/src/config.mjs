// Configuration resolution for dsh-browser. Pure: imports nothing from dsh.
//
// Connection keys have defaults here. The page/timeout keys deliberately have
// NO default: dsh-playwright-browser already owns viewport, timeouts and output
// limits through its own row, and this plugin inherits whatever that row
// resolved to. A key set here only overrides it for the per-session browsers.

// The loopback default is the address a Browserless container is conventionally
// published on next to the harness; it is a documented universal default, not a
// deployment's answer.
// verify-allow: no-deployment-leaks
export const DEFAULT_CONNECT_URL = 'ws://127.0.0.1:3100/chromium/playwright'

export const DEFAULTS = Object.freeze({
  connectUrl: DEFAULT_CONNECT_URL,
  connectTimeoutMs: 10000,
  retryRemoteAfterMs: 30000,
})

const POSITIVE_INTEGERS = [
  'connectTimeoutMs',
  'viewportWidth',
  'viewportHeight',
  'actionTimeoutMs',
  'navigationTimeoutMs',
  'maxSnapshotChars',
]
const NON_NEGATIVE_INTEGERS = ['retryRemoteAfterMs']
const STRINGS = ['fallbackExecutablePath', 'screenshotDir']
const KNOWN = new Set(['connectUrl', 'logToStderr', ...POSITIVE_INTEGERS, ...NON_NEGATIVE_INTEGERS, ...STRINGS])

/**
 * @param {unknown} config - the plugin row's `config` object (may be absent).
 * @returns {{ settings: object, warnings: string[] }} `settings.connectUrl` is
 *   `undefined` when remote connections are switched off (`connectUrl: ''`);
 *   `settings.controllerOverrides` holds only the page/timeout keys the user set.
 */
export function resolveSettings(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const warnings = []
  const settings = {
    connectUrl: DEFAULTS.connectUrl,
    connectTimeoutMs: DEFAULTS.connectTimeoutMs,
    retryRemoteAfterMs: DEFAULTS.retryRemoteAfterMs,
    fallbackExecutablePath: undefined,
    logToStderr: false,
    controllerOverrides: {},
  }

  if (raw.logToStderr !== undefined) {
    if (typeof raw.logToStderr === 'boolean') settings.logToStderr = raw.logToStderr
    else warnings.push(`logToStderr must be true or false (got ${JSON.stringify(raw.logToStderr)}); using false`)
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN.has(key)) warnings.push(`unknown config key "${key}" ignored`)
  }

  if (raw.connectUrl !== undefined) {
    if (typeof raw.connectUrl !== 'string') {
      warnings.push(`connectUrl must be a string (got ${JSON.stringify(raw.connectUrl)}); using ${DEFAULTS.connectUrl}`)
    } else if (raw.connectUrl.trim() === '') {
      settings.connectUrl = undefined
    } else if (!/^wss?:\/\//i.test(raw.connectUrl.trim())) {
      warnings.push(`connectUrl must be a ws:// or wss:// URL (got a different scheme); using ${DEFAULTS.connectUrl}`)
    } else {
      settings.connectUrl = raw.connectUrl.trim()
    }
  }

  for (const key of POSITIVE_INTEGERS) {
    if (raw[key] === undefined) continue
    if (!Number.isInteger(raw[key]) || raw[key] < 1) {
      warnings.push(`${key} must be a positive integer (got ${JSON.stringify(raw[key])}); ignored`)
    } else if (key === 'connectTimeoutMs') {
      settings.connectTimeoutMs = raw[key]
    } else {
      settings.controllerOverrides[key] = raw[key]
    }
  }
  for (const key of NON_NEGATIVE_INTEGERS) {
    if (raw[key] === undefined) continue
    if (Number.isInteger(raw[key]) && raw[key] >= 0) settings[key] = raw[key]
    else warnings.push(`${key} must be a non-negative integer (got ${JSON.stringify(raw[key])}); using ${DEFAULTS[key]}`)
  }
  for (const key of STRINGS) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'string' || raw[key].trim() === '') {
      warnings.push(`${key} must be a non-empty string; ignored`)
    } else if (key === 'fallbackExecutablePath') {
      settings.fallbackExecutablePath = raw[key]
    } else {
      settings.controllerOverrides[key] = raw[key]
    }
  }

  return { settings, warnings }
}

/** The endpoint as safe to show a model or a log: no credentials, no query (tokens live there). */
export function describeEndpoint(url) {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return '(unparseable connectUrl)'
  }
}

/**
 * First line of an error, which is the part that is not a Playwright call log,
 * with any URL query value masked: a connect failure can echo the endpoint, and
 * Browserless tokens travel in its query string.
 */
export function errorSummary(error) {
  const text = error instanceof Error ? error.message : String(error)
  const first = text.split('\n')[0].trim().replace(/([?&][^=\s&]+=)[^&\s]+/g, '$1***')
  return first || 'unknown error'
}
