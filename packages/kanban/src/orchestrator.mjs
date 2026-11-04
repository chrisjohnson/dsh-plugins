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
// orchestrator has no tool that approves, discards or closes a ticket, and no
// tool for a question that genuinely needs a human — a worker question that does
// not need one is answered with `kanban_message`. What it can do is
// create, read, move, start, retry, kick, message, and edit — where create only
// files a new ticket into Backlog and edit only touches the title or body of a
// ticket nothing has started yet, under the same pristine lock as the human edit
// boundary. Completion stays a human call.

export const ORCHESTRATOR_PRESET_ID = 'dsh-kanban-orchestrator'
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

export const ORCHESTRATOR_TOOL_SPECS = [
  {
    name: 'kanban_board',
    description:
      'Read the whole board as the orchestrator sees it: every open ticket with its column, phase, park reason, attempt count and whether a session is running on it. No gate — read freely, as often as you like.',
    parameters: {},
    guard: () => ({ ok: true }),
    run: async (_args, api) => api.board(),
  },
  {
    name: 'kanban_ticket',
    description:
      'Read one ticket in full: body, plan and its conditions with the latest claims, the last review, its sessions and its recent events. Use this before acting on a ticket so the action matches what the record actually says.',
    parameters: { ticket: TICKET_ARG },
    guard: (args, api) => requireTicket(api, args.ticket),
    run: async (args, api, resolved) => api.ticket(resolved.ticket),
  },
  {
    name: 'kanban_create',
    description:
      'File a new ticket into Backlog: a title, a markdown body, and an optional integer priority. This is how work you discover gets onto the board — including a rule about how the board itself should be run — instead of waiting for a person to type it. The ticket lands exactly where a human files one: Backlog, unstarted, waiting to be planned. It cannot attach images, and filing it starts nothing.',
    parameters: {
      title: { type: 'string', required: true, description: 'One line naming the work.' },
      body: { type: 'string', required: true, description: 'The body in markdown: what you found, why it matters, and what done looks like.' },
      priority: { type: 'integer', description: 'Optional sort priority, higher first. Defaults to 0.' },
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
      return { ok: true, title, body, priority: Number.isInteger(args.priority) ? args.priority : undefined }
    },
    run: async (_args, api, checked) => api.create({ title: checked.title, body: checked.body, priority: checked.priority }),
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
      'Retry a parked ticket with a fresh attempt budget and an instruction the role will read on its next turn. This is how a stuck ticket gets unstuck with a nudge instead of a human. The ticket must actually be parked; a ticket that is not parked is already moving.',
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
 *   edit, ticketEditable, move, start, retry, kick, message, sessions.
 */
export async function runOrchestratorTool(name, args, api) {
  const spec = ORCHESTRATOR_TOOL_SPECS.find((candidate) => candidate.name === name)
  if (spec === undefined) throw new Error(`unknown orchestrator tool ${name}`)
  const input = args !== null && typeof args === 'object' ? args : {}
  const checked = spec.guard(input, api)
  if (checked.ok !== true) throw new Error(checked.message ?? 'that call is not allowed')
  return spec.run(input, api, checked)
}
