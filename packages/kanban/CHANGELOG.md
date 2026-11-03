# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

## Unreleased

## 0.25.1

### Fixed

- **The Work board is now usable on a phone.** The board was hard-wired to three
  columns (`min-width:780px`) with no mobile rule, so on a ~390px screen only
  about one and a half columns were visible and the whole page scrolled
  sideways. On a narrow screen (≤768px) the board now collapses to a single
  full-width track and shows the **Working** column by default; **Backlog** and
  **Done** are tucked behind two reveal buttons above the board (each showing its
  count), and the pinned Done column no longer sticks or caps its height. The
  low-value "created N ago" footer is hidden to give the cards room. Desktop
  layout is unchanged.

## 0.25.0

### Added

- **The ticket page now shows the plan.** The plan artifact has always arrived on
  the detail payload, but only its `done_when` rows and its sandbox grants were
  ever drawn, so a ticket parked on "Plan ready" asked for a decision without
  showing the thing being decided on. The Overview renders a **Plan** panel
  directly below the Body: the summary as markdown, the numbered steps, and the
  release scope, with the plan version in the heading. While the ticket is parked
  on that decision the panel wears a red glowing border and carries **Approve
  plan** and **Revise plan** inside it; both buttons moved out of the ticket hero,
  which keeps the "awaiting approval" chip. A ticket with no plan renders nothing,
  exactly as the grants panel already did.

## 0.24.2

### Fixed

- **The Preset picker and the ticket Details row now say the harness names.** A
  shipped preset publishes no name of its own, so the board printed its registry
  id — "standard", "ptc", "minimal", "cordis" — where the harness's own preset UI
  says "Standard mode", "PTC mode", "Minimal mode", "Creator mode". The
  new-ticket and edit-ticket dropdowns, the "Harness default (…)" parenthetical
  and the Details **Preset** row now show that wording, and a custom preset keeps
  the name its own declaration published. Only the display copy moved: a ticket
  still stores the registry id, `/api/kanban/capabilities` still carries it as
  `id`, and plan and verify sessions still run the standard preset.

## 0.24.1

### Fixed

- **The ticket overview's phase stepper is now just the dot and the name.** Each
  phase that has a session used to be a pill-shaped button: it carried padding and
  a negative margin, a rounded background, an underlined label, and the connector
  dash drawn inside its own box, so the whole pill was the click target. Now only
  the colour dot and the phase name are the button — no pill padding, no underline
  — and the dash between phases is a separate non-interactive element. Hovering
  still tints just the dot-and-name box, and clicking it still opens that phase's
  session.

## 0.24.0

### Added

- A sandbox path grant now also covers bash calls that stay inside it: a call
  with no command-grant match is auto-approved when it is not denylisted, names
  only paths inside a granted path, the ticket's workspace or platform temp, and
  names at least one absolute path (or `cd` target) inside a granted path. Network
  commands and commands that name no absolute path still need a command grant.
  `grant_applied` events record `kind` (`path` or `command`).
- `plan_ready` events carry an `advisory` when a plan declares path grants but no
  command grants.
- `liveCheckoutReadOnlyCommands` (default none): command prefixes a deployment
  treats as read-only inspection from a live checkout.
- A guard denial steers a notice into the denied session saying it was a policy
  rule, not a person, naming the rule and path, and what to do instead.

### Changed

- The live-checkout guard allows `git fetch` (no refspec, `--force` or `--prune`)
  and no longer treats `2>&1` or redirects to `/dev/null` as writes.
- Both planner prompts and the `kanban_submit_plan` sandbox description say what a
  path grant covers and that network and workspace-relative commands need command
  grants.
- The implement, rework and review prompts no longer restate the working
  directory; the session already starts there.
- The new-ticket worktree switch defaults to on when the worktree service is
  mounted, in the form and on the host `create` path.
- The implement and rework prompts say to keep run evidence under "an ignored
  directory" instead of naming one.

## 0.23.1

### Fixed

- **The edit pencil is now a pencil.** The glyph on the ticket's edit/lock button,
  on the acceptance-criteria edit button and on the routing edit button was a bare
  diagonal bar with a small loop at the top, which at 15px read as a paperclip
  rather than a pencil. It is now a whole pencil on the same 45° diagonal: a
  sharpened tip with its wood line, a shaft wide enough to stay hollow at this
  size, a ferrule band and a flat eraser end. Same 15px currentColor stroke style,
  same button, same tooltip — only the drawing changed.

## 0.23.0

### Changed

- **The board is pushed, not polled.** A visible board holds one stream shared by
  the sidebar badges and the page, instead of two timers asking for the whole
  board every 3 and 5 seconds. Frames are sent only when something on the board
  changed; a hidden tab sends nothing; an unavailable stream falls back to asking
  with a change token, answered "unchanged" in a line and backing off from 3 to
  30 seconds. The open ticket is fetched when selected and again only when the
  Host says something changed, and an unchanged ticket costs one line. Routing,
  workspaces and presets are read when their dialog or form opens, not on timers.
- **A cheaper board and ticket.** The board is built from one read per table, and
  the history-derived facts of closed tickets are remembered; the ticket payload
  drops the unused span tree and the duplicate artifact list, and leaves the
  lifecycle log to the Events tab. Done and Discarded travel once.
