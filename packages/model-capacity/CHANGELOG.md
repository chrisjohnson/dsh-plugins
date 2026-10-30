# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

## 0.3.0

### Added

- **Activity panel motion.** A finished call no longer blinks out: its card
  "poofs" in place (scale-up and fade, ~350 ms) as a temporary ghost clone, the
  promoted queue card slides down into Active with a fade, and the remaining
  queued cards slide up to close the gap (in-section FLIP). The working-state
  glow is a faster ~2 s breath — brighter ring plus a barely-there scale — and
  the panel now polls every 750 ms instead of 1500 ms so the animations land
  while you are still looking at the card that caused them. Everything new is
  disabled under `prefers-reduced-motion`, in CSS and in the ghost bookkeeping.

## 0.2.0

### Added

- **Adjust limits** dialog on the Activity page: edit each provider's
  `maxConcurrent`/`unlimited`, the default per-provider limit and the queue
  bound, then save. The dialog writes the complete `limits` section back to the
  profile's `model-capacity` row through `configEditor.edit`; the running
  manager is updated immediately and the existing config watcher sees the new
  row atomically.

## 0.1.0

### Added

- Host-wide per-provider capacity gate on `llm/stream`: interactive calls queue
  FIFO with no queue timeout; a slot is released when the stream ends, fails or
  aborts.
- Synchronous subagent preflight for `subagent`, `subagent_fork` and
  `spawn_teammate`, with a hard reservation consumed by the child's first main
  call and an error listing active/reserved/waiting counts plus free routes.
- `unlimited: true` provider limits that never queue and never reject a
  reservation, intended for a cloud proxy.
- `ctx.capacity` service exposing `snapshot()`, `isWaitingForSession()` and the
  cancel/force-release/dismiss operations.
- **Activity** page in the Context-tab visual language: live enforcing status,
  active/queued/reserved KPIs, colour-accented provider cards, capacity bars,
  clickable session cards that open the session, pulsing live cards, and
  subagent reservation cards.
- Live per-provider sidebar pills showing `active + queued / limit` demand,
  with green/yellow/red states and provider tooltips.
- Session-log wait-history cards under each turn, recorded client-side from
  `sessionWaits` and never added to model context.
- Composer dock showing this session's queue position and a cancel action.
- Strict config with boot-time provider validation, atomic reload, and a
  `/api/modelCapacity` inspection/control surface.
