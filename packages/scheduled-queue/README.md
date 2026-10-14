# dsh-scheduled-queue

**Schedule the message in your composer to be sent later, into the same session.**

A composer feature for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): type a message, press the clock button beside Send, choose how many minutes from now, and the message is delivered to that session when the time comes — even if the session has been stopped in the meantime, and even if the harness restarts first.

| What | Where | What it does |
| --- | --- | --- |
| Clock button | composer, before the Send action | Enabled while the draft has text. Opens a small dialog: send in N minutes, optionally as **force steer**. |
| Scheduled-messages dock | above the composer card | Lists **this session's** scheduled messages with a live countdown. Each row can be edited (text, minutes, force steer — editing restarts the countdown), removed, or sent now. Hidden when the session has none. |
| Delivery | host | A scanner checks for due items; each is sent exactly like a normal composer send. |

A scheduled message is the user's own text. It arrives in the transcript as an ordinary user message (source kind `user`), not as a plugin notice.

## Per-session scope

Both composer slots are scoped to one session window and are handed that session's id. The dock shows, and the host returns, only the items scheduled for that session: a message scheduled in session A is not visible in, and cannot be edited, removed or sent from, session B. A call that does not name a session gets no items back rather than everything.

## Delivery

When an item is due the host calls `sessionController.prompt` with the item's id as the request id — the same call the composer's Send button makes.

- **Normal item** — a follow-up: it runs as its own turn after the current one.
- **Force steer item** — steering: it interrupts the current turn at the next step.
- **Session not running** — the session is resumed first, then the message is delivered.
- **Retries** — a delivery that fails stays queued and is retried with a back-off (5 s, doubling, capped at 5 min). A delivery that gets no answer within `deliveryTimeoutMs` is given up on and counts as a failure, so one hung session cannot hold up the others; the item is retried later. The harness only checks the abort signal before it admits a prompt, so a prompt that was already admitted may still land. The retry then carries the same request id, which `prompt` dedupes on, so it cannot send twice.
- **Session not found** — the harness also reports this transiently (a session disposed while the message was being admitted), so the host asks once more after two seconds. Only if the session is still not found is the item dropped, with a warning that includes the message text (first 500 characters).
- **Rejected by the harness** (`gateway/bad-request`, e.g. empty content) — retrying cannot help, so the item is dropped with a warning that includes its text.
- **Sorting** — due items are delivered oldest-due first.
- **Time zone** — the browser's time zone is stored with the item when it is scheduled and passed as `clientTimeZone`, so time-aware context sees a zone. Only `UTC` and `Area/Location` names are kept (the harness rejects anything else, such as `GMT`, `EST` or `+05:00`); otherwise the field is left off. If the harness still refuses a stored zone, the send is retried once without it. Items without one (queued by earlier versions) are sent without.
- **Disposal** — when the plugin is unloaded the scanner stops, in-flight calls are aborted, and nothing more is sent or written.

## How this differs from the official schedule bundle

dsh 0.2.0 ships an optional `@deepseek-ai/dsh-experimental-schedule-bundle` (rows `time-context`, `schedule`, `ui-schedule`). Both can be enabled together. They solve different problems:

| | `dsh-scheduled-queue` (this) | `@deepseek-ai/dsh-experimental-schedule-bundle` |
| --- | --- | --- |
| Who schedules | **You**, from the composer | **The agent**, through tools (`schedule_create`, `schedule_list`, `schedule_update`, `schedule_delete`), and you, from the task page |
| What | One-shot "send this text in N minutes" | One-shot, fixed-rate, daily, weekly and cron reminders with titles and delivery history |
| Surface | Clock button and dock in the composer | Task page, session-row marks, header utilities |
| Storage | `<dsh home>/storages/scheduled-queue.json` | `schedule.json` in the harness's storage domain |

Why both exist: the official bundle is a task manager for recurring and agent-created reminders. This plugin is a "send this later" button on the draft you are looking at, with the pending messages visible beside the composer. Neither replaces the other.

Nothing collides, so no setup is needed to run them side by side. Checked against 0.2.0-rc.2:

- **Plugin rows:** this plugin is `scheduled-queue`; the bundle inserts `time-context`, `schedule`, `ui-schedule`.
- **Tools:** this plugin registers none; the bundle's are `schedule_create`, `schedule_list`, `schedule_update`, `schedule_delete`.
- **Slots:** this plugin uses `conversation.input.right` (id `sq-clock`) and `conversation.input.dock` (id `sq-dock`), both additive list slots. The bundle's client mounts into `conversation.session.header.utilities`, `conversation.chat.turnTail`, `sidebar.*` and `shell.overlay`, not these.
- **Routes:** this plugin owns `/api/scheduledQueue/*`; the bundle's service uses the typed `schedule` remote namespace.
- **Storage:** different files, different formats.
- **Client module id and styles:** `dsh-scheduled-queue`, style tag `sq-styles`, CSS classes `sq-*`.

One practical consequence: a message queued here is not visible to the agent's `schedule_list`, and a reminder created through the bundle does not show in this plugin's dock.

## Replacing the in-tree plugin