- **A cheaper scheduler tick.** With nothing to launch a tick is one narrow query,
  and at the concurrency cap it reads nothing.
- **Less redrawing.** Cards that say the same thing are not redrawn, "N ago" and
  a growing working time update as small text leaves on one shared tick, and
  dragging measures the cards once per frame.

### Fixed

- **"Could not reach the Host." no longer sticks.** The banner appears only after
  two failed polls in a row, slows the asking down while the Host is down, and goes
  away on the first poll that works, on the Refresh button's successful reload, and
  when you move to another ticket or view. An error from something you did stays
  until your next action that works.

## 0.22.1

### Fixed

- **Managed worktrees inside a live checkout are no longer treated as the live
  checkout.** When a live checkout holds its ticket worktrees and plugin clones
  under its own `.dsh-worktrees` directory, a build session writing in its own
  worktree was denied as a live checkout write, and closing a ticket never archived
  its workspace. A path now counts as inside a live checkout only when it is within
  the live root and not under `<live root>/.dsh-worktrees`; the live root itself,
  its profile directory and everything else beneath it stay protected, a
  `.dsh-worktrees` directory nested deeper (or a lookalike name) gets no
  exemption, and another open ticket's worktree there is still denied by the
  cross-ticket rule. The guard and the archive decision share this one rule.

## 0.22.0

### Added

- **Archive a closed ticket's workspace** (`archiveWorkspaceOnClose`: `off`, `done`,
  `done_and_discarded`; default `off`). After a ticket is approved, marked done or
  (if configured) discarded, its managed working copy is removed through the
  worktree plugin's new `removeForPath` and all of its sessions are archived. A copy
  is removed only when it sits under a `.dsh-worktrees` root, is not a configured live
  checkout and is not used by another open ticket or open session; one holding
  uncommitted, unpushed or stashed work, or whose state cannot be read, is refused and
  left in place with its sessions unarchived. The step runs after the close commits,
  never fails or delays it, is idempotent, and records `workspace_archived` or
  `workspace_archive_skipped` (with the reason) as a ticket event. With an older
  worktree plugin that lacks `removeForPath`, nothing is removed and the skip is
  recorded. A ticket without a worktree is untouched.

## 0.21.0

### Added

- **Mark done.** A human can close any open ticket as done when its work was
  finished outside the engine: from Backlog or Working, in any phase (plan,
  implement, review, approval), parked or not. A reason is required. The ticket's
  sessions are closed and a `done` event is recorded with actor `human`, the
  reason, `outsideEngine: true` and the column it was closed from. Available as
  `markDone` on the `resolve` and `action` endpoints and as a button in the ticket
  detail header and its needs-attention panel. Dragging a card to Done is still
  refused. A turn that fails after the ticket was closed no longer parks it.
- **Re-run review.** A ticket parked in implement or review whose work already
  exists can resume at the review phase without spending an attempt
  (`rerunReview` on both endpoints, a button in the needs-attention panel).
- **Revise plan.** Before the build starts (planned in Backlog at the build phase,
  queued in Working, or waiting for plan approval) a human can send an instruction
  to the plan session (`revisePlan`, a button in the detail header). The session's
  resubmission replaces the plan and `done_when` as a new plan version; new sandbox
  grants supersede the old ones and put the ticket back in the plan-approval wait,
  a revision without grants lifts it. If the resubmission is rejected the current
  plan stays, and the ticket says so: a `plan_revision_rejected` event and a red
  banner with the reason. The detail payload now carries `actions` (`markDone`,
  `rerunReview`, `revisePlan`) and `planRevision`.
- **One automatic resume after a restart.** A ticket the engine was driving when
  the service restarted has its interrupted plan, build, review or approval session
  reopened and told to continue, as the same attempt. It parks with the reason if
  the session cannot be reopened, or if the previous automatic resume made no
  progress before another restart. A ticket that was already parked keeps its
  reason. The events are `restart_recovered` (with `autoResume`) and
  `session_resumed`.
- **A question is attention.** A session that ends its turn on a question parks the
  ticket on `Waiting on your answer in the <phase> session: <question>`. The board
  shows "Waiting on you" and the detail a "waiting on your answer" chip, exactly as
  for a live `ask_user_question`, with Open session, instead of a generic failure.

### Changed

- **A retry continues the earlier work.** Retrying reopens the ticket's previous
  build session (live, already loaded, or resumed from disk through the session
  controller) instead of starting a cold one. When no session can be reopened the
  new one begins with a summary: whether the work already passed review, the
  implementation rounds so far, the last review's verdict, reasons and
  instruction, what was shipped and what is left.
- **The human's retry instruction reaches the model.** It is appended once to the
  next prompt of the planner, implementer or reviewer that resumes.
- **The unchanged-tree guard only speaks about conditions.** It fires when the
  round before failed named conditions; a failure that named none (a bookkeeping
  rejection) no longer parks the next round. A human retry starts the guard over.
- **The implementer prompts say that ending a turn without calling
  `kanban_submit_implementation` parks the ticket.**
- **Open session buttons report what happened.** They show "Opening…" while they
  work and print the failure (session not in the list, view unavailable, open
  threw) beside the button.

