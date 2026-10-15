# dsh-continue-kicker

**Automatically send "continue" when a turn halts, and stop when that is not helping.**

A host-plane plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). A session that hits its output-token limit just stops, silently, until somebody notices. This plugin notices: it sends one follow-up user message that tells the model to stop re-deriving its reasoning and act, and it gives up after a configurable number of kicks with no progress in between, so a task genuinely too big for its budget surfaces in the log instead of burning GPU-hours.

## What it kicks on

| Halt | Detected as | Kick |
| --- | --- | --- |
| Output budget exhausted | last `turn/end` reason `max-tokens` | "Do NOT re-derive your thinking: state your conclusion, then act. Be succinct." |
| Reasoning-only empty stop | `completed` turn whose final assistant message has no text and no tool call, with at least `emptyCompletionMinReasoningChars` of reasoning | Same "be decisive" framing |
| Failed turn (opt-in: `kickOnError`) | last `turn/end` reason `error` (the model backend dropped, a provider error) | "The previous turn failed with an error and was cut off before it finished. Please continue from where you left off." |
| Crash-orphaned turn | last `turn/end` reason `interrupted` (synthesized when a session is loaded) | "Please continue from where you left off." |

It never kicks over `aborted` (an explicit Stop, a parent or hook cancel, a disposal), `error` unless `kickOnError` is on, `blocked`, `forked`, a completed turn with real content, or a tail already followed by a user or assistant message.

Two doors feed one decision: `agent/created` (reopening a session, crash recovery) and a live watcher that re-analyses the tail `liveKickDelayMs` after every turn end, so an unattended halt is caught without anyone reopening the session.

## Install

