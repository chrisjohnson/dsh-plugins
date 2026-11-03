// dsh-kanban: workflow session dispatch.
//
// Sessions are grouped by purpose, not by role:
//   plan          grill questions + plan submission (one flat session)
//   build         implement <-> review, then approval (one session)
//   verify        mechanical end gate (one session)
//
// Approval is a phase of the build session, not a session of its own: the same
// conversation that built and reviewed the work is what asks the human what to
// do with it.
//
// Every session starts once in a preset: plan and verify always take the
// standard one; a build session takes the ticket's chosen preset (KAN-15), or
// the harness default when the ticket has no opinion. Every standard tool a
// normal session has is available to every role. Kanban registers no tool
// guard: the action tools are present in every workflow session and each one
// refuses a call that does not belong to its phase.
//
// Phase changes do not rebind a preset or replace a system prompt: they change
// the next user prompt and which action tool will accept a submission. The
// sandbox mode is set by session purpose plus the ticket's write-mode choice,
// so a phase change inside one session never moves it.

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { registerActionTools } from './actions.mjs';
import { TurnActivity } from './activity.mjs';
import { sessionTitle } from './board-view.mjs';
import { makeGrantApprover } from './grants.mjs';
import { makeGuardApprover, resolveLiveCheckouts, resolveReadOnlyCommands } from './guard.mjs';
import { askUserToolDefinition, makeQuestionAnswerer } from './questions.mjs';

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
  // Approval is a phase of the build session: the session that built and
  // reviewed the work is the one that asks the human to approve it.
  if (role === 'implementer' || role === 'reviewer' || role === 'approver') return 'build';
  throw new DispatchError(`no workflow session purpose for role ${role}`, { code: 'NO_PURPOSE' });
}

/**
 * The role a reopened session comes back as. A build session carries three
 * phases, so the ticket's own phase decides which one it is mid-conversation;
 * `purpose === 'approval'` is the pre-0.7.0 shape, where approval was a session
 * of its own, and stays mapped so old rows reattach correctly.
 */
export function roleForSession(purpose, ticket) {
  if (purpose === 'plan') return 'planner';
  if (purpose === 'approval') return 'approver';
  if (ticket.phase === 'verify') return 'approver';
  if (ticket.phase === 'review') return 'reviewer';
  return 'implementer';
}

/**
 * The sentence a plan prompt gets when the ticket's working copy was left where
 * it is: which copy, why, and what it is standing on. A planner that does not
 * know it is reading an old commit will plan against code that is not current,
 * so this is appended to the prompt rather than only written to a log.
 */
export function worktreeStaleNote(refreshed) {
  const reason = refreshed?.reason ?? 'unknown';
  const base = typeof refreshed?.baseOid === 'string' && refreshed.baseOid !== ''
    ? refreshed.baseOid.slice(0, 10)
    : 'an unknown commit';
  const branch = refreshed?.branch ?? '(no branch)';
  return (
    `Worktree note: ${refreshed?.managedRoot ?? '(unknown path)'} (branch ${branch}) was left as-is because ${reason}; ` +
    `it is based on ${base}, not the latest main — plan against it as-is.`
  );
}

/**
 * The map of sessions paused on a person, reporting each open and close so the
 * ticket's event log can say when it was waiting on a human (working time
 * excludes those stretches). Every existing set/delete site keeps working.
 */
class WaitLedger extends Map {
  constructor(onChange) {
    super();
    this.onChange = onChange;
  }

  set(sessionId, wait) {
    const opened = !this.has(sessionId);
    super.set(sessionId, wait);
    if (opened) this.onChange(sessionId, wait, true);
    return this;
  }

  delete(sessionId) {
    const wait = this.get(sessionId);
    const had = super.delete(sessionId);
    if (had) this.onChange(sessionId, wait, false);
    return had;
  }

  clear() {
    const open = [...this.entries()];
    super.clear();
    for (const [sessionId, wait] of open) this.onChange(sessionId, wait, false);
  }
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
    /**
     * Sessions paused mid-turn on a human, KAN-17: sessionId ->
     * `{kind: 'approval' | 'question', id, toolName?, reason?}`.
     *
     * A harness approval prompt (`approval/asked` ... `approval/decided`) and
     * an unanswered `ask_user_question` call are both pauses *inside* a turn:
     * the turn stays in flight while the person decides, so the board would
     * otherwise show a blue "running" card for a session doing nothing but
     * waiting. The engine's own waiters only cover turns it started itself;
     * this map covers every turn on a ticket session, engine- or human-driven.
     */
    this.humanWaits = new WaitLedger((sessionId, wait, started) => this.#recordWait(sessionId, wait, started));
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
    /** Say the "no userQuestions service" warning once, not once per session. */
    this.askToolWarned = false;
  }

