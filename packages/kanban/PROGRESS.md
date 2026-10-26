# dsh-kanban — plan, progress and resume notes

Last updated: 2026-10-21 09:35 America/New_York
Author: implementing agent (fleet-cinder worktree)
Read this file first after a context compaction. It is the durable state of the
build; the conversation can be discarded.

---

## 1. TL;DR

`dsh-kanban` is implemented as a new DeepSeek Harness plugin and verified
end-to-end in the default lab. Two real tickets reached `done` through
intake → plan → implement → verify → review using real local model sessions.
The plugin is committed on branch `feat/kanban` in the `dsh-plugins` checkout
the lab is linked to. It is **not released or deployed**, and two spec items are
partial (real-model forced-failure demo; exact UI placement decision) — see §8.

Canonical locations:

- Plugin source: `/home/dsh/dsh-lab/plugins/dsh-plugins/packages/kanban`
- Lab: `/home/dsh/dsh-lab/default` on `127.0.0.1:3099` (token in `.lab/url`)
- Lab DB: `/home/dsh/dsh-lab/default/.dsh/kanban/kanban.db`
- Lab server logs: `/home/dsh/dsh-lab/default/.lab/lab.log` (stdout+stderr,
  truncated on every start/restart, mode 600)
- dsh-deploy worktree: `/home/dsh/dsh-deploy/.dsh-worktrees/fleet-cinder`
  (branch `dsh/fleet-cinder`, compared with `origin/main`)

---

## 2. The specification in one paragraph

A ticket-centric board and workflow engine: tickets are SQLite rows; **code**
drives each phase, spawns sandboxed role sessions, gates dispatch on real
provider concurrency, mechanically checks machine-readable `done_when`
conditions, and records every step's time/tokens. The human surfaces are a board
(Backlog · Now · Blocked · Needs attention · Done/Discarded) and an in-flight
view. The old `@shengsheng/dsh-taskboard` is removed; this engine owns the board.

Non-negotiables implemented: engine-only ticket mutation; role sessions have no
board tools; verifier/reviewer independence; per-provider capacity including
judge calls; paid-call budget refusal; fail-closed config; restart safety; no
credentials or provider wire code (every model call via `ctx.llm.stream()`);
state in SQLite, policy in YAML; no DSH core edits.

---

## 3. Build plan and status

| Phase | Scope | Status |
|---|---|---|
| P0 Foundations | env check; taskboard removal; config loader with strict schema/defaults/row validation/reload/hashing; schema + migrations; event/span plumbing; session creation/prompt/turn signals/judge helper documented | **Done** |
| P1 Store + lifecycle | intake validation server-side; triage; transitions; acceptance; event log; no config tables | **Done** |
| P2 Dispatch + capacity | provider capacity from YAML; per-turn leases + heartbeat + reclaim; worker tick; role preset sessions; `pending_capacity` | **Done** |
| P3 Result loop | turn-stop detection; JSON extraction; gate order; adjudication; continuations; review; retry ladder | **Done** |
| P4 Telemetry | span tree; token capture; pricing incl. `unpriced`; rollups; Gantt data; JSONL/CSV export; analytics | **Done** |
| P5 UI | Board, Now groups, ticket detail, timeline/Gantt, sessions, events, analytics, exports | **Done** (placement provisional — §8) |
| P6 Hardening | restart recovery; orphan lease sweep; budget refusal; stall handling; config/prompt versioning + reload; real demo run | **Done**, except real-model forced-failure demo (§8) |

The phase ordering followed the spec: each phase's tests were written and the
lab was used whenever the phase needed the real host.

---

## 4. What exists (file map)

All under `/home/dsh/dsh-lab/plugins/dsh-plugins/packages/kanban`:

| File | Contents |
|---|---|
| `package.json` | bundle + web client manifest, peer deps, `files` allowlist |
| `cordis.patch.yml` | bundle layer, one `kanban` row with **no config** |
| `index.mjs` | host entry re-export |
| `src/config.mjs` | defaults, merge, strict validation, provider policy, escalation ladder, canonical JSON |
| `src/schema.mjs` | forward-only migrations, `schema_version`, all tables/indexes |
| `src/db.mjs` | `node:sqlite` open, WAL, busy timeout, migration runner |
| `src/store.mjs` | all ticket state mutations in `BEGIN IMMEDIATE`, row `version`, post-commit events; acceptance/conditions/sessions/events/spans/usage/verifications/leases/runs/artifacts; analytics/rollups |
| `src/lifecycle.mjs` | pure state machine, intake table, transition guards, Now groups, attempt failure policy |
| `src/result.mjs` | JSON extraction (bare/fenced/prose), implement/plan/review/grill/adjudication schemas, evidence specificity, gate order |
| `src/usage.mjs` | token pricing and conservative paid-call estimate; `null` cost ⇒ `unpriced` |
| `src/prompts.mjs` | prompt loading, SHA-256 hashing, rendering, judge schemas |
| `src/judge.mjs` | `ctx.llm.stream()` judge: `BlockAssembler`, terminal usage, `failure.code` routing |
| `src/tools.mjs` | monotonic role tool guard (allow-list is the control) |
| `src/dispatch.mjs` | preset registration + mount, tool `restrict` + `guard`, session create, prompt/continue, `turn/end` + polling detection, stall watchdog |
| `src/engine.mjs` | intake/triage/grill/plan/implement/verify/review, retries/escalation, leases, budget, recovery, config snapshot via `AsyncLocalStorage`, tool spans, diff |
| `src/host.mjs` | Cordis wiring, boot route validation, prompt hashing, config reload through `configEditor`, `/api/kanban/*` routes, board/detail/export/analytics payloads |
| `src/client.mjs` | browser half: `sidebar.panellist` **Kanban** button + `main` keyed `kanban`; board, Now groups, detail tabs, Gantt, review panel, exports |
| `prompts/*.md` | orchestrator, griller, planner, implementer, verifier, reviewer |
| `test/*.test.mjs` | 59 tests: config, lifecycle, result, store, engine pipeline (fakes), role guard, host contracts |
| `README.md` | install, config table, roles, lifecycle, protocol, telemetry, limits |
| `DECISIONS.md` | resolved design choices, environment findings, verification evidence |
| `CHANGELOG.md` | 0.1.0 entry |

