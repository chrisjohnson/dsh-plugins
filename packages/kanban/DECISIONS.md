# Decisions

> **2026-10-21 — concurrency moved out of this package.** The per-turn SQLite
> leases, the `maxConcurrent` field, the `pending_capacity` event and the
> `leases` table described below are historical. A new host plugin,
> `dsh-model-capacity`, now gates every `llm/stream` call process-wide, per
> provider, with a FIFO queue; kanban dispatches role turns and lets their model
> calls queue there. `wipCap` still bounds how many tickets are in `Now`.
> Schema migration v2 drops `leases`. The sections below are kept as the design
> history that led here.

Resolved during implementation. Each one is a choice the specification left open
under §20, or an environment fact found while building.

## Session model routing (§7 `[VERIFY]`)

- **API found:** `ctx.agents.create({sessionId, meta:{cwd, agentPreset}, agentOptions:{provider, model, reasoningEffort}, setup})`.
  The setup callback calls `agentPresets.mount(agentCtx, id)` (the same path
  `@deepseek-ai/dsh-api-session-controller` uses for a new session). The model
  route is session creation state, so escalation changes it between attempts by
  creating a session on the next route.
- **Not used:** the `switch_model` tool (session-wide, rewrites the deployment
  default) and `sessionController.selectModel` (its contract also saves the
  deployment default in the background).
- **Presets:** the plugin registers `kanban-{implementer,planner,verifier,reviewer,griller}`
  with `agentPresets.register` and composes each one from the standard tool
  plugins. The role's `allowTools` is applied twice: `agentCtx.tools.restrict({allow})`
  over the preset's inherited tools, plus `agentCtx.tools.guard((exec) => allow.includes(exec.name) ? undefined : reason)`.
  The guard is the control; the restriction is the model-visible surface.

## Turn-stop detection (§9 `[VERIFY]`)

- **Primary:** `ctx.on('session/event', (session, event) => ...)` with
  `event.type === 'turn/end'`. The final assistant message is read from the
  session log (`session.snapshotEvents()`), not from a live stream, so a
  listener attached late still sees the committed turn.
- **Fallback:** the worker tick asks each waiting agent for `agent.status`; if it
  is `idle` and an `turn/end` exists in the log, the turn settles. This covers a
  listener attached after the event fired.
- **Watchdog:** no event for `stallTimeoutMs` resolves the wait as `stalled`; the
  engine abandons the span, releases the lease and retries/escalates.

## Judge calls (§7, §11)

- **Route:** `roles.orchestrator` — the cheap route by default. On a second
  attempt the escalation ladder's current rung is used if it names a different
  route; otherwise the same route is tried once more.
- **Failure routing:** `failure.code` from the stream's terminal `finish` chunk,
  never message text. `MISSING_CREDENTIAL`, `AUTH`, `NO_ADAPTER` go straight to
  `needs_attention` with `provider configuration error`; parse/schema failures
  get one retry, then the caller's fallback.
- **Transport:** one `ctx.llm.stream()` call assembled by `BlockAssembler`; the
  usage chunk is recorded on the judge span and priced from the provider YAML.

## Where the planner's plan lives

The planner is read-only and emits the plan as its final JSON. The engine writes
the `plan` artifact and the `conditions` rows. This keeps the planner's tool
surface genuinely read-only (no path-restricted write tool exists in the harness)
while honoring "the plan must emit done_when".

## Judge calls consume capacity too

A judgement is a real provider call. It takes a lease on the orchestrator route's
provider and records a `judge` span. With a single local GPU route this means a
judge can wait behind an agent turn; the ticket records `pending_capacity` and is
retried on the next tick rather than exceeding the declared limit.

## Worktree seam (§19)

`workspace_cwd` is nullable, per ticket, settable through the API/UI. The engine
uses it, or `defaultWorkspaceCwd`, and creates it if missing. No worktree
lifecycle, conversion or cleanup is designed or built.

