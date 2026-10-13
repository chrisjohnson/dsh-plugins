# dsh-loop-watchdog

**A stuck-session signal for agents you leave running — an audit ledger first, an intervention only if you ask for one.**

A host plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that checks a session before each agent step and writes one record per check saying whether it looks stuck, with the evidence. It ships a panel (for `dsh-better-sidebar`) that draws that ledger for the current session.

Precision over recall. A false positive tells a working agent to abandon its strategy; a false negative costs a few minutes. So the watchdog is built around evidence that cannot hallucinate, and what it does about a verdict is off until you turn it on.

| Layer | What it does | Cost |
| --- | --- | --- |
| **Repetition check** (deterministic) | Hashes `(tool, normalised arguments)` over the last `fpWindowEvents` events. The same call repeated with *no new information* is stuck: 3 or more repeats with at most one distinct result, or 5 or more with at most two. | No model call. |
| **Model adjudication** (optional) | For windows the first layer did not settle, asks a model you configure whether the last few steps produced **new information** (a new file read, a new error, a result that differs) or re-ran work that already failed. It answers `LOOP:N` or `PROGRESS:N`. | One small completion, at most once per `cooldownMs`, skipped while the previous one was slow. |
| **Intervention** (off by default) | In the *stuck* band, sustained over two consecutive checks, in act mode, once per stuck episode: steers one non-destructive note into the session asking the agent to state what it has established and take the cheapest check that could falsify its approach. | One message. |

Similar-looking commands with new results are progress; the same command returning the same nothing is a loop. That distinction is the whole design.

## Install

