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
      ↓ and acceptance_coverage for every acceptance statement
  approval — the same session, flipped to the approver phase (attention card)
  the agent hands the work over and asks; kanban_approve, kanban_discard,
  kanban_submit_plan
      ↓ approve
   done
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

Needs attention is a state, not a parking brake or a column. The moment any
session attached to a parked ticket starts a turn — you answering the engine's
question, driving the build by hand, or talking an approval through — the park
lifts in place and the card turns blue, and the engine will not inject a role
prompt into a session that already has a turn running. When that turn ends
without a structured submission the card returns to red with the reason it had
before; a `kanban_submit_*` call from the same turn advances the ticket as
usual.

Every session starts once in the **standard preset** and uses its natural system
prompt, so a workflow session has every tool a normal session has. The plugin
does not rebind presets, install a custom system prompt, or register a tool
guard. The sandbox mode follows the session's **purpose**: plan is read-only and
build is workspace-write through all three of its phases — implement, review and
approval — and a phase change inside one session never moves it. Workflow
sessions attach to the ticket's selected workspace and are titled
`KAN-n · purpose`.

Ticket choices:

- **Planning:** `now` or `at_pickup`
- **Questions:** `interactive` (native `ask_user_question`) or `autonomous`
  (self-judgement prompt)

The plan session is one flat session: it asks questions, researches, and calls
`kanban_submit_plan` when confident. A valid plan ends that session. Implement,
review and approval share one session; a complete review flips that same session
to the approver phase and asks the human what to do with the work.

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

Config reload is atomic through `configEditor`; an invalid reload keeps the
previous config.

## Roles

A role is a model route and a phase — not a tool list. Every role session gets
the standard preset's tools, and all five Kanban action tools are registered in
every workflow session, whichever purpose it belongs to. Each action tool
enforces its own phase and refuses a call that does not belong to it, so a
session that changes phase (implement → review) or is reattached after a restart
never finds the tool it needs missing.

| Role | Purpose | Sandbox mode | Action tools that accept a call |
|---|---|---|---|
| `planner` | plan | read-only | `kanban_submit_plan` |
| `implementer` | build | workspace-write | `kanban_submit_implementation` |
| `reviewer` | build | workspace-write | `kanban_submit_review` |
| `approver` | build | workspace-write | `kanban_approve`, `kanban_discard`, `kanban_submit_plan` |

A misdirected call is an ordinary tool error the model can read and correct, and
the engine re-validates the ticket's own phase before it records anything, so a
call made in the right session but the wrong ticket state still fails cleanly.

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
  offer the level you had picked, resets that draft back to Default.
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

## Restart safety

Running spans are abandoned on restart; affected tickets park in place with a
needs-attention reason (their column is untouched), and their workflow sessions
are closed so continue-kicker does not resume a dead Kanban session.

[dsh-continue-kicker]: https://github.com/chrisjohnson/dsh-plugins/tree/main/packages/continue-kicker#provided-service-continuekicker