## Human interaction

- Grilling is a session turn that returns `questions[]`; the board renders the
  questions and posts `answers[]` back into the **same** griller session. If the
  plugin restarted and that session is no longer live, a fresh griller session is
  given the questions and answers (the thread is not resumed across a plugin
  restart; the ticket data is).
- Auto-answered implementer questions are capped at two rounds, then
  `needs_attention`.
- `blocked` is settable by a human with a required reason; it is never produced
  by the engine.

## UI placement (the two options the spec asked for)

The shell's only additive seats are the global panel list (`sidebar.panellist`)
and the right sidebar's session-scoped tabs (used by `dsh-better-sidebar`).
Nothing is additive *above* the workspaces list without replacing the shell.

- **Implemented:** `sidebar.panellist` entry `kanban` + `main` key `kanban`.
  It is a root-level, full-width board, additive, and does not patch the shell.
- **Alternative:** a `dsh-better-sidebar` / native right-sidebar tab. It would
  live inside a session's right column, which is a poor home for a global board,
  and it would couple this plugin to that plugin's API.

The panel is rendered from the same host queries the tests use, so moving it
later is a client-only change. This is why no shell replacement was attempted.

## Capacity seeds and the demo measurement

The deployment in the lab offers one local provider route plus a cloud proxy, not
two GPU-specific route ids. The lab config therefore declares the local route
with `maxConcurrent: 3` and no paid route. The concurrency check (six `now`
tickets) measured at most three live agent spans on that route; see the lab
`RESULTS`/verification notes. Unknown providers still default to a limit of one.

## Event schema

`events.kind` is a short stable string (`created`, `triaged`, `planned`,
`attempt_started`, `implemented`, `verified`, `reviewed`, `retry_scheduled`,
`needs_attention`, `grill_questions`, `awaiting_human`, `grill_answered`,
`session_attached`, `session_detached`, `pending_capacity`, `stalled`,
`recovered`, `lease_reclaimed`, `ticket_updated`, `config_snapshot`, ...).
`payload_json` carries the reason and any identifiers; the transition columns
(`phase_from`, `phase_to`) are separate columns so the timeline is queryable
without parsing JSON.

## Span naming

`workflow:pickup`, `plan`, `grill`, `implement`, `verify`, `review`,
`<role>-continuation`, `adjudicate`, `coverage`, `triage`, `answer-question`.
Child tool spans are named by the tool the role called and carry the agent span
as parent. `wait` spans are reserved for capacity/human waits; the current
implementation records those as `pending_capacity` events plus an `awaiting_human`
event, not as spans.

## Deviations from the letter of the spec

- **No separate `done_when` table in the spec's list.** A plan's conditions must
  be queryable per attempt, so they live in `conditions` (ticket state, not
  config). The plan JSON itself is an artifact.
- **Verification.** The spec's §9 table advances straight to review after a
  mechanical pass, while §5/§7 require a verifier role and §11 says verification
  judges `done_when`. Implemented both: the mechanical gate decides whether the
  implementer's claim even qualifies, then a fresh verifier session independently
  checks each condition before review.
- **Planner write access.** The planner emits the plan; it does not write a plan
  file (see above).
- **Config reload implementation.** Watched through `ctx.get('configEditor')`
  (host-owned, already parses the profile patch) rather than a raw YAML file
  watcher, so a reload cannot race the loader or half-apply.

## Verification evidence

Environment: the default lab at `~/dsh-lab/default` (port 3099), linked to this
checkout with `--preserve-symlinks`, provider route `local-ai-machine` with
`maxConcurrent: 3`.