Size: ~5,528 lines source+prompts+entry; ~873 lines tests.

---

## 5. Lifecycle and protocol as implemented

- Columns: `backlog | now | blocked | needs_attention | done | discarded`.
- Phases: `intake | triage | grill | plan | implement | verify | review | closed`.
- Intake table enforced in `store.transitionTicket`/`createTicket`, not only UI:
  `at_pickup` grill + `now` plan is rejected.
- Pickup = drag into Now or auto-promote; `wipCap` enforced in engine.pickup and
  auto-promote.
- Grill always precedes plan; `judgement` grill only evaluated when sibling plan
  work is due. Griller questions park the ticket with an `awaiting_human` event;
  board answers resume the same live griller session and merge
  `refined_acceptance` with `source=grill`.
- `one_shot`: triage converts acceptance via judge; if not checkable the ticket
  is forced onto a plan (`planMode=at_pickup`).
- Plan must emit ≥1 `done_when`; engine persists conditions and a plan artifact;
  intent-coverage judge may request one planner revision, never an implement retry.
- Implementer final JSON contract gated in order: parse → schema → exact ids →
  specific evidence → confidence ≥ threshold. Failure → up to 2 continuations →
  out-of-band adjudication (≤2 calls) → retry/escalate.
- Verification is a fresh read-only verifier session judging each condition
  independently; review is a fresh reviewer session reading plan, verification,
  diff, and mapping conditions to acceptance phrases. Pass ⇒ `done`; fail ⇒ retry.
- Attempts: 1–2 rung 0, 3 rung 1, then attempt budget ⇒ `needs_attention` packet
  (reason, event history, attempt feedback artifact).
- Paid providers require `allow_paid` + budget; unknown price refuses rather than
  guessing; no downgrade.
- Capacity: leases per live turn (agents **and** judges), heartbeat 15 s, reclaim
  at 30 s, unknown provider limit 1.
- Turn stop: `session/event` + `turn/end` primary; worker-tick polling fallback via
  `agent.status === idle`; 10-min stall watchdog.
- Restart: running spans abandoned, all leases released, ticket requeued or
  `needs_attention` if attempts exhausted.

---

## 6. Lab configuration used

Lab profile `.dsh/profiles/web/cordis.patch.yml`, row `id: kanban`:

```yaml
providers:
  - name: local-ai-machine
    maxConcurrent: 3
    tier: local
roles: all six -> provider local-ai-machine, model medium-dense,
       presets kanban-<role> (orchestrator has no preset)
confidenceThreshold: 0.7
maxAttempts: 3
tickIntervalMs: 3000
stallTimeoutMs: 600000
wipCap: 2
autoPromote: true
defaultWorkspaceCwd: /home/dsh/dsh-lab/kanban-workspace
defaultGrillMode: judgement
defaultPlanMode: at_pickup
```

Lab manifests were edited by hand (not committed to dsh-deploy):
`dsh-kanban` is a `link:` dependency in both lab `package.json` files and in
`dsh.profiles.web.bundles`. `lab.sh status` shows `LINKED dsh-kanban`.

Demo workspace: `/home/dsh/dsh-lab/kanban-workspace` — a tiny git repo whose
`test/greet.test.mjs` imports `shout` from `src/greet.mjs`; `shout` was missing
at baseline. Both demo tickets caused it to be added and the suite turns green.

---

## 7. Verification evidence

### Tests (all passing)
`node --test test/*.test.mjs` in the package: **59 tests, 59 pass, 0 fail**.
Covered: defaults/validation/ladder; mode table/transitions/terminal sink;
JSON extraction/schema/evidence/confidence; store CRUD/version/events/conditions/
sessions/leases/rollups/no-config-table; engine branches (pass, unmet →
adjudication → retry, no-JSON → continuation, blocked, questions → answer,
verifier exhaustion/packet, paid refusal, capacity wait, grill Q&A, restart
recovery); role tool guard; host contracts (no tool registration, all routes
under `/api`, no credentials/endpoints, allow-lists contain no board names).

Repo gates:
- `node scripts/verify.mjs --package dsh-kanban` → 0 errors / 0 warnings.
- `node scripts/check-plugin-hooks.mjs packages/kanban` → 0 violations.

### Real lab runs (default lab, linked package)
- KAN-1 "Diagnose turn settlement" and KAN-2 "Diagnose turn settlement 2" both
  `done`/`closed`, attempt 1, in `/home/dsh/dsh-lab/default/.dsh/kanban/kanban.db`.
