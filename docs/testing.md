# Testing a plugin

How a change in this repository goes from "my editor says it looks right" to
"installed on someone's harness". Four tiers, cheapest first, and each one states
what it cannot catch.

## Tier 0 — static gates (no install, no dsh, no network)

```sh
node scripts/verify.mjs                     # the release contract
node scripts/check-plugin-hooks.mjs         # Rules of Hooks over every client half
```

`verify.mjs` is not a linter; it checks the things that make a git-tag install
*work* — that the bundle patch exists and loads the package by name rather than by
path, that `dsh.client` has a matching `./client` export, that every
`@deepseek-ai/dsh*` peer and `engines.dsh` use the repository's one harness range,
that every file the package imports is inside its `files` allowlist (all a git-tag
install ships), that the README shows the git-tag install line and no bare-name one,
that every `config.*` key is documented, that the package is in the README index, and
that no author-local path, provider id, or credential pattern shipped.

## Tier 1 — unit tests

```sh
node --test packages/*/test/*.test.mjs scripts/test/*.test.mjs   # or npm test
```

These run against the pure modules (`src/fit.mjs`, `src/config.mjs`,
`src/searxng.mjs`, plus `scripts/lib/` for the repository's own checks) — which is
why those files import nothing from `@deepseek-ai/*`.
If a decision cannot be tested this way, that is a signal it is tangled with the host
and should be pulled out.

## Tier 2 — composition smoke (needs a dsh installation)

```sh
DSH_DEPLOY_DIR=/path/to/a/dsh/checkout node scripts/compose-smoke.mjs
# or: DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js node scripts/compose-smoke.mjs
```

For each package it builds a throwaway profile under `.lab/`, runs the real
`dsh plugin … add`, **imports the package the way the Cordis loader will**, and
asserts the bundle's layer and rows appear in `--dump-config`. This is the tier that
catches a peer range nobody could install against, a bad `exports`, or a patch file
that points at a directory.

**What it cannot catch:** anything that needs a configured host — tool dispatch,
service injection, the browser half, the shape of a real refusal message. For that:
tier 3.

## Tier 3 — the lab profile

```sh
node scripts/lab.mjs up          # http://127.0.0.1:3099
node scripts/lab.mjs clean
```

`.lab/install` gets its own dsh (`DSH_VERSION`, defaulting to `0.2.0-rc.2`, the same
version CI smokes against) plus every local package; `.lab/home` is its own
`DSH_HOME`. The production profile, its sessions, its settings and its service are
never touched, so an agent can restart the thing it is testing as many times as it
likes. `npm` installs a local `file:` dependency as a symlink, so edits under
`packages/*/src` are picked up by the next lab boot with no reinstall.

> **Why the plugin has to live next to the dsh installation.** The loader imports a
> plugin row from its own module location, so a package installed only into a
> profile's `node_modules` composes fine but fails to import at boot from an
> unrelated installation. A flat tree solves it; `npm` gives you one. (Measured here,
> not inferred — this is the failure mode `compose-smoke` would not have shown.)

> **Configuring the lab.** dsh 0.2 has no `settings.yaml`; providers and plugin config
> are rows in `.lab/home/profiles/web/cordis.patch.yml`. The old `--settings` flag is
> gone and now exits with an error that says this. That file may hold API keys: never
> copy it into the repository, never print it, and remember that a lab session with
> real credentials can spend real money.

## The browser half

There is no build, no typecheck and no hot reload between an edit to
`src/client.mjs` and a user's browser, and a crash inside a slot is swallowed by the
renderer's error boundary — the symptom is an *empty region*, not an error page.

- Check `node scripts/check-plugin-hooks.mjs` first; it catches the hook-order class
  (production `Minified React error #311` / `#310`, console line
  `slot entry crashed in '<slotKey>'`) that otherwise costs an hour of guessing.
- Then load the lab URL, **hard-reload** (the client bundle is cached by URL, not by
  content hash), and open the browser console. A blank region with no console output
  is not "fine, I'll look later" — it is the swallowed crash.
- Exercise the state transition, not just the first render. A component that adopts a
  session on first mount and then renders a different number of hooks is the exact
  shape that breaks.

## Restart discipline

The harness caches ES modules by URL, so a host-side change needs a process restart —
and on the production service that restart ends every session running inside it,
**including the session making the change**. So:

- Iterate in the lab. Restart the lab freely.
- Never restart, reload or signal the production dsh service from a session that is
  running on it. Prepare the exact command, say so, and let the human run it.
- Do not reintroduce the `entry-rN.mjs` versioned-shim trick to dodge the restart. It
  leaks into published packages, and `verify.mjs` fails it on purpose.

## Status of the tiers on this repository

Tiers 0–2 run on CI for every push and pull request (see
`.github/workflows/ci.yml`). Tier 3 is manual by nature; `scripts/lab.mjs` has not
been exercised end-to-end here yet — run it once and correct this line if it lies.
