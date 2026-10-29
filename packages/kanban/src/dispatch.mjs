// dsh-kanban: workflow session dispatch.
//
// Sessions are grouped by purpose, not by role:
//   plan          grill questions + plan submission (one flat session)
//   build         implement <-> review (one session)
//   verify        mechanical end gate (one session)
//
// Every session starts once in the standard preset. Phase changes do not rebind
// a preset or replace a system prompt: they change the tool guard/mask and the
// next user prompt.

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';

import { registerActionTools } from './actions.mjs';
import { TurnActivity } from './activity.mjs';
import { phaseToolGuard } from './tools.mjs';

export class DispatchError extends Error {
  constructor(message, { code = 'DISPATCH_FAILED' } = {}) {
    super(message);
    this.name = 'DispatchError';
    this.code = code;
  }
}

/** Session purpose for a phase/role. */
export function purposeForRole(role) {
  if (role === 'planner') return 'plan';
  if (role === 'implementer' || role === 'reviewer') return 'build';
  throw new DispatchError(`no workflow session purpose for role ${role}`, { code: 'NO_PURPOSE' });
}

/** Existing sessions can be reused within a purpose, never across purposes. */
export class SessionDriver {
  constructor({ ctx, log, getConfig, store }) {
    this.ctx = ctx;
    this.agents = ctx.get('agents');
    this.sessionController = ctx.get('sessionController');
    this.log = log;
    this.getConfig = getConfig;
    this.store = store;
    this.onManualAction = null;
    /** engine hook: a human turn pulled a needs-attention ticket back into play */
    this.onReactivate = null;
    /** engine hook: that turn ended without a structured action */
    this.onSettleTurn = null;
    this.waiters = new Map();
    /** sessionId -> {handle, role, purpose, ticketId} */
    this.live = new Map();
    /** `${ticketId}:${purpose}` -> Set<sessionId> (newest last) */
    this.ticketSessions = new Map();
    /** sessionId -> action recorded by the current turn */
    this.actions = new Map();
    /** which ticket sessions have a turn in flight, and which reactivated a ticket */
    this.activity = new TurnActivity({
      store,
      isLive: (sessionId) => this.live.get(sessionId)?.ticketId,
      hasAction: (sessionId) => this.actions.has(sessionId),
      onReactivate: (ticketId, sessionId) => (typeof this.onReactivate === 'function' ? this.onReactivate(ticketId, sessionId) : false),
      onSettle: (ticketId, sessionId) => (typeof this.onSettleTurn === 'function' ? this.onSettleTurn(ticketId, sessionId) : false),
      log,
    });
    this.disposed = false;
    this.offEvent = null;
    this.offAgent = null;
  }

  start() {
    this.offAgent = this.ctx.on('agent/created', (payload) => {
      const agent = payload?.agent;
      if (agent === undefined || agent === null) return;
      setTimeout(() => { void this.attachExistingSession(agent.id, agent).catch((error) => this.log.warn('kanban: reattach %s failed: %s', agent.id, String(error?.message ?? error))); }, 100);
    });
    this.offEvent = this.ctx.on('session/event', (session, event) => {
      this.#trackTicketTurn(session, event);
      const waiter = this.waiters.get(session.id);
      if (waiter === undefined) return;
      if (event.type === 'tool/call') {
        const name = event.data?.name ?? event.data?.call?.name;
        if (name === 'ask_user_question') waiter.awaitingUser = true;
      } else if (event.type === 'tool/result') {
        const name = event.data?.name ?? event.data?.message?.name;
        if (name === 'ask_user_question') waiter.awaitingUser = false;
      }
      waiter.lastEventAt = Date.now();
      if (event.type === 'turn/end') {
        try {
          this.#settleTurn(session, event, waiter);
        } catch (error) {
          this.log.warn('kanban driver: settle failed: %s', String(error?.stack ?? error));
        }
      }
    });
  }