- **Real end-to-end runs.** Two tickets (KAN-1, KAN-2 in the lab database) were
  created through the HTTP surface, auto-promoted, planned, implemented,
  independently verified and reviewed by real `medium-dense` sessions, and both
  reached `done`/`closed` at attempt 1. Their workspaces contain the committed
  edit; `npm test` in the demo workspace passes. The spans table has the full
  chain: `grill-judgement` (judge), `plan` (planner) with `read/glob/bash` tool
  children, `coverage` (judge), `implement` with `read/edit/bash` children,
  `verify` with `read/bash` children, and `review` with `read` children.
- **Mechanical branches.** `test/engine.test.mjs` exercises every row of the §9
  table with a fake driver and fake judge: pass, unmet claim → adjudication →
  second attempt → done, no-JSON → continuation → done, blocked → needs_attention,
  questions → orchestrator answer → same attempt continues, verifier failure →
  attempt exhaustion + packet, paid refusal, capacity hold, grill Q&A, restart
  recovery.
- **Concurrency.** A test launches six tickets against a provider with
  `maxConcurrent: 2` and records the maximum overlapping implementer turns and
  live leases: both are ≤ 2, and all six finish. The lab config's local route is
  declared with `maxConcurrent: 3`; no run exceeded it.
- **Restart mid-run.** The lab was killed and restarted several times during real
  planning/implementation turns. Each time the running span was marked
  `abandoned`, its lease released, and the ticket requeued; a later attempt
  completed it. No duplicate attempt for the same span and no orphan lease
  remained.
- **Config reload.** Editing `wipCap` in the lab profile YAML changed the live
  `/api/kanban/config` value from 2 to 3 and back without a restart; an invalid
  reload path is covered by the config tests (it keeps the previous config).
- **Forced verification failure on real models was attempted but not completed
  in the lab.** A third ticket was created and the workspace was reverted right
  after its implementer span finished; by then the local backend had degraded to
  roughly 0.5 output tokens/second and the verifier turn stalled. That branch is
  covered deterministically by `test/engine.test.mjs` (verifier fails → retry →
  exhaustion packet). The attempt was discarded rather than left stalling.

Visual verification used the accessibility tree, not screenshots: the active
model route in the implementing session does not accept image input.

## Global capacity refactor (2026-10-21)

- **Where it lives:** `dsh-model-capacity`, a separate host plugin. It registers
  one `llm/stream` waterfall listener (`{global:true, prepend:true}`) and one
  global `tools.guard`. It is not per-session and not in the browser.
- **Per-call, not per-turn:** the gate acquires a lease before `next()` reaches
  the adapter and releases it when the stream ends/fails/aborts. A tool-heavy
  turn does not hold a slot, so sessions interleave inference and tool time.
- **Kanban:** all capacity code is gone, including lease admission,
  `maxConcurrent`, the `pending_capacity` group, capacity snapshots and the
  `isWaitingForCapacity` stall callback. A role turn creates its span and sends
  the prompt; any model-call queueing is invisible to this plugin.
- **Subagents:** `subagent`, `subagent_fork` and `spawn_teammate` preflight in
  the tool guard. A reservation is bound to the child on `session/created` and
  consumed by the child's first **main** call (title/compaction calls do not
  consume it). Tool errors cancel their reservation by `callId`; a TTL and
  `session/disposed` clean up the rest. `workflow` is deliberately excluded:
  its fan-out is not declared, so its children queue normally.
- **Timeouts:** no plugin queue timeout. The wait occurs before the adapter's
  `streamIdleTimeoutMs` starts; the only plugin timer is reservation cleanup.
- **UI:** the queue UI belongs to `dsh-model-capacity` (now the **Activity**
  panel); Kanban shows no capacity controls or counters.

## 2026-10-22 supersession — one shared session per ticket

The per-phase role-session decision above is superseded. A ticket now owns one
workflow session. Each phase is a turn in that session; the engine changes the
tool allow-list through a phase-aware guard and calls
`agents.selectForNextRequest()` to change provider/model for the next turn when
the role routes differ. This preserves one continuous transcript (and its
context) across intake → plan → implement → verify → review, instead of
re-explaining the ticket at every boundary. `reuseSessionOnRetry` now controls
whether a failed attempt keeps that live session or starts a fresh one.

