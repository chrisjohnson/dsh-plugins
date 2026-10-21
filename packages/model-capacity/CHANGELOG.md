# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

## 0.1.0

### Added

- Host-wide per-provider capacity gate on `llm/stream`: interactive calls queue
  FIFO with no plugin timeout; a slot is released when the stream ends, fails or
  aborts.
- Synchronous subagent preflight for `subagent`, `subagent_fork` and
  `spawn_teammate`, with a hard reservation consumed by the child's first main
  call and an error listing active/reserved/waiting counts plus free routes.
- `ctx.capacity` service and a Capacity panel: active leases, FIFO waiters,
  reservations, cancel-turn, dismiss-reservation and force-release controls.
- Per-session composer dock that shows when this session's model call is queued.
- Strict config with boot-time provider validation and atomic reload.
