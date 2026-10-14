# dsh-plugins

Public [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugins by [Chris Johnson](https://github.com/chrisjohnson). One repository, independently installable plugins — each with its own README, its own tests, its own changelog and its own version.

## Install

**Nothing here is published to npm.** Every release is a git tag on this repository, named `<package>-v<version>` (for example `dsh-model-switch-v0.2.1`), and you install a plugin by pinning that tag plus the package's subdirectory:

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#<package>-v<version>&path:/packages/<dir>"
```

`dsh plugin add` hands that spec to pnpm and also lists the package under the profile's `dsh.profile.bundles`, which is what activates its configuration layer. If you manage a profile's `package.json` yourself, the same spec works with pnpm directly — but then add the package name to `dsh.profile.bundles` by hand, because a plain `pnpm add` installs the plugin without enabling it:

```sh
pnpm add "git+https://github.com/chrisjohnson/dsh-plugins.git#<package>-v<version>&path:/packages/<dir>"
```

Pick the tag from [the repository's tags](https://github.com/chrisjohnson/dsh-plugins/tags); `<dir>` is the folder under `packages/` in the index below.

> **Warning — do not install these by bare name.** `pnpm add dsh-model-switch` (or `dsh plugin add dsh-model-switch`) resolves against the npm registry, and the npm package called `dsh-model-switch` belongs to an unrelated author: it is **not** this plugin. The same can happen to any unscoped `dsh-*` name. Always use the git-tag spec above.

## Index

| Plugin | What it is for | Latest | Directory |
| --- | --- | --- | --- |
| **[dsh-model-switch](./packages/model-switch/)** | Let the agent switch its own model mid-session, with a context-window fit guard so neither it nor a human in the composer can strand a conversation on a model too small to read it. | 0.2.1 | `packages/model-switch` |
| **[dsh-image-search-searxng](./packages/image-search-searxng/)** | A model-facing `image_search` tool over your own SearXNG, rendered inline in the Web GUI. | 0.2.0 | `packages/image-search-searxng` |
| **[dsh-continue-kicker](./packages/continue-kicker/)** | Automatically send "continue" when a turn halts on the output-token limit (or after a crash, or on a reasoning-only empty stop), with a runaway guard that stops after repeated kicks with no progress. | 0.1.0 | `packages/continue-kicker` |
| **[dsh-loop-watchdog](./packages/loop-watchdog/)** | Detect an agent stuck in a loop before each step (a deterministic repetition check plus an optional model judge), keep an audit ledger of every check, optionally steer the session, and chart the ledger in a `dsh-better-sidebar` panel. | 0.1.0 | `packages/loop-watchdog` |
| **[dsh-scheduled-queue](./packages/scheduled-queue/)** | Schedule the composer's draft to be sent to its own session later, with a per-session dock to edit, cancel or send now. Runs alongside the official schedule bundle. | 0.1.0 | `packages/scheduled-queue` |
| **[dsh-better-git-worktree](./packages/better-git-worktree/)** | Run a session in its own self-contained git working copy: a composer Worktree switch, a `worktree_convert` tool, session-list status badges, a header menu, and an archive prompt that decides the working copy's fate. | 0.1.1 | `packages/better-git-worktree` |

Install lines for the latest release of each package:

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-model-switch-v0.2.1&path:/packages/model-switch"
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-image-search-searxng-v0.2.0&path:/packages/image-search-searxng"
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-continue-kicker-v0.1.0&path:/packages/continue-kicker"
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-loop-watchdog-v0.1.0&path:/packages/loop-watchdog"
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-scheduled-queue-v0.1.0&path:/packages/scheduled-queue"
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-better-git-worktree-v0.1.1&path:/packages/better-git-worktree"
```

Each package's README is the contract: what it does, every configuration key and what happens when it is unset, how it fails, how to install it, and how to run its checks. Nothing important lives only here.

## Releases

1. A release is a normal pull request that bumps one package's version and moves its CHANGELOG `Unreleased` entry under that version.
2. After it merges, the tag `<package>-v<version>` is cut on that merge commit and pushed. Nothing is committed directly to `main`.
3. Consumers pin the tag with the install spec above. A tag is never moved or rewritten once pushed.

Details: [docs/releasing.md](./docs/releasing.md).

## What "a plugin from this repo" means

- **Plain ESM, no build step.** `git clone && npm test` works with nothing installed. No bundler, no TypeScript layer, no generated client — what the harness loads is what is in `src/`.
- **Every plugin declares `dsh.bundle.patch`**, so one command installs *and* activates it; nothing here needs a hand-edited `cordis.yml`.
- **Deployment-specific values are configuration, never defaults.** A plugin that "works on my machine" because it hard-codes my provider ids is broken for everyone else. `node scripts/verify.mjs` fails the build on author-local paths and provider ids.
- **Nothing is required to be configured.** Optional features report themselves unavailable and name the key that enables them, instead of throwing at boot or failing at first use.
- **Every decision worth testing lives in a module that imports nothing from dsh**, which is what makes the tests real rather than decorative.

## Checking this repository

```sh
npm run check          # verify + hook gate + all tests, no install needed
node scripts/verify.mjs            # the release contract (see below)
node scripts/compose-smoke.mjs     # install into a throwaway profile, import, compose
```

`scripts/verify.mjs` is the interesting one: it enforces the rules that make a plugin installable and trustworthy — `dsh.bundle.patch` present and loading the package by name, `dsh.client` matched by an `./client` export, one harness peer range across every package (`>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0`; dsh checks it with prereleases included, while plain node-semver/pnpm admit only `0.2.0-rc.*` and `0.3.0-*` prereleases from it), every shipped file inside the `files` allowlist (all a git-tag install ships), a git-tag install line (and no bare-name one) in every package README, every config key documented in its README, every package listed in the index above, and no deployment leakage. It runs on CI for every push and it runs on a bare clone.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). If you are an agent working in this repository, read [AGENTS.md](./AGENTS.md) first; it is short and it exists because these plugins run with your user's credentials.

For how these plugins get developed, tested against a live harness, released and consumed by the deployment they came from, see [docs/testing.md](./docs/testing.md) and [docs/releasing.md](./docs/releasing.md).

## License

MIT — see [LICENSE](./LICENSE).
