// Configuration resolution for dsh-loop-watchdog. No dsh imports: what the
// plugin does when an operator sets (or forgets) a key is plugin behaviour, and
// it gets tested like the rest.
//
// Two rules govern this file:
//
//   1. Nothing is required. With no configuration at all the watchdog still runs
//      its deterministic repetition check and records every evaluation; only the
//      language-model adjudication of ambiguous windows is off, and the startup
//      warnings say which keys turn it on.
//   2. Nothing about a deployment is guessed. The model endpoint, the model id
//      and the NAME of the environment variable that holds its API key have no
//      universal default, so they are unset until the operator sets them. The
//      key itself is never configuration: it is read from the environment at call
//      time.

import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_CONFIG = {
  // Minimum gap between two evaluations of one session.
  cooldownMs: 30000,
  // How many substantive events the model sees (and the ledger records).
  maxTranscriptLines: 6,
  // Subagent sessions are skipped unless this is true.
  includeSubagents: false,
  // Log-only until an operator opts in; the mode file can override at runtime.
  interventionEnabled: false,
  // Abort a model call after this long. The check fails open.
  watchdogTimeoutMs: 25000,
  // Raw events scanned by the deterministic repetition layer. A 6-line model
  // window is too small for an alternating loop to repeat three times; ~60 raw
  // events cover ~15 tool calls, and the layer costs no model call.
  fpWindowEvents: 60,
  // After a model call slower than this, the next model check is skipped so the
  // watchdog does not compete with the session it supervises.
  busyYieldMs: 15000,
  // Confidence >= bandStuck is actionable; >= bandWatch is the gentle band.
  bandStuck: 90,
  bandWatch: 70,
  // Diagnostic sinks. The evaluation ledger is not a log and always writes.
  logConsole: false,
  logFile: true,
  logDsh: false,
  logDshErrors: true,
  // Completion budget for the one-line verdict the model replies with.
  llmMaxTokens: 128,
}

const HONOURS = [
  ...Object.keys(DEFAULT_CONFIG),
  'llmBaseUrl',
  'llmModel',
  'llmApiKeyEnv',
  'llmExtraBody',
  'ledgerFile',
  'modeFile',
  'logFilePath',
]

const NUMBER_KEYS = [
  'cooldownMs',
  'maxTranscriptLines',
  'watchdogTimeoutMs',
  'fpWindowEvents',
  'busyYieldMs',
  'bandStuck',
  'bandWatch',
  'llmMaxTokens',
]

const BOOLEAN_KEYS = ['includeSubagents', 'interventionEnabled', 'logConsole', 'logFile', 'logDsh', 'logDshErrors']

/**
 * The dsh home directory: `$DSH_HOME` when set (blank counts as unset), else
 * `~/.dsh`. This mirrors the harness's own resolution so the defaults below land
 * beside the rest of the profile's runtime state.
 */
export function dshHome(env = process.env, home = homedir()) {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return fromEnv.length > 0 ? fromEnv : join(home, '.dsh')
}

/** Directory the plugin owns under `$DSH_HOME/storages`. */
export function storageDir(env, home) {
  return join(dshHome(env, home), 'storages', 'loop-watchdog')
}

/** `<llmBaseUrl>/chat/completions`, tolerating a trailing slash; undefined for anything that is not http(s). */
export function chatCompletionsUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return undefined
  let url
  try {
    url = new URL(baseUrl.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Turn a raw patch-row `config:` object into the settings the plugin runs on.
 *
 * Every way an operator can get a key wrong produces a warning: a misspelling
 * that silently does nothing, a YAML `"30000"` that is a string, a model with no
 * endpoint. They are returned, not logged, so this stays free of a logger.
 *
 * @param {Record<string, unknown>} config
 * @param {{env?: Record<string, string | undefined>, home?: string}} [options]
 * @returns {{settings: object, llm: {url: string, model: string, apiKeyEnv: string | undefined,
 *            extraBody: object, maxTokens: number} | undefined, warnings: string[]}}
 */
export function resolveSettings(config = {}, options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const warnings = []
  const settings = { ...DEFAULT_CONFIG }

  for (const key of NUMBER_KEYS) {
    const value = config[key]
    if (value === undefined) continue
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      settings[key] = value
    } else {
      warnings.push(`${key} ${JSON.stringify(value)} is not a non-negative number; using the default ${DEFAULT_CONFIG[key]}`)
    }
  }
  for (const key of BOOLEAN_KEYS) {
    const value = config[key]
    if (value === undefined) continue
    if (typeof value === 'boolean') {
      settings[key] = value
    } else {
      warnings.push(`${key} ${JSON.stringify(value)} is not true/false; using the default ${DEFAULT_CONFIG[key]}`)
    }
  }
  if (settings.bandWatch > settings.bandStuck) {
    warnings.push(`bandWatch ${settings.bandWatch} is above bandStuck ${settings.bandStuck}; the watch band is empty`)
  }

  const dir = storageDir(env, home)
  settings.ledgerFile = nonEmptyString(config.ledgerFile) ?? join(dir, 'evaluations.jsonl')
  settings.modeFile = nonEmptyString(config.modeFile) ?? join(dir, 'mode.json')
  settings.logFilePath = nonEmptyString(config.logFilePath) ?? join(dir, 'watchdog.log')

  // --- the model that adjudicates windows the repetition check cannot settle ---
  const baseUrl = nonEmptyString(config.llmBaseUrl)
  const model = nonEmptyString(config.llmModel)
  const url = chatCompletionsUrl(baseUrl)
  if (baseUrl !== undefined && url === undefined) {
    warnings.push(`llmBaseUrl ${JSON.stringify(config.llmBaseUrl)} is not an http(s) URL and is treated as unset`)
  }
  if ((url !== undefined) !== (model !== undefined)) {
    if (url !== undefined) warnings.push('llmBaseUrl is set but llmModel is not; model adjudication stays off')
    else if (model !== undefined && baseUrl === undefined) warnings.push('llmModel is set but llmBaseUrl is not; model adjudication stays off')
  }
  const apiKeyEnv = nonEmptyString(config.llmApiKeyEnv)
  let extraBody = {}
  if (config.llmExtraBody !== undefined) {
    if (config.llmExtraBody !== null && typeof config.llmExtraBody === 'object' && !Array.isArray(config.llmExtraBody)) {
      extraBody = config.llmExtraBody
    } else {
      warnings.push('llmExtraBody is not a mapping and is ignored')
    }
  }

  let llm
  if (url !== undefined && model !== undefined) {
    llm = { url, model, apiKeyEnv, extraBody, maxTokens: settings.llmMaxTokens }
    if (apiKeyEnv !== undefined && !nonEmptyString(env[apiKeyEnv])) {
      warnings.push(`llmApiKeyEnv names ${apiKeyEnv}, which is empty in this environment; requests are sent without an Authorization header`)
    }
  } else if (url === undefined && model === undefined) {
    warnings.push(
      'model adjudication is off (llmBaseUrl and llmModel unset): only the deterministic repetition check runs; ambiguous windows are recorded as skipped (no-llm)',
    )
  }

  for (const key of Object.keys(config)) {
    if (!HONOURS.includes(key)) {
      warnings.push(`unknown config key "${key}" is ignored; this plugin honours ${HONOURS.join(', ')}`)
    }
  }

  return { settings, llm, warnings }
}
