# dsh-model-switch

**Let the agent change its own model mid-session — and make it impossible to strand the conversation on a model too small to read it.**

Two tools and two interface surfaces for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), built for deployments that route the same session across models with wildly different context windows (a 1M-token cloud route and a 262k local one, say):

| What | Who | What it does |
| --- | --- | --- |
| `switch_model` tool | agent | Moves this session to `provider/model` and sends it a self-contained handoff message. Full history carries over. |
| `switch_model_escalate` tool | agent | "I'm stuck" escape hatch to a route **you** designate. The model does not choose the destination — deployment policy does. |
| Context badge | human | Appears beside the composer's model picker the moment the routed model cannot hold the session — amber `210k / 262.1k — compacts at 209.7k`, or red `300k > 262.1k — won't fit`. Its tooltip lists the routes that still fit, and clicking it is how you open the repair panel below. |
| Repair panel | human | Collapsed by default, because past the auto-compact line nothing fails: the next request compacts on the route that can still read it. Click the badge for one-click repair — move to a route that can read the transcript, compact there, return. The one case that cannot wait for a click (past the route's own window, where the next request 400s and overflow recovery summarises with the route that just overflowed) opens itself once. |

The guard applies to the agent's tools **and** the human's picker. It has to be in both places, for a reason that is not obvious: the composer calls `sessionController.selectModel` directly and cannot be intercepted, so the interactive path is warned-and-repaired rather than blocked.

## Why this exists

A real session, 2026-09-28. It had run to ~421k tokens on a route with a 1,048,576-token window. The user switched it to a local model with a 262,144-token window and sent one message:

```
attempt 1  → Request timed out.
attempt 2  → 400 ContextWindowExceededError: request (420948 tokens)
             exceeds the available context size (262144 tokens)
compaction/start   ← the harness classified it and started overflow recovery
compaction/end     ← error: the same 400, at 421,300 tokens
retry              → same 400 → surfaced to the user
```

Two harness behaviours combine to make that unrecoverable:

1. The pre-step pressure gate resolves its target from the **last minted request**, which right after a switch is still the *old* model — so the threshold it compares against is 0.8 × 1,048,576, nothing compacts, and the first request on the new, smaller route is structurally unguarded.
2. Overflow recovery summarizes with the **route that just overflowed**. The rescue call had to push 421k tokens through a 262k model.

A model must *read* a conversation in order to summarize it. That is a physical ceiling, not a tuning problem: the only moment a 421k session can be condensed is while a big-window model is still routed. Hence the rule this plugin enforces — **compact to fit before switching, and refuse with actionable numbers when even that is impossible.**

Every number in the refusal messages is deliberate. A model told "cannot switch" tries again; a model told "delegate this to a local subagent, or pick a larger-window route, here are the token counts" stops burning turns on it.

## Install

Installed from a git tag of this repository — it is not published to npm. Replace `<version>` with a released version (tags are named `dsh-model-switch-v<version>`; see [the tag list](https://github.com/chrisjohnson/dsh-plugins/tags)):

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-model-switch-v<version>&path:/packages/model-switch"
```

That installs the package into the profile and enables its bundle. If you manage the profile's `package.json` yourself, the pnpm equivalent is below — then also add `dsh-model-switch` to the profile's `dsh.profile.bundles`, because `pnpm add` alone installs the plugin without enabling it:

```sh
pnpm add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-model-switch-v<version>&path:/packages/model-switch"
```

> **Warning:** never `pnpm add dsh-model-switch` (or `dsh plugin add dsh-model-switch`) by bare name. That resolves from the npm registry, where the package called `dsh-model-switch` belongs to an unrelated author and is **not** this plugin.

Restart dsh. With no configuration you get `switch_model`, the fit guard, the pill and the banner. `switch_model_escalate` is **not** offered until you designate the escalation route — see below.

## Configuration

Set these on the row in your own profile patch (`config:` block), or via your deployment's equivalent:

| Key | Default | What it does |
| --- | --- | --- |
| `escalationProvider` + `escalationModel` | *unset* | Where `switch_model_escalate` hands the session. **Unset means the tool is not registered at all** — a model that cannot see it will not reach for it, which beats a tool whose every call fails. |
| `readerProvider` + `readerModel` | *unset* | A route whose window can read the whole conversation. The one-click repair moves there, compacts, and returns. Without it the repair refuses and says exactly what to configure. |
| `preferredRoutes` | `[reader]` | Ordered `provider/model` recommendations when a conversation outgrows its route. Needed because "smallest window that still fits" often lands on a different provider that merely declares the same number. |
| `fitRatio` | `0.8` | Fraction of a destination window treated as usable. It is dsh-compaction-basic's own default compaction point, so the guard agrees with what the harness would do anyway. |
| `summaryReserveTokens` | `10000` | Room left for the summary checkpoint compaction writes. |
| `autoCompact` | `true` | When `false`, the guard never compacts on its own: a too-big switch is refused with the `/compact` instruction instead. |

