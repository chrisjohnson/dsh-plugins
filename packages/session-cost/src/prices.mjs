// Pure cost math for dsh-session-cost. No dsh imports, no I/O — every rule here
// is tested in test/prices.test.mjs, and the browser half (src/client.mjs) carries
// a byte-for-byte mirror of this module because the UMD client bundle cannot import
// a sibling module. Keep the two in lockstep.
//
// The numbers mirror dsh-context's own cost display so the badge and the Context
// Insights page agree. dsh-context folds each turn's billed tokens into
// `contextTimeline.cost`, shaped:
//
//   cost[provider][model][period] = { uncached, cacheRead, cacheWrite, output }
//   period ∈ { "peak", "off" }
//
// and prices those buckets against the live models.dev catalog (fetched from the
// browser, the same source dsh-context uses). This module holds the pure side of
// that: building a price book from a catalog, resolving a (provider, model) to a
// rate, and folding the buckets into a USD total. It reproduces dsh-context's
// resolution and fold exactly, so a session prices identically to the Context
// page — including deployment-owned proxy providers (a provider id that is not
// itself a models.dev provider) that resolve through the catalog by model name.

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

// ---- small validators (mirror dsh-context's W / vr / G) -----------------------

function plainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

// non-negative finite number, else null (dsh-context `vr`)
function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