### Fixed

- A turn paused on a permission prompt is no longer counted as stalled while the
  prompt waits, and the stall clock restarts when it is answered. A ticket that was
  red because a prompt was waiting is plain working again once the prompt is
  decided, in the build, review and approval phases.
- A session reopened for a later round is never a stale one: the delayed adoption of a newly created session is skipped when the session was closed in the meantime, so a plan that finishes within a moment of its session being created can still be revised afterwards.

## 0.20.0

### Added

- **Start build.** A planned Backlog ticket (at the build phase) gets a **Start
  build** button on its card and in the ticket page, next to the pencil. It makes
  exactly the move dragging the ticket into Working makes. The same call is
  available to tooling as the `action` endpoint's `startBuild` action
  (`{id, action: "startBuild"}`), which refuses any ticket that is not a planned
  Backlog ticket with `bad_request`; `move` to `working` still does the same
  thing unguarded. A planned ticket waiting in Backlog is an ordinary idle card,
  not an attention state.
- **Jump to session.** A card with a session shows a small icon button that opens
  the active session, else the latest. On the ticket page each progress step is a
  link: Plan opens the latest plan session; Build, Review and Approval open the
  build session.
- **Card facts.** Bottom right of a card: total working time (with a clock icon)
  and when the ticket was created. Working time counts only time the engine had a
  turn, judge call, tool or workflow step running and nobody was being waited on:
  a parked ticket and a turn paused on a question or approval prompt do not count
  (the driver now records `human_wait_started` / `human_wait_ended` events; time
  before this release counts mid-turn waits as work). Done / Discarded is one
  list, newest closed first (`closed` on the `board` payload).
- **Progress segments follow the real path.** A ticket with two implement/review
  rounds shows seven segments, not five. Reached segments are filled; known
  required segments not yet reached are light grey.
- **Workflow session titles** read "<ticket id> · <session type> · <ticket title>".

### Changed

- **Board layout.** Backlog and Working no longer scroll on their own; they grow
  the page. The Done / Discarded column is pinned at the height of the visible
  board with its own scrollbar, so scrolling the page never moves it.
- **Ticket page.** Title, status, body and the rest sit on the left (about 80%);
  workspace, planning, questions, preset, write mode, attempts, spend, working
  time, created and updated sit in a sidebar on the right (about 20%). Below 900px
  the sidebar drops under the header.
- **Card visuals.** The working and attention accents sit inside the rounded
  border instead of poking past the corners; the bar is slightly wider.
- **Durations.** Past 24 hours a duration reads `1d2h`; from two days on, whole
  days only (`3d`, `4d`).
- The first attempt shows no badge; later ones read "second attempt", "third
  attempt" and so on (was "try N").

### Fixed

- **Dragging within a column reorders.** The queue order ignored the stored
  order, so a reorder never changed the list and cards snapped back. Queue order
  is now priority, then the arranged order, then creation (the engine launches in
  it too). Dropping at the end of a column no longer fails. A drop is computed by
  the column from the pointer against the card midpoints, shown with a drop line
  that takes no room, applied at once, and held against older board refreshes.
  A drop into another priority tier adopts that tier's priority. Dragging between
  columns is unchanged.

## 0.19.1

### Fixed

- **A plan-mode exit could be approved with no human in the room** (KAN-32
  review). `exit_plan_mode` asks through the same `user-questions/request` seam
  the 0.18.0 auto-answer listens on, and its ask carries options whose *first*
  label is Approve — so on an autonomous ticket, or in any plan session, the
  engine would have taken it and left plan mode with the plan approved. A
  question carrying a presentation `intent` is now never answered from, in any
  phase or mode: an intent is the ask saying it is a specific kind of human
  decision, not a recommendation being offered. Tests cover the single-intent
  batch, a mixed batch (one intent vetoes the whole batch), and the listener
  path end to end.
## 0.19.0

### Added

- **Build, rework and review prompts render markdown, not JSON.** The stored plan,
  the implementer's result and the review verdict are rendered back as readable
  sections instead of being pasted as JSON. A build or rework prompt now carries
  the human's own title, body, acceptance statements and image paths, the plan
  (summary, steps, release scope, sandbox grants and checks), every condition with
  its id, statement, verification and source, and a submission contract listing
  exactly what the engine checks before it accepts an implementation and what the
  review holds each claim to. A rework prompt adds the review that sent it back.
  The review prompt carries the same ticket and plan plus the implementer's
  result. Tool-call argument schemas are unchanged.
- **Build and rework prompts forbid handoff documents.** They tell the agent not to
  create handoff, runbook, deploy-notes, smoke-results or summary documents, to
  report in its final message, and to keep run evidence under the ignored directory.
- **Cross-ticket checkout access is denied, not prompted.** A sandbox escalation
  from one ticket's build session that reaches another open ticket's workspace,
  worktree or clone (a path segment `kan<number>` or `kan<number>-<name>`) resolves
  `rejected` and records a `guard_denied` event naming the owning ticket. A done or
  discarded ticket's checkout stays readable. Builds name their clones
  `kan<number>-plugins` and `kan<number>-deploy`, and the build prompt says so.