Installed from a git tag of this repository — it is not published to npm. Replace `<version>` with a released version (tags are named `dsh-loop-watchdog-v<version>`; see [the tag list](https://github.com/chrisjohnson/dsh-plugins/tags)):

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-loop-watchdog-v<version>&path:/packages/loop-watchdog"
```

That installs the package into the profile and enables its bundle. If you manage the profile's `package.json` yourself, the pnpm equivalent is below — then also add `dsh-loop-watchdog` to the profile's `dsh.profile.bundles`, because `pnpm add` alone installs the plugin without enabling it:

```sh
pnpm add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-loop-watchdog-v<version>&path:/packages/loop-watchdog"
```

> **Warning:** never `pnpm add dsh-loop-watchdog` (or `dsh plugin add dsh-loop-watchdog`) by bare name. That resolves from the npm registry, where an unscoped `dsh-*` name can belong to an unrelated author and is **not** this plugin.

Restart dsh. With no configuration the repetition check runs, every check is ledgered, and nothing intervenes. Model adjudication stays off until you give it an endpoint and a model (below), and the boot log says so.

## Configuration

Set these on the row in your own profile patch (`config:` block). **A patch layer replaces a row's whole `config` object**, so a row that sets one key must restate every key it wants to differ from the default.

| Key | Default | What it does |
| --- | --- | --- |
| `interventionEnabled` | `false` | Whether to steer a sustained-stuck session. Log-only by default. The [mode file](#the-mode-file) overrides this at runtime. |
| `llmBaseUrl` | *unset* | Base URL of an OpenAI-compatible API; `/chat/completions` is appended. **Unset (or `llmModel` unset) turns model adjudication off**: the repetition check still runs, and ambiguous windows are ledgered as skipped (`no-llm`). |
| `llmModel` | *unset* | Model id sent to that endpoint. |
| `llmApiKeyEnv` | *unset* | The **name** of the environment variable that holds the API key — never the key. Read at call time. Unset, or an empty variable, sends no `Authorization` header (the boot log warns for the empty case). |
| `llmExtraBody` | `{}` | Extra fields merged under the request body, for a backend-specific switch — for example `chat_template_kwargs: {enable_thinking: false}` to stop a thinking model reasoning before a one-line answer. The fixed fields (`model`, `max_tokens`, `temperature: 0`, `messages`) win. |
| `llmMaxTokens` | `128` | Completion budget for the one-line verdict. |
| `ledgerFile` | `$DSH_HOME/storages/loop-watchdog/evaluations.jsonl` | The [evaluation ledger](#the-ledger). Always written. |
| `modeFile` | `$DSH_HOME/storages/loop-watchdog/mode.json` | The runtime act/log override. This plugin only reads it. |
| `cooldownMs` | `30000` | Minimum gap between two evaluations of one session. |
| `maxTranscriptLines` | `6` | Substantive events shown to the model (and recorded in the ledger window). |
| `fpWindowEvents` | `60` | Raw events the repetition check scans (~15 tool calls). |
| `watchdogTimeoutMs` | `25000` | Abort a model call after this long. The check fails open. |
| `busyYieldMs` | `15000` | After a model call slower than this, the next model check is skipped so the watchdog does not compete with the session it supervises. |
| `bandStuck` / `bandWatch` | `90` / `70` | Confidence thresholds for the `stuck` (actionable) and `watch` bands, for a `LOOP` verdict. Anything lower, or any `PROGRESS` verdict, is `noise`. |
| `includeSubagents` | `false` | Subagent sessions are skipped unless this is `true`. |
| `logFile` | `true` | Write the verbose stage trail to `logFilePath`. |
| `logFilePath` | `$DSH_HOME/storages/loop-watchdog/watchdog.log` | Where that trail goes. |
| `logConsole` | `false` | Also print the trail to stdout (the journal under systemd). Off because it fires on every step of every session. |
| `logDsh` | `false` | Send the trail to dsh's own logger. |
| `logDshErrors` | `true` | Keep genuine errors on dsh's logger even when `logDsh` is off. |

`$DSH_HOME` is the environment variable when set (blank counts as unset), else `~/.dsh`. Resolution lives in [`src/config.mjs`](./src/config.mjs) and is [tested](./test/config.test.mjs); a misspelled key, a YAML `"30000"`, a base URL that is not http(s), or a model with no endpoint each print one warning at boot.

Example, on a deployment with a local OpenAI-compatible gateway:

```yaml
- id: loop-watchdog
  name: dsh-loop-watchdog
  config:
    llmBaseUrl: http://127.0.0.1:8000/v1
    llmModel: small-model
    llmApiKeyEnv: GATEWAY_API_KEY
    llmExtraBody:
      chat_template_kwargs:
        enable_thinking: false
    interventionEnabled: false
```

## The ledger

Every evaluation appends one JSON line to `ledgerFile` (schema `v: 2`), carrying both layers:

- `code` — the repetition check's full result, including "ran, scanned N calls, found nothing", which decides nothing and would otherwise leave no trace;
- `model` — the model's verdict, present only when the first layer was inconclusive and the model was consulted;
- `verdict`, `confidence`, `band`, `streak`, `mode`, `outcome` (`logged`, `intervened`, `intervene-error`, `skipped`), the matched `fingerprints`, latency, and the exact transcript `window` that was judged.

Steps deliberately not evaluated are recorded too, but **only the first of a stretch**, so the ledger does not gain a row every few seconds: `no-signal` (fewer than two substantive events), `cooldown`, `busy` (the previous model check was slow), and `no-llm` (nothing left to ask). A real evaluation ends the stretch.

The file is the interface. Anything may read it; the evals panel is one reader. Older `v: 1` (decisions-only) lines stay readable: the reader normalises them into the current shape. The watchdog never rotates or truncates it.

## The mode file

`interventionEnabled` is the default. Whatever UI or script you like can override it at runtime by writing `modeFile`:

```json
{ "interventionEnabled": true }
```

The file is read on **every check**, so a toggle takes effect within one cooldown window, no restart. Absent, unreadable, or without a boolean `interventionEnabled` means "no override". This plugin never writes the file and ships no toggle UI of its own.

## The evals panel

The same package serves a read-only view of the ledger to a `dsh-better-sidebar` tab, "Loop evals": a timing graph with a code lane, a model lane and a dim skip lane, a synced ledger list, and a detail view of one evaluation (fingerprint groups, the model's raw reply, latency, the transcript window). It defaults to the current session, with a toggle for all.

`dsh-better-sidebar` is an **optional** integration. The panel module declares that service as a requirement, so without better-sidebar installed it stays inactive and registers nothing; the watchdog and its ledger are unaffected. It uses better-sidebar 0.25.0's `ctx.betterSidebar.registerTab(descriptor)`, whose registration is disposed with this plugin's fiber. The panel reads the ledger through a plugin-owned route, `/loopWatchdog/<list|sessions|detail>`, behind the connection service's trust check.

## Session format V4

Dsh 0.2.0 sessions are format V4, and the watchdog reads V4 events: a `user/message` event's `data` **is** the message; a `tool/result` event's `data.message` is a first-class `{role: 'tool', toolCallId, content}` message, whose text is its content blocks. The steering note is written with source kind `plugin:loop-watchdog` — V4 refuses the bare kind `plugin` on read, so a session carrying such a message could not be reopened after a restart.

## Failure modes

- **Fails open, always.** A model timeout, HTTP error or unparseable reply yields no verdict (band `noise`) and the turn proceeds. A thrown error is logged and never reaches the agent loop; the `agent/pre-step` listener awaits the waterfall first and runs the check without blocking it.
- **No model configured:** the repetition check still decides on its own; ambiguous windows are ledgered as `no-llm`.
- **Ledger or log not writable:** writes are best effort and silently skipped; the agent is never affected.
- **A model that reasons before answering** may spend `llmMaxTokens` on thinking and return nothing; pass the backend's switch in `llmExtraBody`.

## Compatibility

Requires dsh 0.2.0-rc.2 or later. Declared in `package.json` under `engines.dsh` and on the `@deepseek-ai/dsh-llm` peer as `>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0`. dsh checks these ranges itself, counting prereleases; pnpm's own peer check is narrower and may report a mismatch on other prereleases that dsh does not.

## Troubleshooting

**Nothing is ever ledgered.** The ledger needs at least two substantive events and a clear cooldown. Check `logFilePath` for `[B]` lines: `skip … only N substantive events` or `COOLDOWN_SKIP` say why.

**Every ambiguous window is a `no-llm` skip.** Model adjudication is off. The boot log names the keys: `llmBaseUrl` and `llmModel`.

**The panel tab is missing.** `dsh-better-sidebar` is not installed or not yet loaded. Check the browser console for a `loop-watchdog` line, and that better-sidebar's own tab bar works.

**The panel says "ledger-missing".** The watchdog has not written yet, or the panel and the host disagree on `ledgerFile` — they read the same row's config, so check that the path exists and is writable by the dsh user.

## Development

Plain ESM, no build step:

```sh
node --test packages/loop-watchdog/test/*.test.mjs    # decisions, reading V4 events, ledger, config, client contract
node scripts/verify.mjs --package dsh-loop-watchdog   # release contract
node scripts/compose-smoke.mjs loop-watchdog          # real dsh composition
node scripts/check-plugin-hooks.mjs                   # React hook-order gate for the client half
```

`src/decide.mjs`, `src/summarize.mjs`, `src/ledger.mjs` and `src/config.mjs` hold every decision worth testing and import nothing from dsh. `src/host.mjs` is the Cordis wiring; `src/client.mjs` is the browser half. The tests that need `@deepseek-ai/dsh-llm` (the host wiring, parity with the harness's own constructors) skip on a bare clone. See [`../../docs/authoring.md`](../../docs/authoring.md).

## License

MIT
