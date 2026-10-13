# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

## Unreleased

## 0.1.0

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
  for a force-steer item) and a stopped session is resumed first. Previously a
  normal item was only appended to the inbox, which parks the message without
  waking an idle session.

### Changed

- Requires dsh 0.2.0-rc.2 or later (`engines.dsh`); uses the 0.2.0 session-scoped
  `conversation.input.right` and `conversation.input.dock` slots.
- Installed from a git tag (`dsh-scheduled-queue-v<version>`), not the npm registry.
- A delivery that fails is retried with a back-off (5 s doubling to 5 min) instead
  of every scan; an item whose session no longer exists is dropped with a warning.
  A queue file that is not a JSON array is set aside instead of overwritten.
- The queue file is written to a temporary file and renamed into place, and
  requests wait until the file has been read, so an early request cannot replace
  it with an empty queue.
- Dropped the unused second transport (a private `/scheduledQueue` rpc channel);
  the browser half only ever used the `/api` routes.

### Added

- `scanIntervalMs` config key (default 5000).
- Pure decision modules `src/queue.mjs` and `src/config.mjs` with tests, and a
  host-wiring test against a stand-in harness.

### Unchanged

- The queue file location and item format (`<dsh home>/storages/scheduled-queue.json`,
  a JSON array of `{ id, messageId, sessionId, text, minutes, forceSteer, dueAt,
  createdAt }`), so items already queued survive.