// finite number, else 0 (dsh-context `G`)
function numOr0(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// ---- price book ---------------------------------------------------------------

function rateEq(a, b) {
  return a.hit === b.hit && a.miss === b.miss && a.write === b.write && a.out === b.out
}

// Build a price book from a models.dev catalog:
//   catalog[pid] = { models: { modelId: { cost: { input, output, cache_read?, cache_write? } } }, npm? }
// → { prices: { pid: { modelId: {hit,miss,write,out} } }, byModel: Map }
//
// `prices` is keyed by the models.dev provider id; `byModel` is the model-name
// fallback index (full lowercased id plus each dash-suffix) used when the session's
// provider is not itself a models.dev provider. Mirrors dsh-context's build.
export function buildPriceBook(catalog) {
  const prices = {}
  const byModel = new Map()

  const addCandidate = (key, entry) => {
    let arr = byModel.get(key)
    if (arr === undefined) {
      arr = []
      byModel.set(key, arr)
    } else if (arr.some((e) => e.pid === entry.pid && rateEq(e.rate, entry.rate))) {
      return // same provider + identical rate: no duplicate
    }
    arr.push(entry)
  }

  for (const pid of Object.keys(catalog ?? {})) {
    const entry = catalog[pid]
    if (!plainObject(entry)) continue
    const models = entry.models
    if (!plainObject(models)) continue
    // `primary`: the provider IS the canonical @ai-sdk/<pid> package (used to rank
    // fallback candidates, mirroring dsh-context).
    const npm = entry.npm
    const isPrimary = typeof npm === 'string' && npm.startsWith('@ai-sdk/') && npm.slice(8) === pid
    const providerRates = {}
    for (const modelId of Object.keys(models)) {
      const m = models[modelId]
      const cost = plainObject(m) ? m.cost : null
      if (!plainObject(cost)) continue
      const input = numOrNull(cost.input)
      const output = numOrNull(cost.output)
      if (input === null || output === null) continue // unpriceable without both
      const rate = {
        hit: numOrNull(cost.cache_read) ?? input,
        miss: input,
        write: numOrNull(cost.cache_write) ?? input,
        out: output,
      }
      providerRates[modelId] = rate
      const lower = modelId.toLowerCase()
      const rec = { pid, mid: modelId, rate, primary: isPrimary }
      addCandidate(lower, rec)
      const parts = lower.split('-')
      for (let i = 1; i < parts.length; i++) addCandidate(parts.slice(i).join('-'), rec)
    }
    if (Object.keys(providerRates).length > 0) prices[pid] = providerRates
  }

  return { prices, byModel }
}

// ---- resolution (mirror dsh-context's `or` / `sr` / `ir` + ranking) -----------

// Find a model within one provider's rates: exact key, else case-insensitive, else
// a key that ends with "-<model>". Ambiguous (two distinct candidates) → null.
function modelInProvider(providerRates, model) {
  if (Object.prototype.hasOwnProperty.call(providerRates, model)) {
    return { mid: model, rate: providerRates[model] }
  }
  const n = String(model).toLowerCase()
  let found = null
  let key = null
  for (const mid of Object.keys(providerRates)) {
    const a = mid.toLowerCase()
    if (a === n || a.endsWith('-' + n)) {
      if (key !== null && key !== a) return null // ambiguous
      key = a
      found = { mid, rate: providerRates[mid] }
    }
  }
  return found
}

// Rank fallback candidates: a provider matching the "vendor/" hint first, then the
// primary (@ai-sdk canonical) provider, then the first listed.
function pickCandidate(cands, hintPid) {
  if (hintPid) for (const c of cands) if (c.pid === hintPid) return c
  for (const c of cands) if (c.primary) return c
  return cands[0] ?? null
}

// Resolve a (dsh provider, model) to a rate. Mirrors dsh-context's `sr`:
//   1. the session's provider maps to a models.dev provider with that model → use it
//      (a model missing from that provider resolves to null, not a fallback);
//   2. else, a "deepseek-…" model tries the `deepseek` provider;
//   3. else, the model-name index (full id, then the part after a "vendor/" slash).
// Returns { pid, mid, rate } or null when no rate is known (badge stays hidden).
export function resolveRate(book, dshProvider, model) {
  if (!book || !book.prices) return null
  const { prices, byModel } = book
  const pid = modelsDevProviderOf(dshProvider ?? '')
  const direct = prices[pid]
  if (direct) {
    const m = modelInProvider(direct, model)
    return m ? { pid, mid: m.mid, rate: m.rate } : null
  }
  if (String(model).toLowerCase().startsWith('deepseek-')) {
    const ds = prices['deepseek']
    if (ds) {
      const m = modelInProvider(ds, model)
      if (m) return { pid: 'deepseek', mid: m.mid, rate: m.rate }
    }
  }
  const n = String(model).toLowerCase()
  const slash = n.lastIndexOf('/')
  const hint = slash > 0 ? n.slice(0, slash) : null
  const keys = slash > 0 ? [n, n.slice(slash + 1)] : [n]
  for (const key of keys) {
    const cands = byModel.get(key)
    if (!cands) continue
    const c = pickCandidate(cands, hint)
    if (c) return { pid: c.pid, mid: c.mid, rate: c.rate }
  }
  return null
}

// ---- fold (mirror dsh-context's `lr`) -----------------------------------------

// Total estimated USD for a `contextTimeline.cost` object given a price book. Per
// period: (cacheRead*hit + uncached*miss + cacheWrite*write + output*out)/1e6, with
// the peak period doubled for DeepSeek providers. Returns 0 when nothing priced.
export function estimateCostUsd(cost, book) {
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
      const resolved = resolveRate(book, provider, model)
      if (!resolved) continue
      const rate = resolved.rate
      for (const period of ['peak', 'off']) {
        const b = periods[period]
        if (!plainObject(b)) continue
        const n =
          (numOr0(b.cacheRead) * rate.hit +
            numOr0(b.uncached) * rate.miss +
            numOr0(b.cacheWrite) * rate.write +
            numOr0(b.output) * rate.out) /
          1e6
        total += deep && period === 'peak' ? n * 2 : n
        any = true
      }
    }
  }
  return any ? total : 0
}

// ---- offline fallback ---------------------------------------------------------

// A minimal models.dev-shaped catalog so the badge still prices the common
// DeepSeek case when the live catalog can't be fetched (offline). Rates mirror
// models.dev as of the last manual check; the live fetch supersedes them.
export const FALLBACK_CATALOG = {
  deepseek: {
    npm: '@ai-sdk/openai-compatible',
    models: {
      'deepseek-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
      'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
    },
  },
}

export function buildFallbackBook() {
  return buildPriceBook(FALLBACK_CATALOG)
}

// Format a USD total for the badge, exactly as dsh-context's Context page does
// (its `pr`): two decimals at/above $1, two significant figures below it
// ($0.0021, $0.29, $1.50). Returns null for a $0 / unpriced session so the badge
// stays hidden - the same "no rate, no number" rule dsh-context follows.
export function costText(usd) {
  const n = typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? usd : null
  if (n === null) return null
  return `$${n >= 1 ? n.toFixed(2) : n.toPrecision(2)}`
}
