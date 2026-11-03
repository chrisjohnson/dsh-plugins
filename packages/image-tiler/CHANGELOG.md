# Changelog — dsh-image-tiler

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-03

### Added

- `policy: "ask" | "tile" | "send-whole"` (default `ask`): an over-cap image
  now poses the choice to the human through the harness approval machinery —
  approve tiles, reject sends whole with a note that the backend will likely
  downscale. `askFallback` resolves asks no human can answer (headless,
  cancelled, `never` policy, no approval service); `rememberPerSession` lets
  the first answer decide the rest of a session.
- Route resolution now reads the session's *pending* model selection first, so
  the first message after a composer model pick (no minted header yet) and
  mid-session switches get the right cap. Previously the first paste after
  choosing a capped model passed through until the header minted.

### Changed

- Grid scoring is `tiles × (1 + aspectDistance²)` instead of plain fewest
  tiles: aspect-matched grids beat sliver grids when the tile budget allows
  (a 4K screenshot now gets ~25 near-square tiles instead of 26 full-height
  strips). Coverage audit and cap adherence are unchanged and still enforced.

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