Installed from a git tag of this repository — it is not published to npm. Replace `<version>` with a released version (tags are named `dsh-continue-kicker-v<version>`; see [the tag list](https://github.com/chrisjohnson/dsh-plugins/tags)):

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-continue-kicker-v<version>&path:/packages/continue-kicker"
```

That installs the package into the profile and enables its bundle. If you manage the profile's `package.json` yourself, the pnpm equivalent is below — then also add `dsh-continue-kicker` to the profile's `dsh.profile.bundles`, because `pnpm add` alone installs the plugin without enabling it:

```sh
pnpm add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-continue-kicker-v<version>&path:/packages/continue-kicker"
```

> **Warning:** never `pnpm add dsh-continue-kicker` (or `dsh plugin add dsh-continue-kicker`) by bare name. That resolves from the npm registry, where an unscoped `dsh-*` name may belong to an unrelated author and is **not** this plugin.

Restart dsh. With no configuration it works with the defaults below.

## Configuration

Set these on the plugin's row in your own profile patch (`config:` block). **A top-level row with a `config:` block replaces the whole config object**, so list every key you want to differ from the default in the same row; unlisted keys fall back to the defaults below. The bundle's own layer carries no config for the same reason.

| Key | Default | What it does |
| --- | --- | --- |
| `cooldownMs` | `60000` | Minimum time between kicks for the same session. |
| `liveKickDelayMs` | `3000` | Delay between a live turn end and the tail re-analysis. Lets a fast manual recovery land first. |
| `maxConsecutiveKicks` | `5` | Runaway guard: after this many kicks with no completed turn and no genuine user message in between, the plugin stops kicking that session and logs an error. `0` disables kicking entirely, quietly (the `kickOn*` flags are the finer-grained off switches). |
| `kickOnInterrupted` | `true` | Kick crash-orphaned turns. |
| `kickOnMaxTokens` | `true` | Kick output-token-limit halts. |
| `kickOnEmptyCompletion` | `true` | Kick reasoning-only completed turns. |
| `kickOnError` | `false` | Kick turns that ended with `reason.kind: 'error'`. Off by default because blindly retrying a failing backend can loop; the runaway guard and cooldown bound it. You would want it for unattended work on a backend that drops now and then (a gateway restart, a network blip): the session resumes by itself once the backend is back instead of sitting dead until someone notices. |
| `includeSubagents` | `false` | Also kick delegated child sessions (`origin: subagent` or `delegationDepth > 0`). Off by default: auto-kicking a child fights the parent's own delegation and retry flow. |
| `emptyCompletionMinReasoningChars` | `500` | Reasoning length below which a content-empty completed turn is left alone. |
| `interruptedKickText` | built in | Text sent for an interrupted turn. |
| `maxTokensKickText` | built in | Text sent for a max-tokens halt. Forbids re-deriving the lost reasoning; a plain "please continue" invites another long think straight back into the wall. |
| `emptyCompletionKickText` | built in | Text sent for a reasoning-only empty stop. |
| `errorKickText` | built in | Text sent for a failed turn when `kickOnError` is on. |

Resolution lives in [`src/config.mjs`](./src/config.mjs) and is [tested](./test/config.test.mjs). An unknown key, a string where a number belongs, or an empty text prints one warning at boot and falls back to the default.

Example row (the default for `maxConsecutiveKicks` is 5; 3 here is just an example):

```yaml
- id: continue-kicker
  name: dsh-continue-kicker
  config:
    cooldownMs: 60000
    liveKickDelayMs: 3000
    maxConsecutiveKicks: 3
    kickOnInterrupted: true
    kickOnMaxTokens: true
    kickOnEmptyCompletion: true
    kickOnError: true
    includeSubagents: false
```

## Which turn-end reasons kick

From `TurnEndReasonMap` in `@deepseek-ai/dsh-session`:

| `reason.kind` | Meaning | Kicked? |
| --- | --- | --- |
| `max-tokens` | output budget hit | yes, `kickOnMaxTokens` |
| `interrupted` | crash-orphaned turn closed on load | yes, `kickOnInterrupted` |
| `completed` | model stopped itself | only a reasoning-only empty one, `kickOnEmptyCompletion` |
| `error` | the turn failed (`error` holds message and code) | yes, only with `kickOnError` |
| `aborted` | cancelled on purpose (`user`, `parent`, `hook`, `disposed`, `legacy`) | never |
| `blocked` | a step was rejected before running | never |
| `forked` | fork-seed marker, never emitted live | never |

## The runaway guard

A kick can itself end in the same halt. The plugin counts kicks per session (max-tokens, empty-completion and error flavors share one counter; an interrupted-turn kick does not count). The counter resets when a **completed turn** or a **genuine user message** is observed at the tail. "Genuine" means a message whose source is `user`: the plugin's own kick (source kind `plugin:continue-kicker`) and any other producer's user-role message (goals, other plugins) never reset it. At `maxConsecutiveKicks` the plugin logs an error naming the session and stops until a reset signal arrives.

The kick is written with source kind `plugin:continue-kicker`. Session format V4 refuses the bare kind `plugin`, so a session carrying such a message could not be reopened after a restart.

## Logging

Every decision, kick or skip, is logged with its reason: `journalctl -u dsh | grep continue-kicker` answers "why didn't it fire".

## Compatibility

Requires dsh 0.2.0-rc.2 or later. Declared in `package.json` under `engines.dsh` and on every `@deepseek-ai/dsh*` peer as `>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0`. dsh checks these ranges itself, counting prereleases, so it accepts every harness build from 0.2.0-rc.2 on; on a harness outside them `dsh plugin add` refuses the install, and a profile that already has it skips the bundle with a log line. pnpm's own peer check is narrower: it admits only `0.2.0-rc.*` and `0.3.0-*` prereleases (plus every stable release from 0.2.0), so on other prereleases it reports a peer mismatch that dsh does not.

## Development

```sh
node --test packages/continue-kicker/test/*.test.mjs   # decisions + config
node scripts/verify.mjs --package dsh-continue-kicker  # release contract
node scripts/compose-smoke.mjs continue-kicker         # real dsh composition
```

`src/decide.mjs` and `src/config.mjs` import nothing from dsh; `src/host.mjs` is the thin Cordis wiring. See [`../../docs/authoring.md`](../../docs/authoring.md).

## License

MIT
