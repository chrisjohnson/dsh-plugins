# dsh-browser

**One browser context per DSH session, on one shared remote Browserless connection, for `dsh-playwright-browser`'s tools.**

A host-plane plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It registers no tools and replaces no prompt. [`dsh-playwright-browser`](https://www.npmjs.com/package/dsh-playwright-browser) keeps its ten `browser_*` tools, their schemas, snapshots and prompt exactly as they are; this plugin only changes where their browser comes from.

Without it, every `browser_*` call from every session goes to one local Chromium and one browser context built when the original plugin starts: sessions see and click each other's tabs, and once that browser dies nothing recovers it. With it:

- **One context per session.** A session's tabs, cookies and logins are invisible to every other session. The context is created on the session's first `browser_*` call and closed when the session ends (`agent/disposed`, and `session/disposed`).
- **One connection to Browserless for all of them.** Contexts on a connection cost no extra Browserless slot, so five sessions use one of its concurrent slots, not five. When the last session ends the connection is closed, so an idle DSH holds no slot.
- **Survives a dropped connection.** Browserless kills even active connections at its per-connection timeout (one hour by default). The plugin drops the dead browser and every context on it, and the next call transparently reconnects and opens a fresh context. The result tells the model so, because its old tabs are gone.
- **Says so when it is not remote.** If Browserless cannot be reached, sessions get a local Chromium instead, and every tool result for them carries a line saying the browser is a local fallback and why. It never pretends to be remote.

## How it works

The original plugin builds one `BrowserController` and every tool closes over it; controller methods are never told which session called. So this plugin:

1. wraps each `browser_*` call (the `tools/execute` event) in an `AsyncLocalStorage` store holding the calling agent's id (`exec.agent.id`, the session id);
2. patches the twelve public methods of `BrowserController.prototype` (`open`, `navigate`, `snapshot`, `click`, `fill`, `press`, `history`, `wait`, `screenshot`, `listTabs`, `selectTab`, `closeTab`) so that, when a session id is in the store, the call runs the **original method** on that session's own controller. That controller is a subclass of the original `BrowserController` whose only change is that its browser context comes from the shared connection instead of a private launch. Tab bookkeeping, locators, snapshots and cancellation are the original code, untouched;
3. with no session in the store, falls straight through to the original method, so anything else using the controller behaves as before.

Notices for the model travel on the call's own result via `tools/post-execute`.

### Module identity

The patch only works if the `BrowserController` it patches is the same module instance the original plugin's tools use. Both import `dsh-playwright-browser`'s one `lib/browser-controller.js` (this plugin through the package's `./controller` export), and Node's module cache is keyed by that file's URL, so they share it as long as there is **one installed copy** of `dsh-playwright-browser` that both resolve to. Install them side by side in the same `node_modules`, as a flat (hoisted) tree does.

If they ever do not share it (a second copy of `dsh-playwright-browser`, or a hot reload that replaced only one of them), the patch would silently do nothing. The plugin checks for this: a `browser_*` call that succeeds without reaching a patched method is logged as an error and its result says that session isolation and the remote browser are **not** in effect. [`scripts/browser-live-check.mjs`](../../scripts/browser-live-check.mjs) verifies the sharing against a real dsh process.

## Install

Installed from a git tag of this repository — it is not published to npm. Replace `<version>` with a released version (tags are named `dsh-browser-v<version>`; see [the tag list](https://github.com/chrisjohnson/dsh-plugins/tags)):

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-browser-v<version>&path:/packages/browser"
```

That installs the package into the profile and enables its bundle. If you manage the profile's `package.json` yourself, the pnpm equivalent is below — then also add `dsh-browser` to the profile's `dsh.profile.bundles`, because `pnpm add` alone installs the plugin without enabling it:

```sh
pnpm add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-browser-v<version>&path:/packages/browser"
```

> **Warning:** never `pnpm add dsh-browser` (or `dsh plugin add dsh-browser`) by bare name. That resolves from the npm registry, where an unscoped `dsh-*` name may belong to an unrelated author and is **not** this plugin.

It needs, in the same installation:

- `dsh-playwright-browser` **exactly `0.1.3`** (enabled in the same profile). The patch targets that version's controller internals; the peer range is pinned so a different version is reported at install time instead of misbehaving.
- `playwright-core` (any release from 1.49; `dsh-playwright-browser` already brings one).

With either missing, the plugin logs one error at boot and does nothing; it never stops the profile from starting.

## Configuration

Set these on the plugin's row in your own profile patch (`config:` block). **A top-level row with a `config:` block replaces the whole config object**, so list every key you want to differ from the default in the same row. The bundle's own layer carries no config for the same reason.

| Key | Default | What it does |
| --- | --- | --- |
| `connectUrl` | `ws://127.0.0.1:3100/chromium/playwright` | Playwright websocket endpoint of the Browserless to connect to (`chromium.connect`). Include a `?token=` query if your Browserless needs one; it is never logged or shown to the model. Set to an empty string (`''`) to switch remote off and always use a local browser. A value that is not `ws://` or `wss://` is ignored with a warning. |
| `connectTimeoutMs` | `10000` | How long one connection attempt may take before it counts as unreachable. |
| `retryRemoteAfterMs` | `30000` | After a failed connection, how long new sessions go straight to the local fallback without trying Browserless again. `0` tries on every new session. |
| `fallbackExecutablePath` | unset | Chromium/Chrome executable for the local fallback (and for `connectUrl: ''`). Unset uses the Chromium Playwright manages itself. |
| `viewportWidth`, `viewportHeight` | from `dsh-playwright-browser`'s row | Viewport of each session's context. |
| `actionTimeoutMs`, `navigationTimeoutMs` | from `dsh-playwright-browser`'s row | Per-action and navigation timeouts. |
| `maxSnapshotChars`, `screenshotDir` | from `dsh-playwright-browser`'s row | Snapshot size cap and screenshot directory. |
| `logToStderr` | `false` | Write this plugin's own log lines to stderr (dsh 0.2.0-rc.2 installs no logger exporter, so without it they reach nobody). |

The page and timeout keys exist only to override: when unset, each session's controller is built from the configuration `dsh-playwright-browser` itself resolved (its `playwright-browser` row), so you do not state viewport and timeouts twice. The original's `executablePath`, `channel`, `browser`, `headless` and `userDataDir` have no effect on session browsers: they belong to a local launch, which this plugin only does as a fallback (use `fallbackExecutablePath`).

Resolution lives in [`src/config.mjs`](./src/config.mjs) and is [tested](./test/config.test.mjs). An unknown key or an unusable value prints one warning at boot and falls back to the default. The default `connectUrl` is a loopback address, the usual place a Browserless published on the same host is reachable; every other deployment-specific value is configuration.

Example row:

```yaml
- id: browser
  name: dsh-browser
  config:
    connectUrl: ws://127.0.0.1:3100/chromium/playwright
    connectTimeoutMs: 10000
    retryRemoteAfterMs: 30000
    fallbackExecutablePath: /usr/bin/chromium
    logToStderr: true
```

## Behaviour to know about

- **Tab ids restart after a lost connection** (new context), but keep counting upward, so an id from before the loss is rejected as unknown instead of silently naming a different page.
- **A call in flight when the connection dies fails** with Playwright's own error; the next call recovers.
- **Sessions that fell back to the local browser stay there** until they end, even if Browserless comes back; new sessions try Browserless again after `retryRemoteAfterMs`.
- **Subagents are sessions too**, and each gets its own context.
- **Screenshots are written by DSH, on the DSH host**, as before, into `screenshotDir`.
- **Browserless limits still apply**: its concurrent-connection cap counts connections, and this plugin uses one. Its own memory and CPU limits count open pages across all contexts.
- **The original prompt still tells the model, on a startup failure, to explain `npx playwright install chromium`.** That text is inside `dsh-playwright-browser`'s own prompt section and cannot be edited without replacing it. This plugin adds a short section after it saying not to install browsers here and to report the diagnostic instead.

## Logging

Lines go through the host logger under the name `browser`, and to stderr with `logToStderr: true`:

```
2026-10-28T18:22:00.641Z INFO browser opened remote context for session sess-a (contexts=1)
2026-10-28T18:22:01.186Z WARN browser context for session sess-a was closed by the browser (connection lost); the next call opens a new one
2026-10-28T18:22:03.020Z WARN browser remote browser unavailable, falling back to a local browser: browserType.connect: WebSocket error: connect ECONNREFUSED 127.0.0.1:1
```

## Development

```sh
node --test packages/browser/test/*.test.mjs       # unit tests, no install needed
node scripts/verify.mjs --package dsh-browser      # release contract
node scripts/compose-smoke.mjs browser             # real dsh composition
node scripts/browser-live-check.mjs --install-dir <dsh install> --browserless http://127.0.0.1:3100
```

`src/config.mjs`, `src/pool.mjs`, `src/routing.mjs` and `src/bridge.mjs` import nothing from dsh or Playwright; `src/host.mjs` is the thin wiring. `test/real-controller.test.mjs` runs the routing against the real controller class and is skipped when `dsh-playwright-browser` is not resolvable.

### The live check

`scripts/browser-live-check.mjs` (repository root) boots a throwaway dsh (own `DSH_HOME` and `HOME`, inside the install directory you give it) with both plugins and a test-only driver plugin (`scripts/live/browser-driver.mjs`, not shipped) that creates real agents and runs tool calls through the real tool runtime, with no model involved. Against a reachable Browserless it asserts: the patched and original controller are one file; two sessions calling the original `browser_open`/`browser_tabs` see only their own tabs while Browserless `/pressure` rises by exactly one; killing that connection server-side (`/kill/<id>`, only a session that appeared during the run) is survived and announced; disposing sessions closes their contexts and finally frees the slot; and an unreachable `connectUrl` yields a working local browser with the fallback notice. The install directory needs `@deepseek-ai/dsh`, `dsh-playwright-browser@0.1.3` and this package (a `file:` dependency copies it the way a git install does) in a hoisted `node_modules`, and Chrome for the fallback step (`--fallback-chrome`, or Playwright's own Chromium). Run it only against a Browserless you may load: it opens one connection and two contexts.

## License

MIT
