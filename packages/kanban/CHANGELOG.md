# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

## Unreleased

## 0.9.1

### Fixed

- **A banner now describes its own turn, not the ticket's current state.** The
  review banner decided pass-versus-fail from the ticket's phase alone, so a
  session with one rework round — a failed review, then a later passed one —
  rendered **Review passed** on the turn whose review had failed, the exact
  opposite of what that turn did. The rework loop is the normal path, so this was
  ordinary to hit. The verdict the call itself carried now decides which
  transition to look for, and a pass is only claimed when the ticket's latest
  review is the one that call submitted, so a superseded claim renders nothing
  rather than a later round's outcome.
- **A rejected review quotes its own instruction.** The feedback text came from
  the ticket's latest `review_feedback` artifact, which is one value per ticket,
  so every earlier round displayed the newest round's text. Each banner now uses
  the instruction (or reasons) its own call carried; the ticket's latest feedback
  is only a fallback for a call that carried none, and for the distinct case of a
  claimed pass the code check sent back, where the gaps are the engine's to state.
- **The banner cache is bounded.** It was keyed per session turn with no
  eviction, so one browser tab left open indefinitely grew without limit. It now
  holds the most recent 200 confirmed banners and drops the oldest.

## 0.9.0

### Added

- **A phase-change banner at the turn tail.** A turn that ends on a `kanban_*`
  call now says, one line under the "Completed in …" disclosure, what that turn
  did to the ticket: plan submitted, implementation submitted, review not
  finished (with the reviewer's feedback), review passed, approved or discarded.
  The line is never folded into the disclosure and never taken from the tool call
  itself — a call refused by its phase gate looks identical in the transcript —
  so it is confirmed against the ticket's real phase through a new read-only
  `sessionInfo` endpoint before it renders, and stays hidden when the call did
  not move the ticket. Long values truncate to one line with the full text on
  hover.
- **`kanban_plan`, a read-only tool in every workflow session.** It returns the
  current plan (summary, steps, `done_when` with each condition's id, statement
  and verification), the live conditions and the latest review, so a session can
  re-read the contract it is working against instead of trusting its own summary
  of it. No phase gate: it is available in a plan session exactly as in an
  approval one, and says so plainly when there is no plan yet.

### Changed

- **The needs-attention card is static.** The red glow animation and the status
  dot's ring are gone; the border, tint, left accent bar and red dot stay. The
  blue in-flight glow is untouched — motion now means a turn is running, and
  nothing else.
- **Nothing opens a session on its own.** Both auto-open paths are deleted: the
  ticket detail no longer navigates into a plan session when you click a card,
  and the board poll no longer follows a newly created plan session. Card clicks
  open the ticket detail, and the explicit **Open build session**, **Open** and
  **Recover tools** buttons are unchanged.
- **The review, rework and approval prompts are slim.** Those three phases run
  inside the build session that already holds the plan, the implementation and
  the diff, so they no longer repaste them. The review prompt keeps the
  adversarial instruction and instead enumerates every key of
  `kanban_submit_review`, what the engine checks, and the plan's own condition
  ids; rework is one job statement plus, at most, a short reminder of the
  instruction; approval is the one-line hand-over. `implement.md` and the two
  planning prompts are unchanged — they open fresh sessions and need the full
  contract.
- **A `done_when` id the plan never declared is now a tool error, not a silent
  gap.** `kanban_submit_review` (on a pass) and `kanban_submit_implementation`
  compare the submitted ids against the board's and throw an error naming the
  expected set, so the model corrects itself in the turn instead of producing a
  review the engine can only reject afterwards. A fail verdict may omit rows; it
  may not invent them.

## 0.8.1

### Fixed

- **A stale reasoning level no longer blocks the whole routing save.** When a
  role's model offers no reasoning levels its effort picker is hidden — but the
  draft kept whatever level the route carried, and `saveRouting` sent it, so the
  host rejected the entire payload (`role X: model "…" offers no reasoning
  effort levels`) and no role could be saved at all. The dialog now drops a level
  its row's model does not offer, both when the draft is seeded and at the save
  boundary, so that row goes out as Default. Reachable through a documented
  operator step: reassigning a role's backend, or declaring
  `reasoningEfforts: false` for a model that stops thinking, while a level is
  still saved for it. A model that is not in the catalog at all is left alone and
  the host, which reads the live registry, decides.

## 0.8.0

### Added

- **A reasoning-effort picker in the Model routing dialog.** Every role row now
  has a second dropdown next to its model picker: **Default** plus the levels
  the selected model actually offers, taken from the host model catalog
  (`reasoning.efforts` — the same declaration the global provider settings use),
  with the catalog's own labels. A model with no reasoning metadata gets no
  control at all, and switching a role to a model that does not offer the level
  you had picked resets that row back to Default.
- **`setRoutes` accepts `reasoningEffort` per route** — a level string, or
  `null`/`""` for Default — validates a non-null level against the live catalog
  and answers `bad_request` naming the role, the model and what it offers, and
  writes the key explicitly into `roles.<role>` so Default clears a level saved
  earlier instead of leaving it behind. The runtime already threaded the value
  into `agentOptions`; only the write path was missing.

### Changed

- The route write path moved out of `src/host.mjs` into a decision module,
  `src/routing.mjs`, so the validation and the row fold are testable without a
  harness (`test/routing.test.mjs`).

### Fixed

- Saving a route no longer silently keeps a stale `reasoningEffort`. The old
  spread merged into the existing role entry and never wrote the key, so a level
  picked once stayed in effect after the model was changed under it.
- A configured effort the live catalog no longer offers is now warned about at
  boot and on config reload instead of failing silently on the first turn. It
  stays a warning: a provider-config swap must not take the profile down.

## 0.7.0

### Changed

- **Approval moved into the build session.** A passing review no longer tears the
  build session down and waits for a human to launch a separate approval one. The
  session that wrote the code and reviewed it is flipped to the `approver` phase,
  moved onto the configured `approver` route, and sent one slim hand-over prompt
  as a normal role turn: it summarizes what was built and asks the human what to
  do. The ticket then parks **Awaiting human approval** in that same conversation,
  where `kanban_approve`, `kanban_discard` and `kanban_submit_plan` are already
  live (0.6.0 registered them everywhere and gated them by phase; the phase flip
  is what makes the approval half of that gate reachable). A failed approval turn
  parks as `turn failed in approval: …` like any other phase, and an approval the
  agent closes from inside that turn is not parked over.
- **A reopened build session comes back as the phase its ticket is in.** A
  `verify` ticket's build session reattaches as `approver`, a `review` one as
  `reviewer`; rows written before this release whose purpose was literally
  `approval` still reattach as `approver`.
- **The board's approval card points at the build session.** `approvalSessionId`
  now resolves the ticket's build session, the panel button reads **Open build
  session**, and the hint says where approval actually happens.

### Removed

- The separate approval session is gone: `Engine.startApprovalSession` and
  `Engine.approvalIntro` are deleted, the `approvalSession` sub-action is removed
  from both the `resolve` and `action` endpoints, and the client no longer offers
  a **Launch approval session** button. Nothing creates a purpose-`approval`
  session any more.

## 0.6.0

### Removed

- **The tool guard is gone.** `src/tools.mjs` (`phaseToolGuard`, `roleToolGuard`,
  `allowedTools`) is deleted and `dispatch.mjs` registers no `tools.guard` at all
  — neither the phase allow-list nor the autonomous-question backstop. A workflow
  session runs the bone **standard** preset and has every tool a normal session
  has: `todo_write`, `web_search`, `browser_*`, `subagent`, jobs and the rest are
  no longer denied with `kanban: role "…" may not call "…"`. That denial was a
  second policy stacked on the harness's own sandbox and approval rules, and in
  practice it only crippled the plugin's own sessions.

### Changed

- **All five action tools are registered in every workflow session**, whatever its
  purpose: `kanban_submit_plan`, `kanban_submit_implementation`,
  `kanban_submit_review`, `kanban_approve` and `kanban_discard`. Phase enforcement
  lives inside the tools now — implementation requires the implementer phase,
  review requires the reviewer phase, approve and discard require the approver
  phase, and `kanban_submit_plan` branches on the phase (planner submits the plan
  and ends planning; approver sends the ticket back for another build/review
  round). A misdirected call is an ordinary tool error the model can correct, and
  the engine still re-validates the ticket's own phase.
- **The sandbox mode is set by purpose only.** Plan (and the legacy verify gate)
  runs read-only; build and approval run workspace-write. A build session that
  moves from implementer to reviewer no longer flips to read-only, so a reviewer
  can run the checks its own review asks for; `setPhase` changes the role and the
  next prompt and leaves the sandbox alone.

### Deprecated

- `roles.<role>.allowTools` decides nothing. It stays an accepted config key so an
  existing deployment row validates, and `resolveConfig` warns that it is ignored.
  Delete it from your `kanban` row when convenient.

## 0.5.1

### Fixed

- A discarded ticket now badges **Discarded**. The top-right badge was derived
  from the phase alone, but a discard can land from any phase - only the
  approval-stage discard closes the phase, so a ticket discarded while planning
  sat in the Done / Discarded column still reading "Plan". The badge stage is
  now derived from the column: `discarded` is its own stage (grey), alongside
  Plan / Build / Review / Approval / Done. The lifecycle dot strip is unchanged
  by design - Discarded is a badge stage, not a dot - and the Done / Discarded
  column keeps holding tickets from both closing stages.

## 0.5.0

### Changed

- **The board columns are now intended state: Backlog | Working | Done /
  Discarded, all grey.** The engine never moves a ticket between columns on its
  own. `autoPromote`/`autoPromotePerTick` are gone (unknown keys now, warned and
  ignored), and `wipCap` became a pure concurrency throttle: Working tickets
  beyond the cap wait as idle cards instead of being rejected on a human drag.
- **"In flight" and "Needs attention" became card-level visual statuses**,
  computed from live facts and never stored: a blue pulsing dot and glow while a
  workflow turn is in flight, a red glowing card while the engine has parked the
  ticket (failure, question, or awaiting approval), a plain grey card otherwise.
  The KPI row and the In-flight chip row are gone; the phase badge carries the
  lifecycle colour (Plan blue, Build teal, Review pink, Approval violet, Done
  green).
- **Backlog tickets with Planning=`now` plan in place** and stop at Build until
  a human drags them to Working. Creating a ticket directly into Working is
  unconditional.
- **The Blocked column and Block/Unblock actions are removed.** A parked ticket's
  reason text carries what "blocked" meant.
- Schema migration **V4** rewrites the tickets table in place: `now` → `working`,
  `needs_attention` → `backlog` and `blocked` → `backlog` (a parked ticket keeps
  its reason and still glows red where it stands). Events, spans, sessions and
  artifacts are untouched.

## 0.4.4

### Fixed

- A workflow session a human archived is no longer dispatched into. Sessions are
  grouped by purpose, not role, so an archived build session stayed in the
  driver's live map and the next phase of that purpose — a review, usually — was
  injected into it. Core rejects every turn in an archived session before its
  first step, so the ticket sat in Needs Attention forever and Retry repeated
  the identical dead path. `ensureTicketSession` now consults the workspace
  registry's archive set: it uses a non-archived live session when one exists,
  and when the only live sessions for the purpose are archived it fails with
  `workflow session <id> is archived; unarchive it and retry` instead of
  silently opening a second session. Archived sessions are skipped, never
  evicted, so unarchiving makes them usable again without a restart.
- A turn that ends with reason `blocked` — the shape of that archived-session
  rejection — now settles as a failed turn. It used to read as a successful turn
  that simply did nothing, which produced the misleading
  `reviewer ended without calling kanban_submit_review`. The board now shows
  `turn failed in review: turn blocked (session may be archived)`.
- Reopening an archived session no longer registers it as an engine-live ticket
  session, so it cannot pull its ticket back into flight.
- A failed role turn now records the error's one-line message as its
  needs-attention reason instead of the whole stack trace. The stack still goes
  to the log and the message to the span.

## 0.4.3

### Fixed

- A waiter is only ever settled by the turn it is waiting for. `reconcileTurns`
  recovers a turn whose `turn/end` the driver never saw by settling from the last
  end in the session log — but a waiter armed immediately after a halt (the
  auto-recovery loop, right after it asked for a kick) can be reconciled before
  the turn it waits for has begun: the agent is idle, 1500 ms have passed, and the
  *previous* turn's end is sitting right there. That handed the engine a failure
  for a turn that never ran, so it kicked again, and by the time the guard
  declined a real turn was genuinely in flight — the busy guard then correctly
  refused to park, the ticket stayed In flight, and every tick relaunched the
  phase as a fresh attempt: 9 kicks where `maxConsecutiveKicks` is 3, and a park
  of `attempt budget exhausted (3)` instead of the halt. Waiters now record the
  turn number they were armed on and ignore an older `turn/end`, from both the
  live handler and `reconcileTurns`.
- The recovery kick is now asked for one beat (1500 ms) after the halt, not in
  the same instant. A `turn/end` is published while the agent's driver is still
  inside its own turn and the phase does not return to idle until a moment later;
  a follow-up admitted in that window is queued but its wake is dropped, so the
  kick message sat in the inbox and no turn ever started — the engine then waited
  on a turn that would never come. This is the same ordering that
  dsh-continue-kicker's `liveKickDelayMs` exists for on its own door.
- 0.4.2 diagnosed the same symptom as stale activity bookkeeping. Its
  `activity.turnEnd` on settle is kept (a settled turn is an ended turn), but it
  was not the cause: the busy answer at the park was true.

## 0.4.2

### Fixed

- A settled turn now clears the ticket's realtime busy flag. `#settleTurn` can be
  reached from `reconcileTurns` (a `turn/end` the driver never saw), and that path
  left the session in `TurnActivity.active`. The 0.3.7 busy guard in
  `needsAttention()` then read the ticket as still working and skipped the park,
  so a halted turn whose auto-recovery was declined stayed In flight and was
  relaunched as a fresh attempt on every tick: with `maxConsecutiveKicks: 3` and
  `maxAttempts: 3` that meant 9 recovery kicks and a park reason of
  `attempt budget exhausted (3)` instead of the halt. Found by the lab's
  `kanban-recovery` smoke against the 0.4.0 + 0.3.7 combination.

## 0.4.1

### Fixed

- A reactivated ticket is parked again when its turn ends. The 0.3.7 busy guard in
  `needsAttention()` also stopped the realtime settle: the driver handled
  `turn/end` for the activity bookkeeping **before** releasing the engine's own
  turn waiter, so `isTicketBusy` answered "yes" using the very turn that had just
  ended, the park was skipped, and the ticket stayed in In flight with no reason.
  The approval intro was the case that hit it — an approval-waiting ticket opened
  as an approval session left Needs attention and never came back.
- `settleSessionTurn` now records `session_settled` only when the ticket actually
  moved. If a different session of the same ticket is genuinely mid-turn the
  settle is deferred (the mark is kept, In flight stays the honest column) instead
  of claiming a settle that never happened.

## 0.4.0

### Added

- Engine-owned auto-recovery of a halted role turn. When a plan, implement or
  review turn fails, the engine now asks the `continueKicker` service provided by
  dsh-continue-kicker 0.3.0 for one explicit kick
  (`kick(sessionId, { bypassCooldown: true })`) and waits for the turn it starts,
  taking the structured submission from it like any other role turn. The ticket
  stays In flight while recovery runs; each recovered turn is recorded as a
  `<phase>-continuation` span with its own usage and does not consume an attempt,
  and the timeline carries an `auto_recovered` event per kick.
  The halt policy — what is kickable, how many kicks in a row — stays in
  continue-kicker, so nothing is duplicated.
- `SessionDriver.waitTurn({ sessionId, stallTimeoutMs })`: the sendTurn waiter
  machinery (waiters entry, stall interval, `reconcileTurns` coverage, settle on
  `turn/end`) without injecting a prompt, so the engine can watch a turn that
  someone else started.
- `GET /api/kanban/capabilities` now reports `continueKicker` next to `worktree`.

### Changed

- The integration is optional and detected, exactly like the worktree one: the
  service is resolved lazily and duck-typed, and with dsh-continue-kicker absent
  or older than 0.3.0 kanban logs one line at boot
  (`dsh-continue-kicker not mounted; halted turns park to needs-attention without
  auto-recovery`) and a failed turn parks with the same reason it did in 0.3.x.
  A declined kick, a non-kickable halt, a stall after the kick or a disposed
  session all park the ticket with the original failure.
## 0.3.7

### Fixed

- Select the next model route through `sessionController.agents` when the
  controller facade itself does not expose `selectForNextRequest`; if neither
  selector is available, preserve the session's current route instead of
  failing the turn.
- Restart recovery now parks any ticket with an open workflow session in
  Needs Attention instead of auto-launching a duplicate build/review session.
  Opening the existing session reactivates it through the realtime activity
  path.
- A failing secondary session no longer marks a ticket Needs Attention while
  another session for that ticket is still actively working.

## 0.3.6

### Fixed

- Resolve `sessionController` lazily when switching a workflow session's model
  route. If the service is not published yet, keep the session's current route
  instead of failing the turn with `NO_SESSION_CONTROLLER`.


## 0.3.5

### Added

- Realtime board status. While any session attached to a needs-attention ticket
  has a turn running — a human answering the engine's question, driving the
  build by hand, or talking an approval through — the ticket moves back to
  In flight; when that turn ends without a structured submission it returns to
  Needs attention with the original `needsAttentionReason` preserved. Approval
  (`Awaiting human approval`) follows the same rule.
- The engine now skips dispatch for a ticket whose session has a turn in flight
  (`driver.isTicketBusy`), in both the In flight and backlog planning loops and
  again at the top of `advance()`. A human-driven turn is never interrupted by a
  role prompt and never consumes an attempt.
- A structured submission made from a human-driven turn flows through
  `handleManualAction` without the flip-back, so no extra needs-attention event
  lands after the submission.
- New timeline events `session_reactivated` and `session_settled`.

## 0.3.4

### Fixed

- Workflow sessions are no longer disposed when a ticket enters needs-attention;
  their Kanban action tools stay registered so a continued session can submit.
- Session attachment is a set per ticket/purpose. Reopened or manually continued
  sessions are reattached automatically via `agent/created`, restoring their
  Kanban tools.
- Action tools now support manually driven turns: when no engine turn waiter is
  present, implementation/review/plan submissions flow directly into the engine.
- Added a `recoverSession` action and a **Recover tools** button in the ticket's
  Sessions panel for an already-live stranded session.

## 0.3.3

### Changed

- New-ticket form redesigned as a centered modal; the whole client is
  restyled to the native DSH design language (design tokens, 14px/22px
  body, native buttons, 32px inputs, segmented controls and switches for
  the form's choices, dark mode via tokens). Field set, defaults and the
  create RPC payload are unchanged.

## 0.3.2

### Added

- Opt-in **Worktree** toggle in the new-ticket form, shown only when
  `dsh-better-git-worktree` is mounted. Confirming creates a managed working
  copy through that plugin's host service, registers it as a workspace, and
  points the ticket at it. The worktree copy is adopted by the first workflow
  session in the managed root.
- `capabilities` and `worktree` Kanban endpoints.

## 0.3.1

### Added

- Approval sessions have their own model route (`roles.approver`), editable in
  the Model routing tab. Both the production deployment and lab are configured
  to `local-ai-machine (apu)` / `big-moe`.

## 0.3.0

### Changed

- Removed the separate verification session. A passing review is validated in
  code against the plan's done_when ids and the acceptance criteria; incomplete
  reviews return to implementation. No verifier role or verification tool is
  registered.
- Added a human **Approval** stage. After review passes, the ticket becomes
  Needs Attention with approve, discard, and interactive-session actions.
- Approval sessions run in the standard preset, workspace-write, in the
  ticket's workspace. They expose `kanban_approve`, `kanban_discard`, and
  `kanban_submit_plan`; submitting a plan starts another build/review round.
- Review now emits per-condition done_when rows using the plan ids and
  acceptance_coverage for every acceptance statement.

## 0.2.5

### Fixed

- Workflow sessions now use DSH's canonical `session-<uuid>` ids and retry
  workspace attachment until the workspace registry is ready. Historical
  Kanban sessions are re-attached at boot, so they no longer show as Ungrouped.
- Restart recovery closes every open workflow session. A plan session that was
  interrupted by a restart marks the ticket needs-attention instead of silently
  launching another plan session; review/verify recover to implementation.
- Opening a ticket's plan session picks the latest plan session rather than the
  oldest one.

## 0.2.4

### Fixed

- A plan session waiting on a native `ask_user_question` now appears in the
  Needs Attention group/count with the red status styling. It returns to In
  Flight automatically once the question is answered; the ticket does not enter
  the stalled/retry path.

## 0.2.3

### Fixed

- The plan session's initial ticket state now includes the starting human
  acceptance criteria, so the planner can extend or fill them out with the
  starting point in view.

## 0.2.2

### Added

- Kanban sidebar link now shows board badges in the Activity-link style: a blue
  in-flight count and a red needs-attention count, polling the board every five
  seconds and using the same status colours as the board KPIs.

## 0.2.1

### Fixed

- Plan sessions run in the native **read-only** sandbox mode; review and
  verification also run read-only. Implementation runs in workspace-write.
  The ineffective custom tool mask was removed in favor of the native access
  mode plus the existing phase tool guard.
- Workflow sessions are attached to the selected workspace, so they appear
  under that workspace instead of Ungrouped.
- Workflow sessions pin their title (`KAN-n · purpose`) immediately, preventing
  the auxiliary session-title model call from creating a second activity lease.
- The plan prompt now includes only the ticket title and body, not the column,
  workspace path, or acceptance block.

## 0.2.0

### Changed

- Replaced phase JSON-in-message results with scoped action tools:
  `kanban_submit_plan`, `kanban_submit_implementation`,
  `kanban_submit_review` and `kanban_submit_verification`.
- Every workflow session now starts once in the **standard preset**. The plugin
  no longer registers per-role presets, rebinds presets mid-session, or provides
  a custom system prompt.
- Grill + plan is one flat session. Interactive mode uses the native
  `ask_user_question` tool; autonomous mode uses the self-judgement prompt.
- Implement + review share one session. Both action tools stay available and
  return errors when called in the wrong phase; write/edit are guarded off
  during review.
- Verify moved to the end and runs in its own session.
- Phase order is now `plan → implement → review → verify → closed`.
- New ticket choices: planning timing (`now` or `at_pickup`) and question mode
  (`interactive` or `autonomous`).
- Historical tickets/sessions are intentionally discarded by the V3 migration.
- Sessions close explicitly on plan/review/verify completion so continue-kicker
  sees a completed or aborted tail rather than an idle error.

## 0.1.5

### Fixed

- Human retry now resumes the failed phase instead of always forcing
  `implement`: failures in intake/triage/grill/plan re-enter those phases.
- Implementation refuses to start without at least one `done_when` condition and
  resets to planning (`done_when_required`), so a retry can never bypass plan and
  reach verification with an empty condition set.
- The lifecycle now permits the explicit replan reset from
  implement/verify/review back to triage.
- `needs_attention_reason` events record the failed phase.

## 0.1.4

### Fixed

- Restore the missing drag-event handlers (`startDrag`, `finishDrag`,
  `dragOverColumn`, `dragOverCard`, `dropCard`) that caused the Kanban page to
  crash with `ReferenceError: startDrag is not defined`.

## 0.1.3

### Added

- Dragging a ticket now renders a dashed shadow copy of the card in the target
  column at the hovered insertion point. The target column is outlined while
  hovered, so the drop destination is visible before release.
- Dropping a card onto a card in another column now moves it to that column
  before applying the within-column order.

## 0.1.2

### Fixed

- Phases with different model routes now switch the shared session through
  `ctx.sessionController.selectForNextRequest()` instead of the core agent
  registry, which does not expose that operation. This fixes the production
  plan transition failure (`this.agents.selectForNextRequest is not a function`).

## 0.1.1

### Fixed

- The orchestrator/judge now falls back to the deployment default model when
  `roles.orchestrator.provider/model` are unset, instead of failing with
  “no orchestrator route configured”. This matches the phase roles, which
  already inherited the default route.

## 0.1.0

### Added

- Ticket board (Backlog · Now · Blocked · Needs attention · Done/Discarded) and
  an in-flight view, backed by a local SQLite store with forward-only migrations.
- Code-driven lifecycle: intake, triage, grill, plan, implement, verify, review,
  with the intake-combination table enforced in the store.
- One **shared workflow session per ticket**: every phase is a turn in that
  session, with a phase-aware tool guard and a model-route switch between turns.
- New-ticket form asks for the workspace and initial status; the Host accepts
  `column: backlog|now|blocked`.
- Activity-dashboard visual language: KPI strip, colour-accented columns,
  lifecycle progress on cards, working-card glow, hero detail with a workflow
  timeline and metric cards, and clickable session links.
- Workflow timeline now shows plugin-owned phase blocks (grilling includes the
  human wait), separate orchestrator judge calls, and plugin command steps with
  individual colours; session tools/turns are no longer plotted. Clicking a block
  expands metadata; phase blocks include their prompt/result artifacts and the
  lifecycle events in that phase window, judge blocks include their verdict (and
  question for new runs), and `git diff` persists its output as a plugin artifact.
- Role presets are rebound per phase, changing the actual model-facing tool set
  (plus a global-tool mask); prompts were rewritten for the shared-session model.
- Per-ticket **ticket analytics** is ticket-scoped; the page-level Analytics
  button remains board-wide.
- Model routing is a top-right modal with one row per role and a single
  provider-grouped model picker. A pencil enters edit mode; saves persist the
  role routes to the profile config through `configEditor.edit`.
- Human-friendly token units (k/m), local routes price at $0.00, and a styled
  analytics dashboard with KPI cards and rate bars.
- Removed the remaining Kanban-side capacity coupling (`isWaitingForCapacity`,
  board capacity view/chips, legacy `maxConcurrent`); concurrency is entirely
  outside this plugin.
- Global per-provider capacity is delegated to `dsh-model-capacity`; Kanban owns
  no leases and no per-turn concurrency counters.
- Role sessions created from presets, with tool allow-lists enforced by
  `tools.restrict` and a monotonic execution guard.
- Mechanical result gate, bounded continuations, out-of-band adjudication,
  independent verifier and reviewer sessions, retry ladder and
  `needs_attention` packets.
- Span tree, token/cost ledger (`unpriced` never `$0.00`), JSONL/CSV export and
  analytics queries.
- Config in the profile YAML with strict boot validation, prompt hashing and
  atomic reload; no config table in SQLite.