- **The live checkout is protected.** Configured live checkouts (`liveCheckouts`,
  `DSH_KANBAN_LIVE_CHECKOUTS`) refuse escalated writes, except the approval-phase
  pre-stage (`git pull --ff-only`, `pnpm install`, `pnpm run check`) and read-only
  commands. The matcher is a pure module (`src/guard.mjs`); it runs ahead of the
  grant approver, so a grant cannot override a denial, and the grant denylist is
  unchanged.

## 0.18.0

### Added

- **The Questions setting now covers the whole ticket** (KAN-32). `autonomous`
  ("decide autonomously") used to apply only to planning: an autonomous ticket's
  build session still stopped on an `ask_user_question` prompt and waited for a
  human, which is exactly the round trip the setting says it does not want. Now
  an `ask_user_question` batch whose every question carries options is answered
  by the engine in the implement and review phases of an autonomous ticket, and
  in the plan phase of every ticket — the first (recommended) option is taken
  back from the model, and a `question_answered_autonomously` ticket event
  records the call id and the exact `{id, selected}` batch before the answer is
  claimed. A question with no options is the model saying it genuinely does not
  know, so it still reaches a person in every phase and every mode; so does
  anything in the approval (verify) phase, on a done or discarded ticket, or on
  any malformed input or thrown error — every miss calls `next()` and the human
  answers, and a failed event write does not answer either. The decision is a
  pure module (`src/questions.mjs`, no dsh imports) reached through core's own
  seam: an agent-scoped, prepended `user-questions/request` waterfall listener,
  registered on plan and build sessions at setup and again on reattach after a
  restart, so a restart no longer silently turns an autonomous ticket back into
  one that waits.
- **A tolerant `ask_user_question` in every kanban session.** Registered in the
  agent scope, where it shadows the preset's copy for that session only. A
  question missing its `id` gets one assigned (`q1`, `q2`, …, never colliding
  with a supplied id) instead of the whole call being rejected — the observed
  failure was a model emitting a batch without ids and losing the question
  entirely — and the ask carries the tool call id as its card key, which is what
  lets core's persisted draft store (`dsh.user-questions.drafts.v1`) restore a
  half-typed answer across a page reload. With no `userQuestions` service
  mounted the tool is not registered, the core copy stays, and the log says so
  once.
- **The prompts tell the model what the engine will do.** An autonomous ticket's
  implement, rework and review prompts carry a questions note: an option batch is
  answered for it and logged, asking is therefore safe, and every choice taken
  this way must be named in the submitted report. The interactive planning prompt
  says an all-options batch never reaches a human, so optionless questions are
  reserved for what genuinely needs a person.

## 0.17.1

### Fixed

- **A `fail` could reach approval without the build's own conditions being
  checked** (KAN-31 review). The 0.17.0 rule read a fail as a pass-equivalent
  whenever it left no substantive gaps and had a deferred condition open — but a
  *missing* row is classified cosmetic, not substantive, so a fail that listed
  only the deferred row and never mentioned the build's condition was routed
  straight to the approval park. A fail is now read as a pass-equivalent only
  when every non-deferred condition carries a `met: true` row (`nonDeferredProven`
  in `src/result.mjs`); a fail that omits one goes to the reviewer's retry budget
  like any other bookkeeping failure — one retry, then a park — and never to
  approval, and never back to the build for the reviewer's omission. Tests cover
  the retry-then-approve and the retry-then-park paths, and both fail without the
  fix.
- **A rework round that committed its work was at risk of being called
  no-progress** (KAN-31 review). The fingerprint read `git diff HEAD`, which is
  relative to HEAD, so a round that finished by committing left a clean tree that
  hashed exactly like a round that had done nothing — and the next round would
  park instead of running. `rev-parse HEAD` is now part of the fingerprint, so a
  moved HEAD is progress. Test: a rework round that commits is not called
  no-progress.

## 0.17.0

### Fixed

- **The review gate no longer burns an implement attempt on a human-gated step**
  (KAN-31). A plan can now mark a condition `deferred: true` with the
  `human_evidence` the human is asked to check, and declare a top-level
  `release_scope` of `stop_before_merge` or `full_release`. The review gate
  accepts an unmet deferred row as a pass and routes the ticket straight to
  approval with those conditions listed in the hand-over and in the
  `approval_requested` event, so "merged to main and tagged" costs the build no
  round. A fail verdict whose only unmet conditions are deferred ones is routed
  the same way.
