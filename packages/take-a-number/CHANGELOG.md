# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-15

### Added

- First release.
- `llm/stream` gate: mapped provider routes take a number in the machine's
  take-a-number queue (strict FIFO per GPU); unmapped providers pass through.
- Per-process identity leases (`dsh/web#<pid>@<host>`, `lab-<name>` for labs);
  a crashed dsh frees its leases on connection close.
- Acquire metadata: `kind`, composed `description`, `session`, `sessionTitle`,
  `turn` — surfaced in the daemon dashboard and audit trail.
- Composer dock: per-session queued-call banner with position and cancel.
- Box-wide Activity panel: per-queue capacity bars, 60 s busy graphs, active
  leases and FIFO waiters, cancel / force-release, fed by the daemon's live
  stream (poll fallback).
- Fail-open: daemon unreachable → pass-through after ~300 ms, logged.
- Coexistence guard: with `dsh-model-capacity` also mounted, gating is refused
  (logged) to avoid double-queueing.