  start() {
    this.offAgent = this.ctx.on('agent/created', (payload) => {
      const agent = payload?.agent;
      if (agent === undefined || agent === null) return;
      setTimeout(() => {
        // The agent may have been created and closed inside this delay (a quick
        // plan turn): adopting its disposed scope would hand later rounds a dead agent.
        if (typeof this.agents?.get === 'function' && this.agents.get(agent.id) !== agent) return;
        void this.attachExistingSession(agent.id, agent).catch((error) => this.log.warn('kanban: reattach %s failed: %s', agent.id, String(error?.message ?? error))); }, 100);
    });
    this.offEvent = this.ctx.on('session/event', (session, event) => {
      const waiter = this.waiters.get(session.id);
      if (waiter !== undefined) {
        if (event.type === 'tool/call') {
          const name = event.data?.name ?? event.data?.call?.name;
          if (name === 'ask_user_question') waiter.awaitingUser = true;
        } else if (event.type === 'tool/result') {
          const name = event.data?.name ?? event.data?.message?.name;
          if (name === 'ask_user_question') waiter.awaitingUser = false;
        }
        waiter.lastEventAt = Date.now();
        if (event.type === 'turn/end' && this.#isWaitedTurn(waiter, event.data?.turn)) {
          try {
            this.#settleTurn(session, event, waiter);
          } catch (error) {
            this.log.warn('kanban driver: settle failed: %s', String(error?.stack ?? error));
          }
        }
      }
      // Last, and only after this turn's own waiter is gone: the settle path asks
      // the driver whether the ticket is busy, and the turn that just ended must
      // not be the answer. Running this first made an engine-driven turn on a
      // reactivated ticket look busy to its own settle, so the ticket was never
      // parked again (the approval intro was the case that hit it).
      this.#trackHumanWait(session, event);
      this.#trackTicketTurn(session, event);
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
    this.humanWaits.clear();
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

  // --------------------------------------------------- mid-turn human waits --
  //
  // KAN-17: an approval prompt or an ask_user_question call pauses a turn in
  // flight, not between turns, so `turn/start`/`turn/end` alone cannot tell the
  // board "this session is waiting on a person". The durable log carries exactly
  // that fact — `approval/asked`/`approval/decided` paired by id, and a
  // `tool/call` for ask_user_question answered by the `tool/result` citing the
  // same callId — and every one of those events arrives here for every session,
  // whether the engine started the turn or a human did.

  #recordWait(sessionId, wait, started) {
    try {
      const ticketId = this.activity.ticketOf(sessionId);
      if (ticketId === undefined) return;
      this.store?.appendEvent?.(ticketId, started ? 'human_wait_started' : 'human_wait_ended', {
        actor: 'engine',
        payload: { sessionId, kind: wait?.kind ?? null },
      });
    } catch {
      // The event only feeds working time; a failed write never disturbs the turn.
    }
  }

  #trackHumanWait(session, event) {
    const sessionId = session.id;
    switch (event.type) {
      case 'approval/asked': {
        if (this.activity.ticketOf(sessionId) === undefined) return;
        const data = event.data ?? {};
        this.humanWaits.set(sessionId, {
          kind: 'approval',
          id: data.id ?? null,
          toolName: data.toolName ?? null,
          reason: data.reason ?? null,
        });
        return;
      }
      case 'approval/decided': {
        const wait = this.humanWaits.get(sessionId);
        if (wait === undefined || wait.kind !== 'approval') return;
        // Pair by id; the pair is turn-enclosed, so at most one ask is open and
        // an unnumbered event on either side still clears the one that is.
        const id = event.data?.id;
        if (wait.id === null || id === undefined || id === null || wait.id === id) this.humanWaits.delete(sessionId);
        return;
      }
      case 'tool/call': {
        const name = event.data?.name ?? event.data?.call?.name;
        if (name !== 'ask_user_question') return;
        if (this.activity.ticketOf(sessionId) === undefined) return;
        this.humanWaits.set(sessionId, { kind: 'question', id: event.data?.callId ?? null });
        return;
      }
      case 'tool/result': {
        const wait = this.humanWaits.get(sessionId);
        if (wait === undefined || wait.kind !== 'question') return;
        // A tool result names its call by callId, never by tool name: the
        // message carries `toolCallId` (and `source.callId`), not a `name`.
        const callId = event.data?.callId ?? event.data?.message?.toolCallId ?? event.data?.message?.source?.callId;
        if (wait.id === null || callId === undefined || callId === null || wait.id === callId) this.humanWaits.delete(sessionId);
        return;
      }
      case 'turn/start':
      case 'turn/end': {
        // Defensive: an ask whose decided/result event was never published (a
        // crash between the two, a cancelled turn) must not haunt the session
        // into permanent red. A new turn cannot inherit the old one's wait.
        this.humanWaits.delete(sessionId);
        return;
      }
    }
  }

  /** The pending wait of one kind on any session of this ticket, if there is one. */
  #findHumanWait(ticketId, kind) {
    for (const [sessionId, wait] of this.humanWaits) {
      if (wait.kind !== kind) continue;
      const owner = this.live.get(sessionId)?.ticketId ?? this.activity.ticketOf(sessionId);
      if (owner === ticketId) return { sessionId, ...wait };
    }
    return null;
  }

