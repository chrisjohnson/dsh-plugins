// dsh-kanban: the orchestrator session — Cordis wiring.
//
// One permanent session per deployment, with a stable id, that the engine feeds
// and the human can talk to. This file owns everything about it that needs the
// harness: creating or resuming the session, mounting its preset, decorating it
// with the scoped management tools and its complete system prompt, and turning
// board events into queued messages. The *decisions* — what a digest line says,
// how digests coalesce, what a tool accepts — are in src/orchestrator.mjs.
//
// Three properties this wiring exists to keep:
//
//   - It is permanent. The id is stable across restarts, so the same
//     conversation resumes and the Work page's button has a fixed thing to open.
//     The one deliberate exception is a detach (KAN-65): the board owner can
//     archive this session and start a fresh one — new tools, new prompt, no
//     service restart — and the rotated id is remembered in the board db, so
//     every later boot resumes the new session, not the archived one. If the
//     session cannot be reached, the board still works: every failure here is a
//     log line and a state, never a thrown boot.
//   - It stays answerable. The preset gives it a 5-second shell and 5-second job
//     waits, and everything the engine sends goes in through `followup`, which
//     queues: a digest never interrupts a turn, so it never interrupts the human.
//   - It is a reader with levers, not a worker. Read-only sandbox mode, the
//     write and edit tools restricted away, and a tool set with no approve and no
//     close in it. It can file a new ticket into Backlog — with the preset, write
//     mode and worktree settings its build will need — fix the title or body of
//     one nothing has started, on the same pristine lock the human edit boundary
//     uses, change the settings of an open one (preset, write mode, worktree,
//     priority, plan timing, budget) through the store's own validation, and
//     discard an open one with a reason. Approving and closing stay with a person.

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { startBuild, moveToColumn } from './build.mjs'
import { startPlanning } from './planning.mjs'
import {
  ORCHESTRATOR_PRESET_ID,
  ORCHESTRATOR_PROMPT_SECTION,
  ORCHESTRATOR_SESSION_ID,
  ORCHESTRATOR_TITLE,
  ORCHESTRATOR_TOOL_SPECS,
  boardSnapshotText,
  clip,
  createDigestWindow,
  isWatchedEvent,
  nextOrchestratorSessionId,
  runOrchestratorTool,
  ticketLineFacts,
} from './orchestrator.mjs'

/** How long after the engine starts before the session is ensured. */
const START_DELAY_MS = 1500
/** And how long to wait before retrying a failed attempt. */
const RETRY_DELAY_MS = 30000
/** Characters of a ticket body a `kanban_ticket` read returns. */
const BODY_CHARS = 4000
/** The board-kv keys a detach writes (see src/schema.mjs v9). */
const KV_SESSION_ID = 'orchestrator.sessionId'
const KV_GENERATION = 'orchestrator.generation'
/** How many times a detach tries to archive the session it is retiring. */
const ARCHIVE_ATTEMPTS = 3


const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
}

