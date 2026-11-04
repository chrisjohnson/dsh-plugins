# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

## 0.6.0

### Changed

- **Throughput is now a graph per provider, not a row of cards at the top.** The four
  all-providers rate cards (concurrent output now, 1 minute, 5 minute and 1 hour
  averages) are gone. Each provider card draws its own output-token graph across the
  trailing 60 seconds — one point per second, full card width, the same SVG-polyline
  technique the old sparkline used — between the provider's status line and its
  capacity bar, with a simple relative time axis (`-60s`, `-45s`, `-30s`, `-15s`,
  `now`) and no y scale or value labels. The status line keeps the figures the graph
  shapes: `N concurrent model calls · X tok/s now · Y avg 1m`. The Active leases and
  Queued calls cards, the per-call live rate and the capacity bars are unchanged.
- The snapshot ships that series as `providers[].rates.history60`: 60 one-second
  buckets, oldest first, read out of the ring the meters already keep, so nothing is
  buffered a second time. A second with no output is 0, the series never reaches
  before the meter started (a provider that began five seconds ago draws five seconds
  of line growing in from the right edge rather than an invented flat minute), and a
  provider that has never streamed keeps `rates: null` and draws a flat baseline. The
  all-providers `rates` summary is untouched.

## 0.5.0

### Added

- **Realtime throughput on the Activity page.** Concurrent output tokens per second
  across every model call in the DSH instance: a live figure (trailing 3 s, with a
  sparkline) and 1 minute, 5 minute and 1 hour averages, plus a now and 1-minute
  figure on each provider card and a live rate on each active call card. Counted
  from the streamed chunks (estimated while streaming, corrected to the provider's
  own output-token count when its usage chunk arrives) into a fixed ring of
  one-second buckets: constant work per chunk, bounded memory. Prompt-processing
  rates are not included.
- A `stream` route under `/api/modelCapacity/` that pushes snapshots to the browser
  as newline-delimited JSON, and `rates` and `waitSeq` in the snapshot.

### Changed

- The sidebar pills, composer dock, Activity page and per-turn wait cards share one
  long-lived stream, opened only while something is shown and the tab is visible.
  Capacity events (promotion, hand-over, cancel) reach the page within about 150 ms.
  A hidden tab makes no requests. If the stream cannot be held the page polls
  `snapshot` every 2 s and retries the stream with back-off.
- The per-turn wait cards share one `sessionWaits` request per session and refetch
  only when a new wait has been recorded.
- On the Host, session titles and workspaces are refreshed on demand (at most every
  10 s, only while a snapshot is being read), and an unchanged idle snapshot is not
  re-sent.
- Fixed React "unique key" warnings from the status pill and section headers.

## 0.4.0

### Removed

- **The subagent preflight.** `subagent`, `subagent_fork` and `spawn_teammate` no
  longer take a slot reservation or fail at dispatch with a capacity error. Gone
  with it: the tool guard and its route inference, the reservation lifecycle in
  the semaphore (reserve / bind / consume / cancel / expire) and its TTL timer,
  the **Reservations** KPI and reservation cards in the Activity panel, the
  `dismissReservation` endpoint, and the `reservationTtlMs` and `subagentTools`
  config keys.

### Changed

- A subagent child's model calls queue FIFO behind everything else waiting for
  their provider, exactly like an interactive call. Nothing holds a capacity slot
  unless a stream is live on it, so a dispatch can no longer fail for capacity and
  a child that never starts costs nothing.
- A deployment that still sets `reservationTtlMs` or `subagentTools` boots with
  one `unknown config key "…" (ignored)` warning per key instead of refusing the
  config.

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