- Spans chain: `grill-judgement` (judge) → `plan` (planner, log10, coverage
  judge) → `implement` (implementer) → `verify` (verifier) → `review` (reviewer),
  with nested tool spans (`read`, `edit`, `bash`, `glob`) as children.
- Implementer sessions and verifier sessions are distinct ids (independence).
- Usage rows: 30k–35k input, 5k–8k output, cache-read tokens; local route has no
  prices ⇒ `cost_usd = NULL` and UI shows `unpriced` (not `$0.00`).
- `npm test` in the demo workspace passes after the runs.

### Restart, reload, concurrency
- Lab killed/restarted mid-plan and mid-implement several times: running spans
  abandoned, leases released, tickets requeued; no orphan lease and no duplicate
  span remained; later attempts completed.
- Editing lab `wipCap` 2→3→2 changed `/api/kanban/config` live, no restart;
  invalid-reload path keeps previous config (config tests).
- Concurrency engine test: 6 tickets vs `maxConcurrent: 3`; max overlapping
  implementer turns and max live local leases both ≤ 3; all 6 finish.
- Export API verified: tickets CSV, spans CSV/JSONL, usage CSV; analytics returns
  attempts-to-done, model success rate (fixed to distinct tickets), calibration,
  time-in-phase, cost/ticket, stall rate.

### UI
Verified in the lab through the accessibility tree (the implementing model route
has no image input, so screenshots were not visually inspectable): sidebar
**Kanban** button, board columns, Now groups, ticket detail tabs (overview,
timeline, sessions, events, analytics), Gantt rows with nested tool spans, review
verdict/coverage panel, export buttons, acceptance list, mode editors, and
needs-attention/grill forms. No `slot entry crashed` and no boot errors.

---

## 8. Definition-of-done checklist

| Item | Status |
|---|---|
| Demo ticket grill-now → plan-now → implement → forced verify failure → retry → pass → review → done | **Partial**: real runs reached done, but the *forced-failure* variant was not completed on real models (backend degraded to ~0.5 tok/s; ticket discarded). The branch is covered deterministically by `engine.test.mjs`. |
| Concurrency measured, 6 Now tickets under declared limit | **Done** (engine test at 3 slots; lab config 3; measured ≤3). Literal APU=3/eGPU=1 pair not available on this deployment. |
| Illegal mode combos rejected server-side | **Done** (store + tests; UI disables/explains too). |
| 3 exhausted attempts ⇒ usable `needs_attention` packet | **Done** (test + artifact/event packet). |
| Paid escalation refused when `allow_paid=false`/budget exhausted | **Done** (tests; no paid route used in lab). |
| Restart mid-run: no duplicate attempts, no orphan leases, no lost spans | **Done** (observed + recovery test). |
| Gantt containment; rollup = sum of spans; unpriced flagged | **Done** (tool spans are children; rollup query; `unpriced` in UI/export). |
| Role session provably cannot mutate board state | **Structural + unit**: plugin registers zero tools; role allow-lists contain no board names; guard denies anything outside list. No end-to-end hostile-session test. |
| No credentials/base URLs/provider HTTP | **Done** (host-contract test greps source; judge uses `ctx.llm`). |
| Invalid YAML refuses start; valid reload atomic mid-flight; run config hash explains old runs; no settings in DB | **Done** (boot validation, reload observed, ALS snapshots, config table test). |
| No DSH core edits | **Done** (plugins only). |
| UI placement decided | **Provisional**: implemented additive `sidebar.panellist` + `main` panel; alternative right-sidebar tab documented in `DECISIONS.md`; spec asked to propose and wait. |

---

## 9. Deviations / known gaps

1. **Forced verification failure on real models** is the one incomplete demo item.
   Attempted sabotage (revert workspace after implementer span) but the local
   backend was too slow; the deterministic engine test covers the branch.
2. **Verification model**: §9's table advances straight to review after a
   mechanical pass, while §5/§7/§11 require a verifier role. Implemented both:
   mechanical gate → fresh verifier → fresh reviewer.
3. **Planner writes no plan file**: it emits plan JSON; engine writes artifact and
   conditions. Read-only tool surface honored.
4. **Config reload** watches via host `configEditor` rather than raw file watch.
5. **UI placement** as above; client-only change to relocate.
6. **Capacity seeds**: deployment has one local route (`local-ai-machine`) plus a
   cloud proxy, not two GPU-specific route ids; local route declared max 3.
7. **`wait` spans** reserved in schema/UI CSS, but capacity/human waits are
   recorded as `pending_capacity`/`awaiting_human` events, not wait spans.
8. **Prompt logs**: plugin `ctx.logger` output is quiet by default (no
   `logToStderr`), so only boot output appears in `lab.log`; use the DB events/
   spans for run detail.

---

## 10. Git state and release work left

### dsh-plugins (`/home/dsh/dsh-lab/plugins/dsh-plugins`)
Branch `feat/kanban`, clean working tree:

```
f5d8666 dsh-kanban: extract role tool guard, host contract tests, concurrency at 3 slots
954e7d6 dsh-kanban: review panel, span/usage exports, analytics fixes, verification notes
59a446f dsh-kanban 0.1.0: ticket board, code-driven workflow engine, capacity-gated role sessions
```

