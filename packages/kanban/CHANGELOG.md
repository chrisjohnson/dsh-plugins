# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

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
  lifecycle progress on cards, working-card glow, hero detail with phase
  timeline and metric cards, and clickable session links.
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
