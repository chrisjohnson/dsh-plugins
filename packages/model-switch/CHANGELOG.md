# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

## Unreleased

## 0.2.1

### Fixed

- `switch_model` and `switch_model_escalate` no longer report a failed tool call
  after a successful switch. The success value carried `undefined` for the
  optional `freed`, `tokens` and `window` measurements; dsh 0.2's registry
  requires structured output to be lossless JSON, which rejects an undefined
  property, so the call was marked `INVALID_TOOL_OUTPUT` ("value is not lossless
  JSON") even though the model had switched and the notice was written. Absent
  measurements are now omitted. The text the model sees is unchanged.

### Added

- `test/registry.test.mjs` runs both tools through dsh's own output validation
  (`snapshotJsonValue`, `validateJsonSchemaValue`, `render`) for success,
  compact-then-switch, already-on-route, refusal, failures and the escalate tool.
  It skips on a clone without dsh installed; CI's compose job runs it.

## 0.2.0

### Fixed

- Switch notices are written with `source.kind: 'plugin:model-switch'` instead of
  the shared `'plugin'` kind. Session format V4 (dsh 0.2.0) refuses a message with
  `kind: 'plugin'` when the log is read back, so a session that had switched model
  could not be reopened after a restart. The notice's one-line summary is now also
  bounded to the host's 120-character limit.
- Boot no longer throws for every configuration: the final "model-switch active"
  log line referenced a `reader` variable that was never declared in the plugin's
  scope, so loading the plugin raised a ReferenceError even with a full config. It
  also dereferenced an escalation route that is legitimately absent when unset.
  The line now prints each route, or `unset`.

### Removed

- The context badge's fall back to the session store (`sessions.get`) when no live
  agent exists for the id. The session controller resolves every id a client can
  name to a live agent first, so the branch only described a session that is
  mid-publication or subagent-owned; the badge now reports unavailable for it.

### Changed

- **Fixed a regression in the 0.1.0 switch guard wiring**: the guard returned
  decideFit's verdict unchanged while the switch sequence read `allowed`, so every
  non-compacting case was refused ("model switch refused: undefined"), including
  switches that fit. The guard path now lives in `src/guard.mjs` with its services
  injected, and `test/guard.test.mjs` drives allow, refuse, compact, failed
  compaction, no measurement and no declared window end to end.
- The tool path's "can the current route compact this" test uses the fit margin
  again (`tokens > floor(currentWindow * fitRatio)` refuses with the
  delegate-to-subagent advice), as the in-tree plugin did. This reverses the 0.1.0
  note below for the tool path; the interactive repair still uses the route's full
  window.
- Window lookups are lazy: with no token measurement none is made, and the current
  route's window is resolved only when the destination does not fit, so a switch
  that fits costs a single lookup.
- The `switch_model` parameter descriptions are generic (no deployment-specific
  provider or model ids in the example text).
- The notice source no longer carries the old `plugin: 'model-switch'` field.
- Unknown or invalid config keys now print a boot warning.
- Requires dsh 0.2.0-rc.2 or later: `engines.dsh` and the `@deepseek-ai/dsh-tools`
  / `@deepseek-ai/dsh-llm` peers are now `>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0`.
  dsh 0.2 checks bundle peer ranges at boot, so the range now states the line this
  is actually tested against.
- Installed from a git tag (`dsh-model-switch-v<version>`), not the npm registry —
  see the README's Install section. The npm package named `dsh-model-switch` is an
  unrelated author's, not this plugin.
- The repair panel is collapsed by default. Past the auto-compact line nothing
  fails and nothing is stranded — the next request compacts on the route that can
  still read it — so the paragraph no longer takes composer height until it is
  asked for. The context badge beside the model picker is now the handle: click or
  Enter opens it and re-measures on the way in, and the panel has its own dismiss
  and re-check buttons. Past the route's own window the panel still opens itself,
  once per session and route, and a manual close after that is respected until the
  pressure clears.

## 0.1.0

First public release. Extracted from a running dsh deployment (since 2026-09-28)
where the guard has been preventing the stranding incident described in README.md.

### Added

- `switch_model` and `switch_model_escalate` tools, both behind the fit guard.
- Context-window fit guard: measure → allow / compact-first / refuse with
  actionable numbers. Decisions live in `src/fit.mjs`, tested.
- Browser half: context pill beside the model picker, and a one-click
  compact-then-return repair banner.
- Configuration resolution in `src/config.mjs` with warnings for every way a key
  can be wrong (unknown key, non-numeric value, half-configured route).
- 26 unit tests for the guard and the configuration layer.

### Changed from the pre-public version

- **No built-in escalation or reader route.** The pre-public version defaulted to
  specific provider/model ids on one deployment. They are now configuration;
  `switch_model_escalate` is not registered when unset, and the interactive
  repair reports precisely which keys to set instead of assuming them.
- **The "can this route read the transcript" test uses the route's own window in
  the tool path too.** The repair path already did; the tool path used the fit
  margin, which refused some switches it should have compacted instead (the same
  bug the repair path fixed, left behind there).
- The plugin's dev-time `entry-rN.mjs` module-cache shims are gone; the package
  entry is `index.mjs`.