## 2026-10-29 — columns are intended state (0.5.0)

The board used to mix two orthogonal things in one axis: where the human wants a
ticket to live (`backlog`, `now`) and what the engine is doing about it
(`needs_attention`, `blocked`). That made the engine a co-owner of the columns:
`autoPromote` pulled Backlog tickets into Now on its own schedule, a failed turn
pulled a ticket out of the column the human placed it in, and a WIP cap turned a
human drag into a rejection. The board then lied in both directions — a ticket
sitting in `needs_attention` could be a plan-now ticket nobody asked to start,
and a ticket the human deliberately parked in Backlog could be promoted away.

From 0.5.0 the columns are **intended state only**: `backlog | working | done |
discarded`, all rendered grey. The engine never moves a ticket between columns;
only a human drag (or create-into-Working) does, and it is unconditional — the
WIP cap no longer rejects a move, it only throttles how many turns run at once.

The two things that used to be columns became a **card-level visual status**,
computed from live facts on every board read and never stored:

- `attention` (red glowing card): a needs-attention reason is set, or a plan
  session is waiting on a human answer. The reason stays on the ticket row, so
  a restart keeps the park.
- `active` (blue pulsing dot and glow): the engine is driving the ticket right
  now — an engine advance in flight or any attached session with a turn running.
- `idle` (plain grey card): everything else, including a Working ticket queued
  behind the concurrency cap.

Rules that follow from this:

- **Planning in place.** A Backlog ticket with Planning=`now` plans where it
  stands and stops at Build; dragging it to Working starts the build. An
  `at_pickup` ticket plans only in Working.
- **Parking is in place.** A failure, an exhausted attempt budget, a budget
  refusal, or awaiting-approval sets the reason on the row and leaves the column
  alone. A human column move clears the reason (that drag *is* the resolution);
  retry/approve/manual submissions lift it explicitly.
- **Blocked is gone.** Nothing distinguished it from a parked ticket; the reason
  text carries the same information.
- The phase badge (top-right of each card) now carries the lifecycle colour
  (Plan blue, Build teal, Review pink, Approval violet, Done green) instead of
  the column colour, because the column no longer has meaning to paint with.

Schema V4 rewrites the tickets table in place (data-preserving, unlike the V3
reset): `now` → `working`, `needs_attention` → `backlog` (reason kept, so a
parked ticket still glows red in Backlog), `blocked` → `backlog`. The rewrite
runs with `PRAGMA foreign_keys = OFF` outside the migration transaction — with
them on, `DROP TABLE tickets` would fire every child's `ON DELETE CASCADE` and
wipe the event/span history.

## 2026-10-29 supersession — no tool guard at all (0.6.0)

The allow-list decisions above are superseded. A workflow session runs the bone
standard preset and keeps every tool a normal session has: `phaseToolGuard`,
`roleToolGuard` and `src/tools.mjs` are deleted, and `dispatch.mjs` registers no
`tools.guard` of any kind — not the phase guard, not the autonomous-question
backstop.

Why: the guard was a second, plugin-owned policy on top of the harness's own
sandbox and approval policy, and it was wrong in practice. A build session could
not use `todo_write` or `web_search` because the role's list did not name them,
which read as "kanban cripples its own sessions" rather than as a safety
property — the roles are the operator's own model routes, and the human stays in
the loop at approval.

What replaced each part of it:

- **Phase discipline** moved into the action tools. All five (`kanban_submit_plan`,
  `kanban_submit_implementation`, `kanban_submit_review`, `kanban_approve`,
  `kanban_discard`) are registered in every workflow session regardless of
  purpose, and each one refuses a call outside its phase. `kanban_submit_plan`
  branches on the phase: planner submits the plan, approver sends the ticket back
  for another round. The engine re-validates the ticket's phase either way.
