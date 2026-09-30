# dsh-plugins

Public [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugins by [Chris Johnson](https://github.com/chrisjohnson). One repository, independently installable plugins — each with its own README, its own tests, its own changelog and its own version.

```sh
dsh plugin --profile web add dsh-model-switch
dsh plugin --profile web add dsh-image-search-searxng
```

## Index

| Plugin | What it is for | Install |
| --- | --- | --- |
| **[dsh-model-switch](./packages/model-switch/)** | Let the agent switch its own model mid-session, with a context-window fit guard so neither it nor a human in the composer can strand a conversation on a model too small to read it. | `dsh plugin --profile web add dsh-model-switch` |
| **[dsh-image-search-searxng](./packages/image-search-searxng/)** | A model-facing `image_search` tool over your own SearXNG, rendered inline in the Web GUI. | `dsh plugin --profile web add dsh-image-search-searxng` |

Each package's README is the contract: what it does, every configuration key and what happens when it is unset, how it fails, and how to run its checks. Nothing important lives only here.

**Coming next**, in rough order of readiness: `dsh-continue-kicker` (resume sessions that halted on a maxed-out generation), `dsh-loop-watchdog` (detect an agent stuck in a semantic loop, with an audit ledger), `dsh-git-worktree` (worktree-per-session with approval-aware git), `dsh-semantic-loop-evals`. Their history is already in this repository — see [docs/provenance.md](./docs/provenance.md).

## What "a plugin from this repo" means

- **Plain ESM, no build step.** `git clone && npm test` works with nothing installed. No bundler, no TypeScript layer, no generated client — what the harness loads is what is in `src/`.
- **Every plugin declares `dsh.bundle.patch`**, so one command installs *and* activates it; nothing here needs a hand-edited `cordis.yml`.
- **Deployment-specific values are configuration, never defaults.** A plugin that "works on my machine" because it hard-codes my provider ids is broken for everyone else. `node scripts/verify.mjs` fails the build on author-local paths and provider ids.
- **Nothing is required to be configured.** Optional features report themselves unavailable and name the key that enables them, instead of throwing at boot or failing at first use.
- **Every decision worth testing lives in a module that imports nothing from dsh**, which is what makes the tests real rather than decorative.

## Checking this repository

```sh
npm run check          # verify + hook gate + all tests, no install needed
node scripts/verify.mjs            # the publish contract (see below)
node scripts/compose-smoke.mjs     # install into a throwaway profile, import, compose
```

`scripts/verify.mjs` is the interesting one: it enforces the rules that make a plugin installable and trustworthy — `dsh.bundle.patch` present and loading the package by name, `dsh.client` matched by an `./client` export, peer ranges that admit prerelease harness builds, every shipped file inside the `files` allowlist, every config key documented in its README, every package listed in the index above, and no deployment leakage. It runs on CI for every push and it runs on a bare clone.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). If you are an agent working in this repository, read [AGENTS.md](./AGENTS.md) first; it is short and it exists because these plugins run with your user's credentials.

For how these plugins get developed, tested against a live harness, released and consumed by the deployment they came from, see [docs/testing.md](./docs/testing.md) and [docs/releasing.md](./docs/releasing.md).

## License

MIT — see [LICENSE](./LICENSE).
