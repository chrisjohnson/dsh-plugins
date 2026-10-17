// Pure cost math for dsh-session-cost. No dsh imports, no I/O — every rule here
// is tested directly in test/prices.test.mjs, and the browser half (src/client.mjs)
// carries a byte-for-byte mirror of `estimateCostUsd` + `MODEL_RATES` because the
// UMD client bundle cannot import a sibling module. Keep the two in lockstep.
//
// The numbers mirror dsh-context's own cost display so the badge and the Context
// Insights page agree. dsh-context folds each turn's billed tokens into
// `contextTimeline.cost`, shaped:
//
//   cost[provider][model][period] = { uncached, cacheRead, cacheWrite, output }
//   period ∈ { "peak", "off" }
//
// and prices that with the models.dev per-million rates, doubling the PEAK period
// for DeepSeek providers (their peak windows bill at 2× the off-peak/list rate).
// We reproduce that exactly, looking the rate up by MODEL id (deployment-agnostic)
// rather than by the dsh provider id.

// dsh provider id -> models.dev provider id. A provider not listed maps to itself.
// (Mirrors dsh-context's MODELS_DEV_PROVIDER_IDS.)
export const MODELS_DEV_PROVIDER_IDS = {
  'deepseek-official': 'deepseek',
  'deepseek-account': 'deepseek',
  'kimi-coding': 'moonshotai',
  'minimax-cn': 'minimax',
  'zai-coding-cn': 'zhipuai',
}

export function modelsDevProviderOf(dshProviderId) {
  return MODELS_DEV_PROVIDER_IDS[dshProviderId] ?? dshProviderId
}

export function isDeepSeekProvider(dshProviderId) {
  return modelsDevProviderOf(dshProviderId) === 'deepseek'
}

// Public models.dev per-million rates, keyed by MODEL id. Fields are the models.dev
// `cost` keys: input, output, and (optionally) cacheRead / cacheWrite. cache_write
// is unlisted for these models, so the effective write rate falls back to `input`
// (matching dsh-context). `reasoning` output is already included in `output`.
export const MODEL_RATES = {
  // models.dev /deepseek/deepseek-flash  (last_updated 2026-09-10)
  'deepseek-flash': { input: 0.15, output: 0.6, cacheRead: 0.003 },
  // deprecated alias of the same model, kept so older sessions still price
  'deepseek-v4-flash': { input: 0.15, output: 0.6, cacheRead: 0.003 },
}

// Resolve a model's rate to the { hit, miss, write, out } shape the formula uses.
// Returns null when the model has no known rate (the badge stays hidden for it).
export function rateForModel(model) {
  const r = MODEL_RATES[model]
  if (!r) return null
  return {
    hit: r.cacheRead != null ? r.cacheRead : r.input,
    miss: r.input,
    write: r.cacheWrite != null ? r.cacheWrite : r.input,
    out: r.output,
  }
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function plainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

// Total estimated USD for a `contextTimeline.cost` object. Mirrors dsh-context's
// cost fold: per period, (cacheRead*hit + uncached*miss + cacheWrite*write +
// output*out)/1e6, with the peak period doubled for DeepSeek providers.
export function estimateCostUsd(cost) {
  if (!plainObject(cost)) return 0
  let total = 0
  let any = false
  for (const provider of Object.keys(cost)) {
    const models = cost[provider]
    if (!plainObject(models)) continue
    const deep = isDeepSeekProvider(provider)
    for (const model of Object.keys(models)) {
      const periods = models[model]
      if (!plainObject(periods)) continue
      const rate = rateForModel(model)
      if (!rate) continue
      for (const period of ['peak', 'off']) {
        const b = periods[period]
        if (!plainObject(b)) continue
        const n =
          (finite(b.cacheRead) * rate.hit +
            finite(b.uncached) * rate.miss +
            finite(b.cacheWrite) * rate.write +
            finite(b.output) * rate.out) /
          1e6
        total += deep && period === 'peak' ? n * 2 : n
        any = true
      }
    }
  }
  return any ? total : 0
}

// Format a USD total for the badge: hide sub-cent values, two decimals under
// $1000, rounded whole dollars with a thousands comma at/above it.
export function costText(usd) {
  const n = typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? usd : 0
  if (n < 1000) {
    const s = n.toFixed(2)
    return s === '0.00' ? null : `$${s}`
  }
  return `$${Math.round(n).toLocaleString('en-US')}`
}