If your deployment still carries the earlier copy (dsh-deploy's `.dsh/profiles/web/plugins/scheduled-queue` and its `scheduled-queue` row in `cordis.patch.yml`), remove or keep disabled that row **before** enabling this package. Two plugins would register the same `/api/scheduledQueue/*` routes (the second registration fails) and scan the same queue file. The queue file is shared and compatible, so items already queued carry over.

## Install

Installed from a git tag of this repository — it is not published to npm. Replace `<version>` with a released version (tags are named `dsh-scheduled-queue-v<version>`; see [the tag list](https://github.com/chrisjohnson/dsh-plugins/tags)):

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-scheduled-queue-v<version>&path:/packages/scheduled-queue"
```

That installs the package into the profile and enables its bundle. If you manage the profile's `package.json` yourself, the pnpm equivalent is below — then also add `dsh-scheduled-queue` to the profile's `dsh.profile.bundles`, because `pnpm add` alone installs the plugin without enabling it:

```sh
pnpm add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-scheduled-queue-v<version>&path:/packages/scheduled-queue"
```

> **Warning:** never `pnpm add dsh-scheduled-queue` (or `dsh plugin add dsh-scheduled-queue`) by bare name. That resolves from the npm registry, where an unscoped `dsh-*` name can belong to an unrelated author and is **not** this plugin.

Restart dsh. With no configuration you get the clock button, the dock and delivery.

## Configuration

Set these on the row in your own profile patch (`config:` block). A top-level config-only row replaces the whole `config` object, so list every key you want.

| Key | Default | What it does |
| --- | --- | --- |
| `scanIntervalMs` | `5000` | How often, in milliseconds, the host looks for due items. Clamped to 1000–60000; a value that is not a number is ignored with a warning naming the key. Unset = 5000. |
| `deliveryTimeoutMs` | `60000` | How long one delivery may take before it is given up on and retried. Clamped to 1000–600000; same handling of bad values. Unset = 60000. |

Unknown keys are ignored with one warning each. Nothing is required.

## Persistence

The queue is one JSON file, `<dsh home>/storages/scheduled-queue.json`, where the dsh home is `$DSH_HOME` (a leading `~` is expanded), else `~/.dsh`. It is an array of

```json
{ "id": "…", "messageId": "…", "sessionId": "…", "text": "…", "minutes": 5, "forceSteer": false, "dueAt": 1700000000000, "createdAt": 1699999700000 }
```

Items are written on every change (to a temporary file, then renamed into place) and read at startup, before any request or delivery is served. Items queued by earlier versions use this same format and location and are picked up as they are; `timeZone` is an optional field added later. A file that is not a JSON array is moved aside to `scheduled-queue.json.corrupt-<time>` and the queue starts empty, rather than being overwritten. A file that exists but cannot be read (permissions, I/O error) is logged loudly and **never written over**: the in-memory queue keeps working, nothing is persisted, and the read is retried on every scan; once it succeeds the restored items are merged in and the file is written.

## Host endpoints

Exact Fetch routes under the authenticated `/api` fence; the browser half calls them as `connection.rpc.call('/api', 'scheduledQueue/<endpoint>', payload)`.

| Endpoint | Payload | Result |
| --- | --- | --- |
| `schedule` | `sessionId`, `text`, `minutes`, `forceSteer` | `{ id, dueAt, queue }` for that session |
| `list` | `sessionId` (required) | `{ queue }` for that session |
| `remove` | `id`, `sessionId` | `{ removed, queue }` |
| `sendNow` | `id`, `sessionId` | `{ delivered, queue }` |
| `edit` | `id`, `sessionId`, any of `text`, `minutes`, `forceSteer` | `{ queue }`; empty text is refused |

Every endpoint requires `sessionId`; a call without one gets `bad-request`. `remove`, `edit` and `sendNow` answer `being-sent` for an item whose delivery is in flight.

## Known limits

- If the queue file exists but cannot be read, scheduling still works in memory and the dock warns that messages are not being saved yet. Nothing is written over the file; once it is readable again the restored items are merged in, without bringing back items that were delivered or removed in the meantime.

- **Archived sessions** accept the message and park it until the session is unarchived, exactly as a normal composer send does.
- **Overdue items** (due while the harness was down) wake and resume their sessions on the first scan after start-up. Several overdue items are delivered oldest-due first, one after another.
- **Send now** reports what happened: sent, "stays queued and is retried automatically", or "could not be delivered and was removed" (its text is in the host log). The notice appears even when the dock has no rows left.
- Scheduling does not clear the composer draft.
- The dock lists scheduled messages only for the session window it is in; there is no cross-session view.

## Checks

```sh
node --test packages/scheduled-queue/test/*.test.mjs
```

Covers the per-session filter (host and browser copies), scheduling and edit rules, back-off, the delivery request, reading earlier versions' queue files, and the host wiring against a stand-in harness. The browser rendering and a real delivery into a running session need a live harness and are checked by hand.

## Compatibility

dsh `>=0.2.0-rc.2`. Uses the `conversation.input.right` and `conversation.input.dock` slots, `connection.fetch.register`, and `sessionController.prompt`.