  stop() {
    this.disposed = true;
    if (this.offEvent !== null) {
      try {
        this.offEvent();
      } catch {
        // already detached
      }
      this.offEvent = null;
    }
    for (const waiter of this.waiters.values()) {
      clearInterval(waiter.timer);
      waiter.resolve({ status: 'disposed', finalText: null, usage: null, reason: null, error: 'plugin stopped', action: null });
    }
    this.waiters.clear();
    this.actions.clear();
    this.activity.clear();
  }

  // ------------------------------------------------- realtime turn activity --
  //
  // `turn/start` and `turn/end` arrive on the global session event stream, so a
  // turn a human starts in a ticket's session is visible here exactly like one
  // the engine started. The bookkeeping itself lives in src/activity.mjs.

  #trackTicketTurn(session, event) {
    if (event.type === 'turn/start') {
      this.actions.delete(session.id);
      this.activity.turnStart(session.id);
    } else if (event.type === 'turn/end') {
      this.activity.turnEnd(session.id);
    }
  }

  /** True while any session of this ticket has work in flight, engine-driven or human-driven. */
  isTicketBusy(ticketId) {
    return this.activity.busy(ticketId, this.waiters.keys());
  }

  recordAction(sessionId, action) {
    if (this.actions.has(sessionId)) throw new Error('an action was already submitted for this turn');
    this.actions.set(sessionId, action);
  }

  takeAction(sessionId) {
    const action = this.actions.get(sessionId) ?? null;
    this.actions.delete(sessionId);
    return action;
  }

  /**
   * The registry's archive set as a live snapshot. Read on every use: DSH
   * publishes no archive/unarchive event, and there is no reason to — the set is
   * a plain getter over committed state.
   */
  #archivedSessionIds() {
    try {
      const ids = this.ctx.get('workspaceRegistry')?.archivedSessionIds;
      return new Set(Array.isArray(ids) ? ids.map(String) : []);
    } catch {
      return new Set();
    }
  }

  /** Live sessions registered for one ticket purpose, newest first, each tagged archived or not. */
  #purposeCandidates(ticketId, purpose) {
    const ids = this.ticketSessions.get(`${ticketId}:${purpose}`);
    if (ids === undefined) return [];
    const archived = this.#archivedSessionIds();
    const out = [];
    for (const sessionId of [...ids].reverse()) {
      const live = this.live.get(sessionId);
      if (live === undefined) continue;
      out.push({ sessionId, live, archived: archived.has(String(sessionId)) });
    }
    return out;
  }

  /** Return the live session for one ticket purpose, creating it on first use. */
  async ensureTicketSession({ ticket, role, route, purpose }) {
    if (this.disposed) throw new DispatchError('plugin is stopping');
    // An archived session is unusable: core's `agent/pre-step` gate rejects every
    // turn in it, so dispatching into one burns a phase turn that ends instantly
    // and reads as "the role ended without submitting". Skip archived candidates
    // rather than evicting them — unarchiving must make them live again without a
    // restart — and if the archive is all that is left, say so out loud instead of
    // silently creating a second session for the purpose.
    const candidates = this.#purposeCandidates(ticket.id, purpose);
    for (const candidate of candidates) {
      if (candidate.archived) continue;
      return { sessionId: candidate.sessionId, handle: candidate.live.handle };
    }
    const blocked = candidates.find((candidate) => candidate.archived);
    if (blocked !== undefined) {
      throw new DispatchError(`workflow session ${blocked.sessionId} is archived; unarchive it and retry`, { code: 'SESSION_ARCHIVED' });
    }
    if (this.agents === undefined) throw new DispatchError('agents service is missing', { code: 'NO_AGENTS' });
    const config = this.getConfig();
    const cwd = ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd();
    await mkdir(cwd, { recursive: true }).catch(() => {});
    const sessionId = `session-${randomUUID()}`;
    const liveRef = {
      handle: null,
      role,
      purpose,
      phase: { role },
      ticketId: ticket.id,
      preset: 'standard',
      routeKey: null,
      actionDispose: null,
      sandboxMode: null,
      owned: true,
    };
    const handle = await this.agents.create({
      sessionId,
      meta: { cwd, agentPreset: 'standard' },
      agentOptions: {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === null || route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      },
      setup: async (agentCtx) => {
        const presets = this.ctx.get('agentPresets');
        if (presets === undefined) throw new DispatchError('agentPresets service is missing', { code: 'NO_PRESETS' });
        await presets.mount(agentCtx, 'standard');
        liveRef.actionDispose = registerActionTools({ ctx: agentCtx, sessionId, purpose, liveRef, driver: this });
        agentCtx.tools.guard(phaseToolGuard(() => liveRef.phase.role, () => this.getConfig().roles));
        agentCtx.tools.guard((execution) => {
          if (purpose === 'plan' && execution.name === 'ask_user_question' && ticket.planQuestions === 'autonomous') {
            return 'this ticket uses autonomous judgement; ask the user no questions';
          }
          return undefined;
        });
      },
    });
    liveRef.handle = handle;
    liveRef.routeKey = routeKey(route);
    this.#applySandboxMode(liveRef);
    void this.#attachWorkspace(sessionId, cwd, 0);
    try {
      const titles = this.ctx.get('sessionTitle');
      if (titles?.rename) titles.rename(handle.agent.session, `${ticket.key} · ${purpose}`);
    } catch (error) {
      this.log.warn('workflow session: title pin failed: %s', String(error?.message ?? error));
    }
    this.live.set(sessionId, liveRef);
    this.#addTicketSession(ticket.id, purpose, sessionId);
    return { sessionId, handle };
  }

  /** Change the role inside one session without changing preset or system prompt. */
  setPhase(sessionId, role) {
    const live = this.live.get(sessionId);
    if (live === undefined) throw new DispatchError(`session ${sessionId} is not live`, { code: 'NOT_LIVE' });
    live.role = role;
    live.phase.role = role;
    this.#applySandboxMode(live);
  }

  async #attachWorkspace(sessionId, cwd, attempt) {
    const workspace = this.ctx.get('workspaceRegistry')?.list?.().find((item) => item.path === cwd);
    if (workspace === undefined || !workspace?.attachSession) {
      if (attempt >= 20) {
        this.log.warn('workflow session: no registered workspace matched %s', cwd);
        return;
      }
      setTimeout(() => { void this.#attachWorkspace(sessionId, cwd, attempt + 1); }, 250);
      return;
    }
    try {
      await workspace.attachSession(sessionId);
    } catch (error) {
      if (attempt >= 20) {
        this.log.warn('workflow session: workspace attach failed: %s', String(error?.message ?? error));
        return;
      }
      setTimeout(() => { void this.#attachWorkspace(sessionId, cwd, attempt + 1); }, 250);
    }
  }

  attachWorkspace(sessionId, cwd) {
    void this.#attachWorkspace(sessionId, cwd, 0);
  }

  #applySandboxMode(live) {
    const mode = live.purpose === 'plan' || live.purpose === 'verify' || live.role === 'reviewer' ? 'read-only' : 'workspace-write';
    if (live.sandboxMode === mode) return;
    try {
      setSandboxMode(live.handle.agent.session, mode);
      live.sandboxMode = mode;
    } catch (error) {
      this.log.warn('workflow session: sandbox mode %s could not be applied: %s', mode, String(error?.message ?? error));
    }
  }

  setRoute(sessionId, route) {
    const live = this.live.get(sessionId);
    if (live === undefined) throw new DispatchError(`session ${sessionId} is not live`, { code: 'NOT_LIVE' });
    const key = routeKey(route);
    if (live.routeKey === key) return;
    // The plugin can be mounted before the API session controller is published.
    // Resolve lazily; if it is genuinely unavailable, keep the session's current
    // route rather than failing the workflow turn.
    const controller = this.sessionController ?? this.ctx.get('sessionController');
    const selector = typeof controller?.selectForNextRequest === 'function'
      ? controller
      : controller?.agents;
    if (typeof selector?.selectForNextRequest !== 'function') {
      this.log.warn('sessionController route selector unavailable; keeping the current route for %s', sessionId);
      live.routeKey = key;
      return;
    }
    this.sessionController = controller;
    selector.selectForNextRequest(live.handle.agent, {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === null || route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    });
    live.routeKey = key;
  }

  liveTicketSessions(ticketId, purpose) {
    const ids = this.ticketSessions.get(`${ticketId}:${purpose}`);
    if (ids === undefined) return [];
    return [...ids].filter((id) => this.live.has(id));
  }

  liveTicketSession(ticketId, purpose) {
    const ids = this.liveTicketSessions(ticketId, purpose);
    return ids.length > 0 ? ids[ids.length - 1] : undefined;
  }

  #addTicketSession(ticketId, purpose, sessionId) {
    const key = `${ticketId}:${purpose}`;
    let ids = this.ticketSessions.get(key);
    if (ids === undefined) { ids = new Set(); this.ticketSessions.set(key, ids); }
    ids.delete(sessionId);
    ids.add(sessionId);
  }

  async attachExistingSession(sessionId, agentOverride) {
    if (this.disposed || this.live.has(sessionId)) return false;
    // Reopening an archived session in the UI must not hand it back to the
    // engine: it is still archived, so every turn in it is rejected at once.
    if (this.#archivedSessionIds().has(String(sessionId))) return false;
    const record = this.store?.findSession?.(sessionId);
    if (record === undefined || record.ticketId === null || record.ticketId === undefined) return false;
    const ticket = this.store.getTicket(record.ticketId);
    if (ticket === undefined) return false;
    const agent = agentOverride ?? this.agents?.get?.(sessionId);
    if (agent === undefined || agent === null) return false;
    const purpose = record.purpose ?? 'build';
    const role = purpose === 'plan' ? 'planner' : purpose === 'approval' ? 'approver' : purpose === 'build' && ticket.phase === 'review' ? 'reviewer' : 'implementer';
    const liveRef = {
      handle: { agent },
      role,
      purpose,
      phase: { role },
      ticketId: ticket.id,
      preset: 'standard',
      routeKey: null,
      actionDispose: null,
      sandboxMode: null,
      owned: false,
    };
    this.live.set(sessionId, liveRef);
    this.activity.negatives.delete(sessionId);
    this.#addTicketSession(ticket.id, purpose, sessionId);
    await this.#registerExistingTools(agent.ctx, liveRef, ticket, sessionId, purpose);
    this.#applySandboxMode(liveRef);
    void this.#attachWorkspace(sessionId, ticket.workspaceCwd ?? this.getConfig().defaultWorkspaceCwd ?? process.cwd(), 0);
    this.log.info('kanban: reattached session %s to %s/%s', sessionId, ticket.key, purpose);
    return true;
  }

  async #registerExistingTools(agentCtx, liveRef, ticket, sessionId, purpose) {
    liveRef.actionDispose = registerActionTools({ ctx: agentCtx, sessionId, purpose, liveRef, driver: this });
    agentCtx.tools.guard(phaseToolGuard(() => liveRef.phase.role, () => this.getConfig().roles));
    agentCtx.tools.guard((execution) => {
      if (purpose === 'plan' && execution.name === 'ask_user_question' && ticket.planQuestions === 'autonomous') return 'this ticket uses autonomous judgement; ask the user no questions';
      return undefined;
    });
  }

  isAwaitingUser(ticketId) {
    for (const [sessionId, waiter] of this.waiters) {
      if (waiter.awaitingUser && this.live.get(sessionId)?.ticketId === ticketId) return true;
    }
    return false;
  }

  #settleTurn(session, event, waiter) {
    this.waiters.delete(session.id);
    clearInterval(waiter.timer);
    const turn = event.data.turn;
    const events = session.snapshotEvents ? session.snapshotEvents() : [];
    const turnEvents = events.filter((e) => e.data !== null && typeof e.data === 'object' && e.data.turn === turn);
    const assistants = turnEvents.filter((e) => e.type === 'assistant/message');
    const last = assistants[assistants.length - 1];
    const finalText =
      last === undefined
        ? ''
        : (last.data.message.content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('');
    const usage = aggregateUsage(assistants.map((e) => e.data.usage));
    const reason = event.data.reason ?? null;
    // `blocked` is how core ends a turn rejected before its first step — the
    // archived-session gate among them. It is a failure, not a no-op turn: left
    // as success it reads as "the role ended without submitting".
    const failed = reason !== null && TURN_FAILURE_KINDS.includes(reason.kind);
    waiter.resolve({
      status: failed ? 'failed' : 'ok',
      finalText,
      usage,
      reason,
      error: failed ? turnFailureError(reason) : null,
      turn,
      events: turnEvents,
      session,
      action: this.takeAction(session.id),
    });
  }

  sendTurn({ sessionId, prompt, stallTimeoutMs }) {
    const live = this.live.get(sessionId);
    if (live === undefined) return Promise.reject(new DispatchError(`session ${sessionId} is not live`, { code: 'NOT_LIVE' }));
    if (this.waiters.has(sessionId) || this.activity.active.has(sessionId)) {
      return Promise.reject(new DispatchError(`session ${sessionId} already has a turn in flight`, { code: 'BUSY' }));
    }
    this.actions.delete(sessionId);
    const startedMono = process.hrtime.bigint();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null, lastEventAt: Date.now(), startedMono, sessionId, awaitingUser: false };
      const interval = Math.max(1000, Math.min(5000, Math.floor(stallTimeoutMs / 4)));
      const timer = setInterval(() => {
        if (this.waiters.get(sessionId) !== waiter) return;
        if (waiter.awaitingUser) return;
        if (Date.now() - waiter.lastEventAt <= stallTimeoutMs) return;
        this.waiters.delete(sessionId);
        clearInterval(timer);
        waiter.resolve({ status: 'stalled', finalText: null, usage: null, reason: null, error: 'no turn event within stallTimeoutMs', startedMono, action: null });
      }, interval);
      if (typeof timer.unref === 'function') timer.unref();
      waiter.timer = timer;
      this.waiters.set(sessionId, waiter);
      try {
        live.handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
      } catch (error) {
        this.waiters.delete(sessionId);
        clearInterval(timer);
        reject(new DispatchError(`could not admit prompt: ${error?.message ?? error}`, { code: 'PROMPT_REJECTED' }));
      }
    });
  }

  reconcileTurns() {
    const now = Date.now();
    // A turn/end that never arrived (host restart mid-turn, listener attached
    // after the fact) must not park a ticket as busy forever.
    this.activity.prune((sessionId) => {
      if (this.waiters.has(sessionId)) return true;
      try {
        const agent = this.agents?.get?.(sessionId);
        return agent === undefined || agent === null ? true : agent.status === 'running';
      } catch {
        return true;
      }
    });
    for (const [sessionId, waiter] of [...this.waiters]) {
      const live = this.live.get(sessionId);
      if (live === undefined) continue;
      if (waiter.awaitingUser) continue;
      if (now - waiter.lastEventAt > this.getConfig().stallTimeoutMs) {
        this.waiters.delete(sessionId);
        clearInterval(waiter.timer);
        waiter.resolve({ status: 'stalled', finalText: null, usage: null, reason: null, error: 'stalled', startedMono: waiter.startedMono, action: null });
        continue;
      }
      if (live.handle.agent.status === 'idle' && now - waiter.lastEventAt > 1500) {
        const session = live.handle.agent.session;
        const events = session.snapshotEvents ? session.snapshotEvents() : [];
        const ends = events.filter((event) => event.type === 'turn/end');
        const lastEnd = ends[ends.length - 1];
        if (lastEnd !== undefined) {
          try {
            this.#settleTurn(session, lastEnd, waiter);
          } catch (error) {
            this.log.warn('kanban driver: reconcile settle failed: %s', String(error?.stack ?? error));
          }
        }
      }
    }
  }

  submitAction(sessionId, action, exec) {
    const live = this.live.get(sessionId);
    if (live === undefined) throw new DispatchError(`session ${sessionId} is not live`, { code: 'NOT_LIVE' });
    if (this.waiters.has(sessionId)) {
      this.recordAction(sessionId, action);
      exec.concludeTurn();
      return { accepted: true, action: action.type };
    }
    // Record it for the turn before concluding it: the turn/end handler must see
    // that this session spoke through a structured action and must not settle
    // the ticket back to needs attention.
    if (!this.actions.has(sessionId)) this.actions.set(sessionId, action);
    exec.concludeTurn();
    setTimeout(() => {
      if (typeof this.onManualAction !== 'function') return;
      Promise.resolve(this.onManualAction({ ticketId: live.ticketId, purpose: live.purpose, sessionId, action }))
        .catch((error) => this.log.warn('kanban: manual action failed: %s', String(error?.stack ?? error)));
    }, 0);
    return { accepted: true, action: action.type, manual: true };
  }

  /** Abort and dispose a workflow session so continue-kicker sees an aborted end, not an idle error. */
  async closeSession(sessionId) {
    const live = this.live.get(sessionId);
    if (live === undefined) return;
    this.live.delete(sessionId);
    for (const [key, ids] of this.ticketSessions) { ids.delete(sessionId); if (ids.size === 0) this.ticketSessions.delete(key); }
    this.activity.forget(sessionId);
    this.actions.delete(sessionId);
    if (typeof live.actionDispose === 'function') live.actionDispose();
    const waiter = this.waiters.get(sessionId);
    if (waiter !== undefined) {
      this.waiters.delete(sessionId);
      clearInterval(waiter.timer);
      waiter.resolve({ status: 'disposed', finalText: null, usage: null, reason: null, error: 'session closed', action: null });
    }
    try {
      if (live.handle.agent?.status === 'running') live.handle.agent.cancel({ kind: 'user' });
    } catch {
      // Cancellation is best-effort; disposal below still tears the scope down.
    }
    if (live.owned !== false) try {
      await live.handle.dispose();
    } catch (error) {
      this.log.warn('session %s dispose failed: %s', sessionId, String(error?.message ?? error));
    }
  }

  async closeTicketSessions(ticketId) {
    const ids = [];
    for (const [key, set] of this.ticketSessions) {
      if (key.startsWith(`${ticketId}:`)) ids.push(...set);
    }
    for (const id of ids) await this.closeSession(id);
  }

  isLive(sessionId) {
    return this.live.has(sessionId);
  }
}

function routeKey(route) {
  return [route.provider, route.model, route.reasoningEffort ?? ''].join('|');
}

/** Turn-end reasons that mean the role never got to work. */
const TURN_FAILURE_KINDS = ['error', 'aborted', 'interrupted', 'max-tokens', 'blocked'];

/** One-line, user-facing explanation of a failed turn end, for needs-attention reasons. */
function turnFailureError(reason) {
  if (reason.kind === 'error') return reason.error?.message ?? 'model error';
  if (reason.kind === 'blocked') return 'turn blocked (session may be archived)';
  return reason.kind;
}

export function aggregateUsage(usages) {
  const present = usages.filter((u) => u !== null && u !== undefined && typeof u === 'object');
  if (present.length === 0) return null;
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const usage of present) {
    total.inputTokens += Number(usage.inputTokens ?? 0);
    total.outputTokens += Number(usage.outputTokens ?? 0);
    total.cacheReadTokens += Number(usage.cacheReadTokens ?? 0);
    total.cacheWriteTokens += Number(usage.cacheWriteTokens ?? 0);
  }
  return total;
}
