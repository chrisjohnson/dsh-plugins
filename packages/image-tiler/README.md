# dsh-image-tiler

Some vision backends refuse — or silently downscale — any image above a hard
pixel budget. llama.cpp builds with `--image-max-pixels N` are the common case:
a full-size screenshot pasted into such a session either errors the turn or
arrives illegible. DSH's own attachment pipeline normalizes to a much larger
budget (4M px), so the mismatch must be closed **before** the request leaves
the harness.

This plugin closes it at the `agent/pre-step` waterfall. When a user message
about to enter a step carries an image whose stored pixels exceed the routed
model's cap, the plugin cuts the image into the smallest overlapping grid
whose every tile fits under the cap, saves the tiles as durable attachments,
and commits the tiles (plus one explanatory text block) in place of the single
oversized block. The model reads the tiles as separate images; the overlap
means nothing that straddles a tile border is cut mid-glyph. Because the
rewrite happens before the messages land in the session log, every later step
— and any compaction of this history — sees the tiles, never the oversized
original.

Routes without a configured cap are never touched, and neither is any image
already under its cap. The plugin is inert until you add one `caps` entry.

## Install

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-image-tiler-v0.1.0&path:/packages/image-tiler"
```

Then add a configuration row to your profile's `cordis.patch.yml` (see
Configuration below) and restart the service. Nothing takes effect without the
`caps` entry — an installed, unconfigured plugin passes everything through.

## Configuration

Every key is optional; an absent row is the documented inert state. A row's
`config` replaces the whole config object, so list every key you want to keep.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Kill switch. When `false` the listener still runs but returns every decision untouched. |
| `caps` | `{}` | Map of `"provider/model"` → maximum pixels one image may occupy on that route. The key is the exact provider id, a `/`, and the exact model id as the harness routes them (e.g. `"my-vision-provider/small-vlm": 393216`). Routes with no entry are never tiled. A malformed entry is dropped with a warning at boot. |
| `overlapRatio` | `0.12` | Fraction of a tile's width/height shared with its neighbours, `[0, 0.75)`. Higher overlap means fewer pixels lost at borders but larger tiles (so possibly more of them). |
| `safetyFactor` | `0.95` | Every tile stays at or under `cap * safetyFactor` pixels, `(0, 1]`. The margin absorbs encoder rounding and per-route accounting differences. |
| `maxTilesPerImage` | `32` | Valve. If no grid within this many tiles fits under the cap, the original image is sent whole with a note instead. Bounds the damage of a pathological aspect ratio or a tiny cap. Maximum accepted value is 256. |
| `logToStderr` | `false` | Forward this plugin's own log lines (every tiling, every fallback) to stderr, where a service manager captures them. |

Example row:

```yaml
- id: image-tiler
  config:
    caps:
      "my-vision-provider/small-vlm": 393216
    overlapRatio: 0.12
    maxTilesPerImage: 32
    logToStderr: true
```

## How it decides

- **Route**: the cap is looked up from the session's last minted request
  header (`session.requestHeader()?.config`), falling back to the agent's own
  `options.provider`/`options.model` before any header exists — the same
  resolution order the core compaction plugin uses. Mid-session model switches
  are therefore honoured from the next step.
- **Size**: the stored (normalized) image dimensions on the attachment
  reference decide, not the browser-side original. An image at exactly the cap
  passes through.
- **Grid**: smallest tile count wins; among equals, the smallest tile area.
  Every candidate grid is verified by a full-coverage audit before use; a grid
  that fails the audit is treated as infeasible (original sent whole).
- **Tiles** are PNG-encoded and committed through `ctx.attachments.saveImages`,
  so they are durable, content-addressed attachments like any pasted image.

## Failure modes

The plugin fails open everywhere: your turn proceeds even when tiling cannot
happen, and the session log says so.

- No `caps` entry for the route, or `enabled: false` → every message passes
  through untouched.
- Image under the cap, or its bytes unreadable, or an animated raster (GIF/WebP
  with more than one frame), or no attachment store in the profile, or a
  tile-encode/storage error, or the grid exceeding `maxTilesPerImage` → the
  original image block stays, followed by a text note explaining what happened.
- An unexpected internal error → the step is entered exactly as the rest of the
  waterfall produced it; the failure is logged.
- Already-offloaded image blocks (`offloaded: true`) are never re-read or tiled.

## Checks

```sh
node --test packages/image-tiler/test/*.test.mjs   # unit tests, bare clone
node scripts/verify.mjs --package dsh-image-tiler  # release contract
node scripts/compose-smoke.mjs image-tiler         # real bundle composition
```

The grid math, config validation, and the full pre-step rewrite contract
(pass-through and replacement shapes against a stubbed attachment store) are
unit-tested without dsh, sharp, or a network; the sharp pipeline test skips
itself when sharp is not installed.
