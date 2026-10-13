// Tests for the fit guard: the arithmetic that decides whether a conversation
// may move to another model, and what to say when it may not.
//
// The numbers below are not toy numbers. They are the real windows from the
// deployment this plugin was written on — 1,048,576-token cloud route, 262,144
// local route, 421k-token conversation — because the incident those numbers
// produced is the entire reason the guard exists (README.md, "Why this exists").

import test from 'node:test'
import assert from 'node:assert/strict'

import { budgetFor, canCompactFrom, canRead, classifyFit, decideFit, fitsWindow, pickSuggestion } from '../src/fit.mjs'

const BIG = 1048576
const LOCAL = 262144
const STRANDED = 420948
const CONFIG = { fitRatio: 0.8, preferredRoutes: [] }

test('budget: the margin is a floor of fitRatio x window', () => {
  assert.equal(budgetFor(1000, 0.8), 800)
  assert.equal(budgetFor(262144, 0.8), 209715)
  assert.equal(budgetFor(undefined, 0.8), undefined, 'an undeclared window has no budget')
})

test('fitsWindow: undefined window stays undefined, not false', () => {
  // `undefined` means "cannot tell, do not block the switch"; `false` would
  // refuse every move on a route whose adapter declares no window.
  assert.equal(fitsWindow(STRANDED, undefined, CONFIG), undefined)
  assert.equal(fitsWindow(200000, LOCAL, CONFIG), true)
  assert.equal(fitsWindow(STRANDED, LOCAL, CONFIG), false)
})

test('canRead uses the route window itself, not the fit margin', () => {
  // 85% of its own window: readable, even though it is past the 0.8 margin.
  // Conflating the two sends a session off to another route and back for a
  // compaction the current route could have done itself.
  const tokens = Math.floor(LOCAL * 0.85)
  assert.equal(fitsWindow(tokens, LOCAL, CONFIG), false)
  assert.equal(canRead(tokens, LOCAL), true)
  assert.equal(canRead(STRANDED, LOCAL), false)
})

test('classify: "does not fit" splits into advisory and hard failure', () => {
  const advisory = classifyFit(Math.floor(LOCAL * 0.85), LOCAL, 0.8)
  assert.equal(advisory.fits, false)
  assert.equal(advisory.exceedsWindow, false, 'the next request will not fail; the harness compacts first')

  const hard = classifyFit(STRANDED, LOCAL, 0.8)
  assert.equal(hard.fits, false)
  assert.equal(hard.exceedsWindow, true, 'this is the stranding case: 400 now, 400 again in recovery')

  const unknown = classifyFit(STRANDED, undefined, 0.8)
  assert.equal(unknown.fits, true)
  assert.equal(unknown.exceedsWindow, undefined)
})

test('decideFit: no measurement or no declared window never blocks the switch', async () => {
  const noTokens = await decideFit({ tokens: undefined, fitRatio: 0.8, destWindow: LOCAL, currentWindow: () => BIG, autoCompact: true, dest: { provider: 'p', model: 'm' }, routedLabel: 'p/old' })
  assert.equal(noTokens.action, 'allow')
  assert.match(noTokens.note, /skipped/)

  const noWindow = await decideFit({ tokens: STRANDED, fitRatio: 0.8, destWindow: undefined, currentWindow: () => BIG, autoCompact: true, dest: { provider: 'p', model: 'm' }, routedLabel: 'p/old' })
  assert.equal(noWindow.action, 'allow')
  assert.match(noWindow.note, /no declared context window/)
})

test('decideFit: a route that can already hold the conversation is a plain allow', async () => {
  const decision = await decideFit({ tokens: 50000, fitRatio: 0.8, destWindow: LOCAL, currentWindow: () => BIG, autoCompact: true, dest: { provider: 'p', model: 'm' }, routedLabel: 'p/old' })
  assert.deepEqual(decision, { action: 'allow', tokens: 50000, window: LOCAL })
})

test('decideFit: the incident case is refused with numbers and a way out', async () => {
  // 421k of conversation, currently on a 262k route, asked to move to another
  // small route. Nothing can compact it from here.
  const decision = await decideFit({ tokens: STRANDED, fitRatio: 0.8, destWindow: LOCAL, currentWindow: () => LOCAL, autoCompact: true, dest: { provider: 'local', model: 'small' }, routedLabel: 'local/current' })
  assert.equal(decision.action, 'refuse')
  assert.match(decision.reason, /420948 tokens/)
  assert.match(decision.reason, /must read[\s\S]*summarize/)
  assert.match(decision.reason, /subagent/, 'the model needs an alternative it can act on')
})

