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

Two doors feed one decision: `agent/created` (reopening a session, crash recovery) and a live watcher that re-analyses the tail `liveKickDelayMs` after every turn end, so an unattended halt is caught without anyone reopening the session. A third door is explicit: another plugin can ask for one kick of one session through the [`continueKicker` service](#provided-service-continuekicker), which runs the same decision and applies the same guards.

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
| `maxConsecutiveKicks` | `5` | Runaway guard: after this many kicks (all flavors together, counted from the session's event log) with no normally completed turn and no genuine user message in between, the plugin stops kicking that session and logs an error. `0` disables kicking entirely, quietly (the `kickOn*` flags are the finer-grained off switches). |
| `kickOnInterrupted` | `true` | Kick crash-orphaned turns. |
| `kickOnMaxTokens` | `true` | Kick output-token-limit halts. |
| `kickOnEmptyCompletion` | `true` | Kick reasoning-only completed turns. |
| `kickOnError` | `false` | Kick turns that ended with `reason.kind: 'error'`. Off by default because blindly retrying a failing backend can loop; the runaway guard and cooldown bound it. You would want it for unattended work on a backend that drops now and then (a gateway restart, a network blip): the session resumes by itself once the backend is back instead of sitting dead until someone notices. |
| `includeSubagents` | `false` | Also kick delegated child sessions (`origin: subagent` or `delegationDepth > 0`). Off by default: auto-kicking a child fights the parent's own delegation and retry flow. |
| `logToStderr` | `false` | Write this plugin's log lines to stderr (see Logging). Needed to see them at all on dsh 0.2.0-rc.2. |
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
    logToStderr: true
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

A kick can itself end in the same halt, so the plugin counts kicks and stops at `maxConsecutiveKicks`.

The count is derived from the session's own event log on every analysis, not kept in memory, so it survives a dsh restart and the live and reopen paths always agree. It is the number of this plugin's kick messages (source kind `plugin:continue-kicker`; the retired bare `plugin` kind counts only when it names this plugin and carries one of the known kick texts) found walking back from the end of the log, up to the nearest reset signal:

- a **genuine user message**: source kind `user` and nothing else. The plugin's own kicks and any other producer's user-role messages (goals, other plugins) neither reset nor count.
- a turn that **completed normally**. A reasoning-only completion is a kickable halt, not progress, so it does not reset.

Every flavor counts together: max-tokens, empty-completion, error and interrupted. So the cap also bounds a crash loop: a session that keeps getting killed mid-turn and resumed stops being resumed after `maxConsecutiveKicks` kicks until a user message or a completed turn arrives. At the cap the plugin logs an error naming the session ("needs human attention") and does not kick. Only the cooldown timestamp is in memory; a restart forgets it, which at worst allows one extra kick that the stateless cap still bounds.

Changed from 0.1.0: the old reset fired only when a genuine user message was the *last* event, but a halted turn always ends in `turn/end`, so a new prompt after the cap never reset it; the count lived in memory and was lost on restart; and interrupted kicks were not counted at all.

The kick is written with source kind `plugin:continue-kicker`. Session format V4 refuses the bare kind `plugin`, so a session carrying such a message could not be reopened after a restart.

## Provided service: `continueKicker`

Besides watching sessions on its own, the plugin provides a service named `continueKicker` so another plugin that owns a session's lifecycle can ask for one explicit recovery kick instead of waiting for the automatic doors. `dsh-kanban` uses it: when a role turn halts, the engine asks for a kick and waits for the result, so the recovery is part of the workflow rather than something that happens to a parked session.

```js
const kicker = ctx.get('continueKicker')   // undefined when this plugin is not installed
```

| Member | Shape | Meaning |
| --- | --- | --- |
| `version` | `1` | the contract version. It goes up only on a breaking change; a consumer that sees an unknown version should treat the details as unreliable. |
| `kick(sessionId, options?)` | `(string, { bypassCooldown?: boolean }) => result` | runs one decision for one live session and sends the kick if it is due. Synchronous; never throws. |

`kick` returns one of:

| Result | When |
| --- | --- |
| `{ kicked: true, flavor, consecutive }` | a kick was sent. `flavor` is `max-tokens`, `interrupted`, `empty-completion` or `error`; `consecutive` is this kick's number in the runaway count. |
| `{ kicked: false, why }` | nothing was sent: the session is not live, its tail is not a kickable halt, the halt's `kickOn*` switch is off, the session is an excluded subagent, or the cooldown is running. |
| `{ kicked: false, why, stopped: true }` | the runaway guard declined: this session has already had `maxConsecutiveKicks` kicks with no progress and needs a human. |

The service is the **same decision, not a second one**: `kick()` runs `decide()` over the session's own event log with this plugin's resolved settings, sends the same message with the same `plugin:continue-kicker` source kind, records the same cooldown, and is bounded by the same runaway counter. A caller therefore gets the plugin's policy instead of a private copy of it, and the automatic doors keep working alongside it — a kick sent through the service lands in the log like any other, so the watcher's delayed re-analysis of the same halt sees a kick already awaiting its result and does nothing.

`bypassCooldown: true` opens only the cooldown gate. It exists because a caller that just watched a turn fail is asking for recovery, not re-analysing a halt it kicked a second ago; every other gate (the per-kind switches, the subagent scope, `maxConsecutiveKicks`) still applies.

**The service is optional for the consumer.** A caller must resolve it lazily (`ctx.get` at use time, not at boot), duck-type `typeof kicker?.kick === 'function'`, and degrade to its own behaviour when it is absent — the same rule `dsh-kanban` follows for the `betterGitWorktree` service. Nothing here requires a caller: with no consumer installed the plugin behaves exactly as before.

## Logging

Every decision, kick or skip, is logged with its reason, through the host logger under the name `continue-kicker`.

**Where those lines go (dsh 0.2.0-rc.2):** nowhere you can read. The harness registers no console or file exporter on the logger; plugin lines only land in an in-memory ring buffer (`ctx.logger.buffer`, 1000 entries) that nothing displays, and only startup warnings and errors are surfaced, inside a startup failure. So `journalctl -u dsh | grep continue-kicker` finds nothing by default. Set `logToStderr: true` and the plugin registers its own exporter that writes only its own lines to stderr, which a service manager (journald under systemd) captures:

```
2026-10-15T18:28:05.590Z INFO continue-kicker created: kicked session s1 (flavor=max-tokens, consecutive=1)
```

The kick itself is also visible in the conversation as a notice row ("Auto-resumed after a max-tokens halt (2/5)"), but the "needs human attention" error at the cap appears only in the log. A general fix (surface plugin logs in the harness) belongs upstream or in a separate plugin.

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
