# AGENTS.md — dsh-plugins

What is true here, and what to do about it. Written for agent sessions; humans get
the same rules in [CONTRIBUTING.md](./CONTRIBUTING.md), less the imperative.

## What this repository is

Public plugins for DeepSeek Harness. Each `packages/<name>` is an independently
installable npm package and a dsh **bundle** (a package that ships a configuration
layer). This repository is the source of truth for plugin code; the deployment that
consumes them (`dsh-deploy`) installs published versions and owns none of this code.

Two consequences shape every change:

1. **This code runs with the plugin user's credentials, files and API keys, outside
   any sandbox the agent runs under.** Tool approvals do not gate plugin code. A bug
   here is not a crash, it is a permission you should think about before writing.
2. **A published version can never be unwritten.** Whatever you release is what
   someone's `dsh plugin add` pulls forever, and what their deployment rolls back
   to.

## Layout

```
packages/<name>/
  package.json       # name, dsh.bundle.patch, dsh.client, files allowlist, peers
  cordis.patch.yml   # the layer dsh applies when the bundle is enabled
  README.md          # the plugin's own contract: config, failure modes, checks
  CHANGELOG.md       # Keep a Changelog; must mention the current version
  index.mjs          # host entry (thin re-export)
  src/*.mjs          # implementation; pure decision modules import nothing from dsh
  src/client.mjs     # browser half, only for plugins with UI
  test/*.test.mjs    # node:test, must pass on a bare clone
```

## Commands

| Command | What it proves |
| --- | --- |
| `npm run check` | Everything below, in one go. |
| `node scripts/verify.mjs` | The publish contract: installability, docs parity, no deployment leakage, prerelease-safe peer ranges. |
| `node --test packages/*/test/*.test.mjs` | Unit tests. No dsh, no install, no network. |
| `node scripts/check-plugin-hooks.mjs` | React Rules-of-Hooks gate over every browser half. |
| `node scripts/compose-smoke.mjs` | Installs each package into a throwaway profile under `.lab/`, imports it for real, and asserts the layer lands in a composed config. Needs a dsh installation (`DSH_BIN`, or `DSH_DEPLOY_DIR` pointing at a checkout that has one). |

All of them run on CI. Run `verify` before you commit: it is fast, and it catches
the mistakes that stay invisible until somebody's install fails.

## Rules

**Never require configuration to boot.** An unset optional feature says so once at
startup and names the key. A plugin that throws at boot because it was not
configured has taught the user nothing and taken their profile with it.

**Never default to a deployment's answer.** Provider ids, model ids, host names,
ports, paths — those are configuration, resolved config → environment → a
documented universal default. `verify.mjs` fails on `/home/…`, `/Users/…` and the
author's provider ids; the sanctioned exception is a deliberate loopback default,
marked `// verify-allow: no-deployment-leaks` and documented in the README.

**Keep the bundle patch's `config:` block empty.** A patch layer *replaces* a row's
whole `config` object rather than deep-merging, so every key you restate in the
bundle is a key the user must restate again to override anything else. Resolve
defaults in code.

**Put decisions where they can be tested.** Anything with branches gets a module
that imports nothing from `@deepseek-ai/*`, plus tests against it. The Cordis wiring
in `src/host.mjs` should be thin enough that reading it is enough.

**Ship a `files` allowlist, and keep it honest.** `verify.mjs` fails when a source
file is not covered by it, because a published package missing a file it imports is
a 404 for the user.

**Declare official packages as peers, with a prerelease branch.**
`@deepseek-ai/dsh-*` belongs in `peerDependencies`, not `dependencies` — the host
supplies the single instance, and a second copy splits entry and context identity at
runtime. Every `@deepseek-ai/dsh*` peer, and `engines.dsh`, is exactly
`>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0` — one range repository-wide, enforced by
`verify.mjs`. The prerelease tags matter: node-semver only admits a prerelease when
some comparator carries a prerelease tag on the same tuple, so an innocuous-looking
`>=0.2.0 <0.3.0` excludes every `-rc` build of the harness and the user gets an
`ERESOLVE`. dsh itself checks these ranges at install and again at boot, and skips a
bundle whose range misses the runtime with one log line — so a wrong range is a
plugin that silently stops loading, not just an install warning.

**Never declare the bare `cordis` package** in any dependency field — the harness
supplies `@deepseek-ai/cordis`, and the Desktop community market rejects the bare
name outright.

### The browser half

`src/client.mjs` is live React in the user's browser, mounted into the same React
root as core, with no build, no typecheck and no lint between you and it.

The trap specific to this renderer: standard state arrives as **hook-valued props**
(`useInput`, `useSessions`, …), and each call expands to roughly four hook slots. So
the ordinary defensive reflex is the bug:

```js
var input = useInput ? useInput(sel) : null;                    // WRONG
if (typeof seat !== "function") return null; /* hooks below */  // WRONG
```

Call the seat over a stable module-scope fallback and branch on the **result**:

```js
var NO_SEAT = function () { return null };
var input = (props.useInput || NO_SEAT)(sel);
if (!input) { /* … */ }
```

A guard is not made safe by the seat "always being a function in practice": a
session-maybe entry adopts its first session without remounting, so a prop's
presence can differ between two renders of one mounted component. React then throws
"Should have a queue" (production `Minified React error #311`, `#310` when a list
grew), the renderer's `SlotErrorBoundary` swallows it, and the region renders as an
empty `<div>` — a blank composer that only a page reload clears.

`scripts/check-plugin-hooks.mjs` is the only automated gate this gets. Zero findings
is the expected output.

### Versioned entry shims

`entry-r7.mjs` files appear in this repository's history. They existed to defeat
Node's ES-module cache (keyed on module URL, not mtime) so a host reload picked up
edits without a restart. **They must never be published.** Release a version; do not
ship a query string.

## Working here

- Branch, then open a pull request. Changes reach `main` through a pull request,
  merged once CI has passed and it has been reviewed. That is a convention, not a
  GitHub setting: `main` has no branch protection, so nothing stops a direct push
  or an unreviewed merge except you following it.
- Update the package's `CHANGELOG.md` in the same commit as the change; bump the
  version only in a release commit.
- A user-visible behaviour change gets a test, or a README paragraph explaining why
  a test would be worse than the docs.
- Never edit `node_modules` to fix another plugin, including your own published one.
  Pin, reproduce, report, release a fix.
- Never push a version CI has not passed; never rewrite a pushed tag.

## Adding a plugin

1. `mkdir -p packages/<name>/{src,test}`, then copy the shape of what is here:
   `image-search-searxng` for the minimal case, `model-switch` for one with a
   browser half and real configuration.
2. It must be **self-contained**: no imports from outside its own directory, no
   reading another plugin's state files, no assumption about what else is installed.
   Optional integrations degrade to a no-op and say so in the log.
3. Name it `dsh-<something>` (unscoped), set `repository.directory`, `engines.dsh`,
   `keywords: ["dsh-plugin", …]`, MIT, and a `files` allowlist.
4. Write its README before you finish coding. If you cannot say what every config key
   does and what happens when it is unset, you have designed a plugin only its author
   can operate.
5. Add a row to the index table in `README.md` — `verify.mjs` fails without it.
6. `npm run check`, then `node scripts/compose-smoke.mjs`.

See [docs/authoring.md](./docs/authoring.md) for the rest, and
[docs/releasing.md](./docs/releasing.md) for shipping it.
