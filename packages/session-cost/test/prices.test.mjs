import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFallbackBook,
  buildPriceBook,
  costText,
  estimateCostUsd,
  isDeepSeekProvider,
  modelsDevProviderOf,
  resolveRate,
} from '../src/prices.mjs'

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} not ≈ ${b}`)

// A small models.dev-shaped catalog: deepseek (canonical, has deepseek-flash),
// openai (canonical @ai-sdk/openai, has gpt-4o), and an unknown cost shape that
// must be skipped (no output). Mirrors the live catalog's structure.
const CATALOG = {
  deepseek: {
    npm: '@ai-sdk/openai-compatible',
    models: {
      'deepseek-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
      'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
    },
  },
  openai: {
    npm: '@ai-sdk/openai',
    models: {
      'gpt-4o': { cost: { input: 2.5, output: 10, cache_read: 0.25 } },
      'broken-model': { cost: { input: 1 } }, // no output → unpriceable, skipped
    },
  },
}
const BOOK = buildPriceBook(CATALOG)

test('provider map: known ids resolve, unknown ids map to themselves', () => {
  assert.equal(modelsDevProviderOf('deepseek-official'), 'deepseek')
  assert.equal(modelsDevProviderOf('deepseek-account'), 'deepseek')
  assert.equal(modelsDevProviderOf('kimi-coding'), 'moonshotai')
  assert.equal(modelsDevProviderOf('some-proxy'), 'some-proxy')
})

test('isDeepSeekProvider is true only for the two deepseek dsh ids', () => {
  assert.equal(isDeepSeekProvider('deepseek-official'), true)
  assert.equal(isDeepSeekProvider('deepseek-account'), true)
  assert.equal(isDeepSeekProvider('some-proxy'), false)
  assert.equal(isDeepSeekProvider('kimi-coding'), false)
})

test('buildPriceBook: extracts hit/miss/write/out, falls back write to input, skips unpriceable', () => {
  assert.deepEqual(BOOK.prices.deepseek['deepseek-flash'], { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 })
  assert.deepEqual(BOOK.prices.openai['gpt-4o'], { hit: 0.25, miss: 2.5, write: 2.5, out: 10 })
  assert.equal(BOOK.prices.openai['broken-model'], undefined)
  // the model-name index has the full id and each dash-suffix
  assert.ok(BOOK.byModel.get('deepseek-flash'))
  assert.ok(BOOK.byModel.get('flash'))
  assert.ok(BOOK.byModel.get('gpt-4o'))
})

test('resolveRate: direct provider + model', () => {
  const r = resolveRate(BOOK, 'openai', 'gpt-4o')
  assert.deepEqual(r, { pid: 'openai', mid: 'gpt-4o', rate: { hit: 0.25, miss: 2.5, write: 2.5, out: 10 } })
})

test('resolveRate: mapped dsh provider (deepseek-official -> deepseek)', () => {
  const r = resolveRate(BOOK, 'deepseek-official', 'deepseek-flash')
  assert.equal(r.pid, 'deepseek')
  assert.deepEqual(r.rate, { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 })
})

test('resolveRate: proxy provider falls back through the deepseek- prefix to the deepseek provider', () => {
  // local-ai-machine-cloud is not a models.dev provider; the deepseek- prefix
  // routes it to the deepseek catalog entry (mirrors dsh-context).
  const r = resolveRate(BOOK, 'local-ai-machine-cloud', 'deepseek-flash')
  assert.equal(r.pid, 'deepseek')
  assert.equal(r.mid, 'deepseek-flash')
  assert.deepEqual(r.rate, { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 })
})

test('resolveRate: unknown model resolves to null (badge hidden)', () => {
  assert.equal(resolveRate(BOOK, 'some-proxy', 'no-such-model'), null)
  // a model present only under a different provider is not found via a direct hit
  // when the session provider is a known provider that lacks it
  assert.equal(resolveRate(BOOK, 'openai', 'deepseek-flash'), null)
})

test('estimateCostUsd: a single flat (off-peak) deepseek bucket prices at the list rates', () => {
  const cost = {
    'some-proxy': {
      'deepseek-flash': {
        off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 },
      },
    },
  }
  // 1M * 0.15 + 1M * 0.6 = 0.75
  approx(estimateCostUsd(cost, BOOK), 0.75)
})

test('estimateCostUsd: cacheRead uses the cheap rate, cacheWrite falls back to input', () => {
  const cost = {
    'some-proxy': {
      'deepseek-flash': {
        off: { uncached: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 0 },
      },
    },
  }
  // 1M * 0.003 + 1M * 0.15 = 0.153
  approx(estimateCostUsd(cost, BOOK), 0.153)
})

test('estimateCostUsd: a deepseek-mapped provider doubles the PEAK period only', () => {
  const same = { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }
  // non-deepseek (proxy): peak bucket bills at 1× (0.15)
  approx(estimateCostUsd({ 'some-proxy': { 'deepseek-flash': { peak: { ...same } } } }, BOOK), 0.15)
  // deepseek-mapped: peak bucket bills at 2× (0.30)
  approx(estimateCostUsd({ 'deepseek-official': { 'deepseek-flash': { peak: { ...same } } } }, BOOK), 0.3)
})

test('estimateCostUsd: deepseek-mapped off-peak stays at 1× (the ×2 is peak-only)', () => {
  const same = { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }
  approx(estimateCostUsd({ 'deepseek-account': { 'deepseek-flash': { off: { ...same } } } }, BOOK), 0.15)
})

test('estimateCostUsd: prices a non-deepseek provider (openai) at its own rates', () => {
  const cost = {
    openai: {
      'gpt-4o': {
        peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
      },
    },
  }
  approx(estimateCostUsd(cost, BOOK), 2.5)
})

test('estimateCostUsd: sums across models, periods, and providers', () => {
  const cost = {
    'some-proxy': {
      'deepseek-flash': {
        off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }, // 0.75
        peak: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }, // 0.60 (proxy, 1×)
      },
    },
  }
  approx(estimateCostUsd(cost, BOOK), 1.35)
})

test('estimateCostUsd: unknown model contributes nothing and stays hidden', () => {
  const cost = {
    'some-proxy': {
      'some-local-model': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 } },
    },
  }
  assert.equal(estimateCostUsd(cost, BOOK), 0)
})

test('estimateCostUsd: tolerates empty, null, and malformed input', () => {
  assert.equal(estimateCostUsd(null, BOOK), 0)
  assert.equal(estimateCostUsd(undefined, BOOK), 0)
  assert.equal(estimateCostUsd({}, BOOK), 0)
  assert.equal(estimateCostUsd({ 'some-proxy': {} }, BOOK), 0)
  assert.equal(estimateCostUsd({ 'some-proxy': { 'deepseek-flash': {} } }, BOOK), 0)
  // no book → nothing prices
  assert.equal(estimateCostUsd({ 'some-proxy': { 'deepseek-flash': { off: { uncached: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 } } } }, null), 0)
})

test('buildFallbackBook: prices deepseek-flash even offline', () => {
  const book = buildFallbackBook()
  const cost = { 'local-ai-machine-cloud': { 'deepseek-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
  approx(estimateCostUsd(cost, book), 0.15)
})

test('costText: matches dsh-context display (2dp >=$1, 2 sig figs below), null at $0', () => {
  assert.equal(costText(0), null) // no cost / free / unpriced -> hidden
  assert.equal(costText(0.0021), '$0.0021') // the deepseek-flash sub-cent case, as dsh-context shows it
  assert.equal(costText(0.29), '$0.29')
  assert.equal(costText(0.987), '$0.99')
  assert.equal(costText(1), '$1.00')
  assert.equal(costText(9.87), '$9.87')
  assert.equal(costText(1000), '$1000.00')
  assert.equal(costText(1234.567), '$1234.57')
  assert.equal(costText(NaN), null)
  assert.equal(costText(-3), null)
})
