// dsh-kanban: the orchestrator's board feed and management tools — decisions only.
//
// The orchestrator is one permanent session that watches the board and keeps
// tickets moving. Everything that makes that readable is decided here, in a
// module that imports nothing from `@deepseek-ai/*` so every branch is testable
// on a bare clone:
//
//   - which board events are worth waking the orchestrator for, and the one-line
//     text each of them becomes (a digest);
//   - the coalescing window that turns a burst of digests into one message, with
//     a cap on how many may sit in the session's inbox unread;
//   - the compact board snapshot that greets the session on (re)start;
//   - the scoped tool contracts the orchestrator may call, and what each one
//     refuses before it reaches the engine at all.
//
// The Cordis wiring — creating the session, mounting its preset, registering
// these tools and delivering these texts — lives in src/orchestrator-host.mjs.
//
// Safe autonomy is a property of the tool set, not of the prompt: the
// orchestrator has no tool that approves or closes a ticket as done, and no tool
// for a question that genuinely needs a human — a worker question that does
// not need one is answered with `kanban_message`. What it can do is
// create, read, move, start, retry, kick, message, edit, configure and discard —
// where create files a new ticket into Backlog with the settings its build needs,
// edit only touches the title or body of a ticket nothing has started yet, under
// the same pristine lock as the human edit boundary, configure changes the
// *settings* of an open ticket (preset, write mode, worktree, priority, plan
// timing, budget) through the same store validation the human create form goes
// through, and discard needs a reason and refuses a ticket that is already Done or
// Discarded. Completion stays a human call: the board owner moved discard over to
// the orchestrator on 2026-11-04, and kept approve and close.
//
// A read also has to be answerable: the standing directive tells the
// orchestrator to read a parked question before deciding whether it needs a
// human, so `kanban_ticket` and `kanban_board` carry the question itself, not
// just the fact that something is waiting (KAN-66).

import { PLAN_QUESTIONS, PLAN_TIMINGS, validateTicketModes } from './lifecycle.mjs'
import { questionFromParkReason } from './recovery.mjs'
import { WRITE_MODES } from './store.mjs'

export const ORCHESTRATOR_PRESET_ID = 'dsh-kanban-orchestrator'
/** What a tool call answers while a human has paused the orchestrator. */
export const ORCHESTRATOR_PAUSED_MESSAGE = 'The orchestrator is paused by a human; do not change the board.'
export const ORCHESTRATOR_TITLE = 'Kanban orchestrator'
/** The stable session id: one per deployment, reused across restarts. */
export const ORCHESTRATOR_SESSION_ID = 'kanban-orchestrator'
/** The system-prompt section name the host registers for that agent scope. */
export const ORCHESTRATOR_PROMPT_SECTION = 'dsh-kanban:orchestrator'

/** How many digest messages may be queued ahead of the orchestrator at once. */
export const MAX_IN_FLIGHT_DIGESTS = 2
/** Lines buffered before a window flushes early, so one message stays bounded. */
export const MAX_DIGEST_LINES = 40
/** Tickets a board snapshot lists per column before it says "and N more". */
export const MAX_BOARD_LINES = 40
/** Characters kept from a park reason or an instruction in a digest line. */
export const MAX_DIGEST_CHARS = 180

/**
 * The session id a detach rotates to.
 *
 * A restart of the orchestrator session archives the current one and starts a
 * fresh id rather than reusing the archived one: the host's archived-session
 * guard and the restart-resume path both refuse a reused id, so the conversation
 * would come back dead. Rotation is therefore monotonic — `kanban-orchestrator`,
 * then `kanban-orchestrator-2`, then `-3` — and the number is derived from the id
 * it is rotating from, so a deployment that renamed its orchestrator keeps its
 * own name as the stem.
 *
 * @param {string} currentId - the id being retired.
 * @param {number|null|undefined} generation - the rotation count stored beside
 *   it. When it is missing or unusable the suffix of `currentId` decides, so the
 *   helper never needs the store to be right for the id to be unique.
 * @returns {string} the next id.
 */
export function nextOrchestratorSessionId(currentId, generation = null) {
  const raw = typeof currentId === 'string' && currentId.trim() !== '' ? currentId.trim() : ORCHESTRATOR_SESSION_ID
  const suffixed = /^(.*)-(\d+)$/.exec(raw)
  const stem = suffixed !== null ? suffixed[1] : raw
  const fromId = suffixed !== null ? Number(suffixed[2]) : 1
  const current = Number.isFinite(generation) && Number(generation) >= 1 ? Math.floor(Number(generation)) : fromId
  return `${stem}-${current + 1}`
}

/**
 * The event kinds worth waking the orchestrator for, and the family each one
 * belongs to. Two events in the same family for the same ticket inside one
 * window is one line, not two: a park writes `needs_attention_reason` (the
 * engine's own account, with the failed phase) and `needs_attention` (the store
 * row), and the orchestrator only needs to hear it once.
 */
const WATCHED_KINDS = new Map([
  ['needs_attention_reason', 'parked'],
  ['needs_attention', 'parked'],
  ['attention_cleared', 'unparked'],
  ['stalled', 'stalled'],
  ['phase_changed', 'phase'],
  ['column_changed', 'column'],
  ['done', 'closed'],
  ['discarded', 'closed'],
  ['aborted', 'aborted'],
  ['grant_applied', 'grants'],
  ['plan_approved', 'plan-approved'],
  ['retry_scheduled', 'retry'],
  ['restart_recovered', 'restart'],
  ['auto_recovered', 'recovered'],
  ['guard_denied', 'denied'],
  ['preset_fallback', 'preset'],
])

