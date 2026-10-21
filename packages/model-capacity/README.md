# dsh-model-capacity

**Process-wide, per-provider model-call capacity for DeepSeek Harness.**

One host plugin gates every `ctx.llm.stream()` call — interactive turns, subagent
children, judges, titles and compaction — with a per-provider counting semaphore.
Interactive calls wait in a strict FIFO queue; agent-spawning tools (`subagent`,
`subagent_fork`, `spawn_teammate`) preflight synchronously and get an immediate,
actionable capacity error instead of a silent wait. The Host exposes a Capacity
panel with active leases, queued calls and reservations.

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
        maxConcurrent: 3
      - provider: gpu-b
        maxConcurrent: 1
    queueLimitPerProvider: 1000
    reservationTtlMs: 300000
    subagentTools: [subagent, subagent_fork, spawn_teammate]
```

| Key | Meaning |
|---|---|
| `enabled` | `false` makes the gate and guard inert while keeping the panel available. |
| `defaultMaxConcurrent` | Limit for a provider with no `limits` entry. Unknown providers therefore admit one call at a time. |
| `limits[]` | `{provider, maxConcurrent}`. Capacity is **per provider**, because a provider is the physical backend a deployment split its GPUs into. Every model id behind one provider shares its slots. |
| `queueLimitPerProvider` | Bound on queued calls per provider; exceeding it rejects new calls with `CAPACITY_QUEUE_FULL` instead of growing memory forever. |
| `reservationTtlMs` | Cleanup only: a subagent reservation whose child never starts is released after this long. This is **not** a queue timeout. |
| `subagentTools` | Tools that preflight and fail immediately. `workflow` is deliberately excluded: its fan-out is not declared in the call, so there is no honest capacity statement; its children start sessions normally and queue. |

Every provider named in `limits` has a visible queue even at `0/limit`, and the
deployment's default model provider is seeded the same way; other providers
appear on first use. Adding both of your provider routes to `limits` is the
simplest way to see two queues in the panel.

Limits are validated against `ctx.llm.listProviders()` when adapters register; a
limit naming a route the host never offers is logged loudly (the configured limit
still applies if it appears). The config is watched through the host
`configEditor` and swapped atomically; an invalid reload keeps the previous
limits.

## Behavior

| Caller | Behavior |
|---|---|
| Ordinary prompt / any session model call | `llm/stream` waits for a slot before the adapter sees the request. The session stays `running`; the composer dock shows position, provider/model and elapsed time, with **Cancel turn**. There is no plugin-level timeout. |
| `subagent` / `subagent_fork` / `spawn_teammate` | The tool guard resolves the child route (explicit `provider`/`model`, else the parent request header), takes a hard reservation, or returns `Error: capacity: …` with the active/reserved/waiting counts and currently free routes. |
| Subagent child first call | Consumes its reservation instead of acquiring again; a title/compaction call for the child does not consume it. |
| `workflow` | Not preflighted. Children go through the normal per-call queue once their sessions start. |
| Kanban | Uses the same global gate per call. It no longer owns a semaphore, leases or capacity checks; `wipCap` only bounds how many tickets are in `Now`. |

Because the wait happens **before** `next()` reaches the provider adapter, the
provider's `streamIdleTimeoutMs` does not start until a slot exists. This is what
makes multi-hour waits safe for a machine that thinks for hours.

The gate is in-process: a host restart clears all leases and waiters (their turns
are already interrupted by the restart). No database is used.

## Panel

- `sidebar.panellist` entry **Capacity** → `main` panel showing per provider:
  `used/limit`, active leases (session title, workspace, model, elapsed), FIFO
  waiters (position, session title, workspace, model, waited) and subagent
  reservations (parent/child titles, tool, age, state). Session titles come from
  the session log's `title` projection; workspace names come from the workspace
  registry, matched by the session's cwd.
- `conversation.input.dock` on every session: appears only while that session has
  a queued call.
- Controls: **Cancel turn** (safe; cancels the session's active turn, which
  aborts the waiter), **Cancel** a queued call, **Dismiss** a reservation, and
  **Force release** a lease behind a confirmation (the underlying stream may
  still run; this can exceed the limit — use it only for a stuck lease).

Routes are under the authenticated `/api` fence:
`/api/modelCapacity/{snapshot,cancelSession,cancelWaiter,dismissReservation,forceRelease}`.

## Tests

```sh
node --test test/*.test.mjs
```

Covers FIFO admission, abort/cancel, reservation consume/mismatch/expiry,
force-release, raising limits, queue bound, the `llm/stream` gate (acquire before
first chunk, release on abort/error, no reservation consumption by title calls),
the subagent guard message and free-route suggestions, and host contracts (no
tools, no credentials, routes under `/api`).
