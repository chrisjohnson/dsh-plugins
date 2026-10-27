# dsh-kanban

A ticket-centric workflow plugin for DeepSeek Harness. Tickets live in SQLite;
code drives them through one flat plan session, an implement/review session, and
a final mechanical verify session. Agents return structured data by calling
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
build-review session
  kanban_submit_implementation
  kanban_submit_review
  fail → implement again in the same session
      ↓ review pass
verify session
  kanban_submit_verification
      ↓
   done
```

Every session starts once in the **standard preset** and uses its natural system
prompt. The plugin does not rebind presets or install a custom system prompt.
The plan session is read-only and guarded against write/edit. Build-review keeps
both action tools available; a tool called in the wrong phase returns an error.
Write/edit are guarded off during review.

Ticket choices:

- **Planning:** `now` or `at_pickup`
- **Questions:** `interactive` (native `ask_user_question`) or `autonomous`
  (self-judgement prompt)

The plan session is one flat session: it asks questions, researches, and calls
`kanban_submit_plan` when confident. A valid plan ends that session. Implement
and review share one session; verify is a separate session after review passes.

## Config

<!-- verify-allow: config-documented -->

Everything below lives on the `kanban` row.

| Key | Meaning |
|---|---|
| `dbPath` | SQLite file; default `$DSH_HOME/kanban/kanban.db`. |
| `defaultWorkspaceCwd` | cwd for a ticket with no workspace. |
| `providers[]` | `{name, tier: local\|paid, priceIn, priceOut, priceCacheRead, priceCacheWrite}`. |
| `roles{}` | `planner`, `implementer`, `reviewer`, `verifier`; each has `provider`, `model`, `reasoningEffort`, `allowTools[]`. A null route falls back to the host default model. |
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
`implement.md`, `rework.md`, `review.md`, `verify.md`. Their hashes are recorded
on runs and spans.

Config reload is atomic through `configEditor`; an invalid reload keeps the
previous config.

## Roles

| Role | Tools |
|---|---|
| `planner` | read-only inspection + `ask_user_question`; plan action tool |
| `implementer` | read/write/edit/shell/jobs; implementation action tool |
| `reviewer` | read-only inspection; review action tool |
| `verifier` | read/bash; verification action tool |

The phase guard denies tools outside `allowTools`; Kanban action tools are
allowed through and enforce their own phase. Plan/review/verify have write/edit
guarded off. Verification is intentionally mechanical: it checks the
`done_when` conditions, not scope.

## Lifecycle

```text
phase: plan → implement → review → verify → closed
column: backlog | now | blocked | needs_attention | done | discarded
```

- Plan runs immediately for `now`, or when the ticket enters `now` for
  `at_pickup`.
- A plan completed while still in backlog leaves the ticket ready; the build
  session starts when it is promoted.
- Review pass creates a fresh verify session.
- Verify failure returns to a fresh build-review session.
- Historical tickets/sessions are discarded by the schema V3 reset.

## Model routing

The top-right **Model routing** dialog edits each role's base route through
`configEditor.edit`. The picker is one provider-grouped list sourced from the
host model catalog.

## Telemetry

Spans record role, provider/model, attempt, timing, status and prompt hash;
usage records tokens and cost. Timeline blocks are plugin/phase steps, with
expandable prompt/result/plan/review/verification artifacts and lifecycle
events. JSONL/CSV exports and analytics remain available.

## Restart safety

Running spans are abandoned on restart; affected tickets return to implement or
needs attention, and their workflow sessions are closed so continue-kicker does
not resume a dead Kanban session.
