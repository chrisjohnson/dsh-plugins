import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

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

test('the preset is mounted once from the ticket choice and no preset is recomposed', async () => {
  const dispatch = (await sources())['dispatch.mjs']
  // KAN-15: build takes the ticket's preset (undefined = harness default),
  // plan and verify stay on standard; the mount happens exactly once per session.
  assert.match(dispatch, /const presetChoice = purpose === 'build' \? \(ticket\.preset \?\? undefined\) : 'standard'/)
  assert.match(dispatch, /presets\.mount\(agentCtx, presetChoice\)/)
  assert.match(dispatch, /presets\.mount\(agentCtx, undefined\)/, 'the fallback remounts the harness default')
  assert.equal((dispatch.match(/presets\.mount\(/g) || []).length, 2, 'one requested mount plus the fallback mount, nothing else')
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
  assert.match(files['engine.mjs'], /enterApproval\(ticket, turn\.sessionId, \{ deferred: decision\.deferred \}\)/)
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
  const motion = client.slice(client.indexOf('@media (prefers-reduced-motion'), client.indexOf('@media (max-width:900px){.kb-analytics-kpis'))
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
  // Every open goes through a handler that reports a failure: the button
  // component, or the alert helper for controls with no room for a message.
  assert.equal(callers.length, 4, 'one declaration, one definition and the two reporting handlers, nothing else')
  for (const line of callers) {
    const allowed = line.includes('var openSessionById = null;')
      || line.includes('openSessionById = function')
      || line.includes('var opening = openSessionById')
    assert.equal(allowed, true, `not the declaration, the definition or the click handler: ${line.trim()}`)
  }
  // The explicit buttons stay, all of them the loading-and-error button.
  assert.match(client, /h\(OpenSessionButton, \{ sessionId: session\.sessionId, label: "Open"/)
  assert.match(client, /h\(OpenSessionButton, \{ sessionId: sessionId, label: "Open build session" \}\)/)
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

// --------------------------------------------------------------- KAN-14

test('the host update path is the guarded edit boundary, not a raw store write', async () => {
  const host = (await sources())['host.mjs']
  assert.match(host, /import \{[^}]*\beditTicket\b[^}]*\} from '\.\/edit\.mjs'/)
  const update = host.slice(host.indexOf("case 'update'"), host.indexOf("case 'move'"))
  // KAN-7: the patch is copied and its body image refs resolved first, but the
  // write itself is still exactly one guarded editTicket call.
  assert.match(update, /editTicket\(store, String\(p\.id\), patch/)
  assert.match(update, /prepareBodyImages\(\{ body: draftBody, images: uploads, attachments: attachments\(\) \}\)/)
  assert.equal(/store\.updateTicket\(/.test(update), false, 'the update endpoint must not bypass the guard')
  // Engine-internal writes stay direct: reorder, worktree creation, the retry patch.
  assert.match(host, /store\.updateTicket\(ticket\.id, patch, \{ actor: 'human', reason: 'reorder' \}\)/)
  assert.match(host, /store\.updateTicket\(ticket\.id, \{ workspaceCwd: created\.managedRoot \}/)
  // KAN-60: the retry patch names whoever asked, so the actor is a variable here
  // and not a literal — the guard this test keeps is that the write is one call
  // inside retry(), not a raw store write on the endpoint.
  assert.match((await sources())['engine.mjs'], /this\.store\.updateTicket\(ticket\.id, patch, \{ actor, reason: 'needs_attention resolution' \}\)/)
})

// --------------------------------------------------------------- KAN-7

test('create stores images and resolves refs before the ticket exists', async () => {
  const host = (await sources())['host.mjs']
  const create = host.slice(host.indexOf("case 'create'"), host.indexOf("case 'update'"))
  // The image gate runs before createTicket; a failed save creates nothing.
  assert.ok(create.indexOf('prepareBodyImages') < create.indexOf('store.createTicket'), 'images must resolve before the ticket row is written')
  assert.match(create, /if \(!prepared\.ok\) return fail\('bad_request', prepared\.error\)/)
  // KAN-72: the column the caller asked for is honoured unless the Working cap
  // is full, in which case the row is created in Backlog wearing the queue park.
  assert.match(create, /store\.createTicket\(\{ \.\.\.fields, body: prepared\.body, column: queued === null \? column : 'backlog' \}\)/)
})

test('readImage is a registered endpoint answering through the store helper', async () => {
  const host = (await sources())['host.mjs']
  assert.match(host, /'readImage',/, 'readImage must be in ENDPOINTS so the route is registered')
  const read = host.slice(host.indexOf("case 'readImage'"), host.indexOf("case 'create'"))
  assert.match(read, /readImageFromStore\(attachments\(\), String\(p\.attachmentId \?\? ''\)\)/)
  assert.match(read, /if \(!out\.ok\) return fail\(out\.code, out\.error\)/)
  assert.match(read, /base64: out\.value\.base64/)
})

test('the detail response carries the body image refs', async () => {
  const host = (await sources())['host.mjs']
  const detail = host.slice(host.indexOf('const detail = (id'), host.indexOf('const handler ='))
  assert.match(detail, /images: describeBodyImages\(attachments\(\), ticket\.body \?\? ''\)/)
})

test('both acceptance actions go through the guarded boundary', async () => {
  const host = (await sources())['host.mjs']
  const actions = host.slice(host.indexOf("case 'action'"), host.indexOf("case 'reorder'"))
  assert.match(actions, /return appendAcceptance\(store, ticket\.id, p\.statement\)/)
  assert.match(actions, /action === 'setAcceptance'/)
  assert.match(actions, /return replaceAcceptance\(store, ticket\.id, p\.statements\)/)
  assert.equal(/store\.addAcceptance\(/.test(actions), false, 'the unguarded direct add is gone')
})

test('the board and the detail both carry the editable flag', async () => {
  const files = await sources()
  const host = files['host.mjs']
  const snapshot = files['board-snapshot.mjs']
  assert.match(snapshot, /summary\(ticket, store\.isEditableTicket\(ticket\), nowMs\)/, 'every board card knows if it is still editable')
  assert.match(snapshot, /export function summary\(ticket, editable = false/)
  assert.match(host, /const editable = store\.isEditableTicket\(ticket\)/, 'the detail computes the same predicate')
  assert.equal((snapshot.match(/^\s+editable,$/gm) || []).length, 1, 'summary carries it once')
  assert.equal((host.match(/^\s+editable,$/gm) || []).length, 1, 'and so does the detail')
})

test('the detail hero has one Edit ticket pencil, disabled once the ticket started', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  assert.match(client, /"Locked — the ticket has already started"/)
  assert.match(client, /disabled: t\.editable === false/)
  assert.equal(client.includes('Edit modes and budget'), false, 'the old pencil is gone')
  assert.equal(/function ModeEditor\b|function AcceptanceEditor\b/.test(client), false, 'the two old editors are gone')
  assert.match(client, /function TicketEditor\(props\)/)
  assert.match(client, /h\(TicketEditor, \{/, 'the hero opens the one editor')
})

test('the unified editor saves every field in one update call', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  const body = client.slice(client.indexOf('function TicketEditor'), client.indexOf('function Timeline'))
  assert.ok(body.length > 500, 'TicketEditor must be present and complete')
  for (const label of ['Ticket title', 'Ticket body', 'Acceptance statements', 'Planning', 'Questions', 'Priority', 'Allow paid models', 'Budget USD', 'Workspace cwd']) {
    assert.ok(body.includes(label), `the editor must expose ${label}`)
  }
  // Acceptance rides on the same save, and only when a line actually changed.
  assert.match(body, /if \(acceptanceChanged\) patch\.acceptance = lines/)
  assert.match(body, /props\.onSave\(patch\)/)
  assert.equal((body.match(/rpc\(/g) || []).length, 0, 'the editor makes exactly one call, through onSave')
  // The old add-only path is gone from the client: acceptance is edited, not appended.
  assert.equal(client.includes('addAcceptance'), false)
})

test('the panel returns the save so the editor can close on success', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  // Without the `return`, the editor resolves undefined, reports a save that
  // actually landed as an error, and leaves its modal open.
  assert.match(client, /onSave: function \(id, patch, images\) \{ return act\("update", \{ id: id, patch: patch, images: images \|\| \[\] \}\); \}/)
})

// KAN-7: the browser half mirrors src/images.mjs rules and shares one draft
// manager between both editing surfaces.
test('both editing surfaces share the image draft manager', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  assert.match(client, /function imageDrafts\(getBody, setBody, bodyRef\)/)
  // Called unconditionally by exactly the two forms — never conditionally, the
  // hook gate would fail it.
  assert.equal((client.match(/= imageDrafts\(/g) || []).length, 2, 'CreateForm and TicketEditor each call imageDrafts once')
  assert.match(client, /imageTextareaProps\(imgs, bodyRef\)\)\)/)
  assert.equal((client.match(/imageTextareaProps\(imgs, bodyRef\)\)\)/g) || []).length, 2)
  assert.match(client, /onPaste: function \(ev\) \{/)
  assert.match(client, /onDrop: function \(ev\) \{/)
  assert.match(client, /children: "Add image"/)
  assert.match(client, /pending-" \+ token/)
})

test('the client enforces the same image limits as the host', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  assert.match(client, /var IMG_MAX = 10;/)
  assert.match(client, /var IMG_MAX_BYTES = 20 \* 1024 \* 1024;/)
  assert.match(client, /"image\/png", "image\/jpeg", "image\/webp", "image\/gif"/)
  assert.match(client, /A ticket carries at most " \+ IMG_MAX \+ " images\./)
})

test('the detail renders the body as markdown and reads images through the RPC', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  assert.match(client, /function renderMarkdown\(text\)/)
  assert.match(client, /h\(BodyImage, \{ key: key \+ "-" \+ i, attachmentId: m\[2\], name: m\[1\] \}\)/)
  assert.match(client, /rpc\("readImage", \{ attachmentId: attachmentId \}\)/)
  assert.match(client, /image unavailable/)
  // The Body panel sits in the Overview.
  const overview = client.slice(client.indexOf('function Overview(props)'))
  assert.match(overview, /children: "Body"/)
  assert.match(overview, /renderMarkdown\(t\.body\)/)
})

// --------------------------------------------------------------- KAN-7.1
test('ensureStyles refreshes a stale style tag instead of skipping it', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  const fn = client.slice(client.indexOf('function ensureStyles'), client.indexOf('// ------------------------------------------------------------------ icon'))
  // The 0.11.0 early-return left old CSS styling new markup after an
  // in-place client swap — the tile must re-adopt the running stylesheet.
  assert.match(fn, /if \(existing\.textContent !== CSS\) existing\.textContent = CSS;/)
  assert.equal(/if \(document\.getElementById\(id\)\) return;/.test(fn), false, 'the bare early-return is the bug')
})

test('the tile X floats over the corner and reveals on hover or focus', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  assert.match(client, /\.kb-img-x\{position:absolute;top:-7px;right:-7px;z-index:1[^}]*opacity:0;transition:opacity \.12s ease\}/)
  assert.match(client, /\.kb-img-tile:hover \.kb-img-x,\.kb-img-tile:focus-within \.kb-img-x\{opacity:1\}/)
  // The tile must not clip the overhanging badge.
  assert.equal(/\.kb-img-tile\{[^}]*overflow:hidden/.test(client), false)
})

// --------------------------------------------------------------- KAN-15

test('create validates the write mode and the preset before the row exists', async () => {
  const host = (await sources())['host.mjs']
  const create = host.slice(host.indexOf("case 'create'"), host.indexOf("case 'update'"))
  // The closed vocabulary is imported from the store, not re-declared here.
  assert.match(host, /import \{ KanbanStore, WRITE_MODES \} from '\.\/store\.mjs'/)
  assert.match(create, /!WRITE_MODES\.includes\(p\.writeMode\)/)
  assert.match(create, /return fail\('bad_request', `writeMode must be one of \$\{WRITE_MODES\.join\(', '\)\}`\)/)
  // A supplied preset is resolved against the live registry; unknown ids answer
  // unknown_preset, and the check sits before createTicket so nothing is half-written.
  assert.ok(create.indexOf('presets.resolve') < create.indexOf('store.createTicket'), 'the preset must be checked before the ticket row is written')
  assert.match(create, /await presets\.resolve\(String\(p\.preset\)\)/)
  assert.match(create, /return fail\('unknown_preset', `unknown agent preset: \$\{p\.preset\}`\)/)
  // null/undefined preset means the harness default and is never resolved.
  assert.match(create, /if \(p\.preset !== undefined \&\& p\.preset !== null\) \{/)
})

test('capabilities exposes the preset roster with the harness default id', async () => {
  const host = (await sources())['host.mjs']
  const capabilities = host.slice(host.indexOf("case 'capabilities'"), host.indexOf("case 'worktree'"))
  assert.match(capabilities, /presets: await presetsCapability\(ctx, log\)/)
  assert.match(capabilities, /writeModes: WRITE_MODES/)
  const helper = host.slice(host.indexOf('async function presetsCapability'))
  const body = helper.slice(0, helper.indexOf('\n}\n') + 3)
  assert.match(body, /ctx\.get\('agentPresets'\)/)
  assert.match(body, /await presets\.list\(\)/)
  assert.match(body, /default: presets\.defaultId \?\? null/)
  // KAN-56: the wire carries the harness display name, never the bare id.
  assert.match(body, /name: presetDisplayName\(row\.id, row\.name\)/)
  assert.match(body, /broken: row\.broken !== undefined \&\& row\.broken !== null/)
  // A missing or failing registry says null, it never takes capabilities down.
  assert.match(body, /return null/)
})

test('the client offers both options in create and edit and shows them in the overview', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  // The picker: harness default first (empty value = null), broken ones labelled,
  // and every label is display copy — a shipped id reads as the harness name.
  assert.match(client, /function presetOptions\(presets\)/)
  assert.match(client, /"Harness default \(" \+ defLabel \+ "\)"/)
  assert.match(client, /presetDisplayName\(def, presetNameFromWire\(presets, def\)\)/)
  assert.match(client, /presetDisplayName\(p\.id, p\.name\)/)
  assert.match(client, /\(p\.broken \? " \(unavailable\)" : ""\)/)
  // The write-mode control carries the closed vocabulary with workspace-write default.
  assert.match(client, /var WRITE_MODE_OPTIONS = \[/)
  assert.match(client, /\{ value: "workspace-write", label: "Workspace write" \}/)
  assert.match(client, /\{ value: "danger-full-access", label: "Full access" \}/)
  // Create sends the empty preset as null; both forms carry the two controls.
  assert.match(client, /preset: form\.preset \|\| null,/)
  assert.match(client, /writeMode: form\.writeMode/)
  assert.equal((client.match(/ariaLabel: "Preset"/g) || []).length, 2, 'CreateForm and TicketEditor each render the picker')
  assert.equal((client.match(/ariaLabel: "Write mode"/g) || []).length, 2, 'CreateForm and TicketEditor each render the control')
  // The editor diffs both into the one save patch.
  const editor = client.slice(client.indexOf('function TicketEditor'), client.indexOf('function Timeline'))
  assert.match(editor, /if \(nextPreset !== \(t\.preset === undefined \? null : t\.preset\)\) patch\.preset = nextPreset/)
  assert.match(editor, /if \(form\.writeMode !== \(t\.writeMode \|\| "workspace-write"\)\) patch\.writeMode = form\.writeMode/)
  // The overview shows the stored choice as display copy, and says the default
  // is what a ticket that chose nothing tracks (KAN-56).
  const meta = client.slice(client.indexOf('function TicketMeta(props)'), client.indexOf('function TicketDetail(props)'))
  assert.match(meta, /t\.preset \? presetDisplayName\(t\.preset, presetNameFromWire\(props\.presets, t\.preset\)\) : "harness default"/)
  assert.match(meta, /t\.writeMode \|\| "workspace write"/)
})

// --------------------------------------------------------------- KAN-16

test('startPlanning is a host action that delegates to the planning module', async () => {
  const host = (await sources())['host.mjs']
  assert.match(host, /import \{ startPlanning \} from '\.\/planning\.mjs'/)
  const action = host.slice(host.indexOf("case 'action':"))
  assert.match(action, /if \(action === 'startPlanning'\) \{/)
  // The decision is not re-inlined in the wiring: one call, its result mapped
  // onto the existing envelope, and the same engineRef the other actions use.
  assert.match(action, /const result = startPlanning\(\{ store, driver, engine: engineRef\.current, ticket \}\);/)
  assert.match(action, /if \(!result\.ok\) return fail\(result\.code, result\.message\);/)
  assert.match(action, /return \{ ok: true, value: \{ ticket: result\.ticket \} \};/)
})

test('the planning module owns the guards and never moves the ticket', async () => {
  const planning = (await sources())['planning.mjs']
  // Column and phase are checked, never written: the only store calls are the
  // park lift and the planTiming flip.
  assert.match(planning, /ticket\.column !== 'backlog' \|\| ticket\.phase !== 'plan'/)
  assert.equal(/store\.(transitionTicket|setColumn|setPhase)/.test(planning), false, 'start planning must not move the ticket')
  assert.match(planning, /store\.clearNeedsAttention\(ticket\.id, \{ actor: 'human', reason: 'start planning' \}\)/)
  assert.match(planning, /store\.updateTicket\(ticket\.id, \{ planTiming: 'now' \}, \{ actor: 'human', reason: 'start planning' \}\)/)
  assert.match(planning, /if \(typeof engine\?\.tick === 'function'\) void engine\.tick\(\);/)
})

test('the client offers Start planning on the card and in the detail hero', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  // One rule, used by both seats.
  assert.match(client, /function canStartPlanning\(t\) \{/)
  assert.equal((client.match(/canStartPlanning\(/g) || []).length, 3, 'the definition plus the card and the hero')
  // The card button stops the click so it does not also open the detail.
  const card = client.slice(client.indexOf('function Card(props)'), client.indexOf('function Column(props)'))
  assert.match(card, /h\("div", \{ className: "kb-cardfoot" \},[\s\S]*canStartPlanning\(t\) \? h\("button"/)
  assert.match(card, /ev\.stopPropagation\(\);\s*\n\s*if \(props\.onStartPlanning\) props\.onStartPlanning\(t\.id\);/)
  // Column passes the handler down; the board sends it as an action and lets act()
  // refresh the board and surface a refusal as a notice.
  assert.match(client, /onStartPlanning: props\.onStartPlanning/)
  assert.match(client, /onStartPlanning: startPlanningNow/)
  assert.match(client, /function startPlanningNow\(id\) \{\s*\n\s*return act\("action", \{ id: id, action: "startPlanning" \}\);/)
  // The detail hero sits next to the pencil and uses the detail's own action prop.
  const hero = client.slice(client.indexOf('function TicketDetail(props)'), client.indexOf('function ApprovalPanel'))
  assert.match(hero, /canStartPlanning\(\{ column: t\.column, phase: t\.phase, planTiming: t\.planTiming, status: detailStatus, awaitingQuestion: d\.awaitingQuestion \}\)/)
  assert.match(hero, /props\.onAction\(t\.id, "startPlanning", \{\}\)/)
})

test('the client rule and the host rule say the same thing', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  const planning = (await sources())['planning.mjs']
  const rule = (text, name) => {
    const body = text.slice(text.indexOf(`function ${name}`))
    const lines = body.split('\n').slice(0, 10).join('\n')
    return [
      /column !== ["']backlog["'] \|\| .*phase !== ["']plan["']/.test(lines),
      /planTiming === ["']now["']/.test(lines),
      /status.*=== ["']active["']/.test(lines),
      /awaitingQuestion/.test(lines),
    ]
  }
  const [host, browser] = [rule(planning, 'canStartPlanning'), rule(client, 'canStartPlanning')]
  assert.deepEqual(browser, host, 'the client hides a button the host would accept, or offers one it would refuse')
  assert.deepEqual(host, [true, true, true, true], 'the host rule lost one of its four conditions')
})

test('KAN-17: a mid-turn human wait reaches the board as attention', async () => {
  const files = await sources()
  const host = files['host.mjs']
  const dispatch = files['dispatch.mjs']
  const client = files['client.mjs']

  // The driver owns the fold and answers both kinds of wait for any phase.
  assert.match(dispatch, /this\.humanWaits = new WaitLedger\(/)
  assert.match(dispatch, /case 'approval\/asked'/)
  assert.match(dispatch, /case 'approval\/decided'/)
  assert.match(dispatch, /isAwaitingApproval\(ticketId\)/)
  assert.match(dispatch, /isAwaitingQuestion\(ticketId\)/)
  assert.match(dispatch, /#seedHumanWait\(sessionId, agent\)/, 'reattach seeds the wait from the session log')

  // The host feeds both flags to the card status and surfaces them on the board
  // and in the detail, with a reason that names which ask is pending.
  const snapshot = files['board-snapshot.mjs']
  assert.match(host, /attentionFacts\(ticket, \{ engine, driver \}\)\.status/)
  assert.match(snapshot, /attentionFacts\(ticket, \{ engine, driver \}\)\.status/)
  assert.match((await sources())['attention.mjs'], /awaitingApproval,\n\s*\}\);|awaitingUser: awaitingQuestion,\n\s*awaitingApproval,/)
  assert.match(snapshot, /item\.awaitingApproval = driver\.isAwaitingApproval\(ticket\.id\)/)
  assert.match(snapshot, /'Awaiting your approval'/)
  assert.match(host, /awaitingApproval,\n\s*status:/, 'the detail payload carries the flag')
  assert.match(host, /pendingWait\?\.sessionId/, 'the detail points at the session holding the ask')
  // The question scan is no longer gated on the plan phase.
  assert.equal(/ticket\.phase === 'plan' && driver\.isAwaitingUser/.test(host), false)

  // The client labels both cases and offers the way to the prompt.
  assert.match(client, /t\.awaitingApproval \? "Awaiting approval"/)
  assert.match(client, /\(t\.awaitingQuestion \|\| t\.parkedOnQuestion\) \? "Waiting on you"/)
  assert.match(client, /d\.awaitingApproval \? "awaiting approval"/)
  assert.match(client, /sessionId: d\.approvalSessionId,\s*label: "Open session"/)
})

// ---------------------------------------------------------------- KAN-18 lazy worktree

test('the new-ticket worktree switch records intent and creates nothing', async () => {
  const files = await sources()
  const client = files['client.mjs']
  // The eager path is gone from the form: no rpc call, and none of the state that
  // only existed to show a copy that had already been made.
  assert.equal(/rpc\("worktree"/.test(client), false, 'the create form must not create a working copy any more')
  assert.equal(/worktreeCreated|worktreePath|createWorktree\b/.test(client), false, 'the eager-create form state is gone')
  assert.match(client, /worktree: wantWorktree/, 'the create payload carries the intent flag')
  assert.match(client, /form\.worktree === null \? Boolean\(props\.worktreeAvailable\)/, 'the switch defaults to on when the service is mounted')
  assert.match(client, /On by default: a worktree from the latest main is created when planning starts\./)
  // The host endpoint stays as the manual escape hatch; the form just no longer calls it.
  assert.match(files['host.mjs'], /case 'worktree':/)
})

test('planning settles the working copy through the betterGitWorktree seam', async () => {
  const files = await sources()
  assert.match(files['dispatch.mjs'], /async preparePlanWorktree\(ticket\)/)
  assert.match(files['dispatch.mjs'], /refreshManagedCopy\(\{ path: ticket\.workspaceCwd, fetchFirst: true \}\)/)
  assert.match(files['dispatch.mjs'], /fetchFirst: true,/)
  assert.match(files['dispatch.mjs'], /baseOnRemote: true,/)
  assert.match(files['dispatch.mjs'], /worktree created at plan start/)
  // The engine asks before it renders the prompt, and passes the answer down.
  const plan = files['engine.mjs'].slice(files['engine.mjs'].indexOf('async plan(ticket)'))
  assert.ok(plan.indexOf('preparePlanWorktree') < plan.indexOf('render('), 'the copy is settled before the prompt is rendered')
  assert.match(plan, /preparedCwd: prep\.cwd/)
  assert.match(files['engine.mjs'], /ensureTicketSession\(\{ ticket, role, route, purpose, preparedCwd \}\)/)
})

// --------------------------------------------------------------- KAN-30

test('approvePlan is wired on both endpoints and the engine owns the decision', async () => {
  const files = await sources()
  const host = files['host.mjs']
  // Both the resolve and the action endpoint accept it, and both delegate —
  // the host decides nothing itself.
  assert.equal((host.match(/action === 'approvePlan'/g) || []).length, 2, 'approvePlan on resolve and action')
  assert.equal((host.match(/engineRef\.current\.approvePlan\(/g) || []).length, 2)
  const engine = files['engine.mjs']
  assert.match(engine, /async approvePlan\(ticketId, message = ''\)/)
  assert.match(engine, /isPlanReady\(ticket\.needsAttentionReason\)/)
  assert.match(engine, /'plan_approved'/)
})

test('the grant approver is registered only on build sessions, on both session paths', async () => {
  const files = await sources()
  const dispatch = files['dispatch.mjs']
  assert.match(dispatch, /import \{ makeGrantApprover \} from '\.\/grants\.mjs'/)
  assert.match(dispatch, /agentCtx\.on\('approval\/request', makeGrantApprover\(\{ store: this\.store, log: this\.log \}\), \{ prepend: true \}\)/)
  // Exactly two call sites: the fresh-session setup and the post-restart
  // reattach, each gated on purpose === 'build'.
  assert.equal((dispatch.match(/#registerGrantApprover\(/g) || []).length, 3, 'one definition, two call sites')
  assert.match(dispatch, /if \(purpose === 'build'\) this\.#registerGrantApprover\(agentCtx\)/)
  assert.match(dispatch, /if \(purpose === 'build'\) this\.#registerGrantApprover\(agent\.ctx\)/)
})

test('the plan-ready park and the Approve-plan button agree on the prefix', async () => {
  const files = await sources()
  const grants = files['grants.mjs']
  assert.match(grants, /export const PLAN_READY_PREFIX = 'Plan ready:'/)
  const client = files['client.mjs']
  assert.match(client, /indexOf\("Plan ready:"\) === 0/)
  assert.match(client, /\}, "Approve plan"\)/)
  assert.match(client, /props\.onResolve\(t\.id, "approvePlan"\)/)
  // The grants section renders paths, commands and the checks table.
  assert.match(client, /Sandbox grants/)
  assert.match(client, /d\.plan\.sandbox\.grants/)
  assert.match(client, /d\.plan\.sandbox\.checks/)
})

// ------------------------------------------------------------------- KAN-31

test('the detail payload carries the real attempt cap', async () => {
  const files = await sources()
  const host = files['host.mjs']
  // The client used to hard-code 3 and print "5 / 3". The cap is configuration,
  // so the host now sends the one the engine is enforcing.
  assert.match(host, /maxAttempts: getConfig\(\)\.maxAttempts/)
  const detail = host.slice(host.indexOf('const detail = (id'))
  assert.ok(detail.indexOf('maxAttempts: getConfig().maxAttempts') < detail.indexOf('awaitingQuestion,'), 'the cap rides on the detail payload')
  const client = files['client.mjs']
  assert.match(client, /t\.attemptCount \+ " \/ " \+ \(d\.maxAttempts \|\| 3\)/, 'the attempts row reads the cap from the detail')
  assert.equal(/props\.maxAttempts/.test(client), false, 'the never-passed prop is gone')
})

test('a human retry resets the attempt budget on both endpoints and records it', async () => {
  const files = await sources()
  const host = files['host.mjs']
  // One shared path, wired on both endpoints, so the reset cannot be forgotten.
  assert.equal((host.match(/retryWithFreshBudget\(/g) || []).length, 2, 'one definition, two call sites')
  assert.match(host, /const retryWithFreshBudget = \(ticket, \{ instruction, patch \} = \{\}\) =>\s*engineRef\.current\.retry\(ticket, \{ instruction, patch \}\)/)
  const engine = files['engine.mjs']
  assert.match(engine, /this\.store\.setAttempt\(ticket\.id, 0, 0\)/)
  assert.match(engine, /'budget_reset'/)
  // KAN-60: the reset is recorded under whoever asked ('human' or
  // 'orchestrator'), so the reason is a template — the fact under test is that
  // the event carries the old and new attempt counts.
  assert.match(engine, /from: ticket\.attemptCount, to: 0, reason: `\$\{actor\} retry`/)
  // The reset happens before the phase transition, so the next round is round one.
  const body = engine.slice(engine.indexOf('  retry(ticket,'), engine.indexOf('  async rerunReview('))
  assert.ok(body.indexOf('setAttempt') < body.indexOf('transitionTicket'), 'the budget is reset before the ticket moves')
  assert.match(engine, /a human Retry with instruction grants a fresh budget/)
})

test('the plan and review tool schemas carry the KAN-31 fields', async () => {
  const files = await sources()
  const actions = files['actions.mjs']
  assert.match(actions, /release_scope: \{/)
  assert.match(actions, /enum: \['stop_before_merge', 'full_release'\]/)
  assert.match(actions, /deferred: \{ type: 'boolean'/)
  assert.match(actions, /human_evidence: \{ type: 'string'/)
  assert.match(actions, /One row per stored acceptance statement only/)
  assert.match(actions, /submit an empty array when the ticket has no stored acceptance/)
  // kanban_plan re-reads the contract, so it has to carry the scope and the marker.
  assert.match(actions, /release_scope: plan\.releaseScope/)
  assert.match(actions, /deferred: true, human_evidence: String\(condition\.humanEvidence/)
})

test('the board marks a deferred condition', async () => {
  const files = await sources()
  const client = files['client.mjs']
  assert.match(client, /c\.deferred \? h\("span", \{ className: "kb-hint", children: " \(deferred to approval\)" \}\)/)
})

test('a fail is read as a pass-equivalent only when it proves every non-deferred condition', async () => {
  const files = await sources()
  assert.match(files['result.mjs'], /export function nonDeferredProven\(value, conditions\)/)
  assert.match(files['result.mjs'], /if \(row === undefined \|\| row\.met !== true\) unproven\.push\(condition\.id\)/)
  const engine = files['engine.mjs']
  const decision = engine.slice(engine.indexOf('reviewDecision(value'))
  // The approval route on the fail branch is gated on the proof, not on the
  // absence of substantive gaps alone.
  assert.match(decision, /const proven = nonDeferredProven\(value, conditions\);/)
  assert.match(decision, /if \(proven\.ok\) return \{ route: 'approval'/)
  assert.match(decision, /is not proven met by the review/)
})

// ------------------------------------------------------------------- KAN-32
//
// The Questions setting reaches the whole ticket through two registrations on
// the session's own scope: the `user-questions/request` answerer, and the
// tolerant `ask_user_question` tool that shadows the preset's copy. Both are
// pinned here because a session that silently lacks them behaves exactly like
// the pre-0.18 board — which is the failure mode nobody would notice.

test('the question answerer is an agent-scoped waterfall listener on both session paths', async () => {
  const dispatch = (await sources())['dispatch.mjs']
  assert.match(dispatch, /import \{ askUserToolDefinition, makeQuestionAnswerer, questionsFromCallArgs \} from '\.\/questions\.mjs'/)
  assert.match(
    dispatch,
    /agentCtx\.on\('user-questions\/request', makeQuestionAnswerer\(\{ store: this\.store, log: this\.log \}\), \{ prepend: true \}\)/,
  )
  assert.equal((dispatch.match(/#registerQuestionAnswerer\(/g) || []).length, 3, 'one definition, two call sites')
  // Plan and build sessions both get one; a verify session never does, so an
  // approval-phase question stays the human's.
  assert.match(dispatch, /if \(purpose === 'plan' \|\| purpose === 'build'\) \{\n\s*this\.#registerQuestionAnswerer\(agentCtx\);/)
  assert.match(dispatch, /if \(purpose === 'plan' \|\| purpose === 'build'\) \{\n\s*this\.#registerQuestionAnswerer\(agent\.ctx\);/)
  assert.equal(/purpose === 'verify'\) this\.#registerQuestionAnswerer/.test(dispatch), false, 'a verify session gets no answerer')
})

test('the tolerant ask_user_question is registered in the session scope and undone with it', async () => {
  const files = await sources()
  const dispatch = files['dispatch.mjs']
  assert.match(dispatch, /agentCtx\.tools\.register\(\s*defineTool\(askUserToolDefinition\(\{ ask: \(request\) => service\.ask\(request\), log: this\.log \}\)\)/)
  assert.equal((dispatch.match(/#registerTolerantAskTool\(/g) || []).length, 3, 'one definition, two call sites')
  assert.match(dispatch, /liveRef\.questionDispose = this\.#registerTolerantAskTool\(agentCtx\)/)
  assert.match(dispatch, /liveRef\.questionDispose = this\.#registerTolerantAskTool\(agent\.ctx\)/)
  assert.match(dispatch, /if \(typeof live\.questionDispose === 'function'\)/, 'closing a session disposes its tool')
  // A deployment without the question service keeps the core tool and says so once.
  assert.match(dispatch, /this\.askToolWarned = true/)
  assert.match(dispatch, /userQuestions service is not mounted/)
  // The tool itself lives in the pure module, not in the wiring.
  assert.match(files['questions.mjs'], /export function askUserToolDefinition/)
  assert.match(files['questions.mjs'], /name: 'ask_user_question'/)
  assert.match(files['questions.mjs'], /wait: \{ callId: exec\.callId \}/)
})

test('the questions module is a pure decision module like grants.mjs is', async () => {
  const questions = (await sources())['questions.mjs']
  assert.equal(/from '@deepseek-ai\//.test(questions), false, 'questions.mjs must import nothing from dsh')
  assert.equal(/from 'node:/.test(questions), false, 'and nothing from node either')
  assert.match(questions, /export function recommendedAnswer/)
  assert.match(questions, /export function makeQuestionAnswerer/)
  assert.match(questions, /export function sanitizeQuestions/)
  // The audit event is written before the answer is claimed, and a failed write
  // falls through to the human.
  assert.match(questions, /'question_answered_autonomously'/)
  const body = questions.slice(questions.indexOf('export function makeQuestionAnswerer'))
  assert.ok(body.indexOf('appendEvent') < body.indexOf('return answer'), 'the event precedes the answer')
  assert.match(body, /return next\(\);\n      \}\n      warn\(/, 'a failed event write falls through')
})

test('the build and review prompts carry the autonomous questions note', async () => {
  const files = await sources()
  const engine = files['engine.mjs']
  assert.match(engine, /function questionNote\(ticket, submitTool\)/)
  assert.match(engine, /question_note: questionNote\(ticket, 'kanban_submit_implementation'\)/)
  assert.match(engine, /question_note: questionNote\(ticket, 'kanban_submit_review'\)/)
  for (const name of ['implement.md', 'rework.md', 'review.md']) {
    const text = await readFile(join(PACKAGE_DIR, 'prompts', name), 'utf8')
    assert.match(text, /\{\{question_note\}\}/, `${name} must render the note`)
  }
  // The approval prompt is untouched: an approval-phase question is the human's.
  const approval = await readFile(join(PACKAGE_DIR, 'prompts', 'approval.md'), 'utf8')
  assert.equal(approval.includes('question_note'), false)
  // And the interactive planning prompt states the auto-decide rule.
  const planHuman = await readFile(join(PACKAGE_DIR, 'prompts', 'plan-human.md'), 'utf8')
  assert.match(planHuman, /auto-decided by the board/)
})

// ------------------------------------------------------------- recovery actions

test('the recovery actions are wired on both endpoints and the engine owns every rule', async () => {
  const files = await sources()
  const host = files['host.mjs']
  assert.equal((host.match(/await recoveryAction\(ticket, action, p\)/g) || []).length, 2, 'resolve and action both route through the one helper')
  assert.match(host, /engineRef\.current\.markDone\(ticket\.id,/)
  assert.match(host, /engineRef\.current\.rerunReview\(ticket\.id,/)
  assert.match(host, /engineRef\.current\.revisePlan\(ticket\.id,/)
  // Dragging to Done stays refused: a drag carries no reason.
  assert.match(host, /done is set by human approval, not by dragging/)
  // The detail tells the client which buttons the engine would accept.
  assert.match(host, /markDone: canMarkDone\(ticket\)\.ok/)
  assert.match(host, /revisePlan: engine\.planRevisionBlock\(ticket\) === null/)
  assert.match(host, /planRevision: planRevisionState\(events\)/)
})

test('the client draws the recovery buttons from the detail and reports why a session did not open', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  assert.match(client, /d\.actions && d\.actions\.markDone/)
  assert.match(client, /d\.actions && d\.actions\.revisePlan/)
  assert.match(client, /props\.actions && props\.actions\.rerunReview/)
  assert.match(client, /children: "Re-run review"/)
  assert.match(client, /props\.onResolve\(props\.ticket\.id, "rerunReview", instruction\)/)
  assert.match(client, /props\.onAction\(t\.id, "markDone", \{ reason: reason \}\)/)
  assert.match(client, /props\.onAction\(t\.id, "revisePlan", \{ instruction: instruction \}\)/)
  // Mark done and Revise plan need their text, so the submit is dead without it.
  assert.match(client, /disabled: busy \|\| text\.trim\(\) === ""/)
  // The rejection of a plan revision is on the page, not only in the events list.
  assert.match(client, /"Plan revision rejected: " \+ d\.planRevision\.reason/)
  // A session open shows a loading label and the failure, never nothing.
  assert.match(client, /state\.phase === "loading" \? "Opening…" : props\.label/)
  assert.match(client, /state\.phase === "error" \? h\("span", \{ className: "kb-open-error", role: "alert"/)
  assert.match(client, /function failed\(text\) \{ resolveOpen\(\{ ok: false, error: text \}\); \}/)
  assert.equal(/best-effort navigation/.test(client), false, 'the swallowing catch is gone')
})

test('the question-park chip and the live-wait chip say the same thing', async () => {
  const client = await readFile(join(SRC, 'client.mjs'), 'utf8')
  assert.match(client, /\(d\.awaitingQuestion \|\| d\.parkedOnQuestion\) \? "waiting on your answer"/)
  assert.match(client, /\(d\.awaitingApproval \|\| d\.awaitingQuestion \|\| d\.parkedOnQuestion\) && d\.approvalSessionId/)
})

test('the orchestrator message seam carries the plan out: steer to inject, followup to queue', async () => {
  // KAN-67: the decision is pure and tested in orchestrator.test.mjs; what is
  // pinned here is that the wiring actually uses the two different seams and
  // reports the delivery instead of a bare `sent: true`.
  const host = (await sources())['orchestrator-host.mjs']
  assert.match(host, /message: \(ticket, text, purpose, mode = 'queue'\)/)
  assert.match(host, /planMessageDelivery\(\{/)
  assert.match(host, /steerAvailable: typeof agent\?\.steer === 'function'/)
  assert.match(host, /if \(plan\.delivery === 'injected'\) agent\.steer\(message\)/)
  assert.match(host, /else agent\.followup\(message\)/)
  assert.match(host, /delivery: 'session-gone'/)
  assert.equal(/sent: (?:true|false)/.test(host), false, 'the old boolean result is gone')
  // Both paths send the same payload, so a steered note reads like a queued one.
  assert.match(host, /text: `\[orchestrator\] \$\{text\}`/)
})

// --------------------------------------------------------------- KAN-65

test('orchestratorDetach is a registered endpoint that answers from the orchestrator', async () => {
  const host = (await sources())['host.mjs']
  assert.match(host, /'orchestratorDetach',/, 'orchestratorDetach must be in ENDPOINTS so the route is registered')
  const caseBody = host.slice(host.indexOf("case 'orchestratorDetach'"))
  assert.match(caseBody, /orchestratorRef\.current/, 'it must reach the live orchestrator, not a new one')
  assert.match(caseBody, /await orchestrator\.detach\(\)/)
  // A refusal is a message the board owner reads, not a stack trace.
  assert.match(caseBody, /result\?\.ok !== true/)
  assert.match(caseBody, /return \{ ok: true, value: \{ previousId: result\.previousId, sessionId: result\.sessionId, state: result\.state \} \}/)
})

test('the orchestrator seam files tickets with their settings and discards as itself', async () => {
  const files = await sources()
  const host = files['orchestrator-host.mjs']
  // create: every setting reaches the store, under the orchestrator actor.
  const create = host.slice(host.indexOf('create: async ('), host.indexOf('edit: (ticket, patch)'))
  for (const field of ['preset', 'writeMode', 'planTiming', 'planQuestions']) {
    assert.ok(create.includes(`...(${field} === undefined`), `create must pass ${field} through only when it was given`)
  }
  // worktree is the one setting that is never simply omitted: like the human
  // form, an omitted one means "on if the worktree service is mounted".
  assert.match(create, /worktree: worktree === undefined/)
  assert.match(create, /betterGitWorktree'\)\?\.createForPath === 'function'/)
  assert.match(create, /presets\.resolve\(String\(preset\)\)/, 'a preset id is checked against the live registry, as on the human path')
  assert.match(create, /actor: 'orchestrator'/)
  // discard: the engine's own path, credited to the orchestrator.
  assert.match(host, /discard: async \(ticket, reason\) => \{/)
  assert.match(host, /engine\.discard\(ticket\.id, reason, \{ actor: 'orchestrator' \}\)/)
  // The retired session is archived with its work stopped, and the new id is
  // persisted, or the next boot resumes the archived one.
  assert.match(host, /registry\.archiveSession\(previousId, \{ stopActivity: true \}\)/)
  assert.match(host, /this\.store\.kvSet\(KV_SESSION_ID, nextId\)/)
  assert.match(host, /nextOrchestratorSessionId\(previousId, config\.generation\)/)
  assert.equal(/engine\.discard\(ticket\.id, reason\)/.test(host), false, 'the seam must not drop the actor')
  assert.equal(files['orchestrator.mjs'].includes("import { WRITE_MODES } from './store.mjs'"), true)
})
