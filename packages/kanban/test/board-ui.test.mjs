// The board's browser-side rules, evaluated from the real client source.

import test from 'node:test'
import assert from 'node:assert/strict'

import { clientSource, loadClientHelpers, sliceFunction } from './client-source.mjs'

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

// KAN-57: the plan has to be shown to the person being asked to approve it.
test('the plan park is recognised by phase and reason, not by guesswork', async () => {
  const { planAwaitsApproval } = await loadClientHelpers(['planAwaitsApproval'])
  assert.equal(planAwaitsApproval(null), false)
  assert.equal(planAwaitsApproval({ phase: 'plan' }), false, 'no reason is no park')
  assert.equal(planAwaitsApproval({ phase: 'plan', needsAttentionReason: 'Plan ready: 2 sandbox grant(s) declared' }), true)
  assert.equal(planAwaitsApproval({ phase: 'plan', needsAttentionReason: 'Engine halted: the build died' }), false, 'another park is not the plan park')
  assert.equal(planAwaitsApproval({ phase: 'implement', needsAttentionReason: 'Plan ready: x' }), false, 'a ticket that moved on is not waiting on its plan')
})

test('the release scope says what the server says it says', async () => {
  const { releaseScopeLabel } = await loadClientHelpers(['releaseScopeLabel'])
  assert.match(releaseScopeLabel('stop_before_merge'), /stop before the release/)
  assert.match(releaseScopeLabel('full_release'), /full release/)
  assert.equal(releaseScopeLabel('other'), 'release scope: other')
})

test('the Plan panel renders under the Body and owns the plan buttons', async () => {
  const src = await clientSource()
  const overview = src.slice(src.indexOf('function Overview(props)'))
  const bodyAt = overview.indexOf('children: "Body"')
  const planAt = overview.indexOf('h("h3", { children: d.plan.planVersion ? "Plan · v"')
  const acceptanceAt = overview.indexOf('Acceptance — the human')
  assert.ok(bodyAt >= 0 && planAt > bodyAt && acceptanceAt > planAt, 'Plan renders between the Body and the Acceptance panel')
  assert.match(overview, /renderMarkdown\(d\.plan\.summary\)/, 'the summary is shown, as markdown')
  assert.match(overview, /className: "kb-plan-steps"/, 'the steps are a numbered list')
  assert.match(overview, /releaseScopeLabel\(d\.plan\.releaseScope\)/, 'the release scope rides along')
  assert.match(overview, /className: "kb-panel kb-md" \+ \(planAwaitsApproval\(t\) \? " kb-plan-await" : ""\)/, 'the glow is the park, not every plan')
  assert.match(overview, /props\.onResolve\(t\.id, "approvePlan"\)/)
  assert.match(overview, /props\.onRevisePlan/, 'Revise plan opens the same modal the hero used to')
  // The hero no longer carries either button; the chip that says a decision is
  // owed stays where it was.
  const hero = src.slice(src.indexOf('function TicketDetail(props)'), src.indexOf('h("h2", { className: "kb-hero-title"'))
  assert.ok(hero.length > 0, 'the hero slice was found')
  assert.equal(hero.includes('approvePlan'), false, 'Approve plan moved into the Plan panel')
  assert.equal(hero.includes('"Revise plan"'), false, 'Revise plan moved into the Plan panel')
  assert.match(hero, /awaiting approval/)
  // The panel is a conditional element, not a conditional hook: Overview calls
  // no hooks at all, and TicketDetail still calls exactly its two state pairs.
  assert.equal(/React\.use/.test(sliceFunction(src, 'Overview')), false, 'Overview adds no hooks')
  assert.equal((sliceFunction(src, 'TicketDetail').match(/React\.useState/g) || []).length, 2, 'TicketDetail keeps exactly its two state hooks')
})