This branch is **local only** (not pushed, no PR, no tag). Repo rules require a
release PR and a `<package>-v<version>` tag; direct main commits are not allowed.
`README.md` index and install line for `dsh-kanban-v0.1.0` are prepared.

### dsh-deploy worktree (`/home/dsh/dsh-deploy/.dsh-worktrees/fleet-cinder`)
Branch `dsh/fleet-cinder`, clean after:

```
c57c45c Drop the removed @shengsheng/dsh-taskboard from the web profile
```

Not deployed. Production still runs the old profile until a planned restart.
No kanban pin has been added to dsh-deploy because the tag does not exist yet.

---

## 11. How to resume / operate

```sh
# Lab lifecycle
cd /home/dsh/dsh-deploy
scripts/lab.sh status
scripts/lab.sh up            # starts 127.0.0.1:3099
scripts/lab.sh logs          # tail lab.log (token redacted); LOG_LINES=200 ...
scripts/lab.sh down

# Lab URL (token inside)
cat ~/dsh-lab/default/.lab/url

# Plugin checks
cd ~/dsh-lab/plugins/dsh-plugins
node --test packages/kanban/test/*.test.mjs
node scripts/verify.mjs --package dsh-kanban
node scripts/check-plugin-hooks.mjs packages/kanban

# HTTP API (needs the lab token cookie)
URL=$(cat ~/dsh-lab/default/.lab/url); curl -s -c /tmp/kc "$URL" -o /dev/null
curl -s -b /tmp/kc -X POST http://127.0.0.1:3099/api/kanban/board \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:3099' -d '{}'
```

Next actions if continuing:

1. Push `feat/kanban`, open the release PR, bump/cut tag `dsh-kanban-v0.1.0`.
2. Pin the tag in dsh-deploy's root and profile `package.json`, add to
   `dsh.profile.bundles`, run `pnpm install`, `pnpm run check`, deploy in a
   planned window.
3. Optionally run the forced-failure demo on a healthy backend (sabotage after
   the implementer span).
4. Confirm UI placement with the human (current additive panel vs right-sidebar
   tab); the client is isolated for that move.
5. Optional polish: wait spans, richer Gantt zoom/legend, needs-attention packet
   card instead of events-only view.

---

## 12. Session-provided spec sections that drove decisions

The build followed the 20-section spec (mission, architecture, hard constraints,
data model, lifecycle, intake modes, roles/presets/routing, capacity/dispatch,
turn-stop/result protocol, two kinds of done, verification/adjudication, retries,
human involvement, telemetry, surfaces, config, build order, DoD, deferred work,
resolved decisions). Environment findings and resolved choices are in the
package's `DECISIONS.md`; this file records plan vs. actual and the remaining
release work.

---

## 13. 2026-10-21 — global capacity plugin (post-kanban)

### What changed

Concurrency moved out of kanban into a new separate host plugin:

- `/home/dsh/dsh-lab/plugins/dsh-plugins/packages/model-capacity`
  - `src/config.mjs` — enabled switch, per-provider limits, default 1, queue
    bound, reservation TTL, subagent tool list.
  - `src/semaphore.mjs` — per-provider buckets: active leases, FIFO waiters,
    reservations, snapshot, cancel/force-release, TTL.
  - `src/gate.mjs` — one global `llm/stream` waterfall: acquire before `next()`,
    release in `finally`; a subagent child's first main call consumes its
    reservation; title/compaction calls do not.
  - `src/guard.mjs` — synchronous preflight for subagent tools; error lists
    active/reserved/waiting and free routes.
  - `src/host.mjs` — Cordis `ctx.capacity` service, global gate + tool guard,
    `session/created` reservation binding, `session/event` cleanup on tool error,
    adapters-updated catalog, config reload via `configEditor`, `/api/modelCapacity/*`.
  - `src/client.mjs` — `Capacity` sidebar panel + `main` page; session
    `conversation.input.dock` banner with position/waited and Cancel turn;
    lease/wait/reservation tables, dismiss and force-release.
  - 29 tests.

Kanban simplified to consume the global gate:

- Removed `leases` table usage (schema v2 drops it), lease methods, heartbeat,
  `maxConcurrent` validation/use, capacity admission, `pending_capacity` group
  and events.
- `Now` groups are `active | waiting on you | blocked`. A ticket in `now` is
  active even while its model call is queued; the Capacity panel shows the queue.
- Role stall watchdog asks `ctx.capacity.isWaitingForSession(sessionId)` so
  multi-hour queue waits are not counted as a stalled model call.
- `providers[]` now carries tier/prices only; a legacy `maxConcurrent` warns and
  is ignored.
- Tests updated: 57 pass.

### Lab config

`model-capacity` row:
`enabled: true`, `defaultMaxConcurrent: 1`, `limits: local-ai-machine: 3`,
`queueLimitPerProvider: 1000`, `reservationTtlMs: 300000`,
`subagentTools: [subagent, subagent_fork, spawn_teammate]`.
The kanban row no longer has `maxConcurrent`.

### Verified in the lab

- Capacity panel loads: provider `local-ai-machine 0/3`, active/waiting/reserved
  tables.
- Two real interactive sessions: A's main call active (cloud provider, default
  limit 1), B's main call queued at position 1; snapshot showed
  `active:1, waiting:2` (B main + B title). Cancelling A let B start.
- Subagent success: a session called `subagent` on
  `local-ai-machine/medium-moe`; child started (`started subagent edda…`).