- **Write restriction** is now purely the sandbox mode, set by purpose and never
  by phase: plan (and the legacy verify gate) read-only, build and approval
  workspace-write. A build session that moves implementer → reviewer stays
  workspace-write, so a reviewer can run the checks its own review asks for.
- `roles.<role>.allowTools` stays in the accepted config keys as a deprecated
  no-op, warned and ignored, so an existing deployment row does not fail
  validation on upgrade.

## 2026-10-30 supersession — approval is a build-session phase (0.7.0)

The separate approval session is gone. On a passing review the engine keeps the
build session open, flips its phase role to `approver`, switches it to the
configured `approver` route, sends it one slim hand-over prompt as a normal role
turn, and then parks the ticket **Awaiting human approval** in that same
conversation. `startApprovalSession`, `approvalIntro`, the `approvalSession`
resolve/action sub-actions and the client's **Launch approval session** button are
deleted; nothing creates a purpose-`approval` session any more.

Why: the approval session was a third conversation about work the second one had
just done. It started with no history, so its intro prompt had to re-paste the
ticket body, the acceptance list, the plan and the review verdict — the same text
the build session already had in context — and then sit there waiting for a human
to press a button to launch it. Meanwhile the build session, which knew exactly
what it had built and what the review had checked, was closed and thrown away at
the one moment its context was most useful. Merging the stages also removes a
route the human had to remember: approving and discarding were available in two
places with two different launch paths.

