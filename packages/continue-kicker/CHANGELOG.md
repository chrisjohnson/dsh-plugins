# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

## Unreleased

## 0.1.0

First public release, extracted from a running dsh deployment's in-tree plugin and ported to dsh 0.2.0-rc.2 (session format V4).

### Added

- Resumes a session whose last turn ended `max-tokens`, `interrupted`, or as a reasoning-only empty `completed` turn, with a per-session runaway guard.
- Pure decision module `src/decide.mjs` and configuration resolution `src/config.mjs`, with unit tests.
- New config keys for what was hard-coded: `emptyCompletionMinReasoningChars`, `interruptedKickText`, `maxTokensKickText`, `emptyCompletionKickText`.

### Fixed

- The kick message is written with source kind `plugin:continue-kicker` instead of the bare `plugin`, which session format V4 refuses on read (a session carrying it could not be reopened after a restart).
- Genuine-user detection read the wrong field (`data.message.source`; a V4 `user/message` event's data is the message itself, so the source is `data.source`). Every user message, including the plugin's own kicks, counted as genuine and reset the runaway counter, so `maxConsecutiveKicks` never tripped. Only a message with source kind `user` resets it now.
- Tool-call detection matched the V3 block type `tool_call`; V4 spells it `tool-call`, so a reasoning-plus-tool-call turn looked empty.

### Changed

- The `agent/disposed` listener is registered once rather than once per created agent.
- Default `maxConsecutiveKicks` is 5, as in the in-tree plugin's code; a deployment that wants 3 sets it on its row.
- Requires dsh 0.2.0-rc.2 or later.
