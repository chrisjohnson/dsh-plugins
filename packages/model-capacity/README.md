# dsh-model-capacity

**Process-wide, per-provider model-call capacity for DeepSeek Harness.**

One host plugin gates every `ctx.llm.stream()` call — interactive turns, subagent
children, judges, titles and compaction — with a per-provider counting semaphore.
Every call waits in the same strict FIFO queue for its provider, in arrival
order, whoever started it. The Host exposes a Capacity panel with active leases
and queued calls.

Nothing here is per-session or per-browser. It is one service in the DSH host
process, shared by all sessions.

## Install

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-model-capacity-v<version>&path:/packages/model-capacity"
```

Or add the same git spec to the profile's `package.json` and list
`dsh-model-capacity` in `dsh.profile.bundles`. The bundle mounts row
`id: model-capacity`. The row carries **no config**; write the complete section
in your own profile patch (a patch layer replaces a row's whole `config`).

## Config

```yaml
- id: model-capacity
  config:
    enabled: true
    defaultMaxConcurrent: 1
    limits:
      - provider: gpu-a
        maxConcurrent: 2
      - provider: gpu-b
        maxConcurrent: 2
      - provider: cloud-proxy
        unlimited: true
    queueLimitPerProvider: 1000
```

| Key | Meaning |
|---|---|
| `enabled` | `false` makes the gate inert while keeping the panel available. |
| `defaultMaxConcurrent` | Limit for a provider with no `limits` entry. Unknown providers therefore admit one call at a time. |
| `limits[]` | `{provider, maxConcurrent}` or `{provider, unlimited: true}`. Capacity is **per provider**, because a provider is the physical backend a deployment split its GPUs into. Every model id behind one provider shares its slots. `unlimited: true` means no queue and no rejection for that route (intended for a cloud proxy). |
| `queueLimitPerProvider` | Bound on queued calls per provider; exceeding it rejects new calls with `CAPACITY_QUEUE_FULL` instead of growing memory forever. |

`reservationTtlMs` and `subagentTools` were config keys up to and including 0.3.0.
They are gone: a deployment that still carries them boots with one
`unknown config key "…" (ignored)` warning per key.

Every provider named in `limits` has a visible queue even at `0/limit`, and the
deployment's default model provider is seeded the same way; other providers
appear on first use. Adding both of your provider routes to `limits` is the
simplest way to see two queues in the panel.

Limits are validated against `ctx.llm.listProviders()` when adapters register; a
limit naming a route the host never offers is logged loudly (the configured limit
still applies if it appears). The config is watched through the host
`configEditor` and swapped atomically; an invalid reload keeps the previous
limits.

The Activity page's **Adjust limits** dialog edits these fields directly. Saving
writes the complete limits section back through `configEditor.edit`, applies the
new manager limits immediately, and persists the change in the profile YAML.

## Behavior

| Caller | Behavior |
|---|---|
| Ordinary prompt / any session model call | `llm/stream` waits for a slot before the adapter sees the request. The session stays `running`; the composer dock shows position, provider/model and elapsed time, with **Cancel turn**. There is no plugin-level timeout. |
| `subagent` / `subagent_fork` / `spawn_teammate` / `workflow` | No special path. A dispatch is never refused for capacity: the child's own calls go through the same global gate and queue FIFO behind whatever is already waiting for that provider. The parent sees the tool as running for the child's whole wait-plus-run time. |
| Kanban | Uses the same global gate per call. It no longer owns a semaphore, leases or capacity checks; `wipCap` only bounds how many tickets are in `Now`. |

`unlimited: true` providers never enter the FIFO; the panel labels them
`unlimited`.

Because the wait happens **before** `next()` reaches the provider adapter, the
provider's `streamIdleTimeoutMs` does not start until a slot exists.

### Why the subagent preflight was removed

Up to 0.3.0 an agent-spawning tool asked for a slot before its child existed,
returned a model-visible capacity error when the provider was full, and handed
that reservation to the child's first call. It cost a synchronous guess at the
child's route, a TTL timer for reservations whose child never arrived, and a
second admission path that could jump the queue this gate exists to enforce.

A dispatch is not an inference call. What is being protected is the hardware
behind a provider route, and every request that reaches it already passes
through this gate — a subagent child's included. So the gate is the whole
mechanism: nothing holds a slot unless a stream is live, and one queue orders
everything. The trade is that a busy provider no longer tells the model "do not
bother dispatching"; the child simply waits, visibly, in the same queue.

### Session-log wait history

Every queued main call that waited more than 250 ms is recorded in memory with
its provider, model, turn number and duration. A `conversation.chat.turnTail`
entry renders those waits beneath the turn in the chat log as a small collapsible
card:

```
Waited for capacity  24s  1 wait
  local-ai-machine (apu)/medium-dense        24s