- Subagent capacity error (real tool result): while the cloud provider's single
  slot was held by a title call, a session called `subagent` on
  `local-ai-machine-cloud/deepseek-flash` and received:
  `Error: capacity: provider "local-ai-machine-cloud" is at its limit (1 active,
  0 reserved, 0 waiting). Cannot dispatch "subagent" on "deepseek-flash". Free
  now: deepseek-official/…, local-ai-machine/medium-moe. Retry with provider/model
  set to one of those. This tool does not queue; …`
- Failed-route reservation cleanup verified by code/test (tool error cancels the
  reservation by `callId`); TTL and `session/disposed` also clean up.
- Capacity limit live reload: local limit 3→2→3 through the profile YAML, no
  restart.
- Kanban post-refactor: a real ticket (KAN-3) ran grill judgement → plan →
  coverage → implement (wrote `src/status.txt = KANBAN_OK`) → verify → review and
  reached `done`; no lease rows, capacity snapshot showed per-call activity.
- Repo gates: 86 tests across kanban+capacity pass; `verify.mjs` 0/0; hooks gate
  clean for both clients.

### Not yet done

- Session dock visual check: the panel and queue were verified; the dock's
  queue-filtered rendering was not exercised in a selected session (the title
  waiter case was deliberately filtered out). It passes the hooks gate.
- Release: model-capacity is 0.1.0 on branch `feat/kanban` (commit `3979c49`),
  not tagged/pushed. Kanban still 0.1.0.
- Deployment: dsh-deploy profile still has no capacity row or kanban pin; needs
  release tags, then both packages pinned and the service restarted in a planned
  window.
- Workflow fan-out is deliberately not preflighted; its children queue normally.

### 2026-10-21 follow-up — two visible queues + live UI walkthrough

The first panel version only created a bucket for providers named in
`limits`, so the lab showed one queue (the cloud provider was lazily absent).
Fixed by:

- seeding a bucket for every configured limit and for the deployment's current
  default-model provider;
- declaring both lab provider routes explicitly in the `limits` list.

Both queues now render at `0/limit` before any call. Lab demo config (lab only):

```yaml
limits:
  - provider: local-ai-machine
    maxConcurrent: 1
  - provider: local-ai-machine-cloud
    maxConcurrent: 1
```

Live walkthrough performed with four fresh API-created sessions plus one UI
session:

- cloud A active, cloud B queued; local A active, local B queued; each provider
  `1/1 in use` with its own FIFO (plus title-call entries).
- A selected UI session showed the dock: “Waiting for model capacity
  local-ai-machine/medium-dense · position 4 of 5 · waiting 1s. Inference has
  not started.” with **Cancel turn**.
- The Capacity panel showed both provider cards, active leases, waiters by
  position/kind, and reservation sections.
- Verified `Cancel turn` and limit live-reload earlier; the panel’s reservation
  dismiss/force-release paths are unit-tested, with no live stuck reservation to
  demonstrate at the time.

The lab is intentionally left at 1/1 for both providers so the queues remain
visible; restore the production intent (local 3, cloud 1) by editing the
`model-capacity` row and waiting for the 5 s reload. The session default model
was restored to `local-ai-machine-cloud/deepseek-flash` after the demo.

### 2026-10-21 14:25 — panel identifies sessions by title + workspace

The Capacity panel previously showed raw session ids, so a queue could not be
mapped to real work. It now decorates every active lease, waiter and reservation
with:

- **session title** — read from the live session's `title` projection
  (`ctx.get('sessionTitle').get(session)`), falling back to the cached
  `session/list` row and then to the short session id;
- **workspace title** — matched from `workspaceRegistry.list()` by the session's
  `cwd`;
- model, call kind (`call` / `session-title` / judge), position and wait time.

The live lab demo now shows, on each of the two `1/1` provider queues, entries
such as `CAPACITY DEMO UI session. Reply · lab-wt-repo · medium-dense` and
`Write a very long, detailed · lab-wt-repo · deepseek-flash`; queued entries
show `Convert OK · lab-wt-repo · big-moe`.

API-created demo sessions that pointed at `/home/dsh/dsh-lab/lab-wt-repo` show
`no workspace` because the registered workspace path is
`/home/dsh/dsh-lab/default/.lab/home/lab-wt-repo`; sessions created through the
UI under the `lab-wt-repo` workspace resolve correctly. This is a demo-data path
mismatch, not a lookup bug.

Verified: 29 capacity tests pass, hooks gate clean, `verify.mjs` 0/0, lab boot
clean. Commit `98fd33c` on `feat/kanban`.

### 2026-10-21 14:40 — three provider queues; cloud unlimited

The deployment actually has three provider routes, not two: **APU**, **eGPU**,
and the **cloud proxy**. The lab had only the combined `local-ai-machine` route,
which is why earlier reviews saw one/two queues.

Changes:

- `model-capacity` supports `{provider, unlimited: true}`. An unlimited route
  never enters the FIFO and never rejects a subagent reservation; the panel shows
  `N / unlimited`.
- Lab `llm-pi-ai` now exposes `local-ai-machine (apu)` and
  `local-ai-machine (eGPU)` (duplicated model lists for the test-only split) plus
  `local-ai-machine-cloud`.
- Lab capacity config:
  - APU `maxConcurrent: 2`
  - eGPU `maxConcurrent: 2`
  - cloud `unlimited: true`
