# Provenance

Every plugin here started as an in-tree plugin of a private deployment
(`dsh-deploy/.dsh/profiles/web/plugins`) and was extracted with its history intact.

## How the history moved

```sh
# in the deployment repo
git subtree split -P .dsh/profiles/web/plugins -b dsh-plugins-import
# in this repo
git fetch /path/to/dsh-deploy dsh-plugins-import
git checkout -b main FETCH_HEAD
```

`subtree split` rewrites the commits to the subset that touched that directory, so the
commits here carry the real reasoning — why a guard exists, which incident produced it,
what a comment was warning about. `git log --follow packages/<name>` works.

The consequence is that **the top of `main`'s history still shows the old flat layout**
(`model-switch/`, `image-search-searxng.mjs`, …) until the extraction commits land. The
old paths are not deleted from history and nothing should be pushed to them; the live
layout is `packages/<name>` only.

## Per-package state

| Package | Extracted from | Notes |
| --- | --- | --- |
| `dsh-model-switch` | `plugins/model-switch/` | Behaviour changes at extraction are listed in its `CHANGELOG.md` under 0.1.0 (notably: no built-in escalation/reader routes); the dsh 0.2.0 port (V4 `plugin:model-switch` source kind) is under 0.2.0. The in-tree copy differed from the package in two documented ways: built-in escalation/reader defaults (removed at extraction) and the old `source.kind: 'plugin'` (fixed in 0.2.0). The rest was compared by feature, not line by line (1108 lines in-tree vs 989 in the package). |
| `dsh-image-search-searxng` | `plugins/image-search-searxng.mjs` | Split into a pure `src/searxng.mjs` plus wiring; tool output is byte-compatible with the original. |
| `dsh-continue-kicker` | `plugins/continue-kicker.mjs` | Not yet packaged. |
| `dsh-loop-watchdog` | `plugins/semantic-loop-kicker*.mjs` | Not yet packaged. Needs the deployment's paths and `watchdog-mode.json` replaced with configuration first. |
| `dsh-better-git-worktree` | `plugins/dsh-better-git-worktree/` | Not yet packaged. Its `client.js` is *generated* by inlining an official package via string seams and it disables a core row; releasing it means either upstreaming or rebuilding that half. See the `NOTICE` file in the old directory. |
| `dsh-semantic-loop-evals` | `plugins/semantic-loop-evals/` | Not yet packaged. Hard-`inject`s another plugin's client module, which has to become an optional integration. |
| `dsh-scheduled-queue` | `plugins/scheduled-queue/` | Not yet packaged. Disabled upstream and has no per-session scoping. |

## Why some of them are still waiting

The blockers are all the same shape: the plugin knows something about the deployment it
grew up in — a path, a model id, another plugin's internals, a core version pinned by
string matching. Those are not cosmetic. A plugin that assumes your filesystem is a
plugin that installs and then does nothing, which is worse than one that is absent.
Each one gets a real pass: defaults become configuration, the coupling becomes an
optional integration that says what it needs, and the README gets written before the
package is tagged for release.
