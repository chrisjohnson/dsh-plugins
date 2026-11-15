# dsh-take-a-number

Global model-call queue for DeepSeek Harness. Every model call this dsh instance makes
— an interactive turn, a subagent's, a title, a compaction — takes a number in its GPU's
FIFO queue on the machine's **take-a-number** daemon, runs under a lease stamped with a
per-process identity, and releases. Unmapped providers (cloud routes) pass straight
through. The daemon is the single source of truth for the whole box, so the Activity
panel this plugin serves shows **box-wide** activity: every dsh instance, opencode, and
anything else that gates through the same daemon.

This is the dsh landing zone for take-a-number. The daemon, client library, CLI and
standalone dashboard live in [`chrisjohnson/take-a-number`](https://github.com/chrisjohnson/take-a-number).

## Install

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-take-a-number-v0.1.1&path:/packages/take-a-number"
```

## Configuration

The bundle layer ships an empty `config:` block; the plugin resolves
`config → environment → documented default`. Every key is optional.

| Key        | Env         | Default                       | Meaning                                                        |
| ---------- | ----------- | ----------------------------- | -------------------------------------------------------------- |
| `enabled`  | —           | `true`                        | `false` mounts the plugin without gating (inspection mode).    |
| `sock`     | `TAN_SOCK`  | `/run/take-a-number/tan.sock` | UDS path of the take-a-number daemon.                          |
| `tcp`      | `TAN_TCP`   | `127.0.0.1:4100`              | TCP fallback; must be loopback.                                |
| `queues`   | —           | `[]`                          | `[{provider, queue}]` — which daemon queue a provider route uses. |

Example (the local-ai-machine deployment):

```yaml
- id: take-a-number
  config:
    queues:
      - provider: local-ai-machine (apu)
        queue: strix-apu
      - provider: local-ai-machine (eGPU)
        queue: r9700-egpu
```

A provider with no `queues` entry is **not gated** — its calls pass through, exactly like
an unmapped model on the daemon. Queue limits and the queue→GPU mapping live in the
daemon's own config (`/etc/take-a-number/config.json`), not here.

## Kind mapping

The daemon tags every lease with a `kind`. This plugin maps dsh's
`llm/stream` `options.purpose` onto the canonical kinds in `KIND_MAP`
(`src/gate.mjs`): `turn`/`interactive-turn` → `interactive-chat`, `subagent`, `judge`,
`title`/`set-title`, `compaction`/`compact`, `generate`, `image-gen`; anything absent or
unrecognized falls back to `call`.

**Observed on dsh 0.2.2-rc.1:** `llm/stream` does not pass a `purpose` (or any sibling
field carrying the call's intent) — every call, including interactive turns, titles and
compactions, arrives with none, so today **all acquires are `kind: "call"`**. The
description still carries the session title and turn number, which is what the dashboard
surfaces; the map is the seam for when dsh starts distinguishing call kinds.

The daemon's loopback defaults (`/run/take-a-number/tan.sock`, `127.0.0.1:4100`) are a
deliberate universal default for the box this plugin was built for; override with `sock`/
`tcp` (or `TAN_SOCK`/`TAN_TCP`) anywhere else.

## What the plugin does

- **Gate** — a global `llm/stream` listener (prepended) wraps every model call. Mapped
  providers acquire through the daemon: granted immediately, or queued in strict FIFO
  order. The lease is released when the stream ends, fails, or is aborted; aborting while
  queued cancels the waiter.
- **Identity** — the daemon sees this instance as `dsh/<instance>#<pid>@<host>`, where
  `instance` is `web` for the production profile and `lab-<name>` for a lab (derived from
  `DSH_HOME` under a `dsh-lab/<name>` root). Connection lifetime = identity lifetime: a
  crashed dsh frees its leases instantly.
- **Metadata** — each acquire carries `kind` (from `options.purpose` when dsh provides
  one; `call` today), a composed `description` (`interactive-chat · turn 7 · "Fix the
  deploy script"`), `session`, `sessionTitle`, and `turn`, so the dashboard and audit
  answer "what is that?" without a second lookup.
- **Composer dock** — when *this session's* main call is queued, a banner above the
  composer shows the queue, position, and elapsed wait, with a Cancel.
- **Activity panel** — sidebar "Activity" (badge per queue) + a full page: per-queue
  capacity bars, 60 s busy graphs, active leases and FIFO waiters with identities and
  descriptions, cancel / force-release actions. Fed by the daemon's live stream through
  the host; falls back to polling if the stream cannot be held.
- **Fail-open** — when the daemon is unreachable, model calls pass through after ~300 ms
  (the panel says "passing through"). The queue is an optimization, never a dependency.

## Failure modes

| Situation                                | Behaviour                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| Daemon down at boot                      | Gate degrades to pass-through; reconnects with back-off; logs once.     |
| Daemon dies mid-call                     | In-flight calls keep running (the lease is server-side); next acquire degrades. |
| dsh process dies                         | Connection closes → daemon releases its leases, cancels its waiters.    |
| `dsh-model-capacity` also mounted        | This plugin **refuses to gate** (logged at boot) to avoid double-queueing; the panel still works. Remove the `model-capacity` row to hand gating over. |
| Provider not in `queues`                 | Pass-through, no daemon round-trip.                                     |
| `enabled: false`                         | Inert: no gating, panel still renders.                                  |

## Checks

- `node --test test/*.test.mjs` — config resolution, instance derivation, and the gate
  (pass-through, metadata, degraded, rejection, describe-failure) against injected fakes.
- `npm run check` (repository) — installability, README git-tag line, docs parity, no
  deployment leaks, the one harness peer range, and the React Rules-of-Hooks gate over
  the browser half.