- Kanban provider/role references moved to `local-ai-machine (apu)`.

Live demonstration (currently visible in the lab Capacity panel):

| Provider | Limit | Active | Waiting |
|---|---|---|---|
| `local-ai-machine (apu)` | 2 | 2 | 1 |
| `local-ai-machine (eGPU)` | 2 | 0 | 0 |
| `local-ai-machine-cloud` | unlimited | 2+ | 0 |

The three APU sessions use titled, workspace-matched sessions:
`CAPACITY DEMO UI session. Reply`, `Write a very long, detailed`, and
`Reply with the single word ok`; the third waits at position 1 while two run.
Three cloud sessions were launched concurrently and all ran with zero waiting,
proving the proxy does not queue.

The lab provider split duplicates the model list across APU/eGPU for this test;
production's actual APU/eGPU model split (APU `big-moe`, eGPU `medium-moe` /
`medium-dense`) is unchanged in the deploy config and should be mirrored if the
lab split is kept.

### 2026-10-21 14:55 — live per-provider badges on the Capacity sidebar entry

The sidebar **Capacity** row now polls the capacity snapshot every 1.5 s and
renders one tiny badge per provider next to the icon, before the label:

- `0/2`, `2/2`, `3/∞` (Unicode infinity) using the provider's own limit;
- green when there is free capacity, yellow when `used == limit` and nothing is
  waiting, dark orange when at least one call is waiting;
- the badge's native tooltip names the provider and gives the counts:
  `local-ai-machine (apu): 2/2 · 2 active · 1 waiting`;
- the collapsed rail (`size` 18) shows one colored dot per provider with the same
  tooltip; expanded (`size` 16) shows the counts.

Current demo: APU `2/2` with a waiting call (orange), eGPU `0/2` (green), cloud
`0/∞` (green). Relay polling makes it update without a page reload.

Commit `5e2ecfe`; 31 capacity tests pass, hooks gate clean, `verify.mjs` 0/0.

### 2026-10-21 15:05 — worktree-style capacity pills; demand = active + queued

Sidebar badges restyled to match the better-git-worktree badge language:

- round pill (`border-radius: 999px`), 14px high, 9px tabular monospace;
- light tinted fill + darker border + darker text:
  - green `#15803d` / rgba(34,160,74,.12) / border .35 when capacity is free;
  - yellow `#854d0e` / rgba(234,179,8,.14) / border `#a16207` at exact capacity;
  - red `#b91c1c` / rgba(185,28,28,.12) / border .35 when anything is queued;
  - dark-mode text overrides (`#86efac`, `#fcd34d`, `#fca5a5`);
- the left number is **active + queued** demand, so 2 active + 2 queued on a
  limit-2 provider renders `4/2` (red); unlimited renders `N/∞`;
- tooltip names the provider and decomposes the number:
  `local-ai-machine (apu): 4/2 · 2 active · 2 queued`;
- collapsed rail still uses one colored dot per provider with the same tooltip.

Verified live: APU `4/2` (2 active, 2 queued), eGPU `0/2`, cloud `0/∞`.
Commit `e93498d`; hooks/verify clean.

### 2026-10-21 15:15 — badges after label, dock width, turn wait history

- Sidebar pills are now visually after the word **Capacity**. The sidebar renders
  only the glyph before its hard-coded label, so the pill cluster is absolutely
  positioned `calc(100% + 68px)` from the glyph; OCR of the rendered row confirms
  `Capacity 0/1 0/2 0/∞`. The collapsed 36 px rail hides the pills rather than
  overlapping the icon.
- The queued-session composer banner now uses the same width formula as the core
  composer dock (`--dsh-composer-side-clearance` and
  `--dsh-composer-card-max-width`), so it no longer spans the full viewport.
- Capacity waits are recorded in the Host (in memory): main calls that waited
  >250 ms get `{sessionId, turn, provider, model, waitedMs}`. A
  `conversation.chat.turnTail` card renders them under the turn:
  `Waited for capacity  24s  1 wait` → `local-ai-machine (apu)/medium-dense 24s`.
  This is client-only and never part of session context. Verified live on the
  queued `Reply with the single word ok` session: 23.6 s wait, turn 6, card
  visible with the route and duration.
- History is per Host process (restart clears it) and covers main `call` leases
  only, not title/compaction or judge calls.

32 capacity tests pass; hooks gate clean; `verify.mjs` 0/0. Commit `31f453f`.

### 2026-10-21 15:30 — Context-style Capacity page, clickable session cards

The Capacity panel was rebuilt in the visual language of the Context tab:

- full-page layout with a 20px title, live `ENFORCING` pill, and KPI cards for
  active / queued / reserved;
- one colour-accented provider card per route (blue, violet, teal) with a
  gradient capacity bar, `active + queued` numerator and `limit`/`∞`;
- active and queued calls are session **cards**, showing live/queued status,
  title, workspace, model, kind, elapsed/waited time and actions;
- **clicking any session card opens that session** via
  `uiWorkspace.openSession(sessionId)` — verified live against the running
  `Write a very long, detailed` session;
- active cards have a soft animated green border glow and a pulsing live dot;
  hover lifts cards and reveals “Open ↗”;
- subagent reservations are compact cards with parent → child title, tool and age;
- the whole page uses light tinted cards, gradient accents, dark-mode fallbacks
  and `prefers-reduced-motion` handling.