```

This is client-only and never written to the session log or model context, so it
does not perturb the conversation. The history is per host process (a restart
clears it) and covers main calls only; title/compaction waits and judge calls are
not recorded.

### Composer dock width

The queued-session banner uses the same width calculation as the core composer
dock (`--dsh-composer-side-clearance` / `--dsh-composer-card-max-width`), so it
aligns with the message column instead of spanning the full viewport. This is what
makes multi-hour waits safe for a machine that thinks for hours.

The gate is in-process: a host restart clears all leases and waiters (their turns
are already interrupted by the restart). No database is used.

## Panel

- The **Activity** sidebar entry carries one tiny round pill per provider in
  real time, rendered after the word `Capacity`. The left number is **active +
  queued** demand, so a full provider with one call waiting reads `3/2`; an
  unlimited provider reads `3/∞`. Pills use a light tinted fill with a darker
  border and text: green while there is free capacity, yellow when exactly at
  capacity, red when anything is queued. Hovering a pill names the provider
  (`local-ai-machine (apu): 3/2 · 2 active · 1 queued`). The collapsed rail hides
  the pills because the 36 px rail cannot fit them without overlapping the icon.
- `sidebar.panellist` entry **Activity** → a Context-tab-like full page: header
  with live enforcing status, KPI cards (active / queued), and one
  colour-accented card per provider with a capacity bar. Each active or queued
  call is a session card showing title, workspace, model, kind and elapsed/waited
  time. **Click any session card to open that session**; active cards breathe with
  a green glow. The page uses the
  same card/hover language as `dsh-context`'s Context overview. Session titles come from
  the session log's `title` projection; workspace names come from the workspace
  registry, matched by the session's cwd.
- The Activity page animates handover, because a list that silently re-shuffles is
  unreadable. Each poll diffs a provider against the one before it: a lease that
  left Active is re-rendered in its old position as an inert ghost clone that
  scales up and fades out (~350 ms); a session that moved from Queue to Active gets
  a slide-down-and-fade entrance; the cards still queued slide up to close the gap
  (a small in-section FLIP on `leaseId`/`waiterId` keys, so the motion follows the
  card, not the row). The panel polls every 750 ms so this lands while you are
  looking at it. Under `prefers-reduced-motion` none of it runs — no ghost is even
  mounted, and the lists simply update.
- `conversation.input.dock` on every session: appears only while that session has
  a queued call.
- Controls: **Cancel turn** (safe; cancels the session's active turn, which
  aborts the waiter), **Cancel** a queued call, and
  **Force release** a lease behind a confirmation (the underlying stream may
  still run; this can exceed the limit — use it only for a stuck lease).

Routes are under the authenticated `/api` fence:
`/api/modelCapacity/{snapshot,cancelSession,cancelWaiter,forceRelease}`.

## Tests

```sh
node --test test/*.test.mjs
```

Covers FIFO admission, abort/cancel, force-release, raising limits, the queue
bound, the `llm/stream` gate (acquire before the first chunk, release on
abort/error, and a subagent child queued strictly in arrival order behind an
interactive call), config resolution including the removed 0.3.0 keys, and host
contracts (no tool registration, no tool guard, no credentials, routes under
`/api`).

The browser half is not unit-tested and deliberately stays that way: `src/client.mjs`
is a classic script for `window.__ModuleLoader__` with no module boundary to import
through, so a test would mean extracting the diff into a second file that only the
browser loads — a seam for no reviewer's benefit. What it does get is the repository's
Rules-of-Hooks gate (`node scripts/check-plugin-hooks.mjs`, the only automated check
that can see this file at all) plus the deployment's lab UI smoke, which mounts the
panel for real and fails on any `slot entry crashed`. The animation behaviour itself is
listed above and verified by eye against live traffic.
