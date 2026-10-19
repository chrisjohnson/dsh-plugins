# Decisions

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
