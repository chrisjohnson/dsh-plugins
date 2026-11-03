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
  unreadable. Each pushed frame diffs a provider against the one before it: a lease that
  left Active is re-rendered in its old position as an inert ghost clone that
  scales up and fades out (~350 ms); a session that moved from Queue to Active gets
  a slide-down-and-fade entrance; the cards still queued slide up to close the gap
  (a small in-section FLIP on `leaseId`/`waiterId` keys, so the motion follows the
  card, not the row). Capacity events reach the page within about 150 ms, so this
  lands while you are looking at it. Under `prefers-reduced-motion` none of it runs — no ghost is even
  mounted, and the lists simply update.
- **Throughput.** The top of the page shows the output tokens per second of every
  model call running in this DSH instance added together: a live **now** figure
  (trailing 3 s, with a sparkline of the last 90 frames) and the **1 minute**,
  **5 minute** and **1 hour** averages. Each provider card repeats its own now and
  1-minute figures and each active call card shows that call's own rate. The
  rate is counted from the stream itself: streamed text, reasoning and tool-call
  fragments count at four characters per token while they arrive, and when the
  provider's usage chunk comes in the call is corrected to the provider's own
  output-token count, so totals are exact and only the live figure is an
  estimate. The averages are over the whole window, idle time included, and a
  meter younger than the window averages over its own age, so a freshly started
  host is not diluted. They are in-memory and start from zero at a host restart.
  Prompt-processing (prefill) rates are not shown.
- `conversation.input.dock` on every session: appears only while that session has
  a queued call.
- Controls: **Cancel turn** (safe; cancels the session's active turn, which
  aborts the waiter), **Cancel** a queued call, and
  **Force release** a lease behind a confirmation (the underlying stream may
  still run; this can exceed the limit — use it only for a stuck lease).

Routes are under the authenticated `/api` fence:
`/api/modelCapacity/{snapshot,stream,sessionWaits,cancelSession,cancelWaiter,forceRelease,setLimits}`.

### Live updates and their cost

`stream` is the push channel: one long-lived response of newline-delimited JSON
snapshots. Every component on the page (sidebar pills, the composer dock, the
Activity page, the per-turn wait cards) shares a single stream, which the browser
opens only while something is shown **and the tab is visible**. A hidden tab holds
no connection and runs no timer. On the Host a frame is built once however many
tabs are connected, capacity events are coalesced into at most one frame per
150 ms, an idle snapshot (nothing running, nothing queued) is not re-sent apart from
a 15 s keep-alive, and with nobody connected there is no timer and no work. Session
titles and workspace names are re-read at most every 10 s and only while a snapshot
is being read.

Metering costs a constant amount per streamed chunk: one add to a one-second
bucket in a fixed ring (3600 buckets per meter, one meter overall and one per
provider), with no allocation and no growth with traffic.

If the stream cannot be held (a proxy that buffers or drops long responses, or an
older Host) the page falls back to a `snapshot` poll every 2 s while visible and
retries the stream with back-off up to 30 s; a stream that is silent for 20 s is
treated as dead.

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

The rate math (`src/rate.mjs`) and the push feed (`src/feed.mjs`) are pure modules
with their own tests: window arithmetic, ring bounds, estimate-then-reconcile
accounting, coalescing, keep-alives and unsubscribe cleanup. The browser half is a
classic script with no module boundary to import through, so its transport is tested
by loading the real source against stubs (a manual timer wheel, a controllable
streaming `fetch`, a visibility flag): one shared stream, nothing while hidden, the
polling fallback and its recovery. The visual side is not unit-tested. It gets the repository's
Rules-of-Hooks gate (`node scripts/check-plugin-hooks.mjs`, the only automated check
that can see this file at all) plus the deployment's lab UI smoke, which mounts the
panel for real and fails on any `slot entry crashed`. The animation behaviour itself is
listed above and verified by eye against live traffic.