What made this cheap: 0.6.0 already registers all five action tools in every
workflow session and gates each one on the session's phase role, so approval
needed no new tool surface — only the phase flip that makes the approver half of
that gate reachable, plus a route switch (the approver route is usually a
different, stronger model than the implementer's) and one prompt.

Consequences, and how they are handled:

- **The ticket is in `verify` while the approval turn runs**, and the park is only
  set once the turn ends cleanly. An agent that approves, discards or re-plans
  from inside that turn has already moved the ticket, so the engine re-reads it
  and says nothing rather than parking a closed or re-planned ticket.
- **A manual review submission asks for the approval turn in the same beat that
  concluded the human's own turn.** Sending into a session whose turn is still
  finishing is rejected as busy, so the engine waits (bounded) for the ticket's
  sessions to go quiet first.
- **A reopened build session must come back as the phase its ticket is in**:
  `verify` → `approver`, `review` → `reviewer`, otherwise `implementer`. Rows
  written before this release whose purpose was literally `approval` keep their
  mapping, so an upgrade does not strand a parked ticket.
- **The sandbox mode does not move.** It follows the purpose, and the build
  purpose was already workspace-write, so the approver can merge, deploy or
  iterate in the session it built in — which is the point.
- **`approvalSessionId` keeps its name** and now resolves the build session. It is
  the client's contract; renaming it would be a second change for no benefit.
- **No budget admission for the approval turn**, matching the intro it replaces:
  it is a hand-over, not a work round. With no `approver` route configured the
  engine skips the turn and parks the ticket the way it used to, so a deployment
  that never configured one loses the prompt and nothing else.

## 2026-11-02 — planning on demand, in place (0.13.0)

Backlog has always meant *not yet*, and the only way to make a ticket think was
to drag it into Working, which also meant "build it". KAN-16 splits those two
statements: **Start planning** says *think now, build later*, and says it from
the card.

- **No engine change.** `tick` already launches Backlog tickets at the plan
  phase whose `planTiming` is `now`, and `advance` already stops such a ticket
  at Build until a human drags it over. So the button is not a new path through
  the workflow; it is a one-field write that puts a ticket onto a path the
  engine has had since 0.5.0, plus a tick. That is why the release is a minor
  one with no migration and no new state.
- **It writes `planTiming` and nothing else.** No column move, no phase move. A
  human move is a statement about where the ticket lives; this is a statement
  about when it thinks, and the two must stay distinguishable in the audit
  trail. `startPlanning` therefore refuses anything that is not
  `backlog`/`plan` rather than quietly relocating it.
- **It doubles as the retry on a parked plan.** A plan that ended without
  submitting parks the ticket and leaves its session open on purpose, so the
  human can talk it through. The obvious guard — "refuse while a plan session is
  live" — would then refuse the exact case the button is also for. The rule is
  instead: refuse while a turn of this ticket is in flight, and refuse while a
  plan session is open *on a ticket nobody has parked*. A parked ticket is by
  definition not running, so its open session is the thing being retried, not a
  second launch. An unanswered grilling question is not parked, its session is
  live, and so it is refused — the answer there is to reply, not to re-launch.
- **The visibility rule is written twice, on purpose.** `src/planning.mjs` owns
  it for the host; `client.mjs` is a classic browser script with no imports and
  carries its own copy. `host-contract.test.mjs` compares the two so a change
  on one side fails the suite rather than stranding a button the host refuses.
- **The decision lives outside `host.mjs`.** The host half is wiring and cannot
  be imported without the dsh peer packages, so an action defined inline there
  is an action no test can reach. `startPlanning` takes its store, driver and
  engine as arguments and is tested against a real store and a real `Engine`.

## 2026-11-02 — a mid-turn human wait is attention (0.13.1)

A card said "running" while its session sat on an unanswered approval prompt.
KAN-6's production build-session log is the proof: one `approval/asked` waited
~11.7 minutes for a human while the card pulsed blue. The turn *is* in flight —
the harness pauses inside it — so `cardStatus`'s `active` rule, read from
`turn/start`/`turn/end` alone, could not tell "working" from "blocked on a
person".

- **The session log is the source of truth, not a new signal.** The harness
  already appends `approval/asked` / `approval/decided` (paired by `id`, and
  turn-enclosed by `@deepseek-ai/dsh-user-approval`'s own precondition) and a
  `tool/call` for `ask_user_question` whose `tool/result` cites the same
  `callId`. The driver folds those on the `session/event` stream it already
  consumes, so there is no new event, no tool change, no schema change and no
  config key — the board simply starts reading facts that were always there.
- **The fold lives in the driver, not the engine.** The engine only sees turns
  it started itself (its waiters); a human driving a ticket session by hand, or
  an approval prompt raised inside a human's turn, is visible only on the
  global stream the driver subscribes to. Tracking there covers engine- and
  human-driven turns in every phase uniformly.
- **Attention outranks active, and the wait must die with its turn.** A pending
  ask outranks `active` in `cardStatus` because the one state that needs eyes
  is the one a blue pulse would hide. Every entry is cleared by its own
  `approval/decided` / `tool/result`, and defensively by `turn/end` and
  `turn/start`: a decision that was never published (a crash between the pair)
  must not haunt the session into permanent red. `closeSession` clears it too.
- **Restart recovery reads the log backwards, the same way the harness does.**
  A session reopened mid-turn has no live events to fold, so `attachExisting`
  scans back to the open turn — last `turn/start` with no matching `turn/end`,
  the exact boundary `dsh-user-approval` requires for its audit pair — and
  seeds the wait from what is unanswered inside it. An ask from an earlier turn
  is not the open turn's business.
- **The question scan generalises instead of duplicating.** Before this,
  `ask_user_question` was only surfaced while a *plan-phase* engine waiter was
  armed. The new scan is a superset (any phase, any turn), so the old
  plan-phase-only method is gone rather than kept beside it, and the host's
  `awaitingQuestion` now means "a session of this ticket is waiting on your
  answer", full stop.
- **The detail synthesises a reason for a question but not for an approval.**
  The parked-ticket panels (`ApprovalPanel`, `NeedsAttention`) render from
  `needsAttentionReason`; inventing one for a mid-turn approval would render
  the park panel — retry/discard buttons — under a ticket whose engine is still
  inside the turn. The approval case therefore rides on the new
  `awaitingApproval` flag: chip, badge and the hero's **Open session** button,
  no fake park.

## 2026-11-02 — plan-time sandbox grants (0.16.0, KAN-30)

A build session confined to its workspace asks a human for every out-of-tree
write and every denied command, one prompt at a time, mid-turn. The ticket
already knows — at planning time — that it will need `~/dsh-lab` or a `gh`
config write. KAN-30 moves that decision to where the human actually is.

- **Plugin-only, through the `approval/request` waterfall.** The harness already
  dispatches every approval ask as an agent-scoped waterfall
  (`scopeTarget(req.agent, req.agent)`), and an agent-scoped listener only ever
  sees its own agent's asks. That is the whole seam: no core change, no new
  service, no schema migration. The listener is registered `prepend` so a
  covered ask is answered before the human bridge is reached; an uncovered ask
  calls `next()` and the human is prompted exactly as before.
- **Grants live in the plan artifact.** The `sandbox` section rides inside the
  plan JSON the engine already stores per version, so a new plan version
  supersedes the old grants for free, `kanban_plan` returns them with the rest
  of the contract, and an old board replays unchanged (no `sandbox` key, no
  park, no listener).
- **The gate only fires when grants are declared.** A plan without a `sandbox`
  section transitions to Build exactly as it always did — the overwhelming
  majority of tickets never see the new state. Only a plan that asks for
  something outside the standing sandbox parks as *Plan ready*, because that is
  the one case where a human decision genuinely precedes the build.
- **Approving the plan is the one-time grant.** `approvePlan` is a human action
  on the board (resolve and action endpoints), not a tool the model can call.
  While a ticket is parked on *Plan ready* the grants are inert — the listener
  checks the park before matching — so declaring a grant never pre-empts the
  human who has not approved it yet.
- **The denylist scope is the human's decision, and it is absolute.** The words
  `systemctl`, `service`, `launchctl`, `sudo`, `kill`, `pkill`, `rm`, `dd` (seen
  through `sh -c`/`bash -c`/`env`/`nohup`/`timeout` wrappers) plus the `rm -rf /`
  and `rm -fr /` substrings are never claimable, even by an approved grant, and a
  plan declaring one is rejected at submission. The check is **word-based, not
  position-based**: the command is split on whitespace and on `(`, `)`, `{`, `}`,
  `$`, backtick, `;`, `|`, `&` and newlines, quotes and backslashes are stripped,
  and any word whose basename is a denylisted token denies the whole call. Three
  review rounds were spent learning why position does not work here: 0.16.0 read
  only the line's first token, so a `git push` grant covered `git push &&
  systemctl restart dsh`; 0.16.1 read the first token of every `&&`/`;`/`|`
  segment, and the same grant still covered `git push && (systemctl restart dsh)`,
  `git push && $(systemctl restart dsh)` and `git push && FOO=1 systemctl restart
  dsh`; 0.16.2 read every word but on exact spelling, so `git push && \systemctl
  restart dsh` — the shell's own alias-bypass idiom — still got through. A
  token-prefix grant means the denylist has to see the word anywhere, in any
  natural shell form. The cost is false positives (`grep -r rm -n .` now asks
  the human), which is the only acceptable direction to err in.
- **The denylist is text, not a sandbox, and the docs say so.** Three routes stay
  open by construction and are named in the README rather than pretended away: an
  **interpreter** (a bare `node`/`python3`/`bash script.sh` grant hands the build
  whatever that interpreter runs, so it is a full-access grant), an **encoded
  payload** (`echo <base64> | base64 -d | sh` hides its words from any matcher),
  and **indirection** (a granted command reading a script or config the build
  wrote inside the workspace). None is reachable by string matching: closing them
  needs the sandbox itself to resolve the exec, which is core work and out of this
  plugin's scope. A restart of the service the board runs on must stay a planned
  human act; the denylist keeps the direct shell route unexpressible, and the
  human's plan review is the control for the rest.
- **Fail open, never silent.** Every miss, malformed input, terminal ticket or
  exception calls `next()` and reaches the human. Even a matched grant is not
  applied unless its `grant_applied` audit event was written first — an
  auto-approval nobody can see is the failure mode this whole feature must not
  have.
- **Matching reads the durable log, not the model's prose.** The approval
  request carries only tool name, call id and the escalation reason; the exact
  `file_path` / `command` are read from the session's own `tool/call` event by
  `callId`. A justification string written by the model can therefore never
  talk a grant into covering a different call.
- **Checks are the planner's evidence, not the engine's input.** `test -w` runs
  read-only in the plan session (the KAN-17 lesson: a grant to a path that
  does not exist or is not writable is a mid-build failure wearing a
  permission's clothes). The engine records the `{path, check, observed}` rows
  and shows them to the human; it does not re-run them.

## 2026-11-03 — the review gate may not spend an attempt on a human step (0.17.0, KAN-31)

KAN-16 and KAN-30 both ended the same way: a build that was functionally done was
sent back to implementation because the gate could not tell "the work is
unfinished" from "the review is malformed" or "this step belongs to a human".
Each confusion cost a real implement attempt, and the attempt budget is the only
thing that stops a runaway board.

- **One definition of done, written once.** `release_scope` and per-condition
  `deferred` / `human_evidence` live in the plan artifact and are read from there
  by the build prompt, the review gate and the approval hand-over. The
  alternative — coaching each prompt separately — is how 0.16.x ended up with a
  plan rule (KAN-19: never plan a human-only condition) that the review gate then
  punished the build for failing to evidence.
- **Deferred is a condition, not a skip.** It still needs `statement`,
  `how_verified` and a non-empty `human_evidence`, it is listed to the human by
  id in the approval prompt and the `approval_requested` event, and it is marked
  on the board. What it changes is only who is allowed to leave it unmet. A plan
  that marks verifiable work deferred is visible as exactly that, which is the
  control against using the field to dodge the hard part.
- **The retry budget is separate from the attempt budget, on purpose.** A
  cosmetic gap gets one retry turn in the reviewer's own session and then parks
  with the gap text; it never transitions to implement. Routing a malformed review
  back to the build was the bug — the builder cannot fix the reviewer's JSON, and
  the round it spent is gone. Unknown gap shapes are treated as cosmetic for the
  same reason: the retry path ends in front of a human with the exact text, so
  nothing can be approved by being misclassified, while the substantive path can
  and did burn attempts on a shape nobody had looked at.
- **`acceptance_coverage` is judged against stored acceptance only.** A reviewer
  that invents rows from ticket-body prose (the KAN-30 observation) is describing
  something the human never asked for. Ignoring such a row is honest — every
  statement the human did store still has to be covered — where rejecting it
  punished the build for the reviewer's guess.
- **The no-progress signature is recorded at the start of a rework round, not at
  the review transition.** The plan for this release said the transition should
  write it, and that does not work: nothing runs between the review that failed
  and the next round's first step, so the tree is by definition identical and the
  first rework would have parked every time. Recorded at the round's start, the
  comparison spans exactly one round of work, which is the thing worth detecting.
  The guard also stands down when git cannot read the tree — an unreadable tree is
  never evidence of no progress — and a human retry resets the counter, so the
  guard cannot lock out the retry that exists to override it.
- **A fresh budget on a human retry is the only coherent reading.** The park says
  "a human Retry with instruction grants a fresh budget"; before this it granted
  one more round of a budget already spent, and the ticket parked again on the
  next tick. The reset is an event (`budget_reset`, with the `from` count) so the
  attempt ledger stays honest about which rounds were machine-paid.