  /** True while a session of this ticket sits on an unanswered approval prompt. */
  isAwaitingApproval(ticketId) {
    return this.#findHumanWait(ticketId, 'approval') !== null;
  }

  /**
   * True while a session of this ticket sits on an unanswered ask_user_question,
   * in any phase and on any turn — this supersedes the plan-phase-only waiter
   * scan the board used before KAN-17.
   */
  isAwaitingQuestion(ticketId) {
    return this.#findHumanWait(ticketId, 'question') !== null;
  }

  /**
   * The session holding a pending ask, approval first when both are open. The
   * detail view opens this one so the human can reach the prompt.
   */
  humanWaitSession(ticketId) {
    return this.#findHumanWait(ticketId, 'approval') ?? this.#findHumanWait(ticketId, 'question');
  }

  /**
   * Restart recovery (KAN-17): a session reopened mid-turn may be sitting on an
   * unanswered ask. Walk back to the open turn — the last `turn/start` with no
   * matching `turn/end`, the same boundary `@deepseek-ai/dsh-user-approval`
   * requires for its audit pair — and seed the wait from what is unanswered in
   * it. Best-effort: an unreadable log simply shows no wait.
   */
  #seedHumanWait(sessionId, agent) {
    try {
      const events = agent?.session?.snapshotEvents?.() ?? [];
      let openFrom = -1;
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const type = events[i]?.type;
        if (type === 'turn/end') return;
        if (type === 'turn/start') { openFrom = i; break; }
      }
      if (openFrom < 0) return;
      const asked = new Map();
      const questions = new Map();
      for (let i = openFrom + 1; i < events.length; i += 1) {
        const event = events[i];
        if (event?.type === 'approval/asked') asked.set(event.data?.id ?? '', event.data ?? {});
        else if (event?.type === 'approval/decided') asked.delete(event.data?.id ?? '');
        else if (event?.type === 'tool/call' && (event.data?.name ?? event.data?.call?.name) === 'ask_user_question') questions.set(event.data?.callId ?? '', event.data ?? {});
        else if (event?.type === 'tool/result') {
          const callId = event.data?.callId ?? event.data?.message?.toolCallId ?? event.data?.message?.source?.callId;
          if (callId !== undefined && callId !== null) questions.delete(callId);
        }
      }
      const approval = [...asked.values()].pop();
      if (approval !== undefined) {
        this.humanWaits.set(sessionId, {
          kind: 'approval',
          id: approval.id ?? null,
          toolName: approval.toolName ?? null,
          reason: approval.reason ?? null,
        });
        return;
      }
      const question = [...questions.values()].pop();
      if (question !== undefined) this.humanWaits.set(sessionId, { kind: 'question', id: question.callId ?? null });
    } catch (error) {
      this.log.warn('kanban driver: human-wait reattach scan failed for %s: %s', sessionId, String(error?.message ?? error));
    }
  }

  /** Sessions of this ticket with a turn in flight or a pending ask, for the card's jump-to-session target. */
  activeSessionIds(ticketId) {
    const ids = new Set();
    const candidates = [...this.activity.active, ...this.waiters.keys(), ...this.humanWaits.keys()];
    for (const sessionId of candidates) {
      if (this.activity.ticketOf(sessionId) === ticketId) ids.add(sessionId);
    }
    return [...ids];
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

  /**
   * The `betterGitWorktree` seam, looked up per call: plugin mount order is not
   * fixed, and a plugin that is simply not installed must not stop a ticket.
   */
  #worktreeService() {
    try {
      return this.ctx.get('betterGitWorktree');
    } catch {
      return undefined;
    }
  }

  /**
   * Decide — and now, not at ticket-creation time — which directory a plan
   * session starts in (KAN-18).
   *
   * Three shapes, in the order the board can present them:
   *
   *   (B) The ticket already names a checkout. That is every eager-era ticket,
   *       and any ticket a human pointed at a workspace. When that path is a
   *       managed working copy it is fetched and brought to the latest default
   *       branch *if it holds nothing of its own*; a copy with work in it, or a
   *       path this plugin does not own, is left exactly as it is and the caller
   *       gets a note to say so, which lands in the plan prompt.
   *
   *   (A) The ticket only recorded the intent — the new-ticket switch. The copy
   *       is cut here, from the just-fetched default branch, registered as a
   *       workspace, and the ticket is re-pointed at it.
   *
   *   (C) Neither: the ordinary default workspace, unchanged behavior.
   *
   * A `git fetch` that fails throws, on purpose. Planning on a base the plugin
   * could not bring up to date is exactly what the switch was asked to prevent,
   * so the ticket parks in needs-attention carrying git's own reason instead of
   * quietly planning against yesterday's code.
   *
   * @param {object} ticket - the ticket about to be planned.
   * @returns {Promise<{cwd: string, note?: string}>}
   */
  async preparePlanWorktree(ticket) {
    const config = this.getConfig();
    const plain = ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd();
    const service = this.#worktreeService();
    if (service === undefined || service === null) {
      if (ticket.worktree === true) {
        this.log.warn('kanban: %s asked for a worktree but dsh-better-git-worktree is not mounted; planning in %s', ticket.key, plain);
      }
      return { cwd: plain };
    }
    // (B) a checkout the ticket already points at.
    if (typeof ticket.workspaceCwd === 'string' && ticket.workspaceCwd !== '') {
      if (typeof service.refreshManagedCopy !== 'function') return { cwd: ticket.workspaceCwd };
      const refreshed = await service.refreshManagedCopy({ path: ticket.workspaceCwd, fetchFirst: true });
      // Not one of ours (a plain checkout, a hand-picked folder): nothing to
      // refresh, nothing to say.
      if (refreshed?.managed !== true) return { cwd: ticket.workspaceCwd };
      if (refreshed.updated === true) return { cwd: ticket.workspaceCwd };
      return { cwd: ticket.workspaceCwd, note: worktreeStaleNote(refreshed) };
    }
    // (A) intent only: create the copy now, from the current upstream.
    if (ticket.worktree === true) {
      if (typeof service.createForPath !== 'function') {
        this.log.warn('kanban: %s asked for a worktree but the mounted worktree service cannot create one; planning in %s', ticket.key, plain);
        return { cwd: plain };
      }
      const created = await service.createForPath({
        path: config.defaultWorkspaceCwd ?? process.cwd(),
        title: ticket.title,
        fetchFirst: true,
        baseOnRemote: true,
      });
      try {
        await this.ctx.get('workspaceRegistry')?.create?.(created.managedRoot, ticket.title);
      } catch (error) {
        this.log.warn('kanban: worktree workspace registration failed for %s: %s', created.managedRoot, String(error?.message ?? error));
      }
      this.store.updateTicket(
        ticket.id,
        { workspaceCwd: created.managedRoot },
        { actor: 'engine', reason: 'worktree created at plan start' },
      );
      this.log.info('kanban: %s worktree created at %s based on %s', ticket.key, created.managedRoot, created.baseOid);
      return { cwd: created.managedRoot };
    }
    // (C) nothing was ever asked for.
    return { cwd: plain };
  }

  /** Return the live session for one ticket purpose, creating it on first use. */
  async ensureTicketSession({ ticket, role, route, purpose, preparedCwd }) {
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
    // KAN-18: `preparePlanWorktree` may have created or refreshed the copy this
    // turn is about to run in, and its answer wins over the stored one.
    const cwd = preparedCwd ?? ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd();
    await mkdir(cwd, { recursive: true }).catch(() => {});
    const sessionId = `session-${randomUUID()}`;
    // KAN-15: the ticket chooses its build session's preset and write mode.
    // `undefined` means the harness default, so a NULL column keeps tracking
    // future default changes; plan and verify stay fixed on standard/read-only.
    const presetChoice = purpose === 'build' ? (ticket.preset ?? undefined) : 'standard';
    const liveRef = {
      handle: null,
      role,
      purpose,
      phase: { role },
      ticketId: ticket.id,
      preset: presetChoice ?? 'standard',
      writeMode: purpose === 'build' ? (ticket.writeMode ?? null) : null,
      routeKey: null,
      actionDispose: null,
      questionDispose: null,
      sandboxMode: null,
      owned: true,
    };
    const handle = await this.agents.create({
      sessionId,
      meta: { cwd, ...(presetChoice === undefined ? {} : { agentPreset: presetChoice }) },
      agentOptions: {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === null || route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      },
      setup: async (agentCtx) => {
        const presets = this.ctx.get('agentPresets');
        if (presets === undefined) throw new DispatchError('agentPresets service is missing', { code: 'NO_PRESETS' });
        await this.#mountPreset(presets, agentCtx, presetChoice, liveRef, ticket);
        // No tool guard of any kind: the preset's tools are the role's
        // tools, and every Kanban action tool enforces its own phase.
        liveRef.actionDispose = registerActionTools({ ctx: agentCtx, sessionId, liveRef, driver: this, store: this.store });
        // KAN-30: only a build session carries approved grants; plan and
        // verify sessions stay read-only and never answer an escalation ask.
        if (purpose === 'build') this.#registerGrantApprover(agentCtx);
        // KAN-32: the Questions decision covers the whole ticket now, so both
        // the planning session and the build session answer what the ticket
        // allows; the phase and mode check lives in questions.mjs.
        if (purpose === 'plan' || purpose === 'build') {
          this.#registerQuestionAnswerer(agentCtx);
          liveRef.questionDispose = this.#registerTolerantAskTool(agentCtx);
        }
      },
    });
    liveRef.handle = handle;
    liveRef.routeKey = routeKey(route);
    this.#applySandboxMode(liveRef);
    void this.#attachWorkspace(sessionId, cwd, 0);
    try {
      const titles = this.ctx.get('sessionTitle');
      if (titles?.rename) titles.rename(handle.agent.session, sessionTitle(ticket, purpose));
    } catch (error) {
      this.log.warn('workflow session: title pin failed: %s', String(error?.message ?? error));
    }
    this.live.set(sessionId, liveRef);
    this.#addTicketSession(ticket.id, purpose, sessionId);
    return { sessionId, handle, preset: liveRef.preset };
  }

  /**
   * Mount the ticket's chosen preset into a fresh session (KAN-15). A preset
   * that no longer exists or no longer activates must not strand the ticket:
   * the session starts in the harness default instead, with a warning and a
   * `preset_fallback` event on the ticket so the board can explain the swap.
   */
  async #mountPreset(presets, agentCtx, presetChoice, liveRef, ticket) {
    try {
      const mounted = await presets.mount(agentCtx, presetChoice);
      if (mounted !== undefined && mounted !== null && mounted.id) liveRef.preset = mounted.id;
      return;
    } catch (error) {
      if (presetChoice === undefined) throw error; // already the harness default
      this.log.warn(
        'kanban: preset %s could not be mounted for %s (%s); starting the session in the harness default',
        presetChoice,
        ticket.key,
        String(error?.message ?? error),
      );
      const mounted = await presets.mount(agentCtx, undefined);
      liveRef.preset = (mounted?.id ?? presets.defaultId ?? 'standard');
      try {
        this.store?.appendEvent?.(ticket.id, 'preset_fallback', {
          actor: 'engine',
          payload: { requested: presetChoice, used: liveRef.preset, reason: String(error?.message ?? error) },
        });
      } catch {
        // The event is best-effort; the session is what matters.
      }
    }
  }

  /**
   * KAN-30: register the ticket's approved sandbox grants as an agent-scoped
   * `approval/request` waterfall listener on one build session.
   *
   * The listener is scoped to this agent (core dispatches the waterfall on the
   * requesting agent's scope, and an agent-scoped listener only ever sees its
   * own agent), and it is prepended so a covered ask is answered before the
   * human bridge is reached — an uncovered ask calls `next()` and the human is
   * prompted exactly as before. Plan and verify sessions never get one: they
   * run read-only and have nothing to grant.
   */
  #registerGrantApprover(agentCtx) {
    try {
      agentCtx.on('approval/request', makeGrantApprover({ store: this.store, log: this.log }), { prepend: true });
    } catch (error) {
      // A session without the listener behaves like every pre-0.16 session:
      // each escalation asks the human. Losing grants is never losing work.
      this.log.warn('kanban grants: approver could not be registered: %s', String(error?.message ?? error));
    }
    // Registered second and prepended, so it runs before the grant approver:
    // a denied target can never be rescued by a grant.
    try {
      const guard = makeGuardApprover({
        store: this.store,
        log: this.log,
        getLiveCheckouts: () => resolveLiveCheckouts(this.getConfig()),
        getReadOnlyCommands: () => resolveReadOnlyCommands(this.getConfig()),
        // The approval service tells the model only "the user rejected ...";
        // steering the reason in keeps a policy denial from reading as a person.
        steer: (denied, { text, summary }) => denied.steer(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin:dsh-kanban', form: 'notice', summary: summary.slice(0, 120) },
        })),
      });
      agentCtx.on('approval/request', guard, { prepend: true });
    } catch (error) {
      this.log.warn('kanban guard: approver could not be registered: %s', String(error?.message ?? error));
    }
  }

  /**
   * KAN-32: register the ticket's Questions decision as an agent-scoped
   * `user-questions/request` waterfall listener on one workflow session.
   *
   * Same seam and same reasoning as the grant approver, on the question seam
   * core already publishes: `@deepseek-ai/dsh-user-questions` dispatches the
   * waterfall on the requesting agent's scope, and a cordis waterfall settles
   * on the first listener that does not call `next()`, so prepending here answers
   * that session's asks before the human bridge is reached and nothing else's.
   *
   * Registered on plan and build sessions alike — the decision of *whether* to
   * answer is the ticket's phase and mode, and it is made in `questions.mjs`
   * where it can be tested. A verify session gets no listener: an approval-phase
   * question is the human's conversation by definition.
   */
  #registerQuestionAnswerer(agentCtx) {
    try {
      agentCtx.on('user-questions/request', makeQuestionAnswerer({ store: this.store, log: this.log }), { prepend: true });
    } catch (error) {
      // Without the listener every ask reaches a human, which is the pre-0.18
      // behavior: a missed auto-answer costs a prompt, never a wrong decision.
      this.log.warn('kanban questions: answerer could not be registered: %s', String(error?.message ?? error));
    }
  }

  /**
   * The `userQuestions` service seam, looked up per call: it is published by
   * another plugin and mount order is not fixed, and a deployment without it
   * must still run tickets.
   */
  #userQuestionsService() {
    try {
      return this.ctx.get('userQuestions');
    } catch {
      return undefined;
    }
  }

  /**
   * KAN-32: register the tolerant `ask_user_question` in one workflow session.
   *
   * A scoped registration shadows the preset's global tool for this agent only,
   * so the board's copy is free to be forgiving where core's is strict: it
   * assigns the question ids a malformed call left out instead of losing the
   * question, and it passes the tool call id as the card key, which is what
   * makes a half-typed answer survive a page reload (core persists drafts under
   * that key). If the question service is not mounted, the tool is not
   * registered, the preset's copy stays in place, and the session says so once
   * in the log — a session that cannot ask is a session that parks, and the
   * warning is what explains why.
   */
  #registerTolerantAskTool(agentCtx) {
    const service = this.#userQuestionsService();
    if (service === undefined || service === null || typeof service.ask !== 'function') {
      if (!this.askToolWarned) {
        this.askToolWarned = true;
        this.log.warn('kanban questions: the userQuestions service is not mounted; sessions keep the core ask_user_question tool (no id recovery, no reload-safe drafts)');
      }
      return;
    }
    try {
      const dispose = agentCtx.tools.register(
        defineTool(askUserToolDefinition({ ask: (request) => service.ask(request), log: this.log })),
      );
      // The registration lives on the agent's own scope, so disposing with the
      // session is enough; the driver keeps the handle for symmetry with the
      // action tools and to survive a session closed from the board.
      return typeof dispose === 'function' ? dispose : null;
    } catch (error) {
      // Same fallback as a missing service: the core tool stays, the session
      // still asks, and the log says why the tolerant copy is not there.
      this.log.warn('kanban questions: tolerant ask_user_question could not be registered: %s', String(error?.message ?? error));
      return null;
    }
  }

  /** Change the role inside one session without changing preset or system prompt. */
  setPhase(sessionId, role) {
    const live = this.live.get(sessionId);
    if (live === undefined) throw new DispatchError(`session ${sessionId} is not live`, { code: 'NOT_LIVE' });
    // The action tools' phase checks and the engine's route selection read this;
    // the sandbox mode deliberately does not — it follows the purpose.
    live.role = role;
    live.phase.role = role;
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

  /**
   * The sandbox mode follows the session purpose and the ticket's write-mode
   * choice (KAN-15): planning and the mechanical verify gate always read; the
   * build session writes as much as the ticket asked for, defaulting to
   * workspace-write when the ticket has no opinion. A phase change inside one
   * session (implementer -> reviewer) deliberately leaves it alone, so a
   * reviewer can run the checks its own review asks for.
   */
  #applySandboxMode(live) {
    const mode = live.purpose === 'plan' || live.purpose === 'verify' ? 'read-only' : (live.writeMode ?? 'workspace-write');
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

  /**
   * Bring back the newest usable session a ticket already had for one purpose,
   * so a later round continues in the conversation that holds the work instead
   * of starting cold.
   *
   * Three outcomes: a session is already live (`via: 'live'`), a persisted one
   * was reopened through the session controller and re-wired exactly as a
   * restart reattach does (`via: 'resumed'`), or nothing could be brought back
   * (`ok: false`, with `none: true` when the ticket never had one). An archived
   * session is skipped, never resumed: every turn in it is rejected at once.
   *
   * @returns {Promise<{ok: true, sessionId: string, via: 'live'|'resumed'} | {ok: false, reason: string, none?: boolean}>}
   */
  async reactivateSession(ticketId, purpose) {
    if (this.disposed) return { ok: false, reason: 'plugin is stopping' };
    const live = this.#purposeCandidates(ticketId, purpose).find((candidate) => !candidate.archived);
    if (live !== undefined) return { ok: true, sessionId: live.sessionId, via: 'live' };
    const archived = this.#archivedSessionIds();
    const stored = (this.store?.listSessions?.(ticketId) ?? [])
      .filter((record) => (record.purpose ?? 'build') === purpose && !archived.has(String(record.sessionId)))
      .reverse();
    if (stored.length === 0) return { ok: false, reason: `the ticket has no earlier ${purpose} session`, none: true };
    let lastError = 'the session could not be reopened';
    for (const record of stored) {
      try {
        // The session controller's public resolver returns the agent when it is
        // genuinely live and resumes the persisted session when it is not. A bare
        // registry lookup is only the fallback: it can still answer with an agent
        // whose scope was disposed when the earlier round closed it.
        let agent;
        const controller = this.sessionController ?? this.ctx.get('sessionController');
        if (typeof controller?.resolveAgent === 'function') {
          const resolved = await controller.resolveAgent(record.sessionId);
          if (resolved?.error !== undefined) {
            lastError = String(resolved.error?.message ?? resolved.error);
            continue;
          }
          agent = resolved?.agent;
        } else {
          agent = this.agents?.get?.(record.sessionId);
          if (agent === undefined || agent === null) {
            lastError = 'the session controller cannot reopen a stored session';
            continue;
          }
        }
        if (agent === undefined || agent === null) continue;
        await this.attachExistingSession(record.sessionId, agent);
        if (!this.live.has(record.sessionId)) continue;
        // The store row was closed when the old round ended; it is open again.
        this.store.attachSession({
          ticketId,
          dshSessionId: record.sessionId,
          role: record.role,
          purpose: record.purpose,
          preset: record.preset,
          provider: record.provider,
          model: record.model,
        });
        return { ok: true, sessionId: record.sessionId, via: 'resumed' };
      } catch (error) {
        lastError = String(error?.message ?? error);
        this.log.warn('kanban: could not reopen session %s for %s: %s', record.sessionId, ticketId, lastError);
      }
    }
    return { ok: false, reason: lastError };
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
    const role = roleForSession(purpose, ticket);
    const liveRef = {
      handle: { agent },
      role,
      purpose,
      phase: { role },
      ticketId: ticket.id,
      // Mirror the ticket's choices (KAN-15) so a reattached build session
      // re-applies the right sandbox mode. The preset itself was mounted when
      // the session was created and cannot be remounted on an existing agent.
      preset: purpose === 'build' ? (ticket.preset ?? 'standard') : 'standard',
      writeMode: purpose === 'build' ? (ticket.writeMode ?? null) : null,
      routeKey: null,
      actionDispose: null,
      questionDispose: null,
      sandboxMode: null,
      owned: false,
    };
    this.live.set(sessionId, liveRef);
    this.activity.negatives.delete(sessionId);
    this.#addTicketSession(ticket.id, purpose, sessionId);
    // KAN-17: a session reopened mid-turn may be sitting on an unanswered
    // approval ask or question; the board must show that, not blue "running".
    this.#seedHumanWait(sessionId, agent);
    await this.#registerExistingTools(agent.ctx, liveRef, sessionId);
    // KAN-30: a reattached build session gets its grant approver too — the
    // approved plan outlives the restart, the in-memory listener does not.
    if (purpose === 'build') this.#registerGrantApprover(agent.ctx);
    // KAN-32: same for the Questions answerer and the tolerant ask tool. A
    // restart used to silently turn an autonomous ticket back into one that
    // waits for a human on every question.
    if (purpose === 'plan' || purpose === 'build') {
      this.#registerQuestionAnswerer(agent.ctx);
      liveRef.questionDispose = this.#registerTolerantAskTool(agent.ctx);
    }
    this.#applySandboxMode(liveRef);
    void this.#attachWorkspace(sessionId, ticket.workspaceCwd ?? this.getConfig().defaultWorkspaceCwd ?? process.cwd(), 0);
    this.log.info('kanban: reattached session %s to %s/%s', sessionId, ticket.key, purpose);
    return true;
  }

  async #registerExistingTools(agentCtx, liveRef, sessionId) {
    // Same as the setup path: every action tool, no guard.
    liveRef.actionDispose = registerActionTools({ ctx: agentCtx, sessionId, liveRef, driver: this, store: this.store });
  }

  #settleTurn(session, event, waiter) {
    this.waiters.delete(session.id);
    clearInterval(waiter.timer);
    // Settling a turn means it is over, whichever path noticed: the live
    // `turn/end` handler, or `reconcileTurns` recovering a turn whose end was
    // never delivered. The activity bookkeeping has to agree, or the ticket
    // stays "busy" on the very turn that just ended and the engine's park is
    // skipped by the busy guard, leaving the phase to be relaunched as a fresh
    // attempt on the next tick.
    this.activity.turnEnd(session.id);
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

  /**
   * The highest turn number this session has already finished. A waiter armed
   * now is waiting for a turn after it, never for it.
   */
  #lastTurn(session) {
    try {
      const events = session?.snapshotEvents?.() ?? [];
      let last = 0;
      for (const event of events) {
        if (event?.type === 'turn/end' && Number.isFinite(event.data?.turn)) last = Math.max(last, event.data.turn)
      }
      return last;
    } catch {
      return 0;
    }
  }

  /**
   * True when a `turn/end` belongs to the turn this waiter is waiting for.
   *
   * `reconcileTurns` settles from the last `turn/end` in the log, and a waiter
   * armed just after a halt can be reconciled before the turn it is waiting for
   * has begun: the agent is idle, more than 1500 ms have passed, and the previous
   * turn's end is sitting right there. Settling on it hands the caller a failure
   * for a turn that never ran, so it recovers again and the real turn is then
   * genuinely in flight when the caller tries to park. A waiter only accepts an
   * end newer than the turn it was armed on.
   */
  #isWaitedTurn(waiter, turn) {
    if (!Number.isFinite(waiter.baselineTurn) || !Number.isFinite(turn)) return true;
    return turn > waiter.baselineTurn;
  }

  /**
   * Arm the waiter machinery for one turn on a live session: the waiters map
   * entry, the stall interval, reconcileTurns coverage and #settleTurn on
   * turn/end. Shared by sendTurn (which then injects the role prompt) and
   * waitTurn (which waits for a turn someone else starts).
   *
   * A turn that has already started is fine: the waiter attaches to it and
   * settles on its turn/end like any other.
   */
  #armWaiter(sessionId, stallTimeoutMs, baselineTurn = 0) {
    const startedMono = process.hrtime.bigint()
    let settle
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject }
    })
    const waiter = { resolve: settle.resolve, reject: settle.reject, timer: null, lastEventAt: Date.now(), startedMono, sessionId, awaitingUser: false, baselineTurn }
    const interval = Math.max(1000, Math.min(5000, Math.floor(stallTimeoutMs / 4)))
    const timer = setInterval(() => {
      if (this.waiters.get(sessionId) !== waiter) return;
      // A turn paused on a person is not a stalled turn: the clock only runs
      // while the session is the one that owes the next event.
      if (waiter.awaitingUser || this.humanWaits.has(sessionId)) return;
      if (Date.now() - waiter.lastEventAt <= stallTimeoutMs) return;
      this.waiters.delete(sessionId);
      clearInterval(timer);
      waiter.resolve({ status: 'stalled', finalText: null, usage: null, reason: null, error: 'no turn event within stallTimeoutMs', startedMono, action: null });
    }, interval);
    if (typeof timer.unref === 'function') timer.unref();
    waiter.timer = timer;
    this.waiters.set(sessionId, waiter);
    return {
      promise,
      /** Disarm without settling: used when admitting the prompt fails. */
      abort: (error) => {
        this.waiters.delete(sessionId);
        clearInterval(timer);
        settle.reject(error);
      },
    };
  }

  sendTurn({ sessionId, prompt, stallTimeoutMs }) {
    const live = this.live.get(sessionId);
    if (live === undefined) return Promise.reject(new DispatchError(`session ${sessionId} is not live`, { code: 'NOT_LIVE' }));
    if (this.waiters.has(sessionId) || this.activity.active.has(sessionId)) {
      return Promise.reject(new DispatchError(`session ${sessionId} already has a turn in flight`, { code: 'BUSY' }));
    }
    this.actions.delete(sessionId);
    const { promise, abort } = this.#armWaiter(sessionId, stallTimeoutMs, this.#lastTurn(live.handle.agent.session));
    try {
      live.handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
    } catch (error) {
      abort(new DispatchError(`could not admit prompt: ${error?.message ?? error}`, { code: 'PROMPT_REJECTED' }));
    }
    return promise;
  }

  /**
   * Wait for the next turn on a live session without starting one. The engine
   * uses this after asking dsh-continue-kicker for a recovery kick: the kick
   * starts the turn, kanban watches it end and takes the structured action from
   * it exactly as it would from a turn it prompted itself.
   *
   * Same waiter machinery as sendTurn, same stall timeout, same reconcileTurns
   * coverage; the only difference is that no prompt is injected.
   */
  waitTurn({ sessionId, stallTimeoutMs, afterTurn = null }) {
    const live = this.live.get(sessionId);
    if (live === undefined) return Promise.reject(new DispatchError(`session ${sessionId} is not live`, { code: 'NOT_LIVE' }));
    if (this.waiters.has(sessionId)) {
      return Promise.reject(new DispatchError(`session ${sessionId} already has a turn in flight`, { code: 'BUSY' }));
    }
    // The caller's own observation of the last ended turn wins: the session's
    // event snapshot can lag behind what the driver just settled on, and a
    // baseline read from the lagging log is how a waiter gets settled by the
    // very halt the kick was meant to recover from.
    const baseline = Number.isFinite(afterTurn) ? afterTurn : this.#lastTurn(live.handle.agent.session);
    return this.#armWaiter(sessionId, stallTimeoutMs, baseline).promise;
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
      if (waiter.awaitingUser || this.humanWaits.has(sessionId)) continue;
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
        if (lastEnd !== undefined && this.#isWaitedTurn(waiter, lastEnd.data?.turn)) {
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
    this.humanWaits.delete(sessionId);
    if (typeof live.actionDispose === 'function') live.actionDispose();
    if (typeof live.questionDispose === 'function') {
      try {
        live.questionDispose();
      } catch {
        // Best-effort: the agent scope teardown owns the registration anyway.
      }
    }
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
