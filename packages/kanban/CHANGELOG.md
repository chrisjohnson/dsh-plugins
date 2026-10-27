# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

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