/** Every kind the feed listens to, as an array (the host wires exactly this set). */
export const WATCHED_EVENT_KINDS = [...WATCHED_KINDS.keys()]

/** Whether one store event should reach the orchestrator at all. */
export function isWatchedEvent(event) {
  if (event === null || typeof event !== 'object') return false
  if (typeof event.ticketId !== 'string' || event.ticketId === '') return false
  // The orchestrator's own actions come back through the same stream; feeding
  // them to it would be an echo chamber, so the engine marks them.
  if (event.actor === 'orchestrator') return false
  return WATCHED_KINDS.has(event.kind)
}

/** Clip long free text onto one digest line without cutting a ticket key short. */
export function clip(value, limit = MAX_DIGEST_CHARS) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

const field = (event, key) => {
  const payload = event?.payload
  if (payload !== null && typeof payload === 'object' && payload[key] !== undefined && payload[key] !== null) {
    return payload[key]
  }
  return undefined
}

const phaseOf = (event) => {
  const failed = field(event, 'failedPhase') ?? field(event, 'phase')
  if (typeof failed === 'string' && failed !== '') return failed
  if (typeof event?.phaseTo === 'string' && event.phaseTo !== '') return event.phaseTo
  if (typeof event?.phaseFrom === 'string' && event.phaseFrom !== '') return event.phaseFrom
  return '?'
}

/**
 * The one-line account of one board event, or null when it is not the
 * orchestrator's business. The text is deliberately flat — one line per event,
 * ticket key first — because the orchestrator reads a wall of these and has to
 * pick the one that needs it.
 */
export function digestEvent(event) {
  if (!isWatchedEvent(event)) return null
  const key = typeof event.key === 'string' && event.key !== '' ? event.key : String(event.ticketId).slice(0, 8)
  const kind = event.kind
  switch (kind) {
    case 'needs_attention_reason':
    case 'needs_attention':
      return `${key} parked in ${phaseOf(event)}: ${clip(field(event, 'reason') ?? 'no reason recorded')}`
    case 'attention_cleared':
      return `${key} un-parked${field(event, 'reason') ? `: ${clip(field(event, 'reason'))}` : ''}`
    case 'stalled':
      return `${key} stalled in ${phaseOf(event)}${field(event, 'sessionId') ? ` (session ${String(field(event, 'sessionId')).slice(0, 18)})` : ''}`
    case 'phase_changed':
      return `${key} phase ${event.phaseFrom ?? '?'} → ${event.phaseTo ?? '?'}`
    case 'column_changed':
      return `${key} moved ${field(event, 'from') ?? '?'} → ${field(event, 'to') ?? '?'}${field(event, 'reason') ? ` (${clip(field(event, 'reason'), 60)})` : ''}`
    case 'done':
      return `${key} done${field(event, 'attempt') !== undefined ? ` after ${field(event, 'attempt')} attempt(s)` : ''}`
    case 'discarded':
      return `${key} discarded: ${clip(field(event, 'reason') ?? 'no reason recorded')}`
    case 'aborted':
      return `${key} aborted: ${clip(field(event, 'reason') ?? 'no reason recorded')}`
    case 'grant_applied':
      return `${key} sandbox grants approved — the build may start`
    case 'plan_approved':
      return `${key} plan approved, building now`
    case 'retry_scheduled':
      return `${key} retry scheduled${field(event, 'instruction') ? ` with an instruction: ${clip(field(event, 'instruction'), 90)}` : ''}`
    case 'restart_recovered':
      return `${key} restart found it in ${phaseOf(event)}: ${clip(field(event, 'reason') ?? (field(event, 'autoResume') === true ? 'resuming automatically' : 'parked for a human'), 90)}`
    case 'auto_recovered':
      return `${key} auto-recovered in ${phaseOf(event)} (kick ${field(event, 'kick') ?? '?'})`
    case 'guard_denied':
      return `${key} had a write denied by the board guard: ${clip(field(event, 'reason') ?? field(event, 'summary') ?? 'no detail', 90)}`
    case 'preset_fallback':
      return `${key} could not mount preset ${clip(field(event, 'requested') ?? '?', 40)}; session started in ${clip(field(event, 'used') ?? '?', 40)}`
    default:
      return `${key} ${kind}`
  }
}

/** The dedupe identity of one event: same ticket, same family, one line per window. */
function digestFamily(event) {
  return `${event.ticketId}|${WATCHED_KINDS.get(event.kind) ?? event.kind}`
}

/**
 * The coalescing window: digests arrive one at a time as the board moves, and
 * the orchestrator gets them in batches. A burst costs one message, not one turn
 * per event; and while `maxInFlight` digests already sit in the session's inbox
 * the window keeps buffering instead of stacking more work in front of a
 * conversation the human may be having.
 *
 * Timers are injected so the logic is testable without waiting.
 *
 * @param {object} options
 * @param {number} [options.windowMs] - quiet time before a batch is delivered.
 * @param {number} [options.maxLines] - lines buffered before an early flush.
 * @param {number} [options.maxInFlight] - queued digests allowed ahead of the session.
 * @param {(text: string) => boolean|Promise<boolean>} options.deliver - send it;
 *   return false (or throw) when the session cannot take it, and the lines stay.
 * @param {(fn: () => void, ms: number) => unknown} [options.schedule]
 * @param {(handle: unknown) => void} [options.unschedule]
 * @param {() => number} [options.now]
 */
