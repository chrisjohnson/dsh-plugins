import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

async function sources() {
  const names = (await readdir(SRC)).filter((name) => name.endsWith('.mjs'))
  const out = {}
  for (const name of names) out[name] = await readFile(join(SRC, name), 'utf8')
  return out
}

test('every HTTP route is under the authenticated /api fence', async () => {
  const host = (await sources())['host.mjs']
  assert.match(host, /const API_BASE = '\/api\/kanban'/)
  assert.match(host, /connection\.fetch\.register/)
  assert.equal(/webServer\.register/.test(host), false)
})

test('no credentials, provider endpoints or provider wire code', async () => {
  const files = await sources()
  for (const [name, text] of Object.entries(files)) {
    assert.equal(/apiKey\s*[:=]/.test(text), false, `${name} contains an API key field`)
    assert.equal(/baseURL\s*[:=]/.test(text), false, `${name} contains a provider endpoint`)
    assert.equal(/\bfetch\s*\(\s*['"`]https?:/.test(text), false, `${name} performs provider HTTP`)
    assert.equal(/Authorization\s*:/.test(text), false, `${name} writes an auth header`)
  }
})

test('the only model-facing tools are scoped phase actions', async () => {
  const files = await sources()
  assert.match(files['actions.mjs'], /kanban_submit_plan/)
  assert.match(files['actions.mjs'], /kanban_submit_implementation/)
  assert.match(files['actions.mjs'], /kanban_submit_review/)
  assert.match(files['actions.mjs'], /kanban_approve/)
  assert.match(files['actions.mjs'], /kanban_discard/)
  assert.equal(/kanban_(create|move|update|delete)/.test(files['actions.mjs']), false)
})

test('the standard preset is mounted once and no preset is recomposed', async () => {
  const dispatch = (await sources())['dispatch.mjs']
  assert.match(dispatch, /presets\.mount\(agentCtx, 'standard'\)/)
  assert.equal(/recompose\s*\(/.test(dispatch), false)
  assert.equal(/ensurePresets/.test(dispatch), false)
})

test('approval is a phase of the build session, not a session of its own', async () => {
  const files = await sources()
  // The separate approval session is gone: no engine method creates one, and no
  // endpoint asks for one.
  assert.equal(/startApprovalSession|approvalIntro/.test(files['engine.mjs']), false, 'engine still has the deleted approval-session code')
  assert.equal(/action === 'approvalSession'/.test(files['host.mjs']), false, 'host still routes an approval-session action')
  assert.equal(/liveTicketSession\(ticket\.id, 'approval'\)/.test(files['engine.mjs']), false)
  // The review-pass path hands its own session to the approval phase.
  assert.match(files['engine.mjs'], /enterApproval\(ticket, turn\.sessionId\)/)
  assert.match(files['engine.mjs'], /role: 'approver', purpose: 'build'/)
  assert.match(files['dispatch.mjs'], /role === 'approver'\) return 'build'/)
})

test('the client offers no approval-session launch', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  assert.equal(/Launch approval session|onApprovalSession|onStartSession/.test(client), false)
  assert.match(client, /Open build session/)
})

test('setRoutes decides nothing itself: it delegates to the routing module', async () => {
  const host = (await sources())['host.mjs']
  assert.match(host, /import \{ applyRoutes, prepareRoutes, staleEffortWarnings \} from '\.\/routing\.mjs'/)
  assert.match(host, /const prepared = await prepareRoutes\(\{/)
  // The exact-model lookup is the host registry, so an effort is checked against
  // the same catalog the dialog was built from.
  assert.match(host, /resolveModel: \(provider, model\) => llm\.resolveModelInfo\(provider, model\)/)
  assert.match(host, /await configEditor\.edit\(row\.entry, \(current, inherited\) => applyRoutes\(current, inherited, routes\)\)/)
  // The pre-effort inline write is gone: it silently kept a stale effort.
  assert.equal(/next\.roles\[route\.role\] = \{/.test(host), false, 'host.mjs re-inlined the route write')
  // A stale effort is a warning at boot, never a thrown error.
  assert.match(host, /staleEffortWarnings\(config\.roles,/)
})

test('the routing dialog edits a per-role effort and sends it', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  assert.match(client, /function effortsForModel\(groups, provider, model\)/)
  assert.match(client, /kb-route-effort-picker/)
  assert.match(client, /children: "Default"/)
  // The draft is seeded through the same rule that decides what may be sent.
  assert.match(client, /reasoningEffort: sendableEffort\(routing\.groups, route\.provider, route\.model, route\.reasoningEffort\) \|\| ""/)
  // Default is sent as null so the host clears a level saved earlier.
  assert.match(client, /reasoningEffort: sendableEffort\(routing\.groups, entry\.provider, entry\.model, entry\.reasoningEffort\)/)
  assert.match(client, /efforts\.length > 0 \? h\("select"/)
})

test('a level the row model does not offer is dropped, never sent', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  // The picker is hidden when nothing is offered, so a stale level has no control
  // to clear it — and one bad row makes the host reject the whole payload. The
  // client must therefore drop any level the row's model does not offer.
  assert.match(client, /function sendableEffort\(groups, provider, model, effort\)/)
  const body = client.slice(client.indexOf('function sendableEffort'))
  const fn = body.slice(0, body.indexOf('\n\t\t}') + 4)
  assert.match(fn, /if \(effort === "" \|\| effort === undefined \|\| effort === null\) return null/)
  // Unknown model: leave it to the host, which reads the live registry.
  assert.match(fn, /if \(!known\) return effort/)
  // Known model: only an offered id survives.
  assert.match(fn, /effortsForModel\(groups, provider, model\)/)
  assert.match(fn, /return null;\n\t\t\}/)
  // Both the seed and the save go through it, so neither can carry a stale level.
  assert.equal((client.match(/sendableEffort\(routing\.groups/g) || []).length, 2, 'both startRoutingEdit and saveRouting must filter the effort')
})

// --------------------------------------------------------------- KAN-13

test('sessionInfo is a registered endpoint and answers from the board, not the call', async () => {
  const host = (await sources())['host.mjs']
  assert.match(host, /'sessionInfo',/, 'sessionInfo must be in ENDPOINTS so the route is registered')
  const caseBody = host.slice(host.indexOf("case 'sessionInfo'"))
  assert.match(caseBody, /store\.findSession\(sessionId\)/)
  // The projection is the ticket's real state: phase, plan, conditions, review.
  for (const field of ['phase:', 'plan:', 'conditions:', 'review:', 'reviewFeedback:', 'reviewRejected:', 'acceptance:']) {
    assert.match(caseBody, new RegExp(field), `sessionInfo must return ${field}`)
  }
  // The client cannot tell "this pass was bounced by the code check" from "this
  // pass landed and a follow-up plan moved the ticket back" without artifact
  // ordering, so the host must derive it. Both rows come from latestArtifact and
  // the comparison must be on ids, not on content or presence.
  assert.match(caseBody, /reviewRejected: reviewArtifact !== undefined/, 'reviewRejected must require a review to exist')
  assert.match(caseBody, /feedbackArtifact !== undefined/, 'reviewRejected must require feedback to exist')
  assert.match(caseBody, /Number\(feedbackArtifact\.id\) > Number\(reviewArtifact\.id\)/, 'reviewRejected must compare artifact ids, newest feedback wins')
  assert.match(caseBody, /latestArtifact\(ticket\.id, 'review'\)/)
  assert.match(caseBody, /latestArtifact\(ticket\.id, 'review_feedback'\)/)
  assert.match(caseBody, /not_found/)
})

test('the needs-attention card is static red, the in-flight card still glows', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  assert.equal(client.includes('kb-glow-red'), false, 'the attention card must not animate')
  const attention = client.slice(client.indexOf('.kb-card.attention{'), client.indexOf('.kb-card.attention::before'))
  assert.match(attention, /border-color:color-mix\(in srgb,#b91c1c 45%/)
  assert.match(attention, /background:color-mix\(in srgb,#b91c1c 6%/)
  assert.equal(attention.includes('animation'), false, 'the attention rule must carry no animation')
  const dot = client.slice(client.indexOf('.kb-statusdot.attention{'), client.indexOf('.kb-statusdot.attention{') + 80)
  assert.match(dot, /background:#b91c1c/)
  assert.equal(dot.includes('box-shadow'), false, 'the attention status dot must not carry a ring')
  // The blue in-flight treatment is untouched.
  assert.match(client, /\.kb-card\.active\{[^}]*animation:kb-glow-blue/)
  assert.match(client, /@keyframes kb-glow-blue/)
  assert.match(client, /\.kb-statusdot\.active\{[^}]*animation:kb-pulse/)
  // Reduced motion still covers what does animate.
  const motion = client.slice(client.indexOf('@media (prefers-reduced-motion'), client.indexOf('@media (max-width:900px)'))
  assert.match(motion, /\.kb-card\.active/)
  assert.equal(motion.includes('.kb-card.attention'), false, 'a static card needs no reduced-motion entry')
})

test('nothing opens a session on its own', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  // Every remaining caller is a click handler; no effect may navigate.
  assert.equal(/autoOpenedSessions|knownPlanSessions|planSeen/.test(client), false, 'the auto-open bookkeeping must be gone')
  // No effect anywhere in the client may navigate: every remaining call sits on
  // the same line as the click that caused it, or is the definition itself.
  const callers = client.split('\n').filter((line) => line.includes('openSessionById'))
  assert.equal(callers.length, 4, 'one definition and three click handlers, nothing else')
  for (const line of callers) {
    const allowed = line.includes('var openSessionById = null;')
      || line.includes('openSessionById = function')
      || line.includes('onClick')
      || line.includes('onOpenSession')
    assert.equal(allowed, true, `not a click handler: ${line.trim()}`)
  }
  // The explicit buttons stay.
  assert.match(client, /props\.onOpenSession\(sessionId\)/)
  assert.match(client, /openSessionById\(session\.sessionId\)/)
  assert.match(client, /children: "Recover tools"/)
})

test('the phase banner is a turn-tail entry validated against the board', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  assert.match(client, /slots\.inject\("conversation\.chat\.turnTail"/)
  assert.match(client, /id: "kanban-phase-banner"/)
  // It reads the turn's own tool calls and asks the host before saying anything.
  assert.match(client, /function kanbanCallsInTurn\(turn\)/)
  assert.match(client, /kind !== "tool-call"/)
  assert.match(client, /indexOf\("kanban_"\)/)
  assert.match(client, /rpc\("sessionInfo", \{ sessionId: sessionId \}\)/)
  // All five transitions have wording.
  for (const text of ['Plan submitted', 'Implementation submitted', 'Review status: not finished', 'Review passed', 'Ticket approved and closed', 'Ticket discarded']) {
    assert.ok(client.includes(text), `the banner must render "${text}"`)
  }
  // A refused call must not claim a transition: every branch checks the phase.
  const banner = client.slice(client.indexOf('function bannerFor'), client.indexOf('function fetchSessionInfo'))
  assert.match(banner, /order >= PHASE_ORDER\.implement/)
  assert.match(banner, /order >= PHASE_ORDER\.review/)
  assert.match(banner, /order >= PHASE_ORDER\.verify/)
  assert.match(banner, /ticket\.column === "done"/)
  assert.match(banner, /ticket\.column === "discarded"/)
  // The full text is on hover, the line is truncated by CSS.
  assert.match(client, /title: banner\.text/)
  assert.match(client, /\.kb-banner-text\{[^}]*text-overflow:ellipsis/)
})
