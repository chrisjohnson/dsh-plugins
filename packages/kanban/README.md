# dsh-kanban

A ticket-centric workflow plugin for DeepSeek Harness. Tickets live in SQLite;
code drives them through one flat plan session and one build session that
implements, reviews and then carries approval, with a code-gated review result
and a human who closes the ticket. Agents return structured data by calling
tools, not by printing JSON.

## Install

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-kanban-v<version>&path:/packages/kanban"
```

The bundle mounts `id: kanban` with no config. Put the complete config section
in the deployment profile.

## Ticket flow

```text
plan session
  native ask_user_question (interactive) or self-judgement
  kanban_submit_plan
      ↓
build session
  kanban_submit_implementation
  kanban_submit_review
  fail → implement again in the same session
      ↓ review pass with one done_when row per plan id
      ↓ and acceptance_coverage for every stored acceptance
      ↓ (a pass whose only unmet rows are deferred ones passes)
  approval — the same session, flipped to the approver phase (attention card)
  the agent hands the work over and asks; kanban_approve, kanban_discard,
  kanban_submit_plan
      ↓ approve
   done

kanban_plan (read-only) is available in every session and returns the plan,
its conditions and the latest review, so a session can re-read the contract it
is working against instead of trusting its own summary of it.
```

Approval is a **phase**, not a session. The session that wrote the code and
reviewed it is the one that asks the human what to do with it: it keeps its
workspace, its history and its tools, its phase role flips to `approver`, and it
moves onto the configured approver route. There is no separate approval session
to launch, and no second conversation to catch up on what was built.

There is no verification session. The review is checked in code against the
original plan and acceptance: every planned done_when id must be present with
met/confidence/evidence, and every acceptance statement must be covered. A
missing or incomplete review goes back to implementation. Only when that code
gate passes does the ticket enter human approval.

Columns are **intended state** — where you want the ticket to live — and the
engine never moves a ticket between them on its own. Whether work is happening
is a card-level visual status computed from live facts: a blue pulsing dot and
glow while a workflow turn is in flight, a red glowing card when the engine has
parked the ticket for a human (a failure, a question, or approval), and a plain
grey card otherwise.

Since 0.13.1 a red card also covers the wait *inside* a turn: when a session
pauses mid-turn on an unanswered approval prompt (the harness `approval/asked`
… `approval/decided` pair) or an unanswered `ask_user_question`, the card shows
**Awaiting approval** or **Waiting on you** instead of pretending work is
happening. This needs no configuration: there is no new config key, no schema
change and no tool change — the durable session log already carried the fact,
and the board now reads it.

Needs attention is a state, not a parking brake or a column. The moment any
session attached to a parked ticket starts a turn — you answering the engine's
question, driving the build by hand, or talking an approval through — the park
lifts in place and the card turns blue, and the engine will not inject a role
prompt into a session that already has a turn running. When that turn ends
without a structured submission the card returns to red with the reason it had
before; a `kanban_submit_*` call from the same turn advances the ticket as
usual.

Plan and verify sessions start once in the **standard preset**; a build session
starts in the preset the ticket chose, or the harness default when it did not
choose one. Either way a session uses its preset's natural system prompt and has
every tool that preset gives a normal session. The plugin does not rebind
presets mid-session, install a custom system prompt, or register a tool guard.
The sandbox mode follows the session's **purpose** plus the ticket's write-mode
choice: plan and verify are always read-only, and a build session runs
`read-only`, `workspace-write` (the default) or `danger-full-access` as the
ticket asked — through all three of its phases, implement, review and approval;
a phase change inside one session never moves it. If a stored preset is no
longer registered when the session spawns, the session starts in the harness
default and the ticket records a `preset_fallback` event. Workflow sessions
attach to the ticket's selected workspace and are titled `KAN-n · purpose`.

Ticket choices:

- **Planning:** `now` or `at_pickup`
- **Questions:** `interactive` (native `ask_user_question`) or `autonomous`
  (self-judgement prompt)
- **Preset:** the starting preset of the ticket's build session — the harness
  default (stored as null, so it keeps tracking future default changes) or any
  registered preset; plan and verify stay on standard
- **Write mode:** the build session's file policy — `read-only`,
  `workspace-write` (default) or `danger-full-access`; plan and verify stay
  read-only

The plan session is one flat session: it asks questions, researches, and calls
`kanban_submit_plan` when confident. A valid plan ends that session. Implement,
review and approval share one session; a complete review flips that same session
to the approver phase and asks the human what to do with the work.

### Sandbox grants (0.16.0)

A build session runs under the ticket's write mode with the ticket's workspace as
its sandbox root. Anything outside that — a lab directory, a scratch checkout, a
command the sandbox would deny — normally stops the build mid-turn to ask a human.
A plan may declare those needs up front, in an optional `sandbox` section:

```json
"sandbox": {
  "grants": {
    "paths": ["/home/dsh/dsh-lab/kan30-grant"],
    "commands": ["git push", "gh pr create"]
  },
  "checks": [
    { "path": "/home/dsh/dsh-lab/kan30-grant", "check": "test -w /home/dsh/dsh-lab/kan30-grant", "observed": "writable" }
  ]
}
```

- **A plan that declares grants parks.** The ticket stays in Plan with a
  *Plan ready: N sandbox grant(s) declared* reason and an **Approve plan**
  button on the board. Approving is the one-time grant: it lifts the park,
  records a `plan_approved` event, and the build starts with exactly these
  escalations pre-approved. A plan without grants behaves exactly as before —
  no park, no new step.
- **Matching is mechanical.** A `write`/`edit` call is covered when its
  `file_path` is a granted path or lives under it at a path-segment boundary
  (`/a/b` grants `/a/b/c`, never `/a/bc`). A `bash` call is covered when its
  command starts with a granted prefix at word boundaries (`git push` grants
  `git push origin main`, never `git pushfoo`). The matcher reads the exact
  arguments from the session's own `tool/call` event, never from the model's
  justification text.
- **The denylist is never claimable.** The check is **word-based, not
  position-based**: the command is split on whitespace and on the shell syntax
  that can hide a command from a first-token read (`(`, `)`, `{`, `}`, `$`,
  backtick, `;`, `|`, `&` and newlines), quotes and backslashes are stripped, and
  if ANY resulting word — reduced to its basename and seen through wrappers like
  `sudo`, `env`, `nohup`, `timeout` and `sh -c`/`bash -c` script bodies — is
  `systemctl`, `service`, `launchctl`, `sudo`, `kill`, `pkill`, `rm` or `dd`, the
  whole call is denied; so is any line containing `rm -rf /` or `rm -fr /`. None
  of it can ever be auto-approved, not even by a grant a human approved, and a
  plan declaring one is rejected at submission with a *can never be granted*
  error. Because no position in the command is safe, a granted prefix cannot
  carry a denylisted command written in any natural shell form: a `git push`
  grant covers `git push origin main` and nothing like `git push && systemctl
  restart dsh`, `git push && (systemctl restart dsh)`, `git push && $(systemctl
  restart dsh)`, `git push && FOO=1 systemctl restart dsh` or `git push &&
  \systemctl restart dsh`. Being word-based costs false positives on purpose —
  `grep -r rm -n .` and `git commit -m "rm old path"` ask the human too — because
  a prompt is cheap and a wrong auto-approval is not.
- **The denylist is a text rule, not a sandbox.** It narrows what a grant may
  *say*; it cannot control what a granted command *does*, and three routes stay
  open by construction: an **interpreter** (a plan granting a bare `node`,
  `python3`, `perl` or `bash script.sh` prefix hands the build whatever that
  interpreter runs), an **encoded payload** (`echo <base64> | base64 -d | sh`
  hides its words from any matcher), and **indirection** (a granted command that
  reads a script or config the build wrote inside the workspace). None of these
  is reachable by string matching, so they are the human's call at plan-review
  time: read an interpreter grant as a full-access grant, look at the script a
  grant will run, and prefer the narrowest prefix that actually works.
- **Everything else still asks.** The grant approver is an agent-scoped
  `approval/request` waterfall listener registered only on build sessions
  (plan and verify sessions stay read-only and receive none). It claims only
  asks whose reason starts with `escalate sandbox to `, and it fails open:
  a malformed call, a missing plan, a terminal ticket or any exception falls
  through to the human. Grants live in the plan artifact, so a new plan
  version supersedes them, and while a ticket is parked on *Plan ready* the
  grants are not yet live.
- **Every auto-approval is audited.** A covered escalation appends a
  `grant_applied` ticket event (`toolName`, `callId`, `grant`, `mode`,
  `target`) before answering `allowed-once`; the board's event feed shows
  each one. If the audit event cannot be written, the ask goes to the human
  instead of being answered silently.

The planner is coached to gather evidence for its grants: for every declared
path it runs the read-only `test -w <path>` and records `{path, check,
observed}` in `sandbox.checks`, so the human approves against what was
actually observed rather than an assumption (the KAN-17 `~/dsh-lab` and
KAN-29 `/tmp` classes of surprise). Platform temp areas are already writable
under `workspace-write` and need no grant.

## Release scope and deferred conditions (0.17.0)

A ticket's definition of done is written once, in the plan, and read the same way
by the build prompt, the review gate and the approval hand-over. Two additions to
the plan protocol make that possible without pretending an agent can do a human's
step.

`release_scope` says where the release stops:

- `stop_before_merge` — the build ends with the work on a branch. Merging,
  tagging and deploying are the human's, and the plan lists them as deferred
  conditions.
- `full_release` — the build lands the release itself.
- absent — the plan has no opinion, exactly like every plan written before 0.17.0.

A **deferred** condition is a real condition that only a human can evidence:

```json
"done_when": [
  { "id": "unit-tests", "statement": "the suites pass", "how_verified": "node --test exits 0" },
  {
    "id": "release-landed",
    "statement": "merged to main and tagged",
    "how_verified": "git ls-remote origin refs/tags/v1 prints a sha",
    "deferred": true,
    "human_evidence": "git ls-remote origin refs/tags/v1 prints a sha"
  }
]
```

- The review reports it `met: false` with evidence naming what the human checks.
  A pass whose only unmet conditions are deferred ones **is a pass**: the ticket
  goes straight to approval, the deferred ids ride in the `approval_requested`
  event and in the hand-over prompt, and the build spends no extra attempt. A
  `fail` verdict that marks every non-deferred condition met is routed the same
  way.
- Marking a condition deferred is not a way to dodge work an agent could verify.
  It needs `human_evidence`, it is listed to the human by name, and the board
  shows it as `(deferred to approval)`.

### What the review gate can and cannot blame on the build

`verifyReview` splits its findings in two:

- **substantive** — a non-deferred condition unmet, below the confidence
  threshold, or with no evidence. That is the build's problem and it goes back to
  implementation, costing a round, exactly as before.
- **cosmetic** — a missing, duplicated or invented `done_when` id, a malformed
  coverage row, an uncovered stored statement. That is a defect in the *review*,
  so the reviewer gets exactly one retry turn in its own session with the exact
  gap text, the plan's condition ids and the stored acceptance statements. If the
  second submission is still malformed the ticket parks in review with that text
  for a human. The review-retry budget is separate from the implement-attempt
  budget: a bookkeeping slip in a pass can never spend a build round again.

`acceptance_coverage` is judged against the **stored** acceptance statements only.
A row quoting a sentence from the ticket body is ignored rather than rejected —
the reviewer cannot cover an acceptance the human never wrote — while every
stored statement still has to be covered.

### Attempts, retries and no-progress

- The attempt park says what it now means:
  `attempt budget exhausted (N) — a human Retry with instruction grants a fresh
  budget`, and the retry really does that: both retry endpoints reset the counter
  and record a `budget_reset` event.
- Each rework round records the working tree it started from (`rework_signature`:
  the diff hash plus the condition ids the review left failing). A later rework
  round that starts from that same tree would repeat the previous one, so it parks
  with `no progress: the working tree is unchanged since the round that last
  failed <ids>` and the attempt is not spent.
- The ticket detail carries the configured `maxAttempts`, so the board shows the
  real cap instead of a hard-coded 3.

## Config

<!-- verify-allow: config-documented -->

Everything below lives on the `kanban` row.

| Key | Meaning |
|---|---|
| `dbPath` | SQLite file; default `$DSH_HOME/kanban/kanban.db`. |
| `defaultWorkspaceCwd` | cwd for a ticket with no workspace. |
| `providers[]` | `{name, tier: local\|paid, priceIn, priceOut, priceCacheRead, priceCacheWrite}`. |
| `roles{}` | `planner`, `implementer`, `reviewer`, `approver`; each has `provider`, `model`, `reasoningEffort`. A null route falls back to the host default model. `allowTools` is still accepted but deprecated and ignored (warned at boot): Kanban registers no tool guard. |
| `confidenceThreshold` | default `0.70`. |
| `allowTicketThresholdOverride` | whether a ticket may carry its own threshold. |
| `maxAttempts` | implement/review rounds before `needs_attention`. |
| `escalationLadder[]` | attempt-to-route overrides. |
| `tickIntervalMs` | worker tick (default 5000). |
| `stallTimeoutMs` | idle turn timeout (default 10 min); suspended while a native question waits. |
| `wipCap` | maximum workflow turns the engine drives concurrently (a pure throttle — queued Working tickets wait, nothing is rejected). |
| `defaultPlanTiming` | `now` or `at_pickup`. |
| `defaultPlanQuestions` | `interactive` or `autonomous`. |
| `defaultBudgetUsd`, `retentionDays`, `promptsDir` | budget, artifact retention, prompt directory. |

Prompts are markdown files under `prompts/`: `plan-human.md`, `plan-self.md`,
`implement.md`, `rework.md`, `review.md`, `approval.md`. Their hashes are recorded
on runs and spans.

A prompt says the job and nothing the session can already see. Plan and build
prompts open a fresh session, so they carry the full ticket, plan and conditions.
Review, rework and approval run inside the build session that wrote the code, so
they do not repaste the plan, the implementation JSON or the diff: the review
prompt names the condition ids it must be answered with and the exact shape of
`kanban_submit_review`, and the approval prompt is one line asking the agent to
offer the human their next steps.

Config reload is atomic through `configEditor`; an invalid reload keeps the
previous config.

## Roles

A role is a model route and a phase — not a tool list. Every role session gets
its preset's tools (standard for plan and verify, the ticket's choice for
build), and all six Kanban action tools are registered in
every workflow session, whichever purpose it belongs to. Each submitting tool
enforces its own phase and refuses a call that does not belong to it, so a
session that changes phase (implement → review) or is reattached after a restart
never finds the tool it needs missing. `kanban_plan` is read-only and gated by
nothing.

| Role | Purpose | Sandbox mode | Action tools that accept a call |
|---|---|---|---|
| `planner` | plan | read-only | `kanban_submit_plan` |
| `implementer` | build | workspace-write | `kanban_submit_implementation` |
| `reviewer` | build | workspace-write | `kanban_submit_review` |
| `approver` | build | workspace-write | `kanban_approve`, `kanban_discard`, `kanban_submit_plan` |
| any | plan or build | — | `kanban_plan` (read-only, every phase) |

A misdirected call is an ordinary tool error the model can read and correct, and
the engine re-validates the ticket's own phase before it records anything, so a
call made in the right session but the wrong ticket state still fails cleanly. A
`done_when` array whose ids are not the plan's is rejected the same way, at the
tool boundary, with the expected ids named in the error.

## Lifecycle

```text
phase:  plan → implement → review → approval → closed
column: backlog | working | done | discarded        (intended state, all grey)
status: idle | active | attention                  (computed per card, never stored)
```

- The engine drives every **Working** ticket as far as its phase allows, plus
  **Backlog** tickets whose Planning is `now` — those plan in place and stop at
  Build until a human drags them to Working.
- Plan runs immediately for `now`, or when the ticket enters Working for
  `at_pickup`.
- Review pass is checked against the plan/acceptance by code and then moves to
  `approval`, where the ticket parks with an attention card wherever it stands.
- Approval is the build session's third phase. The engine flips that session to
  the approver phase and route and sends it one slim hand-over prompt; the agent
  summarizes and asks. You can answer it there, or use **Approve and close** /
  **Discard** on the card. `kanban_submit_plan` there starts another
  implement/review round in the same column.
- Dragging a ticket between Backlog and Working is an unconditional human
  statement of intent: into Working starts (or resumes) the engine and lifts any
  park; back into Backlog stops it. There is no Blocked column and no automatic
  promotion.
- Historical tickets/sessions are discarded by the schema V3 reset. Schema V4
  renames the column set in place: `now` → `working`, and `needs_attention` /
  `blocked` → `backlog` (a parked ticket keeps its reason and still glows red).

## Model routing

The top-right **Model routing** dialog edits each role's base route through
`configEditor.edit`. The picker is one provider-grouped list sourced from the
host model catalog.

Next to each model picker is a **reasoning effort** picker. Its options are
**Default** plus the levels the selected model actually offers, read from the
same host catalog the global model settings use (`reasoning.efforts` on the
model's resolved info — for a hand-declared provider route that is its declared
`reasoningEfforts`). Labels come from the catalog too, so the dialog can never
offer a level the provider has not declared.

- **Default** stores `reasoningEffort: null`, which means "ask the model": the
  harness applies the model's own default, and an escalation rung or the
  deployment default model may still supply one. Choosing Default clears a
  level saved earlier instead of leaving it behind.
- A model with no reasoning metadata shows **no effort control at all** — there
  is nothing to pick. Switching a role to such a model, or to one that does not
  offer the level you had picked, resets that draft back to Default — and a row
  that *starts* edit carrying a level its model no longer offers (a hand-edited
  row, or a backend swap that dropped the model's reasoning metadata) drops it
  the same way, so one stale level cannot block the save of the other roles.
- Saving validates every non-null level against the live catalog and answers
  `bad_request` naming the role, the model and the levels it offers. A level
  that cannot be checked because the provider is unreachable is rejected rather
  than guessed at.
- At boot and on config reload a level the catalog no longer offers is a
  **warning**, not a failure: the request path already rejects it with
  `UNSUPPORTED_REASONING_EFFORT`, and a provider-config swap must not take the
  profile down.

The written row looks like any other role route:

```yaml
- id: kanban
  config:
    roles:
      implementer: { provider: local-ai-machine, model: big-moe, reasoningEffort: xhigh }
