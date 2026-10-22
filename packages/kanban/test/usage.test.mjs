import test from 'node:test'
import assert from 'node:assert/strict'

import { priceUsage } from '../src/usage.mjs'

const usage = { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 }

test('configured local route prices at zero dollars', () => {
  const priced = priceUsage(usage, { known: true, tier: 'local', priceIn: null, priceOut: null, priceCacheRead: null, priceCacheWrite: null })
  assert.equal(priced.costUsd, 0)
})

test('unknown route stays unpriced rather than free', () => {
  const priced = priceUsage(usage, { known: false, tier: 'local', priceIn: null, priceOut: null, priceCacheRead: null, priceCacheWrite: null })
  assert.equal(priced.costUsd, null)
})

test('known paid route uses per-million prices', () => {
  const priced = priceUsage(usage, { known: true, tier: 'paid', priceIn: 1, priceOut: 2, priceCacheRead: 0, priceCacheWrite: 0 })
  assert.equal(priced.costUsd, (1200 * 1 + 300 * 2) / 1_000_000)
})
