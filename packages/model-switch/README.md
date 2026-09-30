# dsh-model-switch

**Let the agent change its own model mid-session — and make it impossible to strand the conversation on a model too small to read it.**

Two tools and two interface surfaces for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), built for deployments that route the same session across models with wildly different context windows (a 1M-token cloud route and a 262k local one, say):

| What | Who | What it does |
| --- | --- | --- |
| `switch_model` tool | agent | Moves this session to `provider/model` and sends it a self-contained handoff message. Full history carries over. |
| `switch_model_escalate` tool | agent | "I'm stuck" escape hatch to a route **you** designate. The model does not choose the destination — deployment policy does. |
| Context pill | human | A quiet `ctx 421k` beside the composer's model picker that turns amber with `421k / 262k` the moment the routed model cannot hold the session. Tooltip lists the routes that still fit. |
| Repair banner | human | When the window is exceeded, one click: move to a route that can read the transcript, compact there, return. |

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

```sh
dsh plugin --profile web add dsh-model-switch
```

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
| `maxRegionAttempts` | `8` | Bounded retries when a chosen compaction boundary is rejected by the service. Rarely worth changing. |
| `maxCompactionAttempts` | `3` | Outer attempts: if one compaction did not free enough, shrink the retained tail and try again. Rarely worth changing. |

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
| Doesn't fit, and the current route cannot read the transcript | **refuse**, with token counts and the delegate-to-subagent alternative |
| Doesn't fit, `autoCompact: false` | **refuse**, with the `/compact` instruction |
| Doesn't fit but is compactable here | **compact first**, re-measure, then allow — reporting how much was freed |

One subtlety that cost a bug each way: the *fit* margin (0.8) decides whether to compact, while "can this route read the transcript" uses the **route's own window**. Using the margin for both meant a session at 85% of its own window was shipped off to another route and back for a compaction it could have done itself.

## Compatibility

Declared in `package.json` under `engines.dsh`, with the explicit prerelease branch (`>=0.1.5-rc.1 <0.1.6-0 || >=0.1.6-0`) — without that branch, node-semver quietly excludes every `-rc` build of the harness and users hit an `ERESOLVE` at install.

## Troubleshooting

**"switch_model_escalate" is not offered.** Expected until `escalationProvider`/`escalationModel` are set. The boot log says so.

**A switch was refused that should have worked.** Read the numbers in the refusal. If it says the current route cannot read the conversation, that is real: ask for a compact while still on a big-window route, or delegate to a subagent (which starts with a fresh, small context) instead.

**The pill/banner shows nothing.** It needs a *routed request* — a session that has not sent a message yet has no measurement. It also needs the plugin's client half to load: check the browser console for a `slot entry crashed` line naming this plugin.

**The repair button is missing.** Repair needs compaction reachable through `dsh-compaction-basic` (or the `/compact` command). A profile without compaction composed cannot offer it.

## Development

Plain ESM, no build step:

```sh
node --test packages/model-switch/test/*.test.mjs    # fit guard + config resolution
node scripts/verify.mjs --package dsh-model-switch   # publish contract
node scripts/compose-smoke.mjs model-switch          # real dsh composition
node scripts/check-plugin-hooks.mjs                  # React hook-order gate for the client half
```

`src/fit.mjs` and `src/config.mjs` hold every decision worth testing and import nothing from dsh, which is what lets the suites run on a bare `git clone`. `src/host.mjs` is the Cordis wiring; `src/client.mjs` is the browser half. See [`../../docs/authoring.md`](../../docs/authoring.md).

## License

MIT
