# Provenance

Every plugin here started as an in-tree plugin of the author's `dsh-deploy`
(`dsh-deploy/.dsh/profiles/web/plugins`) and was extracted with its history intact.
The in-tree copies have since been removed from `dsh-deploy`, which now installs
the released tags from this repository.

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
| `dsh-continue-kicker` | `plugins/continue-kicker.mjs` | Split into pure `src/decide.mjs` and `src/config.mjs` plus wiring. Behaviour changes at extraction (V4 source kind, genuine-user detection, `tool-call` block type) are listed in its `CHANGELOG.md` under 0.1.0. |
| `dsh-loop-watchdog` | Merges the former semantic-loop-kicker and semantic-loop-evals: `plugins/semantic-loop-kicker.mjs` (the watchdog, behind its `-rN` shim) and `plugins/semantic-loop-evals/` (the evals panel) | One package. Deployment paths, the model endpoint and the API-key variable became configuration; the panel is an optional `dsh-better-sidebar` integration. Behaviour changes are in its `CHANGELOG.md` under 0.1.0. |
| `dsh-better-git-worktree` | `plugins/dsh-better-git-worktree/` | Split into pure modules (`src/status.mjs`, `registry.mjs`, `removal.mjs`, ...) plus a service and thin dsh wiring. The inlined official-client bundle and its `ui-workspace` election were replaced by the 0.2.0 sidebar seats; the registry format is unchanged. Behaviour changes are in its `CHANGELOG.md` under 0.1.0. |
| `dsh-scheduled-queue` | `plugins/scheduled-queue/` | Split into pure `src/queue.mjs` and `src/config.mjs` plus host and browser halves. Behaviour changes at extraction (per-session dock, delivery through `sessionController.prompt`) are listed in its `CHANGELOG.md` under 0.1.0. |
