# Changelog — dsh-image-tiler

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-02

Initial release.

### Added

- A global `agent/pre-step` listener that tiles user-attached images exceeding
  the routed model's pixel cap (`caps`) into the smallest overlapping grid
  whose every tile fits under `cap * safetyFactor`, before the step's messages
  are committed to the session log.
- Per-route caps keyed `"provider/model"`, resolved from the session's minted
  request header with a fallback to the agent's own options; routes without an
  entry are never touched.
- A full-coverage audit on every generated grid, a tile-count valve
  (`maxTilesPerImage`), and fail-open notes on every fallback (unreadable
  bytes, animated rasters, encoder/storage errors, valve) — the original image
  is always sent whole when tiling does not happen.
- `enabled` kill switch and `logToStderr` opt-in exporter for the plugin's own
  log lines.