- **A malformed review no longer costs the build a round.** `verifyReview` splits
  its gaps into substantive ones (a non-deferred condition unmet, under-confident
  or unevidenced — the build's problem, back to implement as before) and cosmetic
  ones (a missing, duplicated or invented `done_when` id, a malformed coverage
  row, an uncovered statement — the reviewer's problem). Cosmetic-only gaps get
  exactly one retry turn in the same session carrying the exact gap text, the
  plan's condition ids and the stored acceptance statements; a second cosmetic
  failure parks the ticket in review with that text instead of spending an
  attempt. The review-retry budget is now structurally separate from the
  implement-attempt budget.
- **Invented acceptance rows are ignored, not rejected.** `acceptance_coverage`
  is compared against the stored acceptance only. A row quoting a sentence from
  the ticket body — what a reviewer does when the ticket stored nothing — no
  longer fails a review that was fine. Every stored statement still has to be
  covered.
- **A human "Retry with instruction" grants the fresh budget the park promises.**
  The exhausted-attempt park now says so, and both retry endpoints reset the
  counter to a fresh budget and record a `budget_reset` event, instead of parking
  again on the next round with the counter still spent.
- **A rework round that changes nothing is no longer paid for.** Each rework round
  records the working tree it started from (`rework_signature`: diff hash plus the
  condition ids the review left failing). A later rework round that starts from
  that same tree parks with a no-progress reason naming those ids, rather than
  burning the attempt re-running an instruction against an unchanged tree.
- **The board no longer prints "5 / 3".** The ticket detail carries the real
  configured `maxAttempts` and the Overview reads it.

### Added

- `release_scope` and per-condition `deferred` / `human_evidence` in the plan
  protocol (`validatePlan`, `normalizePlan`, `kanban_submit_plan`), stored on the
  condition rows (schema v7, additive `ALTER`s), rendered into the plan, build,
  rework, review and approval prompts, and shown on the ticket's condition table.
- Both plan prompts gained a "Release scope and deferred steps" section, so the
  plan, the build and the review are coached on one definition of done. The
  KAN-19 agent-verifiable rule and the KAN-30 sandbox section are unchanged.


## 0.16.3

### Fixed

- **A backslash-escaped command word still evaded the denylist** (KAN-30 review,
  round three). 0.16.2 compares whole words, but on their exact spelling, so the
  shell's own alias-bypass idiom slipped through: with a human-approved `git
  push` grant, `git push && \systemctl restart dsh` and `git push && \sudo
  reboot` were auto-approved at `danger-full-access` with no human asked, and so
  was `git push && sys\temctl restart dsh`. `commandWords` now strips backslashes
  along with quotes before comparing, so `\systemctl`, `sys\temctl` and `\rm`
  read as the commands they run. Tests cover the escaped forms at the denylist,
  matcher and approver levels.

### Documented

- **The three routes the denylist cannot close, named instead of glossed.** It is
  a text rule, not a sandbox: an **interpreter** (a bare `node`/`python3`/`bash
  script.sh` grant hands the build whatever that interpreter runs), an **encoded
  payload** (`echo <base64> | base64 -d | sh` hides its words from any matcher)
  and **indirection** (a granted command reading a script or config the build
  wrote inside the workspace) are out of reach of string matching by
  construction — closing them needs the sandbox itself to resolve the exec, which
  is core work outside this plugin. README, DECISIONS, the `kanban_submit_plan`
  parameter description and both plan prompts now say that, and replace the "in
  any shell clothing" absolute with "any natural shell form".

## 0.16.2

### Fixed

- **The denylist could still be evaded by shell syntax** (KAN-30 review, round
  two). 0.16.1 checked the first token of every `&&`/`;`/`|` segment, but a
  denylisted word does not have to be any segment's first token: with a
  human-approved `git push` grant, `git push && (systemctl restart dsh)`,
  `git push && $(systemctl restart dsh)`, `git push && FOO=1 systemctl restart
  dsh`, `git push && { systemctl restart dsh; }`, `git push && eval systemctl
  restart dsh` and `git push && xargs -I{} systemctl restart {}` were all
  auto-approved at `danger-full-access` with no human asked. `isDenylisted` is
  now **word-based**: the command is split on whitespace and on `(`, `)`, `{`,
  `}`, `$`, backtick, `;`, `|`, `&` and newlines, and any word whose basename is
  a denylisted token denies the whole call (the first-token wrapper walk of each
  segment still runs on top, so `bash -c "…"` bodies are read as commands). A
  plan declaring such a grant is rejected at submission. The rule over-strictly
  catches a denylisted word that is not a command — `grep -r rm -n .` and
  `git commit -m "rm old path"` now ask the human — which is the only acceptable
  direction to err in, since a prompt is cheap and a wrong auto-approval is not.
  Ordinary compounds of grantable commands (`git push && npm test`) still match.
  Tests cover the shell-clothing cases at the denylist, matcher, approver and
  plan-submission levels.

### Documented

- **The denylist is a text rule and cannot see inside an interpreter.** A plan
  granting a bare `node`, `python3`, `perl` or `bash script.sh` prefix hands the
  build whatever that interpreter runs, so an interpreter grant is a full-access
  grant. README, DECISIONS, the `kanban_submit_plan` parameter description and
  both plan prompts now say that plainly instead of promising that a service
  restart is inexpressible; the planner is told to grant the narrowest prefix
  that works and never a bare interpreter.

## 0.16.1

### Fixed

- **A granted command prefix could chain into a denylisted command** (KAN-30
  review). The denylist inspected only the line's first token (seen through
  wrappers), while a bash grant matches by token prefix, so a human-approved
  `git push` grant auto-approved `git push && systemctl restart dsh` at
  `danger-full-access` — the one thing the denylist exists to make impossible.
  `isDenylisted` now splits the command on `&&`, `||`, `;`, `|`, `&` and
  newlines and runs the first-token wrapper walk on **every** segment, so a
  denylisted token anywhere in a compound command denies the whole call, and a
  plan declaring such a grant is rejected at submission. Ordinary compounds of
  allowed commands (`git push && npm test`) still match. Tests cover the
  chaining cases at the denylist, matcher and approver levels.

## 0.16.0

### Added

- **Plans can front-load their sandbox permissions** (KAN-30). A build session
  that needs to write outside its workspace root, or run a command the standing
  sandbox would deny, used to stop mid-turn and ask a human every single time —
  the classes of surprise a missing directory or an unwritable `/tmp` cause. Now the plan
  protocol grows an optional `sandbox` section: `grants.paths` (absolute paths
  the build may write) and `grants.commands` (token-prefix bash commands), plus
  `checks` — the read-only `test -w` probes the planner ran for each declared
  path, so the human approves against observed evidence instead of an
  assumption.
- **A plan that declares grants parks as *Plan ready*** and the board grows an
  **Approve plan** action (`approvePlan` on the resolve and action endpoints).
  Approving is the one-time grant: it lifts the park, records `plan_approved`,
  and the build starts with exactly those escalations pre-approved. A plan
  without grants behaves exactly as before — no park, no new step. Grants live
  in the plan artifact, so a new plan version supersedes them, and a follow-up
  plan that re-declares grants re-parks the ticket.
- **The grant approver is an agent-scoped `approval/request` waterfall
  listener**, registered only on build sessions (plan and verify stay
  read-only). It claims only asks whose reason starts with `escalate sandbox
  to `, reads the exact `tool/call` arguments by `callId` from the session's
  own durable log, matches paths at segment boundaries and commands at token
  prefixes, and answers `allowed-once` on a match — recording a `grant_applied`
  audit event (`toolName`, `callId`, `grant`, `mode`, `target`) first. Every
  miss, malformed input, terminal ticket or exception falls through to the
  human: the grant path fails open, never closed.
- **A hard denylist is never claimable.** `systemctl`, `service`, `launchctl`,
  `sudo`, `kill`, `pkill`, `rm`, `dd` as first tokens (seen through `sh -c` /
  `bash -c` / `env` / `nohup` / `timeout` wrappers) and `rm -rf /` / `rm -fr /`
  substrings can never be auto-approved, even by an approved grant — and a plan
  declaring one is rejected at submission with a *can never be granted* error.
  The mechanism therefore cannot restart a service.
- The plan prompt now tells the planner the build session's write mode
  (`{{write_mode}}`) and workspace root (`{{cwd}}`), and `kanban_plan` returns
  the plan's `sandbox` section so a build session can re-read its grants.

## 0.15.0

### Changed

- **Plans may no longer depend on a human to be verified** (KAN-19). A plan once
  carried a `human-visual-verify` done_when condition that no agent could ever
  evidence, and the pipeline had nowhere to put it. Both plan prompts
  (`plan-human.md`, `plan-self.md`) now state the hard rule: every `done_when`
  condition must be verifiable by an agent without human input — never a human
  action, visual confirmation, a production restart, or confirmation "on the
  ticket". Human approval is already implicit for every ticket (a passing review
  moves the ticket straight to a human), so when the real acceptance is human
  judgement the plan should carry the strongest agent-verifiable proxy — tests,
  a smoke run, a grep or `git ls-remote` check — and leave the judgement to the
  approval step. The `kanban_submit_plan` tool's `done_when` description says
  the same at submission time, and a new prompt test pins the coaching into the
  rendered `planner_prompt_plan` artifact.
- **The implement prompt tells the builder to fetch first.** A build can start
  long after planning settled the working copy (KAN-18 fetches at plan start,
  nothing did at build start), so `implement.md` now instructs the implementer
  to `git fetch` and bring the working copy up to date with the default branch
  before starting work.

## 0.14.0

### Changed

- **A worktree is created when planning starts, not when the ticket is made**
  (KAN-18). The new-ticket **Worktree** switch was a confirm dialog that cut a
  working copy immediately, before anyone knew what the ticket would turn out to
  be: a board of abandoned tickets each holding a directory. It is now a plain
  switch that records the intent in `tickets.worktree` (schema V6, existing rows
  0), and the copy is settled by the driver at the moment a plan session is
  actually dispatched — from the just-fetched `origin/<default branch>`, not from
  wherever the source checkout happened to sit. The hint says so: *A worktree from
  the latest main is created when planning starts.*
- **A ticket that already points at a working copy is brought up to date instead
  of left behind.** Every eager-era ticket — this includes the whole existing
  backlog — names a copy that was cut days ago. At plan start a *pristine* copy is
  fast-forwarded onto the latest default branch and its base recorded; a copy with
  work in it is **left exactly as it is** and the plan prompt gains a line naming
  the path, the branch, why it was not moved and what it is based on, so the
  planner knows what ground it is standing on. Nothing is deleted, reset or
  rebased, and no existing working copy is removed by this change.
- **A fetch that fails parks the ticket.** Planning on a base this plugin could
  not bring up to date is the one thing the switch exists to prevent, so the plan
  dispatch fails with git's own words in `needsAttentionReason` rather than
  quietly planning against yesterday's code.

### Added

- `SessionDriver.preparePlanWorktree(ticket)`, the single place that decides where
  a plan session runs, and `worktreeStaleNote`, the sentence a not-pristine copy
  contributes to the plan prompt. Both talk to the `betterGitWorktree` seam
  (`refreshManagedCopy` / `createForPath`), resolved lazily and duck-typed: with
  `dsh-better-git-worktree` not mounted the intent is ignored with one log line and
  planning behaves exactly as in 0.13.x. Requires `dsh-better-git-worktree` 0.2.0
  for the fast-forward half; an older worktree plugin simply leaves copies alone.
- The `worktree` endpoint stays as the manual escape hatch (make a copy for a
  ticket right now); only the create form stops calling it.


## 0.13.1

### Fixed

- **A session waiting on you now reads as attention, not as running.** A harness
  approval prompt and an `ask_user_question` call both pause a turn *in flight*
  — the turn stays open while the person decides — so a ticket whose build
  session had sat on an escalation ask for ten minutes still showed the blue
  pulsing "Running" card, and nothing on the board said a human was needed.
  The driver now folds the durable log's own record of the pause — the
  `approval/asked` … `approval/decided` pair (matched by id) and an
  `ask_user_question` call answered by the `tool/result` citing the same
  callId — into a per-session wait for every ticket session, on engine-driven
  and human-driven turns alike. `cardStatus` lets that wait take attention
  precedence over `active`, the card badge reads **Awaiting approval** or
  **Waiting on you** in any phase, and the detail hero grows an **Open session**
  button that lands on the pending prompt. A session reopened mid-turn after a
  restart is seeded from its own log, so the red card survives the restart too.
  No config key, no schema change, no tool change: the events were already in
  the session log, the board just never looked.

## 0.13.0

### Added

- **Start planning.** A Backlog ticket that plans *when picked up* can now be
  planned from the board without dragging it anywhere. A small **Start planning**
  button sits on the card, and the same one next to the pencil in the ticket
  detail hero: it sets that ticket's planning to *now* and nudges the engine,
  which runs the plan session right there in Backlog. When the plan lands the
  ticket stays in Backlog, now at **Build**, waiting to be dragged to Working —
  planning and building remain two separate decisions.
  The button appears only where it does something: a Backlog ticket still at the
  plan phase that is not already planning now, not mid-turn, and not waiting on
  your answer. On a parked plan ticket — a plan that ended without submitting, or
  one that was rejected — it doubles as the retry: it lifts the park and launches
  a fresh plan. The action is a new `startPlanning` action on the existing
  `action` endpoint; it writes `planTiming`, moves no column and no phase, and
  refuses anything else with `bad_request`. The engine already planned Backlog
  plan-now tickets and stopped at Build, so this release changes no engine code.

## 0.12.1

### Fixed

- **Clicking the sidebar Kanban row now always lands on the board.** The row
  selects the panel, so when the kanban panel was already active the click
  re-wrote the same store value, nothing re-rendered, and the page stayed
  exactly where it was — an open ticket stayed open, the Analytics view stayed
  up, and the row looked dead. The click is now caught before the panel
  selection runs: when it lands on this plugin's own sidebar row (wide sidebar
  or collapsed rail) while kanban is already the active panel, the page does
  what the top **Board** button does — switch to the board, close the ticket
  detail, and leave the Analytics view. Clicks that merely open the panel are
  untouched, and the row keeps its normal selection behaviour everywhere else.

## 0.12.0

### Added

- **New-ticket options: build preset and write mode.** The New-ticket dialog
  (and the pristine-ticket editor) gained two choices that apply to the
  ticket's **build** session only. **Preset** picks the agent preset the build
  session starts in — the first option is *Harness default*, stored as null so
  the ticket keeps tracking the deployment's default if it changes later; the
  rest come from the live preset registry, with broken entries labelled
  *(unavailable)*. **Write mode** picks the build session's file policy from
  the closed DSH vocabulary: *Read-only*, *Workspace write* (the default) or
  *Full access*. Plan and verify sessions are unchanged: standard preset,
  read-only, whatever the ticket chose.
- A stored preset that is no longer registered when the session spawns does not
  strand the ticket: the build session starts in the harness default, the
  driver logs a warning, and the ticket records a `preset_fallback` event with
  what was asked and what was used.
- Schema V5: nullable `preset` and `write_mode` columns on `tickets`
  (`write_mode` CHECK-constrained to the vocabulary). Existing rows stay NULL,
  which is exactly the pre-0.12.0 behavior — standard preset, workspace-write
  build, read-only plan/verify.
- The `capabilities` endpoint now carries `presets` (`{default, items[]}` from
  the registry) and `writeModes`, and `create` validates a supplied preset id
  against the registry (`unknown_preset`) and the write mode against the
  vocabulary (`bad_request`) before any row is written. The detail Overview
  shows both choices, and the session rows record the preset actually mounted.

## 0.11.1

### Fixed

- **Image tiles rendered unstyled after an in-place client swap.**
  `ensureStyles()` returned early whenever its `<style id="kanban-styles">`
  tag already existed, so a tab that re-applied the new client half without a
  full reload (reconnect after a service restart) styled the 0.11.0 markup
  with the previous release's CSS: pasted screenshots showed at natural size
  with the × below the image. The tag's content is now refreshed whenever it
  differs from the running client's stylesheet.
- **The × now floats over the tile corner and appears on hover**, mirroring
  the native composer attachment chip: a small dark circle with a light ring
  overhanging the thumbnail's top-right corner, hidden until the tile is
  hovered or keyboard-focused (`:focus-within`, so it is reachable by Tab),
  and still removing the tile and its body reference together.

## 0.11.0

### Added

- **Images in ticket bodies.** Paste a screenshot into the body box of the
  New-ticket dialog or the ticket editor, drop files onto it, or press
  **Add image**: each accepted file gets a thumbnail tile and a markdown
  reference at the cursor, and the tile's X removes both together. Limits:
  png/jpeg/webp/gif, 20 MB each, ten images per ticket — a refusal says why
  and leaves the text alone.
- The bytes go to DSH core's content-addressed attachment store
  (`$DSH_HOME/attachments/v1/objects/xx/<sha256>`) through `ctx.attachments`
  — validated, deduped, durable across restarts — and the body keeps only the
  reference `![name](kanban-image:sha256:…)`. No new table, no migration, no
  new config keys. While a draft is open the reference carries a
  `pending-<token>` id; the Host stores every upload and rewrites every token
  to its real id **before** writing the body, so a failed image means no
  ticket is created and no patch is applied. All of it lives in a new pure
  module, `src/images.mjs`, with the host as thin wiring.
- The ticket detail gained a read-only **Body** panel: light markdown
  (headings, lists, code, links, built as React elements — the body is
  untrusted data and is never interpreted as HTML) with each image reference
  resolved to a real `<img>` through the new `readImage` endpoint, which
  re-digest-verifies the stored bytes against the id it is read under. A
  reference whose bytes no longer resolve renders as an *image unavailable*
  chip instead of vanishing, and the detail response now carries an `images`
  array derived from the body refs.
- A plan session's ticket block ends with an **Attached images** section
  listing each image's host file path, so every role session can `read_image`
  what the human pasted.

## 0.10.0

### Added

- **Edit ticket.** The detail hero's pencil now opens one editor for the whole
  card — title, body, acceptance, planning, questions, priority, allow-paid,
  budget and workspace — and saves it in a single `update` call. Acceptance is
  edited as a list, one statement per line: change a line to edit it, delete a
  line to remove it, clear the box to drop every criterion. Behind it the store
  gained `setAcceptance`, which replaces the rows in one transaction and records
  an `acceptance_set` event carrying both the prior and the new statements, so
  the words a human removed stay readable in the audit trail. The `update` patch
  accepts an optional `acceptance` array, and a `setAcceptance` action sits
  beside the existing `addAcceptance`.
- **`editable` on every board card and in the detail**, answered by
  `store.isEditable(id)`: a ticket is still editable only while no engine has
  touched it — at the plan phase in Backlog or Working, no attempt, no spend, not
  parked, and no session, run, span or condition row attached. The child-row
  check is what catches the quiet touches: a plan session that attached and was
  cancelled leaves rows behind even though the ticket columns look pristine.

### Changed

- **A started ticket is locked to humans.** Once a ticket has started in any
  way, the pencil is disabled with *Locked — the ticket has already started* and
  the `update`, `addAcceptance` and `setAcceptance` endpoints answer
  `ticket_started`. The guard sits at the human edit boundary (`src/edit.mjs`),
  not in `store.updateTicket`, so the engine's own writes — reorder, worktree
  creation, the retry patch — keep working on a started ticket. Editing a
  pristine ticket does not lock it: a person may fix a card as often as they
  like before anything starts work on it.
- The separate "Edit modes and budget" dialog and the add-only acceptance dialog
  are gone, folded into the one editor.

## 0.9.3

### Fixed

- **A review call whose arguments never parsed no longer claims an outcome.**
  0.9.1 and 0.9.2 made each banner read its own call's verdict, but left one
  branch reading the ticket's phase alone: when `argsRaw` did not parse, the
  banner inferred **Review passed** (ticket at `verify`) or **Review status: not
  finished** quoting another round's feedback (ticket at `implement`). A
  non-parsing `argsRaw` means the call may never have run at all — an interrupted
  turn, or a tool-call block still streaming — and a schema-valid review always
  carries a verdict, so there was nothing to infer. That branch now renders
  nothing. Silence is never wrong; a guessed outcome is.

## 0.9.2

### Fixed

- **A review that passed is never called "not finished" by a later phase move.**
  0.9.1 made the banner read its own call's verdict, but a pass was still judged
  as bounced whenever the ticket happened to sit back in `implement` — and a
  ticket gets there by a second route: asking for a follow-up plan during
  approval moves it `verify → implement`. So a clean pass, followed later by a
  follow-up round, displayed **Review status: not finished** quoting whatever
  feedback an older round had left behind. The host now returns `reviewRejected`,
  derived from artifact ordering (the engine writes the `review` row before the
  `review_feedback` that rejects it, and ids are AUTOINCREMENT, so a newer
  feedback row can only mean that review was sent back), and only an explicit
  rejection may call a pass unfinished. When the evidence is ambiguous the banner
  says nothing rather than something wrong.

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
