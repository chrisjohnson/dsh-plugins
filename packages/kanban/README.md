# dsh-kanban

**A ticket-centric work organizer and workflow engine for DeepSeek Harness.**

Tickets are rows in a local SQLite board. Code — not an agent — drives each
ticket through intake, grill, plan, implement, verify and review. Every phase is
a **turn in the ticket's one shared workflow session**; the phase changes the
tool allow-list and, when configured, the model route for the next turn. The
engine gates dispatch on real per-provider concurrency, checks machine-readable
`done_when` conditions mechanically, and records every span's time and tokens.

## Install

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-kanban-v<version>&path:/packages/kanban"
```

Or add the same git spec to the profile's `package.json`, then list `dsh-kanban`
in `dsh.profile.bundles`.

The bundle mounts one row, `id: kanban`. Its own patch carries **no config**: a
patch layer replaces a row's whole `config` object instead of deep-merging, so
the deployment writes the complete section in its own profile patch.

## Where it appears

`sidebar.panellist` gains a **Kanban** button (id `kanban`), and the `main` slot
gains a `kanban` panel designed in the same visual language as the Activity
dashboard: a Work header, backlog/in-flight/blocked/attention/done KPIs, a
colour-accented five-column board, lifecycle progress on every card, a hero
ticket detail with a workflow timeline and metric cards, and clickable
shared-session links. The New ticket form asks for the target workspace and initial status
(Backlog, Now, or Blocked). Both are additive seats in lists the shell already
renders; the sidebar and workspaces list are untouched. A right-sidebar tab is
the alternative placement; see `DECISIONS.md`.

## Config

Everything below lives on the `kanban` row. The database stores state only.
Defaults are in `src/config.mjs`; unknown keys warn once, wrong types and
impossible values refuse to start.

| Key | Meaning |
|---|---|
| `dbPath` | SQLite file; default `$DSH_HOME/kanban/kanban.db`. |
| `defaultWorkspaceCwd` | cwd for a ticket with no `workspace_cwd`. |
| `providers[]` | `{name, tier: local\|paid, priceIn, priceOut, priceCacheRead, priceCacheWrite}`. Prices are USD per million tokens; an unlisted provider is priced `unpriced`. This config has no concurrency slots. |
| `roles{}` | per role: `preset`, `provider`, `model`, `reasoningEffort`, `prompt` (file name), `allowTools[]`. A `null` provider/model falls back to the host's default model selection. |
| `confidenceThreshold` | default `0.70`; a condition below it is not proven. |
| `allowTicketThresholdOverride` | whether a ticket may carry its own threshold. |
| `maxAttempts` | implement → verify → review cycles before `needs_attention` (default 3). |
| `escalationLadder[]` | `{rung, provider?, model?, reasoningEffort?, paid?}`. Attempts 1–2 use rung 0, attempt 3 uses rung 1, and so on. |
| `tickIntervalMs` | worker tick (default 5000). |
| `stallTimeoutMs` | a turn with no event for this long is abandoned (default 10 min). |
| `wipCap` | tickets allowed to hold `now` at once; enforced on drag and auto-promote. |
| `autoPromote`, `autoPromotePerTick` | promote backlog tickets when the WIP cap allows. |
| `defaultBudgetUsd`, `retentionDays`, `promptsDir`, `allowAgentModelSwitch`, `reuseSessionOnRetry`, `maxContinuations`, `maxAdjudications`, `defaultGrillMode`, `defaultPlanMode`, `promptOverrides` | see `src/config.mjs`. |

Every role prompt is a markdown file under `prompts/` (or `promptsDir`), or an
entry in `promptOverrides`. Its SHA-256 is recorded on every run and span.

**Reload:** the plugin watches the profile's live config through the host
`configEditor` service, debounces, re-validates and swaps atomically. A run that
already started keeps its config snapshot (the engine carries it in an
`AsyncLocalStorage`); an invalid reload keeps the previous config and logs the
error. Nothing is written back to YAML or to SQLite.

## Roles and their controls

| Role | May | Enforcement |
|---|---|---|
| `implementer` | read/write/edit/shell/git in the ticket cwd | role preset + execution guard; no board tool exists |
| `planner` | read repo/ticket; emits the plan as its final JSON | role preset + execution guard; the engine writes the plan artifact |
| `verifier` | read, run the checks named by `how_verified` | role preset + execution guard; write/edit denied |
| `reviewer` | read diff and verification output | role preset + execution guard; read-only |
| `griller` | read ticket/acceptance, ask the human through the board | read-only |
| `orchestrator` | read ticket/plan/diff, answer one JSON question | not a session: one `ctx.llm.stream()` call |

There is no tool that can move a ticket, change a budget, attach a session or
spawn work. The guard denies any tool name outside `allowTools` even if a preset
mounts it. Prompts are not controls; the allow-list is.

## Tool visibility across phases

Each role has its own preset. Changing phase rebinds that preset on the one
shared session (`agentPresets.recompose`), so the model-facing tool schemas
actually change: the implementer gets jobs/bash/fs, the verifier loses jobs, and
the reviewer loses bash. A global-tool mask removes tools such as browser,
image-search and model-switch controls that are outside the role. The phase guard
still denies anything outside `allowTools` at execution time.

Two upstream limits are visible and intentional: `dsh-tool-fs` ships
read/write/edit as one plugin, so read-only phases still see the write/edit
schemas (the guard denies them); and session-scoped schedule tools are visible in
every phase but denied outside the role allow-list.

## Lifecycle

`column ∈ backlog | now | blocked | needs_attention | done | discarded`
`phase ∈ intake | triage | grill | plan | implement | verify | review | closed`

Grill always precedes plan, and plan always precedes implement. `at_pickup` grill
with `at_pickup` plan is valid; `at_pickup` grill with `now` plan is rejected by
the store (server-side), not merely disabled in the UI. `blocked` is waiting on
something external; `needs_attention` means the engine ran out of options.

Pickup is a drag into **Now**, or `auto_promote` when a slot is free. A `now`
grill or plan blocks pickup until complete: the card shows **Waiting on you**.

## Two kinds of done

- **acceptance** — the human's words, stored byte-for-byte, never rewritten.
- **done_when** — the plan's decomposition into individually checkable
  conditions. Verification judges only these. A coverage judgement at plan time
  asks whether meeting all of them plausibly satisfies the acceptance; failure
  revises the plan, it does not retry implementation.

A `one_shot` ticket has no plan, so triage converts its acceptance into
checkable conditions first (source `triage`). If it cannot, the ticket is forced
onto a plan.

## Result protocol

Every implementer turn must end with one JSON object (bare or fenced):

```json
{"status":"complete|partial|blocked","summary":"...","changed_files":["..."],
 "done_when":[{"id":"...","met":true,"confidence":0.0,"evidence":"file:line | test | output"}],
 "questions":["..."],"residual_risks":["..."]}