```

## Telemetry

Spans record role, provider/model, attempt, timing, status and prompt hash;
usage records tokens and cost. Timeline blocks are plugin/phase steps, with
expandable prompt/result/plan/review artifacts and lifecycle
events. JSONL/CSV exports and analytics remain available.

## Board and chat surface

A card is **blue and softly glowing** while its ticket has a turn in flight, and
**static red** when it needs attention — border, tint, left accent bar and a red
status dot, no pulsing. Attention is a state to read, not a light to chase. A
red card whose session is paused mid-turn on a person says so in its badge —
**Awaiting approval** for an unanswered approval prompt, **Waiting on you** for
an unanswered question — in any phase, not only in approval.

Clicking a card opens the ticket detail. Nothing in the board ever opens a
session by itself: watching the poll, or clicking through a ticket that is
planning, building or reviewing, never navigates you out of the board. The
explicit buttons still do — **Open build session** on the approval panel,
**Open session** in the detail hero while a mid-turn wait is pending (it lands
you on the prompt itself), **Open** in the sessions table, **Recover tools** on
an orphaned session.

A Backlog ticket usually plans when you drag it into Working. **Start planning**
is the exception you can make without moving it: a small button on the card, and
the same one beside the pencil in the detail hero, sets that ticket's planning to
*now* and lets the engine run the plan session right there in Backlog. When the
plan lands the ticket is still in Backlog, now at **Build** — planning and
building stay two separate decisions, and dragging it over is still what starts
the work. The button shows only where it would do something: a Backlog ticket
still at the plan phase, not already planning now, not mid-turn, and not waiting
on your answer. On a parked plan ticket it doubles as the retry — pressing it
again lifts the park and launches a fresh plan. Behind it is a `startPlanning`
action on the `action` endpoint; it writes `planTiming` and nothing else, and
refuses any other ticket with `bad_request`.

A ticket is edited through the one pencil in the detail hero, which opens a
single editor for the whole card: title, body, acceptance (one statement per
line — change a line to edit it, delete a line to remove it), planning,
questions, priority, allow-paid, budget and workspace, saved in one `update`
call. That pencil is locked the moment the ticket has started in any way: moved
off the plan phase or out of Backlog/Working, an attempt or any spend recorded,
parked for attention, or any session, run, span or condition attached to it. A
locked ticket answers `ticket_started` from `update`, `addAcceptance` and
`setAcceptance`; the engine's own writes (reorder, worktree creation, a retry
patch) go past the lock, because they go straight to the store. Editing a
pristine ticket never locks it — you can fix a card as often as you like before
something starts work on it. An acceptance change is recorded as an
`acceptance_set` event carrying both the prior and the new list, so the words a
human removed stay readable in the audit trail.

In a kanban session's chat, a turn that ended on a `kanban_*` call gets one line
at the turn tail, below the "Completed in …" disclosure, naming the transition
that turn caused: plan submitted, implementation submitted, review not finished
(with the reviewer's feedback), review passed, approved or discarded. Neither
source is enough on its own. The call alone cannot tell an accepted submission
from one a phase gate refused, so the ticket's real phase is checked through the
`sessionInfo` endpoint. The phase alone cannot tell a failed review from a later
passed one in the same session, and would print **Review passed** on the turn
that failed — so the verdict and feedback the call itself carried decide *which*
transition to look for, a pass is only claimed when the ticket's latest review is
the one that call submitted, and a pass is only called unfinished when the host
reports that the review was actually sent back (`reviewRejected`, derived from
artifact ordering) rather than that the ticket happens to sit in `implement`
again. When the two do not agree, nothing is rendered. Long values are truncated
to one line and the full text is in the hover tooltip.

## Ticket images

A ticket body can carry images. In both the New-ticket dialog and the ticket
editor, paste a screenshot into the body box, drop image files onto it, or use
**Add image**: each accepted file gets a thumbnail tile under the box and a
markdown reference inserted at the cursor. The X on a tile removes the tile and
its reference together. Limits: png, jpeg, webp or gif, 20 MB each, at most 10
images per ticket; a rejected paste or drop says why and leaves the text alone.

What is stored is a reference, not the bytes:

```markdown
![screenshot.png](kanban-image:sha256:4f3a…)
```

The bytes live in DSH core's content-addressed attachment store
(`$DSH_HOME/attachments/v1/objects/xx/<sha256>`), so they are validated,
deduplicated, and survive restarts. The body stays the single source of truth —
no extra table, no migration, and **no new config keys**. While you are typing,
the reference carries a temporary `pending-<token>` id; on save the Host stores
each image and rewrites every pending token to its real id before the body is
written. If any image fails to store, or a pending token has no upload behind
it, nothing is written: no ticket is created and no patch is applied.

The ticket detail's **Body** panel renders the body as light markdown —
headings, lists, code, links — and resolves each reference to a real `<img>`
through the `readImage` endpoint. A reference whose bytes no longer resolve
renders as an *image unavailable* chip rather than vanishing.

Role sessions see the images too: a plan session's ticket block ends with an
**Attached images** section listing each image's host file path, and the
session's `read_image` tool works on those paths. Editing a started ticket is
locked by the same rule as any other edit (`ticket_started`).

## Auto-recovery of a halted turn

A role turn can halt for reasons that have nothing to do with the work: the
output-token limit mid-answer, a backend that dropped, a restart that orphaned
the turn. Before 0.4.0 that parked the ticket, and the session sat asleep until
somebody opened it — at which point [dsh-continue-kicker]'s reopen door kicked it
awake *outside* the workflow, so the board said "needs attention" while the
session was actually still working.

Now the engine recovers it inside the workflow. When a plan, implement, review or
approval turn fails, kanban asks the `continueKicker` service that plugin
provides for one explicit kick (`kick(sessionId, { bypassCooldown: true })`),
waits for the
turn it starts, and takes the structured submission from that turn exactly as it
would from one it prompted itself. The ticket keeps its attention card off
(blue, active) throughout; nothing parks until recovery stops.

**The policy is not duplicated here.** What counts as a kickable halt, which
message is sent, and how many kicks in a row still count as recovery rather than
a loop (`maxConsecutiveKicks`) all live in continue-kicker; kanban pulls the
trigger and stops the moment it is declined. A kick that the runaway guard
refuses, a halt it will not kick (an explicit abort), or a turn that stalls after
the kick all park the ticket with the reason it would have had before —
`turn failed in implement: max-tokens` and friends. Each recovered turn is
recorded as a `<phase>-continuation` span with its own usage, so a recovery round
is visible and costed, and it does not consume an attempt.

**The integration is optional and detected, never required.** The service is
resolved lazily and duck-typed (`typeof ctx.get('continueKicker')?.kick ===
'function'`), the same way the worktree integration treats
`betterGitWorktree`. Without the plugin installed kanban logs one line at boot —
`dsh-continue-kicker not mounted; halted turns park to needs-attention without
auto-recovery` — and behaves exactly as in 0.3.x. `GET /api/kanban/capabilities`
reports `continueKicker: true|false` alongside `worktree`. A recovery kick shows
up on the ticket timeline as an `auto_recovered` event carrying the phase, the
halt flavor and the kick number.

## Worktrees

A ticket can ask to be worked in its own git working copy, and the ask is
**intent, not an action**: the new-ticket **Worktree** switch writes
`tickets.worktree` and creates nothing. The copy is settled when a plan session
actually starts, which is the moment the question "where should this work?" first
has an answer.

At plan start the driver asks `dsh-better-git-worktree` for the directory, in
three shapes:

- **The ticket already points at a checkout** (every ticket made before 0.14.0,
  and any workspace a human picked). If that path is a managed working copy it is
  fetched and fast-forwarded onto the latest default branch — but only when the
  copy is *pristine*: a clean tree including untracked paths, and no commit the
  commit it was cut from does not already have. A copy with work in it is left
  exactly as it is, and the plan prompt gains a line saying so, naming the path,
  the branch, why it was not moved and what it is based on. Nothing is ever
  deleted, reset or rebased.
- **The ticket only recorded the intent.** The copy is created now, from the
  just-fetched `origin/<default branch>` (not from wherever the source checkout
  happens to sit), registered as a workspace, and the ticket is re-pointed at it.
  A later phase, or a re-plan, takes the first branch above.
- **Neither.** The ordinary default workspace, exactly as before.

A `git fetch` that fails **fails the plan dispatch**: the ticket parks in
needs-attention carrying git's own words, because planning against a base nobody
could bring up to date is the one thing the switch was asked to prevent. With
`dsh-better-git-worktree` not mounted at all, the switch is hidden, the intent is
ignored with one log line, and planning behaves as it always did.

The `worktree` endpoint on the `action` route stays as the manual escape hatch
(create a copy for a ticket right now); the create form no longer calls it.

## Restart safety

Running spans are abandoned on restart; affected tickets park in place with a
needs-attention reason (their column is untouched), and their workflow sessions
are closed so continue-kicker does not resume a dead Kanban session.

[dsh-continue-kicker]: https://github.com/chrisjohnson/dsh-plugins/tree/main/packages/continue-kicker#provided-service-continuekicker
