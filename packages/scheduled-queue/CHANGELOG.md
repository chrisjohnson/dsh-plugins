# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

## Unreleased

## 0.1.0 - 2026-10-13

First public release, extracted from a running dsh deployment where it was
disabled because of the defect fixed below.

### Fixed

- **The dock listed scheduled messages from every session.** A message scheduled
  in session A showed up in session B's window, where it could be edited, removed
  or sent. The dock now shows only the session it is mounted in (the slots hand
  each entry its `sessionId`), and the host returns only the asking session's
  items from every endpoint. `list` without a session id is refused instead of
  answering with the whole queue; `remove`, `edit` and `sendNow` refuse an item
  that belongs to another session.
- **Delivery goes through `sessionController.prompt`.** Items are sent the way the
  composer's Send button sends them: a live session takes a follow-up (or steering,
  for a force-steer item) and a stopped session is resumed first. The in-tree copy
  delivered a normal item with `agent.inbox.append('next-turn', ...)`, which queues
  the message but does not wake an idle agent, and did nothing for a session with
  no live agent. Its header comment described `followup()` and a
  `sessionController.prompt` fallback that the code did not contain.

### Changed

- Requires dsh 0.2.0-rc.2 or later (`engines.dsh`); uses the 0.2.0 session-scoped
  `conversation.input.right` and `conversation.input.dock` slots.
- Installed from a git tag (`dsh-scheduled-queue-v<version>`), not the npm registry.
- A delivery that fails is retried with a back-off (5 s doubling to 5 min) instead
  of every scan, and is given up on (and retried under the same request id) if it gets no answer
  within `deliveryTimeoutMs`.
  An item whose session is still not found after a second try two seconds later,
  or that the harness rejects as a bad request, is dropped with a warning that
  includes its text. Due items are delivered oldest-due first.
- `remove`, `edit` and `sendNow` require a `sessionId` (as `list` does) and answer
  `being-sent` for an item whose delivery is in flight. An edit cannot leave the
  text empty.
- A queue file that is not a JSON array is set aside instead of overwritten; one
  that exists but cannot be read is never written over, and is re-read each scan.
- The browser's time zone is stored on new items and sent as `clientTimeZone`. The
  field is optional, so older queue files read unchanged.
- The dock reports a failed send-now (retry, or dropped), a rejected edit, and an
  unreadable queue file instead of ignoring them, even when no rows are left.
- A delivery re-reads the current queue entry, so an item removed, edited or sent
  while an earlier delivery was in flight is not sent stale and an edit is kept.
- Only `UTC` and `Area/Location` time zones are stored; a zone the harness refuses
  is retried once without it.
- A disposed plugin stops scanning, aborts in-flight calls, and writes nothing.
- While the queue file is unreadable, scheduling returns a warning, and recovery
  does not bring back items delivered or removed in the meantime.
- The queue file is written to a temporary file and renamed into place, and
  requests wait until the file has been read, so an early request cannot replace
  it with an empty queue.
- Dropped the unused second transport (a private `/scheduledQueue` rpc channel);
  the browser half only ever used the `/api` routes.

### Added

- `scanIntervalMs` (default 5000) and `deliveryTimeoutMs` (default 60000) config keys.
- Pure decision modules `src/queue.mjs` and `src/config.mjs` with tests, and a
  host-wiring test against a stand-in harness.

### Unchanged

- The queue file location and item format (`<dsh home>/storages/scheduled-queue.json`,
  a JSON array of `{ id, messageId, sessionId, text, minutes, forceSteer, dueAt,
  createdAt }`), so items already queued survive. `timeZone` is an optional addition.