```

The gate runs mechanically first: parseable JSON → schema → exact id match →
non-empty specific evidence for every `met` claim → confidence ≥ threshold.
Failure goes to one out-of-band adjudication, then (if it cannot resolve) to a
bounded continuation citing only the gaps. No JSON gets one continuation; two
continuations per attempt at most.

Verification is a **read-only verifier turn** in the shared session that judges
each condition independently, then a **read-only reviewer turn** that reads the
diff, verification and acceptance coverage. A failed verify or review starts a
new attempt; `reuseSessionOnRetry` keeps the live shared session, while the
default starts a fresh one after a failed attempt.

## Telemetry

The workflow timeline deliberately shows **plugin-owned steps**, not the
session's individual turns or tools: one block per phase/attempt (grilling
includes the human answer gap), one block per orchestrator judge call, and one
block per plugin command (currently `git diff`). Clicking a block expands its
metadata; phase blocks show their prompt/result/plan/verification/review
artifacts plus the lifecycle events in that phase window, judge blocks show the
stored result (and, for new runs, the question), and `git diff` now stores its
output as a plugin artifact. Tools remain in the span tree and event log for
diagnostics, but not in the timeline.

Every span records kind (`trigger|workflow|agent|judge|tool|wait`), parent/child
links, role, provider/model, attempt, timing, status and prompt hash. Usage rows
carry input/output/cache-read/cache-write tokens and cost; an unpriceable route
records `cost_usd = NULL` and the UI prints `unpriced`, never `$0.00`.

Exports: JSONL and CSV per ticket or for the whole board. Analytics queries:
attempts-to-done, per-model success rate, confidence calibration, time-in-phase,
cost per ticket, stall rate by role.

## Restart safety

Boot recovery marks every `running` span abandoned and returns affected tickets
to `implement` or `needs_attention`. The SQLite store uses WAL, `busy_timeout`,
and `BEGIN IMMEDIATE` for every mutation, with a row `version` and a post-commit
event. Kanban does not own model-call concurrency; that is entirely outside
this plugin.

## What this plugin is not

- It does not manage worktrees. `workspace_cwd` is the seam; it defaults to
  `defaultWorkspaceCwd` and can be set per ticket.
- It does not use the `switch_model` tool. Sessions get their route at creation
  via `ctx.agents.create({agentOptions})`.
- It holds no credentials, base URLs or provider HTTP code. Every model call,
  including every judgement, goes through `ctx.llm.stream()`.
- It does not replace or integrate with `@shengsheng/dsh-taskboard`; that package
  is removed. The engine owns the board outright.

## Checks

```sh
node --test test/*.test.mjs        # 57 tests: pure modules + engine pipeline with fakes
node scripts/verify.mjs            # repository release contract
```

Interactive model concurrency is outside this plugin. This
package dispatches role turns and lets every model call queue there; `wipCap`
still bounds how many tickets are in `Now`. See `DECISIONS.md` for the
measurement and for resolved design choices.
