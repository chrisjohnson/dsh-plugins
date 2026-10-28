# dsh-kanban

A ticket-centric workflow plugin for DeepSeek Harness. Tickets live in SQLite;
code drives them through one flat plan session, an implement/review session, a
code-gated review result, and a human approval stage. Agents return structured
data by calling tools, not by printing JSON.

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
build-review session
  kanban_submit_implementation
  kanban_submit_review
  fail → implement again in the same session
      ↓ review pass with one done_when row per plan id
      ↓ and acceptance_coverage for every acceptance statement
approval (Needs Attention)
  human approves, discards, or opens an interactive approval session
  approval session tools: kanban_approve, kanban_discard, kanban_submit_plan
      ↓ approve
   done
```

There is no verification session. The review is checked in code against the
original plan and acceptance: every planned done_when id must be present with
met/confidence/evidence, and every acceptance statement must be covered. A
missing or incomplete review goes back to implementation. Only when that code
gate passes does the ticket enter human approval.

Needs attention is a state, not a parking brake. The moment any session attached
to a needs-attention ticket starts a turn — you answering the engine's question,
driving the build by hand, or talking an approval through — the card moves back
to **In flight**, and the engine will not inject a role prompt into a session
that already has a turn running. When that turn ends without a structured
submission the card returns to Needs attention with the reason it had before; a
`kanban_submit_*` call from the same turn advances the ticket as usual.

Every session starts once in the **standard preset** and uses its natural system
prompt. The plugin does not rebind presets or install a custom system prompt.
Plan and review run in the native read-only sandbox mode; implementation and
the approval session run workspace-write. Workflow sessions attach to the
ticket's selected workspace and are titled `KAN-n · purpose`.

Ticket choices:

- **Planning:** `now` or `at_pickup`
- **Questions:** `interactive` (native `ask_user_question`) or `autonomous`
  (self-judgement prompt)

The plan session is one flat session: it asks questions, researches, and calls
`kanban_submit_plan` when confident. A valid plan ends that session. Implement
and review share one session; a complete review moves directly to human approval.

## Config

<!-- verify-allow: config-documented -->

Everything below lives on the `kanban` row.

| Key | Meaning |
|---|---|
| `dbPath` | SQLite file; default `$DSH_HOME/kanban/kanban.db`. |
| `defaultWorkspaceCwd` | cwd for a ticket with no workspace. |
| `providers[]` | `{name, tier: local\|paid, priceIn, priceOut, priceCacheRead, priceCacheWrite}`. |
| `roles{}` | `planner`, `implementer`, `reviewer`, `approver`; each has `provider`, `model`, `reasoningEffort`, `allowTools[]`. A null route falls back to the host default model. |
| `confidenceThreshold` | default `0.70`. |
| `allowTicketThresholdOverride` | whether a ticket may carry its own threshold. |
| `maxAttempts` | implement/review rounds before `needs_attention`. |
| `escalationLadder[]` | attempt-to-route overrides. |
| `tickIntervalMs` | worker tick (default 5000). |
| `stallTimeoutMs` | idle turn timeout (default 10 min); suspended while a native question waits. |
| `wipCap` | tickets allowed in `now`. |
| `autoPromote`, `autoPromotePerTick` | backlog promotion. |
| `defaultPlanTiming` | `now` or `at_pickup`. |
| `defaultPlanQuestions` | `interactive` or `autonomous`. |
| `defaultBudgetUsd`, `retentionDays`, `promptsDir` | budget, artifact retention, prompt directory. |

Prompts are markdown files under `prompts/`: `plan-human.md`, `plan-self.md`,
`implement.md`, `rework.md`, `review.md`. Their hashes are recorded
on runs and spans.

Config reload is atomic through `configEditor`; an invalid reload keeps the
previous config.

## Roles

| Role | Tools |
|---|---|
| `planner` | read-only inspection + `ask_user_question`; plan action tool |
| `implementer` | read/write/edit/shell/jobs; implementation action tool |
| `reviewer` | read-only inspection; review action tool |
| `approver` | workspace-write approval session; approve/discard/plan tools |

The phase guard denies tools outside `allowTools`; Kanban action tools are
allowed through and enforce their own phase. Plan and review have write/edit
denied by the native read-only mode and the role allow-list.

## Lifecycle

```text
phase: plan → implement → review → approval → closed
column: backlog | now | blocked | needs_attention | done | discarded
```

- Plan runs immediately for `now`, or when the ticket enters `now` for
  `at_pickup`.
- Review pass is checked against the plan/acceptance by code and then moves to
  `approval`, where the ticket is `needs_attention`.
- Approval offers approve, discard, or an interactive workspace-write session.
  The approval session can merge/deploy/iterate; its `kanban_submit_plan` starts
  another implement/review round.
- Historical tickets/sessions are discarded by the schema V3 reset.

## Model routing

The top-right **Model routing** dialog edits each role's base route through
`configEditor.edit`. The picker is one provider-grouped list sourced from the
host model catalog.

## Telemetry

Spans record role, provider/model, attempt, timing, status and prompt hash;
usage records tokens and cost. Timeline blocks are plugin/phase steps, with
expandable prompt/result/plan/review artifacts and lifecycle
events. JSONL/CSV exports and analytics remain available.

## Restart safety

Running spans are abandoned on restart; affected tickets return to implement or
needs attention, and their workflow sessions are closed so continue-kicker does
not resume a dead Kanban session.