export function createDigestWindow({
  windowMs = 30000,
  maxLines = MAX_DIGEST_LINES,
  maxInFlight = MAX_IN_FLIGHT_DIGESTS,
  deliver,
  // Unref'd by default: a pending digest must never be the reason a process
  // stays alive. The window is a convenience, not a job.
  schedule = (fn, ms) => {
    const timer = setTimeout(fn, ms)
    if (typeof timer.unref === 'function') timer.unref()
    return timer
  },
  unschedule = (handle) => clearTimeout(handle),
  now = Date.now,
} = {}) {
  if (typeof deliver !== 'function') throw new Error('createDigestWindow needs a deliver function')
  let lines = []
  let families = new Set()
  let dropped = 0
  let timer = null
  let inFlight = 0
  let delivered = 0
  let disposed = false

  const arm = (ms) => {
    if (disposed || timer !== null) return
    timer = schedule(() => {
      timer = null
      void flush()
    }, ms)
  }

  /**
   * Keep the buffer bounded: the oldest news is the least actionable, and a
   * window in front of a session that is not reading must not grow forever.
   */
  function add(line) {
    lines.push(line)
    while (lines.length > maxLines) {
      lines.shift()
      dropped += 1
    }
    arm(windowMs)
  }

  function push(event) {
    if (disposed) return false
    const line = digestEvent(event)
    if (line === null) return false
    const family = digestFamily(event)
    if (families.has(family)) return false
    families.add(family)
    add(line)
    return true
  }

  /** Push a raw line (the board snapshot uses this path; it is not an event). */
  function pushText(text) {
    if (disposed || typeof text !== 'string' || text === '') return false
    add(text)
    return true
  }

  async function flush() {
    if (disposed || lines.length === 0) return false
    if (inFlight >= maxInFlight) {
      // The session has not read what it already has; try again after a window.
      arm(windowMs)
      return false
    }
    const batch = lines
    const forgotten = dropped
    lines = []
    families = new Set()
    dropped = 0
    const header = forgotten > 0
      ? `[board events] ${batch.length} change(s) (plus ${forgotten} earlier, dropped):`
      : `[board events] ${batch.length} change(s):`
    let accepted = false
    try {
      accepted = (await deliver(`${header}\n${batch.join('\n')}`)) !== false
    } catch {
      accepted = false
    }
    if (!accepted) {
      // Nothing was queued: put the lines back at the front, keep order, retry.
      lines = batch.concat(lines)
      dropped = Math.max(dropped, forgotten)
      arm(windowMs)
      return false
    }
    inFlight += 1
    delivered += batch.length
    return true
  }

  return {
    push,
    pushText,
    flush,
    /** The host calls this when the orchestrator finishes a turn. */
    settle() {
      inFlight = Math.max(0, inFlight - 1)
      if (lines.length > 0) arm(Math.max(1000, Math.floor(windowMs / 3)))
    },
    dispose() {
      disposed = true
      if (timer !== null) {
        unschedule(timer)
        timer = null
      }
      lines = []
      families = new Set()
    },
    get pending() {
      return lines.length
    },
    get inFlight() {
      return inFlight
    },
    get delivered() {
      return delivered
    },
    get dropped() {
      return dropped
    },
  }
}

/**
 * The question a ticket is waiting on, in the one shape every surface uses.
 *
 * Two owners know about a question, and they do not always agree, so the order
 * matters:
 *
 *   - the **live** wait: a session paused *inside* its turn on an unanswered
 *     `ask_user_question`. The driver has the batch the model actually wrote,
 *     with its options — the fullest account there is;
 *   - the **park**: the engine parked the ticket because its turn ended on a
 *     question. Only the question text survives, embedded in the park reason.
 *
 * A live batch wins when both exist: it is the current turn's ask, and it carries
 * the options the orchestrator needs in order to answer it itself.
 *
 * @param {object} ticket the ticket row (its `needsAttentionReason` is the park)
 * @param {{questions?: Array<object>}|null} [liveWait] the driver's pending question wait
 * @returns {{questions: Array<object>, source: 'live'|'park'}|null}
 */
export function pendingQuestionFacts(ticket, liveWait = null) {
  const live = Array.isArray(liveWait?.questions) ? liveWait.questions : []
  if (live.length > 0) return { questions: live, source: 'live' }
  const parked = questionFromParkReason(ticket?.needsAttentionReason)
  if (parked !== null) return { questions: [{ question: parked, options: [] }], source: 'park' }
  return null
}

/**
 * The ticket settings `kanban_configure` can change, as every read shows them.
 *
 * A lever you cannot see the state of is a guess: the case that prompted this
 * (KAN-65) is a card filed without its preset, write mode or worktree, and the
 * orchestrator could only learn that from a human. So the board row and the
 * ticket read both carry the current answer, and `kanban_configure` reports the
 * same block back after a change.
 *
 * @param {object} ticket
 */
