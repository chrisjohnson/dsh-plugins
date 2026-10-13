# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

## Unreleased

## 0.1.0

First release: the in-tree `semantic-loop-kicker` watchdog and the `semantic-loop-evals` panel of a private deployment, combined into one installable package for dsh 0.2.0-rc.2 or later.

### Added

- Configuration for everything that was hardcoded: the model endpoint (`llmBaseUrl`), model (`llmModel`), the **name** of the API-key environment variable (`llmApiKeyEnv`), extra request-body fields (`llmExtraBody`), completion budget (`llmMaxTokens`), the ledger path (`ledgerFile`), the mode-file path (`modeFile`) and the log-file path (`logFilePath`). Paths default under `$DSH_HOME/storages/loop-watchdog/`. See the README for each key and what unset means.
- With no model configured the repetition check still runs; ambiguous windows are ledgered once per stretch as `skip: "no-llm"` instead of failing.
- Boot-time warnings for misspelled or wrongly typed keys, a half-set model block, and an empty API-key variable.
- Tests for the decision modules against V4 event shapes, the ledger reader (both schemas), configuration, the client's registration contract, and the host wired to a fake context.

### Changed

- **Session format V4.** The steering note's source kind is `plugin:loop-watchdog` (was the bare `plugin`, which V4 refuses on read, so a session carrying it could not be reopened after a restart), with a `notice` summary bounded to the harness's 120 characters, and no retired `plugin` field.
- **V4 tool results.** Results are read from the first-class tool-role message (`data.message.toolCallId`, text from `content` blocks). The pre-V4 reader looked for a nested `content[0].toolCallId` that no longer exists, so every result read as empty and repeated calls would have flooded false `LOOP` verdicts. Transcript lines for tool results now show their real text instead of `[non-text event]`, and `user/message` events (whose `data` is the message in V4) are read correctly.
- The evals panel is an optional integration: it requires the `betterSidebar` service and stays inactive without `dsh-better-sidebar`. It reads the ledger through a plugin-owned route (`/loopWatchdog/...`) instead of the connection RPC `/api` fence, and its tab id is `loop-watchdog:evals` (was `semantic-loop-kicker:evals`).
- One package, one row (`loop-watchdog`), instead of two rows; the evals read endpoints live on the watchdog's own host half, so both always agree on the ledger path.
- Installed from a git tag (`dsh-loop-watchdog-v<version>`), not the npm registry — see the README's Install section.

### Fixed

- A `PROGRESS` verdict with high confidence no longer lands in the `stuck` band or extends the stuck streak. Confidence is confidence in the verdict, so previously "PROGRESS:95" followed by one "LOOP:95" counted as a sustained streak and could steer after a single LOOP.
- An empty tool result now counts as substantive activity (it is itself the signal), and a corrupt ledger line that parses as a JSON array is counted as corrupt rather than read as a record.
- The "no action" reason in the log names the gate that actually held; the old fall-through could report `already-acted-in-streak` for a non-`LOOP` verdict.

### Removed

- The `semantic-loop-kicker-rN.mjs` reload shim (the cache-busting trick must not ship) and the hardcoded machine paths and gateway endpoint.
- The ledger and mode-file locations are no longer fixed: set `ledgerFile` / `modeFile` to keep reading an existing history in place.
