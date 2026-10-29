# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

## Unreleased

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
