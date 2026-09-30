# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

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