function settingsFacts(ticket) {
  return {
    preset: ticket.preset ?? null,
    writeMode: ticket.writeMode ?? null,
    worktree: ticket.worktree === true,
    priority: ticket.priority,
    planTiming: ticket.planTiming,
    planQuestions: ticket.planQuestions,
    allowPaid: ticket.allowPaid === true,
  }
}

/**
 * The one-line facts of one ticket, as every orchestrator surface shows it: the
 * board rows, the `kanban_ticket` read, and the restart snapshot all come
 * through here, so a question cannot appear in one and be missing from another.
 *
 * The store owns the ticket fields; the host hands in what only the live driver
 * knows (`running`, `waitingOnHuman`, and the live question batch) as `live`.
 *
 * @param {object} ticket
 * @param {{running?: boolean, waitingOnHuman?: boolean, liveWait?: {questions?: Array<object>}|null}} [live]
 */
export function ticketLineFacts(ticket, live = {}) {
  return {
    key: ticket.key,
    title: ticket.title,
    column: ticket.column,
    phase: ticket.phase,
    parked: ticket.needsAttentionReason ?? null,
    pendingQuestion: pendingQuestionFacts(ticket, live.liveWait ?? null),
    settings: settingsFacts(ticket),
    running: live.running === true,
    waitingOnHuman: live.waitingOnHuman === true,
    attemptCount: ticket.attemptCount,
    spentUsd: ticket.spentUsd,
    budgetUsd: ticket.budgetUsd,
    updatedAt: ticket.updatedAt,
  }
}

/**
 * The board as one compact message. The orchestrator starts every restart with
 * this instead of replaying history it was not there for, so it has to say
 * where the work stands right now: what is moving, what is stuck, what is waiting
 * for a person.
 *
 * @param {object} board
 * @param {Record<string, number>} [board.counts]
 * @param {Array<object>} board.tickets - already ordered: working, then backlog, then parked.
 * @param {string} [board.asOf]
 */
export function boardSnapshotText(board) {
  const tickets = Array.isArray(board?.tickets) ? board.tickets : []
  const counts = board?.counts ?? {}
  const head = `[board snapshot${board?.asOf ? ` ${board.asOf}` : ''}] ${
    ['backlog', 'working', 'done', 'discarded'].map((column) => `${column} ${counts[column] ?? 0}`).join(' · ')
  }`
  const lines = [head]
  if (tickets.length === 0) {
    lines.push('The board is empty: nothing in Backlog or Working.')
    return lines.join('\n')
  }
  const listed = tickets.slice(0, MAX_BOARD_LINES)
  for (const ticket of listed) {
    const bits = [ticket.key, `“${clip(ticket.title, 70)}”`]
    if (ticket.column) bits.push(ticket.column)
    if (ticket.phase) bits.push(ticket.phase)
    if (ticket.parked) bits.push(`PARKED: ${clip(ticket.parked, 90)}`)
    // The park line is the engine's sentence and gets clipped; the question is
    // the thing the orchestrator has to *answer*, so it gets its own line at the
    // full digest width, with the options it may choose from.
    const asking = ticket.pendingQuestion?.questions?.[0]?.question
    if (asking) {
      const options = ticket.pendingQuestion.questions[0].options
      bits.push(`ASKING: ${clip(asking, MAX_DIGEST_CHARS)}${Array.isArray(options) && options.length > 0 ? ` [${clip(options.join(' | '), 90)}]` : ''}`)
    }
    if (ticket.running === true) bits.push('running')
    if (Number.isFinite(ticket.attemptCount) && ticket.attemptCount > 0) bits.push(`attempt ${ticket.attemptCount}`)
    if (ticket.waitingOnHuman === true) bits.push('waiting on a person')
    lines.push(`- ${bits.filter(Boolean).join(' · ')}`)
  }
  if (tickets.length > listed.length) {
    lines.push(`- … and ${tickets.length - listed.length} more ticket(s) not listed`)
  }
  return lines.join('\n')
}

// --------------------------------------------------------------------- tools --
//
// One spec per tool: the model-facing contract (`name`, `description`,
// `parameters`), the pure check (`guard`), and `run(args, api)` where `api` is
// the host's engine-facing seam. The guard runs first and its message is what
// the model reads back, so a refusal is a sentence about the boundary, not a
// stack trace.

const TICKET_ARG = {
  type: 'string',
  required: true,
  description: 'The ticket key (KAN-60) or id.',
}

/** The ticket keys the orchestrator may act on: open work only. */
function requireTicket(api, ticket) {
  if (typeof ticket !== 'string' || ticket.trim() === '') return { ok: false, message: 'a ticket key or id is required' }
  const found = api.resolveTicket(ticket.trim())
  if (found === null || found === undefined) return { ok: false, message: `no ticket matches "${ticket}"` }
  return { ok: true, ticket: found }
}

/**
 * A body the orchestrator writes is plain markdown: it has no way to upload an
 * attachment, so a `kanban-image:` reference in one of its bodies could only
 * ever be a broken ref. Refused at the guard instead of filed and left dangling.
 */
const IMAGE_REF_TOKEN = 'kanban-image:'