const message = (error) => (error && error.message ? error.message : String(error))

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export class KanbanOrchestrator {
  /**
   * @param {object} deps
   * @param {object} deps.ctx        Cordis context of the plugin
   * @param {object} deps.store      KanbanStore
   * @param {object} deps.engine     the live Engine
   * @param {object} deps.driver     SessionDriver (for busy/live-session reads)
   * @param {() => object} deps.getConfig
   * @param {() => object} deps.getPrompts
   * @param {object} deps.log
   */
  constructor({ ctx, store, engine, driver, getConfig, getPrompts, log }) {
    this.ctx = ctx
    this.store = store
    this.engine = engine
    this.driver = driver
    this.getConfig = getConfig
    this.getPrompts = getPrompts
    this.log = log
    this.disposed = false
    /** 'off' | 'starting' | 'live' | 'archived' | 'failed' */
    this.phase = 'off'
    this.detail = null
    this.ensuring = null
    this.retryTimer = null
    this.offEvent = null
    /** sessionIds this instance has decorated in this process. */
    this.decorated = new Set()
    this.windowMs = this.#config().windowMs
    this.window = createDigestWindow({
      windowMs: this.windowMs,
      deliver: (text) => this.#deliver(text, 'events'),
    })
  }

  /**
   * The id a detach rotated to, if this board has had one. Read on every call
   * rather than cached in a field: the whole point of a detach is that the id
   * changes under a running process, and the next boot has to resume the rotated
   * session instead of the one named in the config row.
   */
  #kv(key) {
    try {
      const value = typeof this.store?.kvGet === 'function' ? this.store.kvGet(key) : null
      return typeof value === 'string' && value !== '' ? value : null
    } catch {
      // A board db that cannot answer is a board that still has its configured
      // orchestrator; the rotation is a refinement, not a prerequisite.
      return null
    }
  }

  #config() {
    const config = this.getConfig() ?? {}
    const configured = typeof config.orchestratorSessionId === 'string' && config.orchestratorSessionId !== ''
      ? config.orchestratorSessionId
      : ORCHESTRATOR_SESSION_ID
    return {
      enabled: config.orchestratorEnabled !== false,
      sessionId: this.#kv(KV_SESSION_ID) ?? configured,
      generation: Number(this.#kv(KV_GENERATION)),
      windowMs: Number.isFinite(config.orchestratorDigestWindowMs) && config.orchestratorDigestWindowMs > 0
        ? config.orchestratorDigestWindowMs
        : 30000,
      cwd: config.defaultWorkspaceCwd ?? process.cwd(),
      wipCap: Number.isFinite(config.wipCap) ? config.wipCap : null,
    }
  }

  // ------------------------------------------------------------------ state --

  get sessionId() {
    return this.#config().sessionId
  }

  #liveAgent() {
    try {
      const agent = this.ctx.get('agents')?.get?.(this.sessionId)
      return agent === undefined || agent === null || agent.status === 'closed' ? null : agent
    } catch {
      return null
    }
  }

  #archived() {
    try {
      const ids = this.ctx.get('workspaceRegistry')?.archivedSessionIds
      return Array.isArray(ids) && ids.map(String).includes(this.sessionId)
    } catch {
      return false
    }
  }

  /** True while a human has paused the orchestrator; read from the store so a restart keeps it. */
  get paused() {
    try {
      return this.store.isOrchestratorPaused() === true
    } catch {
      return false
    }
  }

  /**
   * Pause or resume. While paused nothing flows between the engine and the
   * session: digests are dropped and tool calls refused. The session itself is
   * left alone. Resuming sends one fresh board snapshot rather than a backlog.
   */
  setPaused(paused) {
    const next = paused === true
    const was = this.paused
    this.store.setOrchestratorPaused(next)
    if (next === was) return this.state()
    if (next) {
      this.window.dispose()
      this.window = createDigestWindow({ windowMs: this.windowMs, deliver: (text) => this.#deliver(text, 'events') })
      this.log.info('orchestrator: paused by a human')
    } else {
      this.log.info('orchestrator: resumed by a human')
      if (this.phase === 'live' && !this.disposed && this.#config().enabled) this.#announce(this.#config())
    }
    return this.state()
  }

  /** What the Work page's button needs to know before it tries to open it. */
  state() {
    const config = this.#config()
    const paused = this.paused
    if (!config.enabled) return { state: 'off', sessionId: config.sessionId, detail: 'orchestratorEnabled is false', paused }
    if (this.#liveAgent() !== null) return { state: 'live', sessionId: config.sessionId, detail: null, paused }
    if (this.#archived()) return { state: 'archived', sessionId: config.sessionId, detail: 'the session is archived; unarchive it to use the orchestrator', paused }
    return { state: 'starting', sessionId: config.sessionId, detail: this.detail, paused }
  }

  // ------------------------------------------------------------- lifecycle --

  start() {
    const config = this.#config()
    if (!config.enabled) {
      this.phase = 'off'
      this.log.info('orchestrator: disabled (set orchestratorEnabled to true to run it)')
      return
    }
    this.disposed = false
    if (this.offEvent === null) {
      this.offEvent = this.ctx.on('session/event', (session, event) => {
        if (this.disposed || session?.id !== this.sessionId) return
        if (event?.type === 'turn/end') this.window.settle()
      })
    }
    this.phase = 'starting'
    this.#schedule(START_DELAY_MS)
  }

  stop() {
    this.disposed = true
    this.window.dispose()
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.offEvent !== null) {
      try {
        this.offEvent()
      } catch {
        // already detached
      }
      this.offEvent = null
    }
  }

  /**
   * A config reload can turn the orchestrator on, off, or change its digest
   * window. Called by the host after it has swapped in the new config; the
   * session itself is never torn down, because a permanent session that vanished
   * every time someone edited a row would not be permanent.
   */
  reconcile() {
    const config = this.#config()
    if (config.windowMs !== this.windowMs) {
      this.windowMs = config.windowMs
      this.window.dispose()
      this.window = createDigestWindow({ windowMs: config.windowMs, deliver: (text) => this.#deliver(text, 'events') })
    }
    if (!config.enabled) {
      if (this.phase !== 'off') {
        this.disposed = true
        this.window.dispose()
        this.phase = 'off'
        this.log.info('orchestrator: turned off by config; the session stays where it is')
      }
      return
    }
    this.start()
  }

  #schedule(ms) {
    if (this.disposed) return
    const timer = setTimeout(() => {
      void this.ensure()
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    this.retryTimer = timer
  }

  /**
   * Bring the session into this process: reuse the live one, resume the stored
   * one, or create it. Idempotent and safe to call from more than one place —
   * concurrent callers share one attempt.
   */
  async ensure() {
    const config = this.#config()
    if (this.disposed || !config.enabled) return this.state()
    if (this.ensuring !== null) return this.ensuring
    this.ensuring = this.#ensureOnce(config)
      .catch((error) => {
        this.phase = 'failed'
        this.detail = message(error)
        this.log.warn('orchestrator: could not start (%s); retrying in %dms', this.detail, RETRY_DELAY_MS)
        this.#schedule(RETRY_DELAY_MS)
        return this.state()
      })
      .finally(() => {
        this.ensuring = null
      })
    return this.ensuring
  }

  /**
   * Retire the current orchestrator session and start a fresh one (KAN-65), with
   * no service restart.
   *
   * Why this exists: a session's tools and system prompt are decorated once, when
   * it is created, so tools shipped by a plugin release do not appear in the live
   * orchestrator until the next restart — and a restart ends every session on the
   * box. Rotating the session is that refresh on its own.
   *
   * It rotates the id rather than reusing it: an archived session stays archived,
   * and both the archived guard above and the resume path refuse a reused id, so
   * a same-id restart would come back dead. The retired session keeps its place in
   * the archive list with its whole history; the new one takes the next id and is
   * greeted with a board snapshot like any first start.
   *
   * @returns {Promise<object>} `{ ok: true, previousId, sessionId, state }`, or
   *   `{ ok: false, error }` with the reason nothing moved.
   */
  async detach() {
    const config = this.#config()
    if (!config.enabled) return { ok: false, error: 'the orchestrator is turned off, so there is no session to restart' }
    if (this.ensuring !== null) return { ok: false, error: 'an orchestrator start is already in flight; try again in a moment' }
    const registry = this.ctx.get('workspaceRegistry')
    if (typeof registry?.archiveSession !== 'function') {
      return { ok: false, error: 'the workspace registry is not mounted, so the current session cannot be archived' }
    }
    const previousId = config.sessionId
    // The session may be mid-turn, and an archive of a session with running work
    // is refused unless it is told to stop it. Three attempts, the same shape the
    // engine uses when it archives a closed ticket's sessions: a transient
    // refusal should not cost the refresh, and "no such session" already is the
    // state we want.
    let archived = false
    let lastError = null
    for (let attempt = 0; attempt < ARCHIVE_ATTEMPTS && archived === false; attempt++) {
      try {
        await registry.archiveSession(previousId, { stopActivity: true })
        archived = true
      } catch (error) {
        lastError = error
        if (error?.name === 'WorkspaceUnknownSessionError') archived = true
        else await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
    if (archived === false) {
      return { ok: false, error: `the current session ${previousId} could not be archived (${message(lastError)})` }
    }
    const nextId = nextOrchestratorSessionId(previousId, config.generation)
    const nextGeneration = Number.isFinite(config.generation) && config.generation >= 1 ? config.generation + 1 : 2
    try {
      this.store.kvSet(KV_SESSION_ID, nextId)
      this.store.kvSet(KV_GENERATION, String(nextGeneration))
    } catch (error) {
      // The old session is archived either way; say so rather than pretend the
      // board is unchanged, because the next boot would resume the configured id.
      return { ok: false, error: `${previousId} was archived but ${nextId} could not be recorded as the orchestrator session (${message(error)}); set orchestratorSessionId or restart the service` }
    }
    // Digests still queued for the retired session are stale now: the fresh one is
    // greeted with a board snapshot, which says the same thing more recently.
    this.window.dispose()
    this.window = createDigestWindow({ windowMs: this.windowMs, deliver: (text) => this.#deliver(text, 'events') })
    this.decorated.delete(previousId)
    this.phase = 'starting'
    this.detail = null
    this.log.info('orchestrator: detached %s, starting %s', previousId, nextId)
    const state = await this.ensure()
    return { ok: true, previousId, sessionId: state.sessionId ?? nextId, state }
  }

  async #ensureOnce(config) {
    const agents = this.ctx.get('agents')
    if (agents === undefined || agents === null) throw new Error('the agents service is not mounted')
    // An archived orchestrator is a human decision, not a restart detail: every
    // turn in it is rejected, so the engine says so and leaves it alone rather
    // than minting a second permanent session nobody asked for.
    if (this.#archived()) {
      if (this.phase !== 'archived') this.log.warn('orchestrator: session %s is archived; unarchive it to use the board orchestrator', config.sessionId)
      this.phase = 'archived'
      this.detail = 'the session is archived'
      return this.state()
    }
    const existing = this.#liveAgent()
    if (existing !== null) {
      await this.#decorateExisting(existing)
      this.#announce(config)
      return this.state()
    }
    // A session that exists but is not live in this process (the host restarted,
    // or nobody has opened it yet) is resumed through the session controller, so
    // the orchestrator keeps the conversation it had yesterday. An error here
    // means "nothing stored under that id" far more often than anything else, and
    // the answer to that is to create it.
    const controller = this.ctx.get('sessionController')
    if (typeof controller?.resolveAgent === 'function') {
      const resolved = await controller.resolveAgent(config.sessionId)
      if (resolved?.agent !== undefined && resolved?.agent !== null) {
        await this.#decorateExisting(resolved.agent)
        this.#announce(config)
        return this.state()
      }
      if (resolved?.error !== undefined) {
        this.log.info('orchestrator: %s could not be resumed (%s); starting a new session', config.sessionId, message(resolved.error))
      }
    }
    const route = this.engine.resolveRoute('orchestrator', 1)
    if (route?.provider === null || route?.model === null || route?.provider === undefined || route?.model === undefined) {
      throw new Error('no model route: set roles.orchestrator in the kanban config row, or a deployment default model')
    }
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined || presets === null) throw new Error('the agentPresets service is not mounted')
    const prompt = this.#promptText()
    const handle = await agents.create({
      sessionId: config.sessionId,
      meta: { cwd: config.cwd, agentPreset: ORCHESTRATOR_PRESET_ID },
      agentOptions: {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === null || route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      },
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, ORCHESTRATOR_PRESET_ID)
        this.#decorate(agentCtx)
        this.decorated.add(config.sessionId)
        // The prompt is registered before the agent publishes, so its very first
        // turn — this one — already carries it.
        agentCtx.systemPrompt.section({
          name: ORCHESTRATOR_PROMPT_SECTION,
          order: 100,
          text: prompt,
          complete: true,
          interpolate: false,
        })
      },
    })
    const agent = handle?.agent
    if (agent !== undefined && agent !== null) {
      this.#nameAndPlace(agent, config)
      this.#applySandbox(agent)
    }
    this.phase = 'live'
    this.detail = null
    this.log.info('orchestrator: session %s started on %s/%s', config.sessionId, route.provider, route.model)
    this.#announce(config)
    return this.state()
  }

  /** Re-attach tools and prompt to a session that already exists (after a restart). */
  async #decorateExisting(agent) {
    const sessionId = this.sessionId
    if (this.decorated.has(sessionId)) {
      this.phase = 'live'
      return
    }
    try {
      this.#decorate(agent.ctx)
      agent.ctx.systemPrompt.section({
        name: ORCHESTRATOR_PROMPT_SECTION,
        order: 100,
        text: this.#promptText(),
        complete: true,
        interpolate: false,
      })
      this.decorated.add(sessionId)
    } catch (error) {
      // A resumed session that cannot be re-decorated still answers the human;
      // it just cannot act on the board, and says so in its log.
      this.log.warn('orchestrator: could not re-attach tools to %s: %s', sessionId, message(error))
    }
    this.#applySandbox(agent)
    this.phase = 'live'
    this.detail = null
  }

  /** The decoration both paths share: the scoped tools, and nothing writable. */
  #decorate(agentCtx) {
    const api = this.#api()
    for (const spec of ORCHESTRATOR_TOOL_SPECS) {
      agentCtx.tools.register(defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: TOOL_OUTPUT,
        execute: async (args) => runOrchestratorTool(spec.name, args ?? {}, api),
      }))
    }
    // tool-fs registers read/write/edit as one plugin and has no switch for the
    // two writers, so they are taken away here — and the session runs read-only
    // anyway, so a write would be denied even if this restriction failed.
    try {
      agentCtx.tools.restrict({ deny: ['write', 'edit'] })
    } catch (error) {
      this.log.warn('orchestrator: write/edit could not be restricted (%s); the read-only sandbox is still the backstop', message(error))
    }
  }

  #applySandbox(agent) {
    try {
      setSandboxMode(agent.session, 'read-only')
    } catch (error) {
      this.log.warn('orchestrator: read-only mode could not be applied: %s', message(error))
    }
  }

  #nameAndPlace(agent, config) {
    try {
      this.ctx.get('sessionTitle')?.rename?.(agent.session, ORCHESTRATOR_TITLE)
    } catch (error) {
      this.log.warn('orchestrator: title could not be set: %s', message(error))
    }
    try {
      this.driver?.attachWorkspace?.(config.sessionId, config.cwd)
    } catch {
      // The session exists either way; a workspace it is not registered under
      // only means the Work page opens it through its own id.
    }
  }

  #promptText() {
    const prompts = this.getPrompts?.()
    const text = prompts?.bodies?.orchestrator
    if (typeof text === 'string' && text !== '') return text
    // Never start the session without its contract: the shipped default is in
    // the package, so a missing key here means a broken promptsDir override.
    return 'You are the Kanban orchestrator. The dsh-kanban prompts directory did not provide prompts/orchestrator.md, so state plainly that your instructions could not be loaded before acting on the board.'
  }

  /** The greeting a session gets when it (re)starts: where the board stands. */
  #announce(config) {
    const text = boardSnapshotText(this.#boardView())
    // Straight to the session, not through the digest window: a snapshot is the
    // state of the board now, and a batch that waits 30s to arrive behind other
    // news would be a worse greeting than none. If it cannot be queued yet, it
    // goes into the window and follows the normal retry path.
    if (!this.#deliver(text, 'snapshot')) this.window.pushText(text)
    void config
  }

  // ------------------------------------------------------------------ feed --

  /** One committed store event. Cheap, synchronous, and never throws. */
  ingest(event) {
    if (this.disposed || this.#config().enabled === false || this.paused) return
    // Nothing is buffered before the session exists: a restart greets the
    // orchestrator with a board snapshot, which already says what happened while
    // it was not there. Buffering the events themselves would deliver a stale
    // narrative on top of the current state.
    if (this.phase !== 'live') return
    if (!isWatchedEvent(event)) return
    const ticket = this.store.getTicket(event.ticketId)
    if (ticket === undefined) return
    try {
      this.window.push({ ...event, key: ticket.key })
    } catch (error) {
      this.log.warn('orchestrator: digest failed: %s', message(error))
    }
  }

  #deliver(text, kind) {
    // Dropped, not refused: a refusal would put the lines back and retry them.
    if (this.paused) return true
    const agent = this.#liveAgent()
    if (agent === null) return false
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin:dsh-kanban',
          form: 'notice',
          summary: kind === 'snapshot' ? 'Kanban board snapshot' : clip(text.split('\n')[0], 110),
        },
      }))
      return true
    } catch (error) {
      this.log.warn('orchestrator: digest could not be queued: %s', message(error))
      return false
    }
  }

  // -------------------------------------------------------------------- api --

  /**
   * One ticket as the orchestrator reads it. The facts themselves are decided in
   * src/orchestrator.mjs so the same line is testable on a bare clone; this only
   * supplies what the live driver knows: whether a session is on the ticket, and
   * the question batch it is paused on, if any (KAN-66).
   */
  #ticketLine(ticket) {
    return ticketLineFacts(ticket, {
      running: this.driver?.isTicketBusy?.(ticket.id) === true,
      waitingOnHuman: this.driver?.isAwaitingQuestion?.(ticket.id) === true || this.driver?.isAwaitingApproval?.(ticket.id) === true,
      liveWait: this.driver?.pendingQuestionFor?.(ticket.id) ?? null,
    })
  }

  #boardView() {
    const open = this.store.listTickets({ columns: ['working', 'backlog'], withBody: false })
    // Working first: the orchestrator's job is the work in motion, and a board
    // read in queue order buries it under the backlog.
    const order = { working: 0, backlog: 1 }
    const tickets = open
      .slice()
      .sort((a, b) => (order[a.column] ?? 9) - (order[b.column] ?? 9))
      .map((ticket) => this.#ticketLine(ticket))
    return {
      asOf: new Date().toISOString(),
      counts: this.store.counts(),
      tickets,
    }
  }

  #api() {
    const store = this.store
    const engine = this.engine
    return {
      paused: () => this.paused,
      resolveTicket: (keyOrId) => store.getTicket(keyOrId) ?? null,

      board: () => {
        const view = this.#boardView()
        return {
          ...view,
          engine: {
            driving: engine?.active?.size ?? 0,
            wipCap: this.#config().wipCap,
          },
        }
      },

      ticket: (ticket) => {
        const plan = store.latestArtifact(ticket.id, 'plan')
        const review = store.latestArtifact(ticket.id, 'review')
        return {
          ...this.#ticketLine(ticket),
          id: ticket.id,
          body: clip(ticket.body ?? '', BODY_CHARS),
          planTiming: ticket.planTiming,
          planQuestions: ticket.planQuestions,
          workspaceCwd: ticket.workspaceCwd,
          plan: plan === undefined ? null : safeJson(plan.content),
          conditions: store.listConditions(ticket.id),
          acceptance: store.listAcceptance(ticket.id),
          review: review === undefined ? null : safeJson(review.content),
          sessions: store.listSessions(ticket.id).map((row) => ({
            sessionId: row.sessionId,
            purpose: row.purpose,
            role: row.role,
            closedAt: row.closedAt,
            live: this.ctx.get('agents')?.get?.(row.sessionId) !== undefined,
          })),
          recentEvents: store.listEvents(ticket.id, { limit: 25 }).map((event) => ({
            at: event.at,
            kind: event.kind,
            actor: event.actor,
            detail: clip(JSON.stringify(event.payload ?? {}), 200),
          })),
        }
      },

      /**
       * `kanban_create`: the same store path a human filing a ticket takes
       * (src/host.mjs), so the card shows up on the board and in digests like
       * any other — only the recorded actor differs. The settings the guard
       * handed over are treated exactly as the human form's are: a preset id
       * means nothing until the live registry says it does, and the worktree
       * default is mirrored from that path — intent is ON whenever the worktree
       * service is mounted, because a ticket without its own worktree would plan
       * inside a live checkout. An omitted setting stays the store default.
       */
      create: async ({ title, body, priority, preset, writeMode, worktree, planTiming, planQuestions }) => {
        if (preset !== undefined && preset !== null) {
          const presets = this.ctx.get('agentPresets')
          if (typeof presets?.resolve !== 'function') {
            return { created: false, reason: 'the agent preset registry is not mounted, so that preset cannot be checked' }
          }
          try {
            await presets.resolve(String(preset))
          } catch {
            return { created: false, reason: `unknown agent preset: ${preset}` }
          }
        }
        const ticket = store.createTicket(
          {
            title,
            body,
            ...(priority === undefined ? {} : { priority }),
            ...(preset === undefined ? {} : { preset }),
            ...(writeMode === undefined ? {} : { writeMode }),
            ...(planTiming === undefined ? {} : { planTiming }),
            ...(planQuestions === undefined ? {} : { planQuestions }),
            column: 'backlog',
            worktree: worktree === undefined
              ? typeof this.ctx.get('betterGitWorktree')?.createForPath === 'function'
              : worktree === true,
          },
          { actor: 'orchestrator' },
        )
        void engine?.tick()
        return { created: true, ticket: this.#ticketLine(ticket) }
      },

      /**
       * `kanban_edit`: the patch carries title and body keys only — the guard in
       * src/orchestrator.mjs built it and checked the pristine lock through
       * `ticketEditable`. The store writes the `ticket_updated` event with this
       * actor and the list of fields that actually changed.
       */
      edit: (ticket, patch) => {
        const updated = store.updateTicket(ticket.id, patch, { actor: 'orchestrator', reason: 'orchestrator edit' })
        void engine?.tick()
        return { edited: true, ticket: this.#ticketLine(updated) }
      },

      /** The human edit boundary's lock (src/edit.mjs), asked of the store. */
      ticketEditable: (ticket) => this.store.isEditable(ticket.id),

      /**
       * `kanban_configure`: the settings patch the guard built, written through
       * the same store path a human settings change takes, so the same rules
       * apply (the write-mode vocabulary, the mode pair, paid-needs-budget) and
       * the `ticket_updated` event — fields, values, reason and this actor — is
       * the audit trail.
       *
       * A preset is the one value the store cannot check: it is an id in another
       * service's registry. It is resolved here first, exactly as the create
       * endpoint does, because an unknown id would mount nothing at session
       * start and fail later and quietly. A bad preset writes nothing at all.
       */
      configure: async (ticket, patch, reason) => {
        if (patch.preset !== undefined && patch.preset !== null) {
          const presets = this.ctx.get('agentPresets')
          if (typeof presets?.resolve !== 'function') {
            return { configured: false, reason: 'the agent preset registry is not mounted, so no preset can be checked' }
          }
          try {
            await presets.resolve(String(patch.preset))
          } catch {
            return { configured: false, reason: `unknown agent preset: ${patch.preset}` }
          }
        }
        const updated = store.updateTicket(ticket.id, patch, {
          actor: 'orchestrator',
          reason: reason ?? 'orchestrator configure',
        })
        void engine?.tick()
        return {
          configured: true,
          applied: Object.fromEntries(Object.keys(patch).map((key) => [key, updated[key]])),
          ticket: this.#ticketLine(updated),
        }
      },

      move: (ticket, to, reason) => {
        const updated = moveToColumn({
          store,
          engine,
          id: ticket.id,
          column: to,
          reason: reason ?? 'orchestrator move',
          actor: 'orchestrator',
        })
        return { moved: true, ticket: this.#ticketLine(updated) }
      },

      start: (ticket, what, reason) => {
        const result = what === 'planning'
          ? startPlanning({ store, driver: this.driver, engine, ticket })
          : startBuild({ store, engine, ticket, reason: reason ?? 'orchestrator start' })
        if (!result.ok) return { started: false, reason: result.message }
        return { started: true, ticket: this.#ticketLine(result.ticket) }
      },

      retry: (ticket, instruction) => {
        const updated = engine.retry(ticket, { instruction, actor: 'orchestrator' })
        return { retried: true, ticket: this.#ticketLine(updated) }
      },

      kick: async (sessionId) => {
        // Only a session the board owns: the orchestrator manages tickets, not
        // whatever else is running on this host.
        const record = store.findSession(sessionId)
        if (record === undefined || record.ticketId === null || record.ticketId === undefined) {
          return { kicked: false, reason: `session ${sessionId} is not a session of any ticket on this board` }
        }
        const kicker = engine.kickerService()
        if (kicker === null) return { kicked: false, reason: 'no continue-kicker service is mounted, so a halted session cannot be kicked from here' }
        const result = await kicker.kick(sessionId, { bypassCooldown: true })
        return { kicked: result?.kicked === true, flavor: result?.flavor ?? null, reason: result?.why ?? null }
      },

      message: (ticket, text, purpose) => {
        const wanted = purpose ?? (ticket.phase === 'plan' ? 'plan' : 'build')
        const sessionId = this.driver?.liveTicketSession?.(ticket.id, wanted)
        if (sessionId === undefined) {
          return { sent: false, reason: `no live ${wanted} session for ${ticket.key}; start it, or retry the ticket with an instruction` }
        }
        const agent = this.ctx.get('agents')?.get?.(sessionId)
        if (agent === undefined || agent === null) return { sent: false, reason: `session ${sessionId} is not live in this process` }
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: `[orchestrator] ${text}` }],
          source: { kind: 'plugin:dsh-kanban', form: 'notice', summary: `orchestrator: ${clip(text, 90)}` },
        }))
        return { sent: true, sessionId, purpose: wanted }
      },

      /**
       * `kanban_discard`: the engine's own discard path, credited to the
       * orchestrator. The guard already refused a blank reason and a ticket that
       * is Done or Discarded; everything past that — closing its sessions,
       * ending its run, the post-close archive — is the sequence a human
       * discard runs, with the actor being the only difference.
       */
      discard: async (ticket, reason) => {
        const updated = await engine.discard(ticket.id, reason, { actor: 'orchestrator' })
        return { discarded: true, ticket: this.#ticketLine(updated) }
      },

      sessions: () => {
        const agents = this.ctx.get('agents')
        const rows = store.listAllSessions().map((row) => {
          const agent = agents?.get?.(row.sessionId)
          const ticket = store.getTicket(row.ticketId)
          return {
            sessionId: row.sessionId,
            ticket: ticket?.key ?? null,
            purpose: row.purpose,
            role: row.role,
            state: agent === undefined || agent === null ? 'not-in-process' : (agent.status ?? 'unknown'),
            busy: this.driver?.isTicketBusy?.(row.ticketId) === true,
            waitingOnHuman: this.driver?.humanWaitSession?.(row.ticketId) ?? null,
          }
        })
        return { sessions: rows, orchestrator: this.state() }
      },
    }
  }
}
