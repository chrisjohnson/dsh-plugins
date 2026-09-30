// Configuration resolution for dsh-model-switch — no dsh imports here, which is
// the point: what a plugin does when an operator sets (or forgets) a key is
// plugin behaviour, and it gets tested like the rest.
//
// Two rules govern this file:
//
//   1. Nothing is required. A plugin that throws on boot because an optional
//      feature was not configured teaches the user nothing.
//   2. Nothing is guessed either. Where a value has no sensible universal
//      default — a provider/model pair is a deployment's answer — the feature
//      that needs it reports itself unavailable and names the key to set.

export const DEFAULT_CONFIG = {
  // Judgement is made against this fraction of the destination window, leaving
  // headroom for the token meter's known under-pricing and for the reply itself.
  // 0.8 is not arbitrary: it is dsh-compaction-basic's own default compaction
  // point, so the guard agrees with what the harness would do anyway.
  fitRatio: 0.8,
  // Room the replacement summary checkpoint will occupy. compaction-basic's
  // default maxTokens is 8192; the framing text is small, so this is
  // deliberately generous.
  summaryReserveTokens: 10000,
  // Bounded retries when a chosen region boundary is rejected by the service.
  maxRegionAttempts: 8,
  // Outer attempts: if one compaction did not free enough, shrink the retained
  // tail and try again.
  maxCompactionAttempts: 3,
}

/** `"provider/model"` → `{ provider, model }`; anything else → undefined. */
export function asRoute(value) {
  if (typeof value !== 'string') return undefined
  const at = value.indexOf('/')
  if (at <= 0 || at === value.length - 1) return undefined
  return { provider: value.slice(0, at), model: value.slice(at + 1) }
}

/**
 * A route is configured only when BOTH halves are non-empty strings. A half-set
 * route is the most common typo in this plugin's configuration, so when a
 * warnings array is passed it says so rather than silently disabling a feature.
 */
export function pickRoute(provider, model, label, warnings) {
  const hasProvider = typeof provider === 'string' && provider.length > 0
  const hasModel = typeof model === 'string' && model.length > 0
  if (hasProvider && hasModel) return { provider, model }
  if ((hasProvider || hasModel) && Array.isArray(warnings)) {
    warnings.push(`${label} route is half-configured (needs both provider and model) and is treated as unset`)
  }
  return undefined
}

/**
 * Turn a raw patch-row `config:` object into the settings the plugin runs on.
 *
 * @param {Record<string, unknown>} config
 * @returns {{settings: object, escalation: {provider: string, model: string} | undefined,
 *            warnings: string[]}}
 *          `warnings` is returned rather than logged so this stays free of a
 *          logger; the caller decides how loudly to say it.
 */
const HONOURS = [
  'escalationProvider',
  'escalationModel',
  'readerProvider',
  'readerModel',
  'preferredRoutes',
  'fitRatio',
  'summaryReserveTokens',
  'autoCompact',
]

/**
 * Turn a raw patch-row `config:` object into the settings the plugin runs on.
 *
 * Every way an operator can get a key wrong produces a warning: a misspelling
 * that silently does nothing, a YAML `"0.8"` that is a string, an escalation
 * provider with no model. That is stricter than most plugins and it is the
 * whole point of keeping this in its own file — a misconfiguration that is
 * printed once at boot is worth far less debugging than one discovered at the
 * first switch.
 *
 * @param {Record<string, unknown>} config
 * @returns {{settings: object, escalation: {provider: string, model: string} | undefined, warnings: string[]}}
 */
export function resolveSettings(config = {}) {
  const warnings = []

  const escalation = pickRoute(config.escalationProvider, config.escalationModel, 'escalation', warnings)
  const reader = pickRoute(config.readerProvider, config.readerModel, 'reader', warnings)
  if (escalation === undefined) {
    warnings.push('switch_model_escalate is not registered: set escalationProvider and escalationModel to enable it')
  }

  // Recommended destinations when a conversation outgrows its route, in order.
  // The configured reader route leads because it is normally the operator's real
  // big-window model; a bare smallest-fitting pick tends to land on a different
  // provider that merely declares the same window (see pickSuggestion).
  const requested = Array.isArray(config.preferredRoutes) ? config.preferredRoutes : []
  const preferredRoutes = []
  for (const entry of requested) {
    const route = asRoute(entry)
    if (route === undefined) {
      warnings.push(`preferredRoutes entry ${JSON.stringify(entry)} is not "provider/model" and was skipped`)
      continue
    }
    preferredRoutes.push(route)
  }
  if (preferredRoutes.length === 0 && reader !== undefined) preferredRoutes.push(reader)

  const fitRatio = numberOr(config.fitRatio, DEFAULT_CONFIG.fitRatio, 'fitRatio', warnings)
  if (Number.isFinite(fitRatio) && !(fitRatio > 0 && fitRatio <= 1)) {
    warnings.push(`fitRatio ${fitRatio} is outside (0, 1]; the guard may refuse switches it should allow`)
  }
  const summaryReserveTokens = numberOr(
    config.summaryReserveTokens,
    DEFAULT_CONFIG.summaryReserveTokens,
    'summaryReserveTokens',
    warnings,
  )

  for (const key of Object.keys(config)) {
    if (!HONOURS.includes(key)) {
      warnings.push(`unknown config key "${key}" is ignored; this plugin honours ${HONOURS.join(', ')}`)
    }
  }

  const settings = {
    ...DEFAULT_CONFIG,
    fitRatio: Number.isFinite(fitRatio) ? fitRatio : DEFAULT_CONFIG.fitRatio,
    summaryReserveTokens: Number.isFinite(summaryReserveTokens) ? summaryReserveTokens : DEFAULT_CONFIG.summaryReserveTokens,
    // Opt-out, not opt-in: compacting before a switch is the safe behaviour, so
    // `autoCompact: false` has to be explicit.
    autoCompact: config.autoCompact !== false,
    reader,
    preferredRoutes,
  }

  return { settings, escalation, warnings }
}

/** A number, or the default with a warning that says exactly what arrived. */
function numberOr(value, fallback, key, warnings) {
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isFinite(value)) return value
  warnings.push(`${key} ${JSON.stringify(value)} is not a number; using the default ${fallback} instead`)
  return fallback
}