function rejectImageRefs(body) {
  return typeof body === 'string' && body.includes(IMAGE_REF_TOKEN)
    ? { ok: false, message: `a body you write cannot contain "${IMAGE_REF_TOKEN}" — the orchestrator cannot attach images` }
    : null
}

/** Non-empty check for an authoring field; the stored value is the trimmed one. */
function requireField(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * The ticket settings `kanban_configure` may change after creation (KAN-66).
 * These are the fields the human create form sets and nothing else could reach:
 * frozen for the orchestrator until now. Column, phase and the plan are not on
 * the list — moving and planning have their own tools, and a plan belongs to the
 * phase that produces it.
 */
const CONFIGURE_KEYS = ['preset', 'writeMode', 'worktree', 'priority', 'planTiming', 'planQuestions', 'allowPaid', 'budgetUsd']

/** The nullable pair: an id (or mode) to set, or null to fall back to the default. */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }

/**
 * `kanban_configure`: the settings patch, checked key by key.
 *
 * The same vocabulary the create form applies, checked here so the model gets a
 * sentence it can correct rather than a store error: `WRITE_MODES`,
 * `PLAN_TIMINGS` and `PLAN_QUESTIONS` are the very lists the store validates
 * against, and the mode pair and the paid-needs-budget rule are re-run on the
 * *resulting* ticket, not just on what was sent — turning a ticket paid without
 * giving it a budget is as invalid as filing one that way.
 *
 * @param {object} ticket the resolved ticket row
 * @param {object} args the raw tool arguments
 * @returns {{ok: true, patch: object}|{ok: false, message: string}}
 */
function configurePatch(ticket, args) {
  const patch = {}
  for (const key of CONFIGURE_KEYS) {
    if (args[key] !== undefined) patch[key] = args[key]
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, message: `nothing to configure: give at least one of ${CONFIGURE_KEYS.join(', ')}` }
  }
  if (patch.preset !== undefined && patch.preset !== null) {
    if (typeof patch.preset !== 'string' || patch.preset.trim() === '') {
      return { ok: false, message: 'preset must be an agent preset id, or null for the harness default' }
    }
    patch.preset = patch.preset.trim()
  }
  if (patch.writeMode !== undefined && patch.writeMode !== null && !WRITE_MODES.includes(patch.writeMode)) {
    return { ok: false, message: `writeMode must be one of ${WRITE_MODES.join(', ')}, or null for the purpose default` }
  }
  for (const key of ['worktree', 'allowPaid']) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') {
      return { ok: false, message: `${key} must be true or false` }
    }
  }
  if (patch.priority !== undefined && !Number.isInteger(patch.priority)) {
    return { ok: false, message: 'priority must be an integer' }
  }
  if (patch.budgetUsd !== undefined && (!Number.isFinite(patch.budgetUsd) || patch.budgetUsd < 0)) {
    return { ok: false, message: 'budgetUsd must be a finite number of dollars, 0 or more' }
  }
  if (patch.planTiming !== undefined && !PLAN_TIMINGS.includes(patch.planTiming)) {
    return { ok: false, message: `planTiming must be one of ${PLAN_TIMINGS.join(', ')}` }
  }
  if (patch.planQuestions !== undefined && !PLAN_QUESTIONS.includes(patch.planQuestions)) {
    return { ok: false, message: `planQuestions must be one of ${PLAN_QUESTIONS.join(', ')}` }
  }
  const modes = validateTicketModes(patch.planTiming ?? ticket.planTiming, patch.planQuestions ?? ticket.planQuestions)
  if (!modes.ok) return { ok: false, message: modes.reason }
  if (patch.allowPaid === true && !((patch.budgetUsd ?? ticket.budgetUsd) > 0)) {
    return { ok: false, message: 'a paid ticket needs a positive budgetUsd — send budgetUsd with allowPaid' }
  }
  return { ok: true, patch }
}

/**
 * The create settings a ticket's later sessions run under (KAN-15/KAN-18), now
 * reachable from `kanban_create` as well as from the human form. These are shape
 * checks only — a preset id's existence can only be answered by the live registry,
 * so the host seam does that, exactly as the human create path does.
 *
 * Returns `{ ok: false, message }` or `{ ok: true, settings }`, where `settings`
 * carries only the keys that were actually given: an omitted one stays the store
 * default instead of being pinned to it.
 */