32 capacity tests pass, hooks/verify clean. Commit `e160850`.

### 2026-10-22 02:10 — Activity rename, capacity release, kanban shared session/UI

**dsh-model-capacity is released.** The sidebar entry and page title are now
**Activity**. `snapshot()` no longer calls private methods, fixing the
`Receiver must be an instance of class ModelCapacity` error when Kanban reads
`ctx.get('capacity').snapshot()` through the Cordis service proxy.

- release PR: https://github.com/chrisjohnson/dsh-plugins/pull/18
- merged commit: `558dcbdbef7501d0d54c2c8d83b879c4c5c2cf1e`
- tag: `dsh-model-capacity-v0.1.0` (pushed)
- CI: contract, tests on Node 20/22/24, and compose all pass.

Kanban changes on `feat/kanban` (pushed, not released):

- **One shared workflow session per ticket.** `ensureTicketSession()` creates it
  once; each phase sets a phase-aware tool guard and calls
  `agents.selectForNextRequest()` when the role route differs. Engine tests now
  assert one `workflow` session across plan/implement/verify/review.
- **New-ticket form asks for workspace and initial status** (Backlog / Now /
  Blocked). Host `create` accepts `workspaceCwd` and `column`; `now` starts the
  intake immediately.
- **Activity-style visual redesign**: Work header, five KPI cards, colour-accented
  board columns, lifecycle progress bars on every card, working-card glow,
  a "live" badge, hero detail with a lifecycle timeline and metric cards, and
  clickable shared-session links.
- Kanban capacity chips now use the real `maxConcurrent`/unlimited snapshot and
  show APU/eGPU/cloud limits instead of `0/undefined`.

Verification: 89 tests pass (57 kanban + 32 capacity), hooks gates clean,
`verify.mjs` 0/0. Live checks: workspace/status form renders with all
workspaces; ticket created in `now` with workspace; one workflow session row
created for the ticket; working KAN-6 card showed `live`/Running; Activity page
loads at APU 2/eGPU 2/cloud ∞ without the receiver error.

Remaining: kanban release/deploy, and a full multi-phase live ticket through
implement→verify→review on a faster model; the planner turn is currently very
slow on `medium-dense`, so the transition was verified by engine tests rather
than a complete live run.

### 2026-10-22 02:20 — shared-session live probe

On a temporary cloud-role config (restored afterwards), KAN-7 ran its planner
turn on `local-ai-machine-cloud/deepseek-flash`, completed 20 tool spans, and
entered the APU orchestrator coverage judge while `store.listSessions` still
showed exactly one `workflow` session. The judge was still running when the
ticket was discarded, so the complete plan→implement→verify live run remains a
verification task; engine tests now assert one shared session across all four
phases.

### 2026-10-22 09:10 — Kanban capacity decoupling, workflow timeline, analytics

- Removed every Kanban-side capacity remnant: the `isWaitingForCapacity` stall
  callback, board capacity view/chips, legacy provider `maxConcurrent`, lease
  schema text, UI capacity fetch, and capacity comments/tests. Kanban now has no
  capacity code at all.
- Timeline is now **workflow-level**: one block per phase/attempt (grilling
  includes the human answer gap), separate orchestrator judge calls, and separate
  plugin command steps (`git diff` recorded as a `workflow` span). Session turns
  and tools are excluded from the timeline but remain in spans/events for
  diagnostics. Phase blocks use distinct colours; plugin steps cycle a separate
  palette; judges are purple.
- Token counts render as `k`/`m`; configured local routes price at `$0.00` rather
  than `unpriced` (unknown providers remain unpriced). Detail, model table, and
  analytics all use the human units.
- Analytics page restyled with KPI cards, per-card accent colours, rate bars and
  hover rows.

Verified: 91 tests (59 Kanban + 32 capacity), hooks clean, verify 0/0. Live
`/api/kanban/ticket` timeline for KAN-4 returned 6 workflow blocks from 31 spans
while excluding 25 tool spans; board no longer contains a `capacity` field;
detail shows `input 24k`, `output 7.7k`, `$0.00`. Commit `b30c80c` on
`feat/kanban` (pushed).

### 2026-10-26 12:20 — per-phase tool presets, ticket analytics, judge details

- Per-ticket **ticket analytics** tab is now ticket-scoped: attempts, tokens,
  spend, conditions met; model usage, phase durations, verification rows and
  span outcomes. The page-level Analytics button remains board-wide.
- Role tools now actually change per phase: each role has its own preset
  (implementer = fs/search/bash/jobs, verifier = fs/search/bash, reviewer =
  fs/search, griller = fs), and `agentPresets.recompose()` rebinds the shared
  session on phase change. A global-tool mask removes browser/image-search/
  model-switch/schedule where possible. Prompt tool lists were rewritten for the
  shared-session model.
- Live session header evidence on a one-shot probe: implementer saw
  `bash/fs/jobs`; verifier saw `bash/fs` without jobs; reviewer saw `fs` without
  bash. `dsh-tool-fs` still bundles write/edit for read-only phases and schedule
  tools remain visible; the execution guard denies both, documented in README.
- Timeline blocks are clickable: phase metadata, provider/model, status and
  span count; judge blocks show stored `judge_*` result artifacts (new runs also
  store `judge_input_*`). Judge calls remain out-of-band (not session turns).
- Tests: 59 Kanban + 32 capacity = 91 pass; hooks/verify clean. Commit `52cb7ce`.

