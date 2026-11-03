// The board's browser-side rules, evaluated from the real client source.

import test from 'node:test'
import assert from 'node:assert/strict'

import { clientSource, loadClientHelpers } from './client-source.mjs'

const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H

test('durations: seconds, minutes, hours, then a day and hours, then whole days', async () => {
  const { fmtDur } = await loadClientHelpers(['fmtDur'])
  assert.equal(fmtDur(null), '—')
  assert.equal(fmtDur(0), '0s')
  assert.equal(fmtDur(42 * S), '42s')
  assert.equal(fmtDur(5 * M + 3 * S), '5m 3s')
  assert.equal(fmtDur(3 * H + 12 * M), '3h 12m')
  assert.equal(fmtDur(23 * H + 59 * M), '23h 59m', 'under a day keeps hours and minutes')
  assert.equal(fmtDur(1 * D + 2 * H), '1d2h')
  assert.equal(fmtDur(1 * D + 2 * H + 40 * M), '1d2h', 'minutes drop out past a day')
  assert.equal(fmtDur(1 * D), '1d')
  assert.equal(fmtDur(1 * D + 23 * H + 59 * M), '1d23h')
  assert.equal(fmtDur(2 * D), '2d')
  assert.equal(fmtDur(2 * D + 23 * H), '2d', 'two days or more shows whole days only')
  assert.equal(fmtDur(3 * D + 5 * H), '3d')
  assert.equal(fmtDur(4 * D), '4d')
  assert.equal(fmtDur(5 * D + 11 * H), '5d')
  assert.equal(fmtDur(40 * D), '40d')
})

test('"ago" reuses the duration wording', async () => {
  const { ago } = await loadClientHelpers(['fmtDur', 'ago'], { Date: class extends Date { static now() { return Date.UTC(2026, 0, 10) } } })
  assert.equal(ago(new Date(Date.UTC(2026, 0, 10) - (3 * D + 4 * H)).toISOString()), '3d ago')
  assert.equal(ago(new Date(Date.UTC(2026, 0, 10) - (1 * D + 4 * H)).toISOString()), '1d4h ago')
  assert.equal(ago(null), '—')
})

test('the client source is still a self-contained classic script', async () => {
  const src = await clientSource()
  assert.equal(/^import /m.test(src), false)
})