Compaction retries are fixed internal limits, not configuration (`maxRegionAttempts` is 8 and `maxCompactionAttempts` is 3; setting either in the row is ignored with an unknown-key warning).

Resolution lives in [`src/config.mjs`](./src/config.mjs) and is [tested](./test/config.test.mjs). It is stricter than most plugins on purpose: a misspelled key, a YAML `"0.8"`, or an escalation provider with no model each print one warning at boot, because a misconfiguration you see once is worth much less debugging than one you discover at the first switch.

Example, on a deployment with a cloud big-window route and a local workhorse:

```yaml
- id: model-switch
  name: dsh-model-switch
  config:
    escalationProvider: cloud
    escalationModel: cloud-frontier
    readerProvider: cloud
    readerModel: cloud-long-context
    preferredRoutes:
      - cloud/cloud-long-context
      - cloud/cloud-frontier
```

## How the guard decides

`switch_model` measures the session (via dsh's replay-based token meter — no model call), resolves the destination window, and picks one of five outcomes in [`src/fit.mjs`](./src/fit.mjs):

| Situation | Outcome |
| --- | --- |
| No measurement, or the destination declares no window | **allow** with a note. The guard never blocks a switch it cannot evaluate. |
| Fits under the margin | **allow** |
| Doesn't fit, and the current route cannot compact it (transcript over `fitRatio` of its window) | **refuse**, with token counts and the delegate-to-subagent alternative |
| Doesn't fit, `autoCompact: false` | **refuse**, with the `/compact` instruction |
| Doesn't fit but is compactable here | **compact first**, re-measure, then allow — reporting how much was freed |

One subtlety that cost a bug each way: the *fit* margin (0.8) decides whether to compact, while "can this route read the transcript" uses the **route's own window**. Using the margin for both meant a session at 85% of its own window was shipped off to another route and back for a compaction it could have done itself.

## Compatibility

Requires dsh 0.2.0-rc.2 or later. Declared in `package.json` under `engines.dsh` and on every `@deepseek-ai/dsh*` peer as `>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0`. dsh checks these ranges itself, counting prereleases, so it accepts every harness build from 0.2.0-rc.2 on; on a harness outside them `dsh plugin add` refuses the install, and a profile that already has it skips the bundle with a log line. pnpm's own peer check is narrower: it admits only `0.2.0-rc.*` and `0.3.0-*` prereleases (plus every stable release from 0.2.0), so on other prereleases it reports a peer mismatch that dsh does not.

## Session format

The handoff message this plugin steers into a session after a switch carries
`source: { kind: 'plugin:model-switch', form: 'notice', summary }`. dsh 0.2.0
sessions (format V4) reject the shared `'plugin'` kind on read, so the producer name
lives in `kind`. Sessions written by dsh 0.1.x with the old kind are rewritten to
this same value by dsh's own migrator.

## Troubleshooting

**"switch_model_escalate" is not offered.** Expected until `escalationProvider`/`escalationModel` are set. The boot log says so.

**A switch was refused that should have worked.** Read the numbers in the refusal. If it says the current route cannot read the conversation, that is real: ask for a compact while still on a big-window route, or delegate to a subagent (which starts with a fresh, small context) instead.

**The pill/banner shows nothing.** It needs a *routed request* — a session that has not sent a message yet has no measurement. It also needs the plugin's client half to load: check the browser console for a `slot entry crashed` line naming this plugin.

**The repair button is missing.** Repair needs compaction reachable through `dsh-compaction-basic` (or the `/compact` command). A profile without compaction composed cannot offer it.

## Development

Plain ESM, no build step:

```sh
node --test packages/model-switch/test/*.test.mjs    # fit guard + config resolution
node scripts/verify.mjs --package dsh-model-switch   # release contract
node scripts/compose-smoke.mjs model-switch          # real dsh composition
node scripts/check-plugin-hooks.mjs                  # React hook-order gate for the client half
```

`src/fit.mjs`, `src/config.mjs`, `src/notice.mjs` and `src/guard.mjs` (services injected) hold every decision worth testing and import nothing from dsh, which is what lets the suites run on a bare `git clone`. `src/host.mjs` is the Cordis wiring; `src/client.mjs` is the browser half. See [`../../docs/authoring.md`](../../docs/authoring.md).

## License

MIT
