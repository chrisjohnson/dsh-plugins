import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MODELS_DEV_PROVIDER_IDS,
  costText,
  estimateCostUsd,
  isDeepSeekProvider,
  modelsDevProviderOf,
  rateForModel,
} from '../src/prices.mjs'

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} not ≈ ${b}`)

test('provider map: known ids resolve, unknown ids map to themselves', () => {
  assert.equal(modelsDevProviderOf('deepseek-official'), 'deepseek')
  assert.equal(modelsDevProviderOf('deepseek-account'), 'deepseek')
  // a deployment-owned proxy id is not in the map, so it maps to itself
  assert.equal(modelsDevProviderOf('some-proxy'), 'some-proxy')
})

test('isDeepSeekProvider is true only for the two deepseek dsh ids', () => {
  assert.equal(isDeepSeekProvider('deepseek-official'), true)
  assert.equal(isDeepSeekProvider('deepseek-account'), true)
  assert.equal(isDeepSeekProvider('some-proxy'), false)
  assert.equal(isDeepSeekProvider('kimi-coding'), false)
})

test('rateForModel resolves deepseek-flash to the models.dev rates, write falls back to input', () => {
  const rate = rateForModel('deepseek-flash')
  assert.deepEqual(rate, { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 })
  assert.equal(rateForModel('unknown-model'), null)
})

test('estimateCostUsd: a single flat (off-peak) deepseek bucket prices at the list rates', () => {
  // 1M uncached input + 1M output, off-peak, non-deepseek-mapped provider (no ×2)
  const cost = {
    'some-proxy': {
      'deepseek-flash': {
        off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 },
      },
    },
  }
  // 1M * 0.15 + 1M * 0.6 = 0.15 + 0.60 = 0.75
  approx(estimateCostUsd(cost), 0.75)
})

test('estimateCostUsd: cacheRead uses the cheap rate, cacheWrite falls back to input', () => {
  const cost = {
    'some-proxy': {
      'deepseek-flash': {
        off: { uncached: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 0 },
      },
    },
  }
  // 1M * 0.003 + 1M * 0.15 = 0.003 + 0.15 = 0.153
  approx(estimateCostUsd(cost), 0.153)
})

test('estimateCostUsd: a deepseek-mapped provider doubles the PEAK period only', () => {
  const same = { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } // 1M input = $0.15
  // non-deepseek: peak bucket bills at 1× (0.15)
  const flat = { 'some-proxy': { 'deepseek-flash': { peak: { ...same } } } }
  approx(estimateCostUsd(flat), 0.15)
  // deepseek-mapped: peak bucket bills at 2× (0.30)
  const deep = { 'deepseek-official': { 'deepseek-flash': { peak: { ...same } } } }
  approx(estimateCostUsd(deep), 0.3)
})

test('estimateCostUsd: deepseek-mapped off-peak stays at 1× (the ×2 is peak-only)', () => {
  const same = { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }
  const deep = { 'deepseek-account': { 'deepseek-flash': { off: { ...same } } } }
  approx(estimateCostUsd(deep), 0.15)
})

test('estimateCostUsd: sums across models, periods, and providers', () => {
  const cost = {
    'some-proxy': {
      'deepseek-flash': {
        off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }, // 0.75
        peak: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }, // 0.60 (non-deepseek, 1×)
      },
    },
  }
  approx(estimateCostUsd(cost), 1.35)
})

test('estimateCostUsd: unknown model contributes nothing and stays hidden', () => {
  const cost = {
    'some-proxy': {
      'some-local-model': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 } },
    },
  }
  assert.equal(estimateCostUsd(cost), 0)
})

test('estimateCostUsd: tolerates empty, null, and malformed input', () => {
  assert.equal(estimateCostUsd(null), 0)
  assert.equal(estimateCostUsd(undefined), 0)
  assert.equal(estimateCostUsd({}), 0)
  assert.equal(estimateCostUsd({ 'some-proxy': {} }), 0)
  assert.equal(estimateCostUsd({ 'some-proxy': { 'deepseek-flash': {} } }), 0)
})

test('costText: hides sub-cent values, two decimals under $1000, rounded + comma above', () => {
  assert.equal(costText(0), null)
  assert.equal(costText(0.001), null)
  assert.equal(costText(0.005), '$0.01')
  assert.equal(costText(0.987), '$0.99')
  assert.equal(costText(9.87), '$9.87')
  assert.equal(costText(999.999), '$1000.00')
  assert.equal(costText(1000), '$1,000')
  assert.equal(costText(123456.7), '$123,457')
  assert.equal(costText(NaN), null)
  assert.equal(costText(-3), null)
})