test('decideFit: an undeclared current window is treated as cannot-read', async () => {
  const decision = await decideFit({ tokens: STRANDED, fitRatio: 0.8, destWindow: LOCAL, currentWindow: () => undefined, autoCompact: true, dest: { provider: 'local', model: 'small' }, routedLabel: 'unknown' })
  assert.equal(decision.action, 'refuse')
  assert.match(decision.reason, /no declared window/)
})

test('decideFit: a compactable move asks for compaction with the right budget', async () => {
  const decision = await decideFit({ tokens: STRANDED, fitRatio: 0.8, destWindow: LOCAL, currentWindow: () => BIG, autoCompact: true, dest: { provider: 'local', model: 'small' }, routedLabel: 'cloud/big' })
  assert.equal(decision.action, 'compact')
  assert.equal(decision.budget, budgetFor(LOCAL, 0.8))
  assert.ok(decision.budget < STRANDED, 'the budget must be below current pressure or compaction is a no-op')
})

test('decideFit: between the margin and the full current window the tool path refuses', async () => {
  // The switch tool keeps the fit margin for "can the current route compact
  // this"; only the interactive repair uses the full window (canRead).
  const tokens = Math.floor(LOCAL * 0.85)
  const decision = await decideFit({ tokens, fitRatio: 0.8, destWindow: 65536, currentWindow: () => LOCAL, autoCompact: true, dest: { provider: 'local', model: 'tiny' }, routedLabel: 'local/mid' })
  assert.equal(decision.action, 'refuse')
  assert.match(decision.reason, /cannot be compacted from the current route/)
  assert.equal(canCompactFrom(tokens, LOCAL, 0.8), false)
  assert.equal(canCompactFrom(Math.floor(LOCAL * 0.79), LOCAL, 0.8), true)
})

test('decideFit: the current window is only looked up when the destination does not fit', async () => {
  let lookups = 0
  const current = () => { lookups += 1; return BIG }
  await decideFit({ tokens: 50000, fitRatio: 0.8, destWindow: LOCAL, currentWindow: current, autoCompact: true, dest: { provider: 'p', model: 'm' }, routedLabel: 'p/old' })
  await decideFit({ tokens: undefined, fitRatio: 0.8, destWindow: LOCAL, currentWindow: current, autoCompact: true, dest: { provider: 'p', model: 'm' }, routedLabel: 'p/old' })
  assert.equal(lookups, 0)
  await decideFit({ tokens: STRANDED, fitRatio: 0.8, destWindow: LOCAL, currentWindow: current, autoCompact: true, dest: { provider: 'p', model: 'm' }, routedLabel: 'p/old' })
  assert.equal(lookups, 1)
})

test('decideFit: autoCompact false turns compact into a refusal that names /compact', async () => {
  const decision = await decideFit({ tokens: STRANDED, fitRatio: 0.8, destWindow: LOCAL, currentWindow: () => BIG, autoCompact: false, dest: { provider: 'local', model: 'small' }, routedLabel: 'cloud/big' })
  assert.equal(decision.action, 'refuse')
  assert.match(decision.reason, /autoCompact: false/)
  assert.match(decision.reason, /compact with \/compact first/)
  assert.match(decision.reason, /over the 209715-token budget/, 'the shortfall is stated in tokens')
})

test('suggestions: preferred routes beat a smaller fit', () => {
  const routes = [
    { provider: 'a', model: 'small-ish', contextWindow: 262144 },
    { provider: 'b', model: 'preferred', contextWindow: BIG },
    { provider: 'c', model: 'also-big', contextWindow: 1000000 },
  ]
  const config = { fitRatio: 0.8, preferredRoutes: [{ provider: 'b', model: 'preferred' }] }
  const picked = pickSuggestion(routes, STRANDED, config, [])
  assert.equal(picked.model, 'preferred')
  assert.equal(picked.preferred, true)
})

test('suggestions: without a preference, smallest window that still fits wins', () => {
  const routes = [
    { provider: 'b', model: 'big', contextWindow: BIG },
    { provider: 'a', model: 'mid', contextWindow: 600000 },
    { provider: 'c', model: 'too-small', contextWindow: 65536 },
  ]
  assert.equal(pickSuggestion(routes, STRANDED, CONFIG, []).model, 'mid')
})

test('suggestions: the route being left is never the recommendation', () => {
  const routes = [
    { provider: 'a', model: 'current', contextWindow: BIG },
    { provider: 'b', model: 'other', contextWindow: BIG },
  ]
  const picked = pickSuggestion(routes, STRANDED, CONFIG, [{ provider: 'a', model: 'current' }])
  assert.equal(picked.model, 'other')
})

test('suggestions: nothing fits is nothing to suggest', () => {
  const routes = [{ provider: 'a', model: 'small', contextWindow: 65536 }]
  assert.equal(pickSuggestion(routes, STRANDED, CONFIG, []), undefined)
  assert.equal(pickSuggestion(undefined, STRANDED, CONFIG, []), undefined)
})
