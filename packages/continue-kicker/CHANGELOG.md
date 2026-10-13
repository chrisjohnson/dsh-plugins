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
- Genuine-user detection read the wrong field (`data.message.source`; a V4 `user/message` event's data is the message itself, so the source is `data.source`). Whenever a user-role message was the tail event, including the plugin's own kick, it counted as genuine and reset the runaway counter. On the live path the tail after a re-halt is `turn/end`, so counting worked there; the guard was defeated on the `agent/created` / reopen path and whenever the kick was still the tail. Only a message with source kind `user` resets it now.
- Kick summaries are bounded to 120 characters like other notice summaries.
- Tool-call detection matched the V3 block type `tool_call`; V4 spells it `tool-call`, so a reasoning-plus-tool-call turn looked empty.

### Changed

- The `agent/disposed` listener is registered once rather than once per created agent.
- Default `maxConsecutiveKicks` is 5, as in the in-tree plugin's code; a deployment that wants 3 sets it on its row.
- `maxConsecutiveKicks: 0` now means "never kick" and skips quietly. The in-tree plugin still gave a fresh session one kick at 0 (`undefined >= 0` is false) and then logged the runaway error. Use the `kickOn*` flags for finer-grained control.
- Requires dsh 0.2.0-rc.2 or later.