### 2026-10-26 12:35 — compact ticket header, edit modals, tool visibility

- Removed the four redundant metric badges under the ticket hero (Attempts,
  Session, Spent, Steps). Steps moved into the ticket analytics tab as a fifth
  KPI; ticket analytics remains ticket-scoped.
- Board cards now show **total ticket time** (creation → close/now) alongside
  attempts, spend and update age.
- Lifecycle step strips now use the same per-phase colours as the timeline
  (grill amber, plan blue, build teal, verify violet, review pink, done green).
- Modes/budget editing moved from the inline overview panel into a modal opened
  by a pencil button in the hero.
- Adding acceptance criteria moved into a modal opened by a pencil next to the
  Acceptance heading; it accepts one statement per line and uses the existing
  `addAcceptance` action.
- Per-phase tools are real now: role-specific presets are rebound with
  `agentPresets.recompose()` and a global-tool mask removes unrelated host
  tools. Live header evidence: implementer had bash+jobs+fs, verifier had bash+fs
  without jobs, reviewer had fs without bash. `dsh-tool-fs` still exposes
  write/edit in read-only phases and schedule tools remain session-scoped; the
  execution guard denies both.
- Prompt files updated for the shared-session model; judge timeline blocks expand
  to show stored result/input artifacts.

Tests: 91 (59 Kanban + 32 capacity); hooks/verify clean.

### 2026-10-26 12:30 — lifecycle dots and pencil visibility

- Hero lifecycle dots now use the timeline phase colours (intake slate, grill
  amber, plan blue, build teal, verify violet, review pink, done green) instead
  of inheriting the hero/column green accent.
- Pencil controls are 28×28 with a darker secondary label colour, stronger
  border/fill, and 15px 1.8-stroke icons.

59 Kanban tests pass; hooks/verify clean. Commit `518299f`.

### 2026-10-26 13:45 — timeline joined to artifacts and lifecycle events

- Phase timeline blocks now collect every artifact attached to their agent
  spans: plan prompt/result, implement prompt/result, verification prompt/result,
  review prompt/result.
- Phase blocks also carry the lifecycle events in their window (and the
  transition event from that phase): `conditions_set`, `planned`,
  `implemented`, `verified`, `done`, `phase_changed`, `attempt_started`, etc.
- Clicking a phase block shows metadata, compact artifact cards and lifecycle
  event payloads; judge blocks still show verdicts; plugin steps now show their
  command output.
- `git diff` persists its output as `plugin_git_diff`, so the `git diff` block
  is no longer "No payload".
- KAN-4 live API now returns Plan artifacts `[plan, planner_prompt_plan]` and
  events `[conditions_set, planned, phase_changed]`; Build/Verify/Review have
  their corresponding artifacts/events.

59 Kanban tests pass; hooks/verify clean. Commit `10e19ce`.

### 2026-10-26 15:45 — model routing panel

- Kanban board now has a **Model routing** strip above the flow: Judge,
  Grill, Plan, Build, Verify, Review, each with its effective provider/model,
  reasoning effort and whether it is a deployment-default fallback.
- Host `config` endpoint resolves each role's effective route through
  `engine.resolveRoute(role, 1)`, so null config routes show the real fallback.
- The strip refreshes every 15 s and is hidden while a ticket detail is open.

Commit `c107aa7`; 59 Kanban tests pass, hooks/verify clean.

### 2026-10-26 16:30 — routing moved into a modal

- Removed the permanent Model routing strip from the board.
- Added a **Model routing** button in the top-right actions; it opens the
  existing dialog with the six role routes.
- Removed the misleading “attempt 1” chip. The board-wide view shows the **base
  route**; the escalation ladder can override it per attempt, which is now stated
  in the modal copy.
- Modal uses a 3-column route grid so provider/model names remain legible.

Commit `59c6494`; 59 Kanban tests pass, hooks/verify clean.

### 2026-10-26 16:40 — editable routing persisted to config

- Routing dialog now shows one role per row.
- Pencil icon in the dialog header switches to edit mode with provider/model
  selects populated from the live host catalog.
- Save validates host provider/model and writes through `configEditor.edit`,
  preserving the rest of the kanban config object and profile comments; the
  5-second config watcher applies it live.
- Verified round trip: reviewer → eGPU/medium-dense persisted, config endpoint
  reloaded it, then restored to APU/medium-dense and confirmed.

Commit `261bbc5`; 59 Kanban tests pass, hooks/verify clean.

### 2026-10-26 17:05 — provider-grouped routing picker

- Routing edit rows now use a **single provider-grouped model picker** per role,
  sourced from the host session model catalog (the same catalog the main session
  picker uses), instead of separate provider/model dropdowns.
- Removed the invalid lab APU `medium-dense` model declaration. Lab APU now
  offers `medium-moe` and `big-moe`; eGPU retains `medium-dense`.
- Lab Kanban role routes changed from APU/medium-dense to APU/medium-moe; lab
  agent default changed from APU/medium-dense to APU/big-moe. These are lab
  config corrections, not plugin defaults.
- Verified live: APU group is `medium-moe, big-moe`; eGPU group is
  `medium-moe, big-moe, medium-dense`; all six Kanban roles show APU/medium-moe;
  edit mode renders one picker per row with provider optgroups.

Commit `96cb5bc`; 59 Kanban tests pass, hooks/verify clean.