function createSettings(args) {
  const settings = {}
  if (args.preset !== undefined && args.preset !== null) {
    const preset = requireField(args.preset)
    if (preset === null) {
      return { ok: false, message: 'preset must be a non-empty string when given; leave it out for the harness default' }
    }
    settings.preset = preset
  }
  if (args.writeMode !== undefined && args.writeMode !== null) {
    if (typeof args.writeMode !== 'string' || !WRITE_MODES.includes(args.writeMode)) {
      return { ok: false, message: `writeMode must be one of ${WRITE_MODES.join(', ')}; leave it out for the purpose default` }
    }
    settings.writeMode = args.writeMode
  }
  if (args.worktree !== undefined && args.worktree !== null) {
    if (typeof args.worktree !== 'boolean') {
      return { ok: false, message: 'worktree must be true or false when given' }
    }
    settings.worktree = args.worktree
  }
  if (args.planTiming !== undefined || args.planQuestions !== undefined) {
    // The store validates the pair together, so a half-given pair is completed
    // with the same defaults the store would apply, then checked.
    const planTiming = args.planTiming ?? 'at_pickup'
    const planQuestions = args.planQuestions ?? 'interactive'
    const modes = validateTicketModes(planTiming, planQuestions)
    if (!modes.ok) return { ok: false, message: modes.reason }
    settings.planTiming = planTiming
    settings.planQuestions = planQuestions
  }
  return { ok: true, settings }


export const ORCHESTRATOR_TOOL_SPECS = [
  {
    name: 'kanban_board',
    description:
      'Read the whole board as the orchestrator sees it: every open ticket with its column, phase, park reason, attempt count, whether a session is running on it, the question it is waiting on when one is open (`pendingQuestion`), and the settings `kanban_configure` can change. No gate — read freely, as often as you like.',
    parameters: {},
    guard: () => ({ ok: true }),
    run: async (_args, api) => api.board(),
  },
  {
    name: 'kanban_ticket',
    description:
      'Read one ticket in full: body, plan and its conditions with the latest claims, the last review, its sessions and its recent events — plus `pendingQuestion`, the question a worker is waiting on with its options, when one is open. Use this before acting on a ticket so the action matches what the record actually says.',
    parameters: { ticket: TICKET_ARG },
    guard: (args, api) => requireTicket(api, args.ticket),
    run: async (args, api, resolved) => api.ticket(resolved.ticket),
  },
  {
    name: 'kanban_create',
    description:
      'File a new ticket into Backlog: a title, a markdown body, an optional integer priority, and the settings its build session runs under — `preset`, `writeMode`, `worktree`, `planTiming` and `planQuestions`. This is how work you discover gets onto the board — including a rule about how the board itself should be run — instead of waiting for a person to type it. Use the settings when the work cannot be done without them: a build of dsh-deploy or dsh-plugins needs `preset: "cordis"`, `writeMode: "danger-full-access"` and `worktree: true` or every install, lab and git push it attempts is denied. The ticket lands exactly where a human files one: Backlog, unstarted, waiting to be planned. It cannot attach images, and filing it starts nothing.',
    parameters: {
      title: { type: 'string', required: true, description: 'One line naming the work.' },
      body: { type: 'string', required: true, description: 'The body in markdown: what you found, why it matters, and what done looks like.' },
      priority: { type: 'integer', description: 'Optional sort priority, higher first. Defaults to 0.' },
      preset: { type: 'string', description: 'Agent preset id for the ticket’s build session, e.g. "cordis" for Creator mode. Omit for the harness default.' },
      writeMode: { type: 'string', description: `Sandbox write mode for the build session: one of ${WRITE_MODES.join(', ')}. Omit for the purpose default.` },
      worktree: { type: 'boolean', description: 'Whether the ticket gets its own git worktree. Omit to mirror the human form, which turns it on whenever the worktree service is available.' },
      planTiming: { type: 'string', description: '"at_pickup" (plan when the engine takes it) or "now" (plan on creation). Defaults to "at_pickup".' },
      planQuestions: { type: 'string', description: '"interactive" (the planner may ask a person) or "autonomous" (it decides alone). Defaults to "interactive".' },
    },
    guard: (args) => {
      const title = requireField(args.title)
      if (title === null) return { ok: false, message: 'a title is required' }
      const body = requireField(args.body)
      if (body === null) return { ok: false, message: 'a body is required: say what the work is, in markdown' }
      if (args.priority !== undefined && args.priority !== null && !Number.isInteger(args.priority)) {
        return { ok: false, message: 'priority must be an integer when given' }
      }
      const imageRef = rejectImageRefs(body)
      if (imageRef !== null) return imageRef
      const checked = createSettings(args)
      if (checked.ok !== true) return checked
      return {
        ok: true,
        title,
        body,
        priority: Number.isInteger(args.priority) ? args.priority : undefined,
        settings: checked.settings,
      }
    },
    run: async (_args, api, checked) => api.create({
      title: checked.title,
      body: checked.body,
      priority: checked.priority,
      ...checked.settings,
    }),
  },
  {
    name: 'kanban_edit',
    description:
      'Fix the title and/or the body of a ticket that has not started — a Backlog or Working card no session has touched. Use it when the record is wrong or thin: a garbled title, a body missing the detail you just learned. It cannot touch a plan, conditions, review or verdicts (those belong to the phases that produce them), and a ticket anything has started answers that it can no longer be edited.',
    parameters: {
      ticket: TICKET_ARG,
      title: { type: 'string', description: 'The new title. Leave it out to keep the current one.' },
      body: { type: 'string', description: 'The new body, in markdown. Leave it out to keep the current one.' },
    },
    guard: (args, api) => {
      const found = requireTicket(api, args.ticket)
      if (!found.ok) return found
      const ticket = found.ticket
      if (ticket.column !== 'backlog' && ticket.column !== 'working') {
        return { ok: false, message: `${ticket.key} is in ${ticket.column}; only a Backlog or Working ticket can be edited` }
      }
      // The same pristine lock as the human edit boundary (src/edit.mjs): once a
      // role is working from the card, the card is frozen for everyone.
      if (api.ticketEditable(ticket) !== true) {
        return { ok: false, message: `${ticket.key} has already started; it can no longer be edited` }
      }
      const patch = {}
      if (args.title !== undefined) {
        const title = requireField(args.title)
        if (title === null) return { ok: false, message: 'a new title cannot be empty; leave it out to keep the current one' }
        patch.title = title
      }
      if (args.body !== undefined) {
        const body = requireField(args.body)
        if (body === null) return { ok: false, message: 'a new body cannot be empty; leave it out to keep the current one' }
        const imageRef = rejectImageRefs(body)
        if (imageRef !== null) return imageRef
        patch.body = body
      }
      if (Object.keys(patch).length === 0) {
        return { ok: false, message: 'nothing to edit: give a title, a body, or both' }
      }
      return { ok: true, ticket, patch }
    },
    run: async (_args, api, checked) => api.edit(checked.ticket, checked.patch),
  },
  {
    name: 'kanban_configure',
    description:
      'Change the settings of an open ticket that were filed wrong: which agent preset its sessions mount, the build write mode, whether it gets its own git worktree, its priority, when planning runs, whether it asks or decides autonomously, and its paid budget. This is the lever for the case where you discover a card was created with the wrong combination — a change to the harness filed without the Creator preset, Full Access or a worktree — instead of asking a person to flip it in the UI. Every value goes through the same validation the create form applies, and a closed ticket refuses: Done and Discarded belong to the human. Name the reason; it is recorded on the ticket.',
    parameters: {
      ticket: TICKET_ARG,
      preset: { ...NULLABLE_STRING, description: 'An agent preset id the sessions mount, or null for the harness default.' },
      writeMode: { ...NULLABLE_STRING, description: `The build sandbox mode: ${WRITE_MODES.join(', ')}, or null for the purpose default.` },
      worktree: { type: 'boolean', description: 'Whether the ticket gets its own git worktree.' },
      priority: { type: 'integer', description: 'Sort priority, higher first.' },
      planTiming: { type: 'string', enum: PLAN_TIMINGS, description: 'When planning runs: now, or at_pickup when the engine reaches it.' },
      planQuestions: { type: 'string', enum: PLAN_QUESTIONS, description: 'interactive asks a person; autonomous lets the engine take the recommended answer.' },
      allowPaid: { type: 'boolean', description: 'Whether paid providers may run this ticket. Needs a positive budgetUsd.' },
      budgetUsd: { type: 'number', description: 'Spend cap in dollars, 0 or more.' },
      reason: { type: 'string', description: 'Why, in one line. It goes into the ticket’s event log.' },
    },
    guard: (args, api) => {
      const found = requireTicket(api, args.ticket)
      if (!found.ok) return found
      const ticket = found.ticket
      if (ticket.column !== 'backlog' && ticket.column !== 'working') {
        return { ok: false, message: `${ticket.key} is in ${ticket.column}; only an open ticket can be reconfigured` }
      }
      const checked = configurePatch(ticket, args)
      if (!checked.ok) return checked
      return { ok: true, ticket, patch: checked.patch, reason: requireField(args.reason) }
    },
    run: async (_args, api, checked) => api.configure(checked.ticket, checked.patch, checked.reason),
  },
  {
    name: 'kanban_move',
    description:
      'Move an open ticket between Backlog and Working. Into Working is a statement that the engine should drive it now; back into Backlog parks it. Done and Discarded are a human’s calls and this tool will not make them.',
    parameters: {
      ticket: TICKET_ARG,
      to: { type: 'string', required: true, description: 'Where to put it: "backlog" or "working".' },
      reason: { type: 'string', description: 'Why, in one line. It goes into the ticket’s event log.' },
    },
    guard: (args, api) => {
      const found = requireTicket(api, args.ticket)
      if (!found.ok) return found
      if (args.to !== 'backlog' && args.to !== 'working') {
        return { ok: false, message: 'only "backlog" and "working" are yours to move between; Done and Discarded belong to the human' }
      }
      return { ok: true, ticket: found.ticket }
    },
    run: async (args, api, resolved) => api.move(resolved.ticket, args.to, args.reason),
  },
  {
    name: 'kanban_start',
    description:
      'Start work the engine is not yet driving: "planning" plans a Backlog ticket in place, "build" moves a planned ticket into Working and launches the build. A ticket already moving says so — do not push it twice.',
    parameters: {
      ticket: TICKET_ARG,
      what: { type: 'string', required: true, description: '"planning" or "build".' },
      reason: { type: 'string', description: 'Why, in one line, for the ticket’s event log.' },
    },
    guard: (args, api) => {
      const found = requireTicket(api, args.ticket)
      if (!found.ok) return found
      if (args.what !== 'planning' && args.what !== 'build') {
        return { ok: false, message: 'what must be "planning" or "build"' }
      }
      return { ok: true, ticket: found.ticket }
    },
    run: async (args, api, resolved) => api.start(resolved.ticket, args.what, args.reason),
  },
  {
    name: 'kanban_retry',
    description:
      'Retry a parked ticket with a fresh attempt budget and an instruction the role will read on its next turn. This is how a stuck ticket gets unstuck with a nudge instead of a human. The ticket resumes in the phase it was parked in, so one held at the approval gate goes back to that gate — its hand-over is re-run, in the session that holds the work or in a fresh one started from the summary of it — with no new plan or build round. The ticket must actually be parked; a ticket that is not parked is already moving.',
    parameters: {
      ticket: TICKET_ARG,
      instruction: { type: 'string', description: 'What the role should do differently. One or two sentences, concrete.' },
    },
    guard: (args, api) => {
      const found = requireTicket(api, args.ticket)
      if (!found.ok) return found
      if (typeof args.instruction !== 'string' || args.instruction.trim() === '') {
        return { ok: false, message: 'an instruction is required: say what the next attempt should do differently' }
      }
      if (!found.ticket.needsAttentionReason) {
        return { ok: false, message: `${found.ticket.key} is not parked, so there is nothing to retry — read the board before acting again` }
      }
      return { ok: true, ticket: found.ticket }
    },
    run: async (args, api, resolved) => api.retry(resolved.ticket, args.instruction),
  },
  {
    name: 'kanban_kick',
    description:
      'Ask the harness to continue a session that stopped mid-turn (a halted or stalled role session). Takes a session id from kanban_board or kanban_ticket. If the session is genuinely still working the kick is declined and the answer says why.',
    parameters: {
      session: { type: 'string', required: true, description: 'The session id to kick.' },
    },
    guard: (args) => {
      if (typeof args.session !== 'string' || args.session.trim() === '') {
        return { ok: false, message: 'a session id is required' }
      }
      return { ok: true }
    },
    run: async (args, api) => api.kick(args.session.trim()),
  },
  {
    name: 'kanban_message',
    description:
      'Send a message into a ticket’s session — a correction, a pointer, a question to put to whoever is working there. It is queued, never interrupting a turn in flight. A session that ended its turn on a question receives it as that session’s next input, so this is also how you answer a worker question that does not need a human. It does not approve anything.',
    parameters: {
      ticket: TICKET_ARG,
      text: { type: 'string', required: true, description: 'What to say to that session.' },
      purpose: { type: 'string', description: 'Which session: "plan", "build" or "verify". Defaults to the one the ticket is in now.' },
    },
    guard: (args, api) => {
      const found = requireTicket(api, args.ticket)
      if (!found.ok) return found
      if (typeof args.text !== 'string' || args.text.trim() === '') {
        return { ok: false, message: 'text is required' }
      }
      if (args.purpose !== undefined && !['plan', 'build', 'verify'].includes(args.purpose)) {
        return { ok: false, message: 'purpose must be "plan", "build" or "verify" when given' }
      }
      return { ok: true, ticket: found.ticket }
    },
    run: async (args, api, resolved) => api.message(resolved.ticket, args.text, args.purpose ?? null),
  },
  {
    name: 'kanban_discard',
    description:
      'Discard a ticket: close it without approval, with a reason, because the work is not going to be done — a duplicate, a misread, something the board owner has decided against. It needs a reason, and it refuses a ticket that is already Done or Discarded. This is the only way you can end a ticket; approving and closing as done stay human actions, and a ticket that still has a chance gets `kanban_retry`, not this.',
    parameters: {
      ticket: TICKET_ARG,
      reason: { type: 'string', required: true, description: 'Why this work is being thrown away. One or two sentences; it goes into the ticket’s event log.' },
    },
    guard: (args, api) => {
      const found = requireTicket(api, args.ticket)
      if (!found.ok) return found
      const reason = requireField(args.reason)
      if (reason === null) {
        return { ok: false, message: 'a reason is required: say why this work is being discarded, not just that it is' }
      }
      if (found.ticket.column === 'done' || found.ticket.column === 'discarded') {
        return { ok: false, message: `${found.ticket.key} is already ${found.ticket.column}; only an open ticket can be discarded` }
      }
      return { ok: true, ticket: found.ticket, reason }
    },
    run: async (_args, api, resolved) => api.discard(resolved.ticket, resolved.reason),
  },
  {
    name: 'kanban_sessions',
    description:
      'List every workflow session the board knows about with its state: running, idle, waiting on a person, or gone. This is where a stalled ticket is diagnosed — the session that owes the next event is named here.',
    parameters: {},
    guard: () => ({ ok: true }),
    run: async (_args, api) => api.sessions(),
  },
]

/** Every tool name the orchestrator is offered (the host registers exactly these). */
export const ORCHESTRATOR_TOOL_NAMES = ORCHESTRATOR_TOOL_SPECS.map((spec) => spec.name)

/**
 * Validate one call and run it. Kept separate from `defineTool` so the contract
 * is testable without a harness: `guard` returns `{ok:false, message}` for a
 * refusal the model can read and correct, and `run` only sees clean arguments.
 *
 * @param {string} name
 * @param {object} args
 * @param {object} api - the host seam: board, ticket, resolveTicket, create,
 *   edit, ticketEditable, configure, move, start, retry, kick, message, discard,
 *   sessions.
 */
export async function runOrchestratorTool(name, args, api) {
  if (api?.paused?.() === true) throw new Error(ORCHESTRATOR_PAUSED_MESSAGE)
  const spec = ORCHESTRATOR_TOOL_SPECS.find((candidate) => candidate.name === name)
  if (spec === undefined) throw new Error(`unknown orchestrator tool ${name}`)
  const input = args !== null && typeof args === 'object' ? args : {}
  const checked = spec.guard(input, api)
  if (checked.ok !== true) throw new Error(checked.message ?? 'that call is not allowed')
  return spec.run(input, api, checked)
}
