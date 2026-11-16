# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-11-16

### Added

- `clientToken` config (or `TAN_CLIENT_TOKEN` env): a per-instance token stamped
  on every reservation so the take-a-number **admission proxy** can claim this
  instance's held lease for its matching HTTP request — the compliant path, where
  dsh idles in its own queue and forwards without double-queueing. Must match the
  static `x-tan-client` header in this instance's litellm provider config. Empty
  (default) leaves the previous hard-queue-only behavior.

### Changed

- Depend on `take-a-number` v0.3.0 (adds the daemon `checkout` op and
  `TanClient.checkout()`).

## [0.1.2] - 2026-11-15

### Changed

- Depend on `take-a-number` v0.1.4: the panel's status-stream subscription is
  now anonymous (no `register` on the dedicated socket), so the panel's
  periodic re-subscription no longer churns daemon identities or audit lines.
  No plugin code change.

## [0.1.1] - 2026-11-15

### Changed

- Depend on `take-a-number` v0.1.2: the client now falls back to the TCP
  endpoint when it cannot write the daemon's UDS (EACCES), and the daemon
  creates its socket world-connectable. No plugin code change.

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
