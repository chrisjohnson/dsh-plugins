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

// KAN-58: the board was hard-wired to three columns (min-width:780px) with no
// mobile rule, so on a ~390px phone only ~1.4 columns showed and the page
// scrolled sideways. On mobile it now collapses to one full-width track, shows
// Working, and tucks Backlog and Done behind reveal buttons.
test('the mobile board collapses to one track and reveals Backlog/Done behind buttons', async () => {
  const src = await clientSource()

  // A phone media query exists and re-declares the grid as a single track. The
  // literal marker is what the deploy pin-check greps for, so keep it exact.
  assert.match(src, /@media \(max-width:768px\)\{/, 'a mobile media query was added')
  assert.ok(src.includes('.kb-cols{grid-template-columns:1fr;min-width:0'), 'the board grid becomes one full-width track')
  assert.ok(src.includes('.kb-created{display:none}'), 'the low-value "created N ago" footer is hidden on mobile')
  // Backlog and Done are hidden by default on mobile and shown only when the
  // matching reveal class is on the grid container.
  assert.ok(src.includes('.kb-col-backlog,.kb-col-done{display:none}'), 'Backlog and Done start hidden on mobile')
  assert.ok(
    src.includes('.kb-cols.show-backlog .kb-col-backlog,.kb-cols.show-done .kb-col-done{display:flex}'),
    'the reveal classes bring a hidden column back'
  )
  // The reveal bar is a phone-only control: hidden in the base sheet.
  assert.ok(src.includes('.kb-mobcolbar{display:none}'), 'the reveal bar is hidden on desktop')

  // The wiring: each column carries a per-column class the CSS can target.
  assert.ok(src.includes('"kb-col kb-col-" + props.column'), 'Column tags itself with kb-col-<name>')

  // KanbanPage drives the reveal from one unconditional state hook (never a
  // conditional hook) and renders the two toggle buttons plus the container
  // classes the media query keys on.
  const page = sliceFunction(src, 'KanbanPage')
  assert.ok(page.includes('React.useState({ backlog: false, done: false })'), 'the reveal state is a single useState')
  assert.equal(/if[\s\S]{0,40}React\.useState/.test(page), false, 'no useState is called conditionally')
  assert.ok(page.includes('className: "kb-mobcolbar"'), 'the reveal bar renders')
  assert.equal((page.match(/kb-col-toggle/g) || []).length, 2, 'there are two reveal buttons')
  assert.ok(
    page.includes('"kb-cols" + (mobileShow.backlog ? " show-backlog" : "") + (mobileShow.done ? " show-done" : "")'),
    'the grid container carries the reveal classes'
  )
})

// KAN-65 kept: the orchestrator session can be retired without restarting the
// service. KAN-73 round 2 moved the control: it lives in the tray pill now (and
// in the phone-only header row), so the handler cannot be a KanbanPage closure.
test('the orchestrator restart moved into the tray and reports through the status store', async () => {
  const src = await clientSource()
  const page = sliceFunction(src, 'KanbanPage')
  const actions = sliceFunction(src, 'OrchestratorActions')

  // The desktop header no longer carries it: KanbanPage renders the shared
  // component inside a phone-only wrapper and nothing else.
  const header = page.slice(page.indexOf('className: "kb-actions"'))
  assert.equal(header.includes('children: "Restart orchestrator"'), false, 'the restart button is out of the header markup')
  assert.equal(header.includes('orchestratorSetPaused'), false, 'and so is the pause toggle')
  assert.match(header, /className: "kb-orc-mobileonly" \}, h\(OrchestratorActions\)/, 'the header keeps one phone-only row of the shared controls')
  assert.ok(page.includes('children: "Open orchestrator"'), 'the launcher itself is still there')

  // The control says what it does wherever it is mounted.
  assert.match(actions, /title: "Detach this orchestrator session and start a fresh one with the current tools and prompt — no service restart"/)
  assert.match(actions, /orchRestart\(\)/)

  // The module handler still asks first (the session it replaces is archived as it
  // happens) and still hits one endpoint.
  const restart = sliceFunction(src, 'orchRestart')
  assert.match(restart, /window\.confirm\("Restart the orchestrator session\?/)
  assert.match(restart, /rpc\("orchestratorDetach", \{\}\)/)
  assert.match(restart, /orchStatus\.set\("Orchestrator restarted: /)
  assert.match(restart, /orchStore\.refresh\(\)/)
  assert.match(restart, /if \(boardRefreshRequest\) boardRefreshRequest\(\)/, 'the mounted page is asked to re-read the board')
  assert.match(sliceFunction(src, 'orchSetPaused'), /rpc\("orchestratorSetPaused", \{ paused: paused \}\)/)

  // A plain handler, like the file's other actions: no hook is added for it, so
  // the slot's hook count cannot change between renders.
  assert.equal(/function orchRestart\(\)[\s\S]{0,700}?React\.use(State|Effect|Ref|Memo)/.test(src), false, 'the restart handler must not call a hook')
  assert.equal(/function orchSetPaused\([\s\S]{0,700}?React\.use(State|Effect|Ref|Memo)/.test(src), false, 'nor may the pause handler')
})


// KAN-68: the Work page said "Ticket flow from plan to approval · sequential
// workflow sessions" in a line nobody read. The five stages are now drawn as a
// ribbon the full width of the columns — a thin coloured bar per stage with the
// stage name floating under it, the same segment language a completed ticket's
// kb-steps strip uses. On a phone the words go and the bar stays.
test('the Work header draws the five-stage flow as a full-width ribbon', async () => {
  const src = await clientSource()
  const page = sliceFunction(src, 'KanbanPage')

  // The sentence is gone, and so is the board-dependent branch: the flow is
  // static, so the header no longer has a "Loading the board…" state.
  assert.equal(src.includes('Ticket flow from plan to approval'), false, 'the old subtitle line was replaced')
  assert.equal(src.includes('Loading the board…'), false, 'the ribbon does not wait on the board payload')

  // One segment per lifecycle phase, taken from PHASES so the ribbon cannot
  // drift from the engine's own lifecycle, bar above label.
  const flowAt = page.indexOf('className: "kb-flow"')
  assert.ok(flowAt >= 0, 'the ribbon renders in the page header')
  const flow = page.slice(flowAt, page.indexOf('h("div", { className: "kb-body"', flowAt))
  assert.match(flow, /PHASES\.map\(function \(phase\) \{/, 'segments come from PHASES in lifecycle order')
  assert.match(flow, /"kb-flow-seg kb-flow-seg-" \+ phase/, 'each segment is tagged with its phase')
  assert.match(flow, /className: "kb-flow-label", children: phaseLabel\(phase\)/, 'labels use the ticket lifecycle names: Plan, Build, Review, Approval, Done')
  assert.ok(flow.indexOf('kb-flow-bar') < flow.indexOf('kb-flow-label'), 'the bar sits above the label')
  // No hook is added for a static element, so the slot keeps its hook count.
  assert.equal(/React\.use/.test(flow), false, 'the ribbon adds no hook')

  // The five stage colors, in the ribbon's own rules, matching the phase tones
  // used by the card badges and the ticket lifecycle strip.
  const HEXES = { plan: '#2563eb', implement: '#0d9488', review: '#db2777', verify: '#7c3aed', closed: '#15803d' }
  Object.keys(HEXES).forEach((phase) => {
    assert.ok(
      src.includes(`.kb-flow-seg-${phase}{--kb-flow-color:${HEXES[phase]}}`),
      `the ${phase} segment carries its phase color`
    )
  })
  // Full width like the columns: it is its own row of the wrapping page header,
  // and it shares the header's horizontal inset, which is the body's too.
  assert.match(src, /\.kb-flow\{[^}]*flex:1 1 100%/, 'the ribbon takes a full-width row of the header')
  // Compact: a 4px bar, a 4px gap and a 13px label line.
  assert.match(src, /\.kb-flow-bar\{height:4px/, 'the bar stays thin')
  assert.match(src, /\.kb-flow-label\{font:600 10px\/13px/, 'the label line stays short')

  // Mobile: the labels are gone, the thin bar remains as the colour cue.
  const mobile = src.slice(src.indexOf('@media (max-width:768px){'))
  assert.ok(mobile.length > 0, 'the phone media query still exists')
  assert.match(mobile, /\.kb-flow-label\{display:none\}/, 'the labels are hidden on a phone')
  assert.match(mobile, /\.kb-flow-bar\{height:3px\}/, 'the bar survives on a phone')
})
