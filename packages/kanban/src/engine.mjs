// dsh-kanban: the workflow engine.
//
// Code decides. This file owns every transition: flat plan session, the
// implement <-> review -> approval session, code-gated approval, retries,
// human attention, and session teardown. Agents return structured data through
// tools; no phase result is parsed out of assistant prose.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { providerPolicy, routeForAttempt } from './config.mjs';
import { StoreError } from './store.mjs';
import { TERMINAL_COLUMNS } from './lifecycle.mjs';
import { hashText, render, shortHash } from './prompts.mjs';
import { normalizePlan, validatePlan, verifyReview } from './result.mjs';
import { estimateTurnCost, priceUsage } from './usage.mjs';

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 60_000;
/**
 * Backstop for the auto-recovery loop. The real cap is continue-kicker's own
 * runaway guard (`maxConsecutiveKicks`), which declines a kick once a session
 * has had too many; this only bounds the loop against a service that keeps
 * saying yes.
 */
const AUTO_RECOVERY_MAX_ROUNDS = 8;
/**
 * How long to let a halted turn finish tearing down before asking for a kick.
 *
 * A `turn/end` is published while the agent's driver is still inside its own
 * turn: the phase does not go back to idle until a moment later. A follow-up
 * admitted in that window is queued but its wake is dropped, so the message
 * sits in the inbox and no turn ever starts. This is the same reason
 * dsh-continue-kicker waits `liveKickDelayMs` before its own re-analysis; the
 * engine is reacting to the same event, so it needs the same beat.
 */
const AUTO_RECOVERY_KICK_DELAY_MS = 1500;

function ticketStateBlock(ticket, acceptance) {
  return [
    `Title: ${ticket.title}`,
    '',
    'Body:',
    ticket.body?.trim() === '' ? '(empty)' : ticket.body,
    '',
    'Acceptance (starting point, human):',
    acceptanceBlock(acceptance),
  ].join('\n');
}

function acceptanceBlock(acceptance) {
  return acceptance.length === 0 ? '(none)' : acceptance.map((a) => `- ${a.statement}`).join('\n');
}

function doneWhenBlock(conditions) {
  return conditions.map((c) => `- ${c.id}: ${c.statement}\n  verify: ${c.howVerified}`).join('\n');
}

/**
 * The compact condition list the review prompt carries: id plus statement, no
 * how_verified. The reviewer's own session already holds the plan and the diff,
 * so the ids are all it needs to answer against — and the one thing it must not
 * invent is an id.
 */
function conditionListBlock(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return '(the plan declared no conditions)';
  return conditions.map((c) => `- \`${c.id}\` — ${c.statement}`).join('\n');
}

/**
 * The one rework line: the reviewer's instruction, but only when it is short
 * enough to be a reminder. A long instruction is already in the session's own
 * transcript as the review tool call, so repeating it buys tokens and nothing
 * else.
 */
function reworkLine(review) {
  if (review === null || review === undefined) return '';
  const text = typeof review.instruction === 'string' && review.instruction.trim() !== ''
    ? review.instruction.trim()
    : (Array.isArray(review.reasons) ? review.reasons.join('; ').trim() : '');
  if (text === '') return '';
  if (text.length > 240) return '';
  return `The reviewer's instruction: ${text}`;
}

export class Engine {
  constructor({ ctx, store, driver, getConfig, getPrompts, log }) {
    this.ctx = ctx;
    this.store = store;
    this.driver = driver;
    this.getConfig = getConfig;
    this.getPrompts = getPrompts;
    this.log = log;
    this.active = new Map();
    this.runIds = new Map();
    /** ticketId -> { sessionId, reason } while a human-driven turn holds a ticket in flight */
    this.reactivations = new Map();
    this.configHash = null;
    this.timer = null;
    this.ticking = false;
    this.disposed = false;
    this.recovered = false;
    this.lastPrune = 0;
    /** the dsh-continue-kicker service once resolved; undefined = not looked up yet */
    this.kicker = undefined;
    this.kickerAnnounced = false;
    if (this.driver !== null && typeof this.driver === 'object') {
      this.driver.approval = {
        approve: (ticketId, message) => this.approve(ticketId, message),
        discard: (ticketId, reason) => this.discard(ticketId, reason),
        plan: (ticketId, value) => this.submitApprovalPlan(ticketId, value),
      };
      this.driver.onManualAction = (input) => this.handleManualAction(input);
      this.driver.onReactivate = (ticketId, sessionId) => this.reactivateFromSession(ticketId, sessionId);
      this.driver.onSettleTurn = (ticketId, sessionId) => this.settleSessionTurn(ticketId, sessionId);
    }
  }

  start() {
    if (this.kickerService() === null) {
      this.log.info('dsh-continue-kicker not mounted; halted turns park to needs-attention without auto-recovery');
    }
    this.driver.start();
    const tick = () => {
      if (!this.disposed) void this.tick();
    };
    void this.tick();
    this.timer = setInterval(tick, this.getConfig().tickIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.driver.stop();
  }

  async tick() {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      if (!this.recovered) {
        this.recovered = true;
        await this.recover();
      }
      this.driver.reconcileTurns();
      // Columns are intended state: the engine launches what the human put in
      // Working, plus Backlog tickets that asked to be planned now. wipCap is a
      // pure concurrency throttle — queued tickets wait, nothing is promoted
      // or rejected on capacity.
      const config = this.getConfig();
      const working = this.store.listTickets({ columns: ['working'] });
      const planNow = this
        .store.listTickets({ columns: ['backlog'] })
        .filter((ticket) => ticket.phase === 'plan' && ticket.planTiming === 'now');
      for (const ticket of [...working, ...planNow]) {
        if (this.disposed || this.active.size >= config.wipCap) break;
        if (this.active.has(ticket.id)) continue;
        if (ticket.needsAttentionReason) continue;
        if (this.busy(ticket)) continue;
        this.launch(ticket);
      }
      this.maybePrune();
    } catch (error) {
      this.log.error('tick failed: %s', error?.stack ?? String(error));
    } finally {
      this.ticking = false;
    }
  }

  launch(ticket) {
    if (this.active.has(ticket.id) || this.disposed) return;
    const promise = this.advance(ticket)
      .catch((error) => this.log.error('ticket %s advance failed: %s', ticket.key, error?.stack ?? String(error)))
      .finally(() => this.active.delete(ticket.id));
    this.active.set(ticket.id, promise);
  }

  async recover() {
    const openTickets = new Map();
    for (const session of this.store.listOpenSessions()) {
      if (session.ticketId !== null && session.ticketId !== undefined) openTickets.set(session.ticketId, session);
    }
    for (const [ticketId, session] of openTickets) {
      await this.driver.closeTicketSessions(ticketId);
      this.store.markSessionClosed(session.sessionId);
      const ticket = this.store.getTicket(ticketId);
      if (ticket === undefined || ticket.column === 'done' || ticket.column === 'discarded') continue;
      const phase = ticket.phase === 'verify' ? 'approval' : ticket.phase;
      const reason = `${phase} session was interrupted by a restart; open the existing session to continue, or retry`;
      this.appendEvent(ticketId, 'restart_recovered', {
        phaseFrom: ticket.phase,
        phaseTo: ticket.phase,
        payload: { sessionId: session.sessionId, reason },
      });
      this.store.setNeedsAttention(ticketId, reason, {
        restartRecovery: true,
        sessionId: session.sessionId,
        phase,
      });
    }
    for (const span of this.store.runningSpans()) {
      this.store.endSpan(span.id, { status: 'abandoned', error: 'host restarted mid-span' });
    }
    for (const session of this.store.listAllSessions()) {
      const ticket = this.store.getTicket(session.ticketId);
      if (ticket === undefined || ticket.workspaceCwd === null || ticket.workspaceCwd === undefined) continue;
      this.driver.attachWorkspace(session.sessionId, ticket.workspaceCwd);
    }
    this.log.info('restart recovery complete');
  }

  maybePrune() {
    const config = this.getConfig();
    const now = Date.now();
    if (now - this.lastPrune < 6 * 60 * 60 * 1000) return;
    this.lastPrune = now;
    const cutoff = new Date(now - config.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const deleted = this.store.pruneArtifacts(cutoff);
    if (deleted > 0) this.log.info('pruned %d artifacts older than %s', deleted, cutoff);
  }

  /** Drive one ticket as far as the current session phase allows. */
  async advance(start) {
    if (this.busy(start)) return { kind: 'wait' };
    let ticket = this.store.getTicket(start.id);
    let guard = 0;
    while (ticket !== undefined && !this.disposed) {
      if (guard++ > 40) {
        this.log.error('ticket %s exceeded pipeline guard', ticket.key);
        return;
      }
      if (TERMINAL_COLUMNS.includes(ticket.column)) return;
      // A parked ticket stays exactly where it is and glows red until a human
      // resolves it; the engine never moves columns on its own.
      if (ticket.needsAttentionReason) return;
      if (ticket.phase === 'closed') return;
      if (ticket.phase === 'plan') {
        // Planning runs in Working, or in Backlog only for plan-now tickets.
        if (ticket.column === 'backlog' && ticket.planTiming !== 'now') return;
        const result = await this.plan(ticket);
        if (result.kind !== 'continue') return;
        ticket = this.store.getTicket(ticket.id);
        continue;
      }
      // Build, review and approval only ever run in Working. A plan-now ticket
      // that planned in Backlog stops here at Build until a human drags it over.
      if (ticket.column !== 'working') return;
      if (ticket.phase === 'implement') {
        const result = await this.implement(ticket);
        if (result.kind !== 'continue') return;
        ticket = this.store.getTicket(ticket.id);
        continue;
      }
      if (ticket.phase === 'review') {
        const result = await this.review(ticket);
        if (result.kind !== 'continue') return;
        ticket = this.store.getTicket(ticket.id);
        continue;
      }
      return;
    }
  }

  // ------------------------------------------------------------------ plan

  async plan(ticket) {
    if (this.stopped(ticket.id)) return { kind: 'stopped' };
    const config = this.getConfig();
    const prompts = this.getPrompts();
    const acceptance = this.store.listAcceptance(ticket.id);
    const route = this.resolveRoute('planner', 1);
    const admission = this.admit(ticket, route, 'planner', { attempt: 1 });
    if (!admission.ok) return this.hold(ticket, admission);
    const promptFile = ticket.planQuestions === 'autonomous' ? 'plan-self' : 'plan-human';
    const prompt = render(prompts.bodies[promptFile] ?? prompts.bodies['plan-human'], {
      ticket_state: ticketStateBlock(ticket, acceptance),
      acceptance: acceptanceBlock(acceptance),
      key: ticket.key,
      title: ticket.title,
    });
    const runId = this.ensureRun(ticket);
    let turn = await this.roleTurn({ ticket, role: 'planner', purpose: 'plan', route, prompt, spanName: 'plan', attempt: 1, runId });
    if (turn.kind !== 'ok') turn = (await this.autoRecover(ticket, turn, 'plan')) ?? turn;
    if (turn.kind !== 'ok') return this.failedTurn(ticket, turn, 'plan');
    const action = turn.action;
    if (action === null || action.type !== 'plan') {
      return this.needsAttention(ticket, 'plan session ended without calling kanban_submit_plan');
    }
    const errors = validatePlan(action.value);
    if (errors.length > 0) return this.needsAttention(ticket, `plan rejected: ${errors.join('; ')}`);
    if (!Array.isArray(action.value.done_when) || action.value.done_when.length === 0) {
      return this.needsAttention(ticket, 'plan rejected: no done_when conditions');
    }
    const plan = normalizePlan(action.value);
    const version = this.store.currentPlanVersion(ticket.id) + 1;
    this.store.replaceConditions(ticket.id, version, plan.conditions, 'plan');
    this.store.addArtifact(ticket.id, 'plan', JSON.stringify({ ...plan, planVersion: version }, null, 2), { spanId: turn.spanId });
    this.appendEvent(ticket.id, 'planned', { phaseFrom: 'plan', phaseTo: 'implement', payload: { planVersion: version } });
    await this.closeSession(turn.sessionId);
    const next = this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: 'plan submitted' });
    return { kind: next.column === 'working' ? 'continue' : 'wait' };
  }

  // -------------------------------------------------------------- implement

  async implement(ticket) {
    if (this.stopped(ticket.id)) return { kind: 'stopped' };
    const config = this.getConfig();
    if (this.store.listConditions(ticket.id).length === 0) {
      this.appendEvent(ticket.id, 'done_when_required', { phaseFrom: ticket.phase, phaseTo: 'plan', payload: { reason: 'implementation requires done_when conditions' } });
      this.store.transitionTicket(ticket.id, { phase: 'plan' }, { actor: 'engine', reason: 'done_when required' });
      return { kind: 'continue' };
    }
    const attempt = ticket.attemptCount + 1;
    if (attempt > config.maxAttempts) return this.needsAttention(ticket, `attempt budget exhausted (${config.maxAttempts})`);
    const route = this.resolveRoute('implementer', attempt);
    const admission = this.admit(ticket, route, 'implementer', { attempt });
    if (!admission.ok) return this.hold(ticket, admission);
    this.store.setAttempt(ticket.id, attempt, route.rung);
    const prompts = this.getPrompts();
    const conditions = this.store.listConditions(ticket.id);
    const acceptance = this.store.listAcceptance(ticket.id);
    const planArtifact = this.store.latestArtifact(ticket.id, 'plan');
    const reviewArtifact = this.store.latestArtifact(ticket.id, 'review');
    const rework = reviewArtifact === undefined ? null : safeJson(reviewArtifact.content);
    const prompt = render(prompts.bodies[rework === null ? 'implement' : 'rework'], {
      key: ticket.key,
      title: ticket.title,
      cwd: ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd(),
      acceptance: acceptanceBlock(acceptance),
      plan: planArtifact === undefined ? '(no plan)' : planArtifact.content,
      done_when: doneWhenBlock(conditions),
      review: rework === null ? '' : JSON.stringify(rework, null, 2),
      review_line: reworkLine(rework),
    });
    const runId = this.ensureRun(ticket);
    let turn = await this.roleTurn({ ticket, role: 'implementer', purpose: 'build', route, prompt, spanName: 'implement', attempt, runId });
    if (turn.kind !== 'ok') turn = (await this.autoRecover(ticket, turn, 'implement')) ?? turn;
    if (turn.kind !== 'ok') return this.failedTurn(ticket, turn, 'implement');
    if (turn.action === null || turn.action.type !== 'implementation') {
      return this.needsAttention(ticket, 'implementer ended without calling kanban_submit_implementation');
    }
    const value = turn.action.value;
    this.store.addArtifact(ticket.id, 'implement_result', JSON.stringify(value, null, 2), { spanId: turn.spanId });
    if (value.status === 'blocked') return this.needsAttention(ticket, 'implementer reported blocked', { gaps: value.reasons ?? value.residual_risks ?? [] });
    this.appendEvent(ticket.id, 'implemented', { phaseFrom: 'implement', phaseTo: 'review', payload: { attempt } });
    const next = this.store.transitionTicket(ticket.id, { phase: 'review' }, { actor: 'engine', reason: 'implementation submitted' });
    return { kind: next.column === 'working' ? 'continue' : 'wait' };
  }

  // ----------------------------------------------------------------- review

  async review(ticket) {
    if (this.stopped(ticket.id)) return { kind: 'stopped' };
    const config = this.getConfig();
    const route = this.resolveRoute('reviewer', ticket.attemptCount);
    const admission = this.admit(ticket, route, 'reviewer', { attempt: ticket.attemptCount });
    if (!admission.ok) return this.hold(ticket, admission);
    const prompts = this.getPrompts();
    const acceptance = this.store.listAcceptance(ticket.id);
    const conditions = this.store.listConditions(ticket.id);
    // The reviewer works in the build session, so the plan, the implementer's
    // result and the diff are already in its transcript: the prompt carries only
    // what must not be paraphrased, the condition ids it has to answer against.
    // The diff is still captured as an artifact, because the board's timeline is
    // where a human looks to see what a round actually changed.
    await this.diff(ticket);
    const prompt = render(prompts.bodies.review, {
      key: ticket.key,
      title: ticket.title,
      cwd: ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd(),
      acceptance: acceptanceBlock(acceptance),
      done_when: conditionListBlock(conditions),
    });
    const runId = this.ensureRun(ticket);
    let turn = await this.roleTurn({ ticket, role: 'reviewer', purpose: 'build', route, prompt, spanName: 'review', attempt: ticket.attemptCount, runId });
    if (turn.kind !== 'ok') turn = (await this.autoRecover(ticket, turn, 'review')) ?? turn;
    if (turn.kind !== 'ok') return this.failedTurn(ticket, turn, 'review');
    if (turn.action === null || turn.action.type !== 'review') {
      return this.needsAttention(ticket, 'reviewer ended without calling kanban_submit_review');
    }
    const value = turn.action.value;
    this.store.addArtifact(ticket.id, 'review', JSON.stringify(value, null, 2), { spanId: turn.spanId });
    if (value.verdict === 'pass') {
      const gaps = verifyReview(value, this.store.listConditions(ticket.id), acceptance, config.confidenceThreshold);
      if (gaps.length > 0) {
        const feedback = `Review cannot be code-verified: ${gaps.join('; ')}`;
        this.store.addArtifact(ticket.id, 'review_feedback', feedback, { spanId: turn.spanId });
        this.appendEvent(ticket.id, 'review_rejected', { phaseFrom: 'review', phaseTo: 'implement', payload: { gaps } });
        this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: feedback });
        return { kind: 'continue' };
      }
      await this.enterApproval(ticket, turn.sessionId);
      return { kind: 'wait' };
    }
    const instruction = typeof value.instruction === 'string' && value.instruction.trim() !== '' ? value.instruction : (value.reasons ?? []).join('; ');
    this.store.addArtifact(ticket.id, 'review_feedback', instruction, { spanId: turn.spanId });
    this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: `review requested changes: ${instruction}` });
    return { kind: 'continue' };
  }

  // --------------------------------------------------------------- approval
  //
  // Approval is a phase of the build session, not a session of its own. The
  // session that just passed review keeps its workspace, its history and its
  // tools; only its phase role flips to `approver` — which is what arms
  // kanban_approve / kanban_discard / kanban_submit_plan — and its route flips to
  // the configured approver route. One slim prompt asks the agent to hand the
  // work over to the human, and the ticket then parks for them.

  async enterApproval(ticket, sessionId) {
    const current = this.store.transitionTicket(ticket.id, { phase: 'verify' }, { actor: 'engine', reason: 'review passed; awaiting approval' });
    this.appendEvent(current.id, 'approval_requested', {
      phaseFrom: 'review',
      phaseTo: 'verify',
      payload: { attempt: current.attemptCount },
    });
    const route = this.resolveRoute('approver', current.attemptCount);
    if (route.provider === null || route.model === null) {
      // Nothing to prompt with: park the ticket the way the pre-0.7.0 flow did and
      // let the human approve, discard or retry from the board.
      this.log.warn('ticket %s has no approver route; parking without an approval turn', current.key);
      this.store.setNeedsAttention(current.id, 'Awaiting human approval');
      return { kind: 'wait' };
    }
    // Flip the session that is about to be prompted before prompting it, so the
    // approval tools are live for this turn even when the build session was
    // reopened after a restart and its role is still whatever it last was.
    if (typeof sessionId === 'string' && this.driver.isLive?.(sessionId) === true) {
      this.driver.setPhase(sessionId, 'approver');
      this.driver.setRoute(sessionId, route);
    }
    const prompts = this.getPrompts();
    // The approval turn is a handover, not a fresh analysis: the session that
    // just passed review already holds the plan, the implementation and the
    // review verdict, so the prompt says one thing and stops.
    const prompt = render(prompts.bodies.approval, {
      key: current.key,
      title: current.title,
    });
    // A manual review submission concludes the human's turn and asks for the
    // approval turn in the same beat; sending into a session whose turn is still
    // finishing is rejected as busy, so let it go quiet first.
    await this.awaitQuiet(current);
    const runId = this.ensureRun(current);
    let turn = await this.roleTurn({ ticket: current, role: 'approver', purpose: 'build', route, prompt, spanName: 'approval', attempt: current.attemptCount, runId });
    if (turn.kind !== 'ok') turn = (await this.autoRecover(current, turn, 'approval')) ?? turn;
    if (turn.kind !== 'ok') return this.failedTurn(current, turn, 'approval');
    // The agent may have closed the ticket or asked for another round from inside
    // this very turn: `kanban_approve` / `kanban_discard` move the column and
    // `kanban_submit_plan` lifts the park itself. Once the ticket has moved on its
    // own, parking it here would only be noise.
    const after = this.store.getTicket(current.id);
    if (after === undefined || TERMINAL_COLUMNS.includes(after.column) || after.phase !== 'verify') {
      return { kind: 'wait' };
    }
    this.store.setNeedsAttention(current.id, 'Awaiting human approval');
    return { kind: 'wait' };
  }

  /**
   * Wait until no session of this ticket has a turn in flight. Bounded: a session
   * that never settles gets the same failed turn any busy dispatch would, rather
   * than hanging the engine.
   */
  async awaitQuiet(ticket, { rounds = 60, delayMs = 50 } = {}) {
    for (let i = 0; i < rounds && !this.disposed && this.busy(ticket); i++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return !this.busy(ticket);
  }

  async approve(ticketId, message = '') {
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${ticketId}`);
    if (ticket.phase !== 'verify') throw new StoreError('bad_request', 'ticket is not awaiting approval');
    await this.closeTicketSessions(ticket.id);
    const done = this.store.transitionTicket(ticket.id, { column: 'done', phase: 'closed' }, { actor: 'human', reason: 'approved' });
    this.endRun(ticket.id);
    this.appendEvent(ticket.id, 'done', { phaseFrom: 'verify', phaseTo: 'closed', actor: 'human', payload: { attempt: ticket.attemptCount, message } });
    return done;
  }

  async discard(ticketId, reason = '') {
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${ticketId}`);
    await this.closeTicketSessions(ticket.id);
    const discarded = this.store.transitionTicket(ticket.id, { column: 'discarded', phase: 'closed' }, { actor: 'human', reason: reason || 'discarded' });
    this.endRun(ticket.id);
    this.appendEvent(ticket.id, 'discarded', { phaseFrom: ticket.phase, phaseTo: 'closed', actor: 'human', payload: { reason } });
    return discarded;
  }

  async submitApprovalPlan(ticketId, value) {
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${ticketId}`);
    if (ticket.phase !== 'verify') throw new StoreError('bad_request', 'ticket is not awaiting approval');
    const errors = validatePlan(value);
    if (errors.length > 0) throw new StoreError('bad_request', `plan rejected: ${errors.join('; ')}`);
    const plan = normalizePlan(value);
    const version = this.store.currentPlanVersion(ticket.id) + 1;
    this.store.replaceConditions(ticket.id, version, plan.conditions, 'plan');
    this.store.addArtifact(ticket.id, 'plan', JSON.stringify({ ...plan, planVersion: version }, null, 2));
    this.appendEvent(ticket.id, 'planned', { phaseFrom: 'verify', phaseTo: 'implement', payload: { planVersion: version, fromApproval: true } });
    const sessionId = this.driver.liveTicketSession(ticket.id, 'build');
    if (sessionId !== undefined) await this.closeSession(sessionId);
    // The follow-up plan takes over the ticket where it stands: the approval
    // park is lifted and the engine drives Build again in the same column. The
    // session that carried approval is closed with it, so the next round starts
    // a fresh build session rather than continuing the approval conversation.
    this.store.clearNeedsAttention(ticket.id, { actor: 'human', reason: 'approval follow-up plan' });
    return this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'human', reason: 'approval follow-up plan' });
  }

  async handleManualAction({ ticketId, purpose, sessionId, action }) {
    this.reactivations.delete(ticketId);
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${ticketId}`);
    if (action === null || action === undefined) throw new StoreError('bad_request', 'no action supplied');
    if (purpose === 'plan' && action.type === 'plan') {
      if (ticket.phase !== 'plan') throw new StoreError('invalid_phase', `plan submitted from ${ticket.phase}`);
      const errors = validatePlan(action.value);
      if (errors.length > 0) throw new StoreError('bad_request', `plan rejected: ${errors.join('; ')}`);
      const plan = normalizePlan(action.value);
      const version = this.store.currentPlanVersion(ticket.id) + 1;
      this.store.replaceConditions(ticket.id, version, plan.conditions, 'plan');
      this.store.addArtifact(ticket.id, 'plan', JSON.stringify({ ...plan, planVersion: version }, null, 2));
      this.appendEvent(ticket.id, 'planned', { phaseFrom: 'plan', phaseTo: 'implement', payload: { planVersion: version, manual: true } });
      await this.closeSession(sessionId);
      // A human submission is a resolution: the park is lifted and the ticket
      // keeps moving from the column it is already in.
      this.store.clearNeedsAttention(ticket.id, { actor: 'human', reason: 'manual plan submission' });
      this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'human', reason: 'manual plan submission' });
      return;
    }
    if (purpose === 'build' && action.type === 'implementation') {
      if (ticket.phase !== 'implement') throw new StoreError('invalid_phase', `implementation submitted from ${ticket.phase}`);
      const value = action.value;
      this.store.addArtifact(ticket.id, 'implement_result', JSON.stringify(value, null, 2));
      if (value.status === 'blocked') return this.needsAttention(ticket, 'implementer reported blocked', { gaps: value.reasons ?? value.residual_risks ?? [], manual: true });
      this.appendEvent(ticket.id, 'implemented', { phaseFrom: 'implement', phaseTo: 'review', payload: { attempt: ticket.attemptCount, manual: true } });
      this.store.clearNeedsAttention(ticket.id, { actor: 'human', reason: 'manual implementation submission' });
      this.store.transitionTicket(ticket.id, { phase: 'review' }, { actor: 'human', reason: 'manual implementation submission' });
      return;
    }
    if (purpose === 'build' && action.type === 'review') {
      if (ticket.phase !== 'review') throw new StoreError('invalid_phase', `review submitted from ${ticket.phase}`);
      const value = action.value;
      this.store.addArtifact(ticket.id, 'review', JSON.stringify(value, null, 2));
      if (value.verdict !== 'pass') {
        const instruction = typeof value.instruction === 'string' && value.instruction.trim() !== '' ? value.instruction : (value.reasons ?? []).join('; ');
        this.store.addArtifact(ticket.id, 'review_feedback', instruction);
        this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'human', reason: `manual review requested changes: ${instruction}` });
        return;
      }
      const gaps = verifyReview(value, this.store.listConditions(ticket.id), this.store.listAcceptance(ticket.id), this.getConfig().confidenceThreshold);
      if (gaps.length > 0) {
        const feedback = `Review cannot be code-verified: ${gaps.join('; ')}`;
        this.store.addArtifact(ticket.id, 'review_feedback', feedback);
        this.appendEvent(ticket.id, 'review_rejected', { phaseFrom: 'review', phaseTo: 'implement', payload: { gaps, manual: true } });
        this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'human', reason: feedback });
        return;
      }
      await this.enterApproval(ticket, sessionId);
      return;
    }
    throw new StoreError('invalid_phase', `${action.type} cannot be submitted from ${ticket.phase}/${purpose}`);
  }

  // ------------------------------------------------ realtime session activity
  //
  // The board mirrors what is actually happening. A parked (needs-attention)
  // ticket whose session has a turn running — a human answering the engine's
  // question, driving the build by hand, or talking an approval through — is
  // being worked on, so its card switches from red to blue: the park is lifted
  // in place, no column moves. The engine keeps out of that conversation
  // (`busy`), and when the turn ends without a structured submission the ticket
  // is parked again with the reason it had before.

  reactivateFromSession(ticketId, sessionId) {
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined || !ticket.needsAttentionReason) return;
    if (TERMINAL_COLUMNS.includes(ticket.column)) return;
    this.reactivations.set(ticketId, { sessionId, reason: ticket.needsAttentionReason });
    this.store.clearNeedsAttention(ticketId, { actor: 'engine', reason: 'session reactivated' });
    this.appendEvent(ticketId, 'session_reactivated', {
      phaseFrom: ticket.phase,
      phaseTo: ticket.phase,
      payload: { sessionId, priorReason: ticket.needsAttentionReason },
    });
    this.log.info('ticket %s reactivated by session %s', ticket.key, sessionId);
  }

  settleSessionTurn(ticketId, sessionId) {
    const mark = this.reactivations.get(ticketId);
    if (mark === undefined) return;
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined || TERMINAL_COLUMNS.includes(ticket.column)) {
      this.reactivations.delete(ticketId);
      return;
    }
    const reason = mark.reason ?? 'session ended without submitting';
    const result = this.needsAttention(ticket, reason, { sessionId, settled: true });
    if (result.kind !== 'needs_attention') {
      // A different session of this ticket is genuinely mid-turn, so leaving it
      // un-parked is the honest state right now. Keep the mark for that turn's
      // end instead of recording a settle that never moved the ticket.
      this.log.info('ticket %s settle deferred: another session is still active', ticket.key);
      return;
    }
    this.reactivations.delete(ticketId);
    this.appendEvent(ticketId, 'session_settled', {
      phaseFrom: ticket.phase,
      phaseTo: ticket.phase,
      payload: { sessionId, reason },
    });
    this.log.info('ticket %s returned to needs attention after session %s', ticket.key, sessionId);
  }

  // -------------------------------------------------------------- auto-recovery
  //
  // A role turn that halts — output budget hit mid-answer, a backend that
  // dropped, a restart that orphaned the turn — used to park the ticket and
  // leave the session asleep until someone opened it, at which point
  // dsh-continue-kicker's reopen door kicked it awake outside the workflow.
  // Instead the engine now asks for that kick itself, through the service the
  // plugin provides, and waits for the turn it starts. The policy stays in
  // continue-kicker: what counts as a kickable halt, which message to send,
  // how many kicks in a row are still recovery and not a loop. Kanban only
  // pulls the trigger and stops the moment it is declined.
  //
  // With the plugin absent, or older than the release that provides the
  // service, none of this runs and a failed turn parks exactly as before.

  /**
   * The `continueKicker` service, or null when it is not there. Resolved lazily
   * (the plugin may mount after kanban) and duck-typed, so a missing or foreign
   * service is simply "no recovery", never a boot failure.
   */
  kickerService() {
    if (this.kicker !== undefined && this.kicker !== null) return this.kicker;
    let candidate = null;
    try {
      candidate = this.ctx.get('continueKicker');
    } catch {
      candidate = null;
    }
    if (candidate === undefined || candidate === null || typeof candidate.kick !== 'function') return null;
    this.kicker = candidate;
    if (!this.kickerAnnounced) {
      this.kickerAnnounced = true;
      this.log.info('auto-recovery available: dsh-continue-kicker kick service v%s', candidate.version ?? '?');
    }
    return candidate;
  }

  /**
   * Recover a failed role turn with one kick from the service, then wait for the
   * turn it starts. Returns a normalized turn result when a kicked turn came
   * back, or null when recovery is unavailable or declined — the caller then
   * parks the ticket with the original failure, which is the pre-0.4.0
   * behaviour.
   */
  async autoRecover(ticket, turn, phaseName) {
    const kicker = this.kickerService();
    if (kicker === null) return null;
    const sessionId = turn.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    if (typeof this.driver.waitTurn !== 'function') return null;
    const config = this.getConfig();
    const runId = turn.runId ?? this.ensureRun(ticket);
    // The turn number the engine last saw end on this session. Each recovery
    // wait only accepts a `turn/end` after it, so a waiter can never be settled
    // by the very halt the kick was sent to recover from.
    let lastTurn = Number.isFinite(turn.turn) ? turn.turn : null;

    for (let round = 1; round <= AUTO_RECOVERY_MAX_ROUNDS; round++) {
      await new Promise((resolve) => setTimeout(resolve, AUTO_RECOVERY_KICK_DELAY_MS));
      const kick = await kicker.kick(sessionId, { bypassCooldown: true });
      if (kick?.kicked !== true) {
        this.log.info('ticket %s: no auto-recovery in %s - %s', ticket.key, phaseName, kick?.why ?? 'the kick service declined');
        return null;
      }
      this.appendEvent(ticket.id, 'auto_recovered', {
        phaseFrom: ticket.phase,
        phaseTo: ticket.phase,
        payload: { phase: phaseName, flavor: kick.flavor, kick: kick.consecutive, round, sessionId },
      });
      this.log.info('ticket %s: auto-recovery kick %d (%s) in %s, waiting for the turn', ticket.key, kick.consecutive, kick.flavor, phaseName);

      let waited;
      const startedMono = process.hrtime.bigint();
      try {
        waited = await this.driver.waitTurn({ sessionId, stallTimeoutMs: config.stallTimeoutMs, afterTurn: lastTurn });
      } catch (error) {
        this.log.warn('ticket %s: could not wait for the recovered turn: %s', ticket.key, String(error?.message ?? error));
        return null;
      }
      if (Number.isFinite(waited.turn)) lastTurn = waited.turn;
      const result = this.continuationTurn(ticket, turn, runId, waited, phaseName, startedMono);
      if (result.kind === 'ok') return result;
      if (waited.status === 'stalled') {
        this.log.warn('ticket %s: turn stalled after auto-recovery in %s', ticket.key, phaseName);
        return { kind: 'failed', error: 'turn stalled after auto-recovery', sessionId, spanId: turn.spanId };
      }
      if (waited.status === 'disposed') return null;
      // The kicked turn halted again. Loop: the runaway guard inside kick() is
      // the cap, and it will decline before this backstop does.
      this.log.info('ticket %s: recovered turn in %s failed again (%s)', ticket.key, phaseName, result.error ?? waited.status);
    }
    this.log.warn('ticket %s: auto-recovery gave up after %d rounds in %s', ticket.key, AUTO_RECOVERY_MAX_ROUNDS, phaseName);
    return null;
  }

  /** Record one waited recovery turn as a `<phase>-continuation` span. */
  continuationTurn(ticket, turn, runId, waited, phaseName, startedMono) {
    const route = turn.route ?? { provider: null, model: null };
    const span = this.startRoleSpan({
      ticket,
      role: turn.role ?? phaseName,
      route,
      spanName: `${phaseName}-continuation`,
      attempt: turn.attempt ?? ticket.attemptCount,
      runId,
      promptHash: null,
    });
    return this.settleWaitedTurn(ticket, span, route, waited, startedMono, turn.sessionId);
  }

  // -------------------------------------------------------------- role turn

  /** Open the span one agent turn is recorded under. */
  startRoleSpan({ ticket, role, route, spanName, attempt, runId, promptHash }) {
    return this.store.startSpan({
      id: randomUUID(),
      ticketId: ticket.id,
      runId,
      parentSpanId: null,
      kind: 'agent',
      name: spanName,
      role,
      provider: route.provider,
      model: route.model,
      attempt,
      promptHash,
    });
  }

  /**
   * Settle one waited turn into the engine's turn result: tool spans and usage
   * recorded, the span closed, and `{ kind: 'ok' | 'failed' }` out. Shared by a
   * turn the engine prompted and by a turn it only waited for (auto-recovery).
   */
  settleWaitedTurn(ticket, span, route, turn, startedMono, sessionId) {
    const durationMs = Number(process.hrtime.bigint() - startedMono) / 1e6;
    this.recordToolSpans(ticket, span, turn.events ?? []);
    this.recordTurnUsage(ticket, span, route, turn.usage);
    if (turn.status === 'ok') {
      this.store.endSpan(span.id, { status: 'ok', durationMs });
      return { kind: 'ok', action: turn.action ?? null, finalText: turn.finalText, usage: turn.usage, sessionId, spanId: span.id, turn: turn.turn ?? null };
    }
    if (turn.status === 'stalled') {
      this.store.endSpan(span.id, { status: 'abandoned', error: 'stalled', durationMs });
      return { kind: 'failed', error: 'turn stalled', sessionId, spanId: span.id, turn: turn.turn ?? null };
    }
    this.store.endSpan(span.id, { status: 'failed', error: turn.error ?? turn.status, durationMs });
    return { kind: 'failed', error: turn.error ?? turn.status, sessionId, spanId: span.id, turn: turn.turn ?? null };
  }

  async roleTurn({ ticket, role, purpose, route, prompt, spanName, attempt, runId }) {
    const promptHash = shortHash(hashText(prompt));
    const span = this.startRoleSpan({ ticket, role, route, spanName, attempt, runId, promptHash });
    // Everything a later auto-recovery needs to record its continuation turns
    // the same way, carried on the result instead of re-derived by the caller.
    const context = { role, route, attempt, runId, spanName };
    const startedMono = process.hrtime.bigint();
    try {
      const session = await this.driver.ensureTicketSession({ ticket, role, route, purpose });
      this.driver.setPhase(session.sessionId, role);
      this.driver.setRoute(session.sessionId, route);
      this.store.attachSession({
        ticketId: ticket.id,
        dshSessionId: session.sessionId,
        role: purpose,
        purpose,
        preset: 'standard',
        provider: route.provider,
        model: route.model,
      });
      this.store.addArtifact(ticket.id, `${role}_prompt_${spanName}`, prompt, { spanId: span.id });
      const turn = await this.driver.sendTurn({ sessionId: session.sessionId, prompt, stallTimeoutMs: this.getConfig().stallTimeoutMs });
      return { ...this.settleWaitedTurn(ticket, span, route, turn, startedMono, session.sessionId), ...context };
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - startedMono) / 1e6;
      this.log.error('role turn %s/%s failed: %s', role, spanName, error?.stack ?? String(error));
      this.store.endSpan(span.id, { status: 'failed', error: String(error?.message ?? error), durationMs });
      // The needs-attention reason is shown on the board, so it stays one
      // actionable line; the stack is already in the log and the span message.
      return { kind: 'failed', error: String(error?.message ?? error), spanId: span.id, ...context };
    }
  }

  recordToolSpans(ticket, parentSpan, events) {
    const open = new Map();
    for (const event of events) {
      if (event.type === 'tool/call') {
        open.set(event.data.callId, event);
      } else if (event.type === 'tool/result') {
        const callId = event.data.message?.toolCallId ?? event.data.message?.source?.callId ?? event.data.callId;
        const call = open.get(callId);
        if (call === undefined) continue;
        open.delete(callId);
        const id = randomUUID();
        this.store.startSpan({
          id,
          ticketId: ticket.id,
          runId: parentSpan.runId,
          parentSpanId: parentSpan.id,
          kind: 'tool',
          name: call.data.name ?? call.data.call?.name ?? 'tool',
          role: parentSpan.role,
          provider: parentSpan.provider,
          model: parentSpan.model,
          attempt: parentSpan.attempt,
        });
        this.store.endSpan(id, {
          status: event.data.isError === true ? 'failed' : 'ok',
          error: event.data.error === undefined ? null : String(event.data.error),
          durationMs: Math.max(0, Number(event.time) - Number(call.time)),
        });
      }
    }
  }

  recordTurnUsage(ticket, span, route, usage) {
    if (usage === null || usage === undefined) return;
    const priced = priceUsage(this.getConfig(), route.provider, route.model, usage);
    this.store.recordUsage({
      spanId: span.id,
      provider: route.provider,
      model: route.model,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      costUsd: priced.costUsd,
      priceVersion: priced.priceVersion,
    });
    if (priced.costUsd !== null) this.store.addSpend(ticket.id, priced.costUsd);
  }

  // ------------------------------------------------------------------ diff

  async diff(ticket) {
    const config = this.getConfig();
    const cwd = ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd();
    const spanId = randomUUID();
    const span = this.store.startSpan({ id: spanId, ticketId: ticket.id, kind: 'workflow', name: 'git diff', status: 'running' });
    const startedMono = process.hrtime.bigint();
    try {
      const [stat, status, diff] = await Promise.all([
        execFileAsync('git', ['-C', cwd, 'diff', '--stat', 'HEAD'], { timeout: 10_000, maxBuffer: MAX_DIFF_BYTES }),
        execFileAsync('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 10_000, maxBuffer: 100_000 }),
        execFileAsync('git', ['-C', cwd, 'diff', 'HEAD'], { timeout: 10_000, maxBuffer: MAX_DIFF_BYTES }),
      ]);
      const untracked = status.stdout.split('\n').filter((line) => line.startsWith('??')).map((line) => line.slice(3)).slice(0, 50);
      const text = [
        'STAT:',
        stat.stdout.trim() || '(no tracked changes)',
        '',
        'UNTRACKED:',
        untracked.length === 0 ? '(none)' : untracked.join('\n'),
        '',
        'DIFF:',
        diff.stdout.slice(0, MAX_DIFF_BYTES) || '(empty)',
      ].join('\n');
      this.store.addArtifact(ticket.id, 'plugin_git_diff', text, { spanId });
      this.store.endSpan(span.id, { status: 'ok', durationMs: Number(process.hrtime.bigint() - startedMono) / 1e6 });
      return text;
    } catch (error) {
      this.store.endSpan(span.id, { status: 'failed', error: String(error?.message ?? error), durationMs: Number(process.hrtime.bigint() - startedMono) / 1e6 });
      return `(could not read git diff in ${cwd}: ${String(error?.message ?? error)})`;
    }
  }

  // --------------------------------------------------------------- utilities

  stopped(ticketId) {
    const ticket = this.store.getTicket(ticketId);
    return ticket === undefined || TERMINAL_COLUMNS.includes(ticket.column);
  }

  /** True while any session of this ticket has a turn in flight, engine-driven or human-driven. */
  busy(ticket) {
    return this.driver?.isTicketBusy?.(ticket.id) === true;
  }

  resolveRoute(role, attempt) {
    const config = this.getConfig();
    const route = routeForAttempt(config, role, attempt);
    if (route.provider !== null && route.model !== null) return route;
    const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.();
    return {
      ...route,
      provider: route.provider ?? selection?.provider ?? null,
      model: route.model ?? selection?.model ?? null,
      reasoningEffort: route.reasoningEffort ?? selection?.reasoningEffort ?? null,
    };
  }

  retryPhase(ticket) {
    if (this.store.listConditions(ticket.id).length === 0) return 'plan';
    if (ticket.phase === 'review') return 'review';
    if (ticket.phase === 'verify') return 'plan';
    if (ticket.phase === 'plan') return 'plan';
    return 'implement';
  }

  admit(ticket, route, role, { attempt = ticket.attemptCount + 1 } = {}) {
    const config = this.getConfig();
    if (route.provider === null || route.model === null) {
      return { ok: false, reason: 'needs_attention', message: `no route configured for role ${role}` };
    }
    const policy = providerPolicy(config, route.provider);
    if (policy.tier !== 'paid') return { ok: true };
    if (!ticket.allowPaid) return { ok: false, reason: 'paid_not_allowed', message: `role ${role} is routed to paid provider ${route.provider} but allow_paid is false` };
    const estimate = estimateTurnCost({ policy, promptChars: 6000, maxOutputTokens: 8192 });
    if (estimate === null) return { ok: false, reason: 'budget', message: `paid provider ${route.provider} has no complete price` };
    if (ticket.spentUsd + estimate > ticket.budgetUsd) {
      return { ok: false, reason: 'budget', message: `budget exhausted: spent $${ticket.spentUsd.toFixed(2)} + estimate $${estimate.toFixed(2)} > $${ticket.budgetUsd.toFixed(2)}` };
    }
    return { ok: true };
  }

  hold(ticket, admission) {
    return this.needsAttention(ticket, admission.message ?? 'dispatch refused', { budget: admission.reason === 'budget' || admission.reason === 'paid_not_allowed' });
  }

  failedTurn(ticket, turn, phaseName) {
    if (turn.kind === 'budget') return this.hold(ticket, turn);
    return this.needsAttention(ticket, `turn failed in ${phaseName}: ${turn.error ?? 'unknown'}`);
  }

  needsAttention(ticket, reason, payload = {}) {
    if (this.driver?.isTicketBusy?.(ticket.id) === true) {
      this.log.info('ticket %s failure ignored: another session is still active', ticket.key);
      return { kind: 'busy' };
    }
    this.reactivations.delete(ticket.id);
    this.appendEvent(ticket.id, 'needs_attention_reason', { payload: { reason, failedPhase: ticket.phase, ...payload } });
    this.store.setNeedsAttention(ticket.id, reason, payload);
    this.endRun(ticket.id);
    this.appendEvent(ticket.id, 'attempt_history', { payload: this.attemptHistory(ticket.id) });
    return { kind: 'needs_attention' };
  }

  attemptHistory(ticketId) {
    return this.store
      .listEvents(ticketId, { limit: 500 })
      .filter((event) => ['implemented', 'review', 'verification_failed', 'retry_scheduled', 'needs_attention_reason'].includes(event.kind))
      .map((event) => ({ at: event.at, kind: event.kind, payload: event.payload }));
  }

  thresholdFor(ticket) {
    const config = this.getConfig();
    return config.allowTicketThresholdOverride && typeof ticket.confidenceThreshold === 'number' ? ticket.confidenceThreshold : config.confidenceThreshold;
  }

  ensureRun(ticket) {
    const existing = this.currentRun(ticket.id);
    if (existing !== undefined) return existing.id;
    const prompts = this.getPrompts();
    const config = this.getConfig();
    const id = this.store.startRun({
      ticketId: ticket.id,
      configHash: this.configHash ?? hashText(JSON.stringify(config)),
      promptHashes: prompts.hashes ?? {},
    });
    this.runIds.set(ticket.id, id);
    return id;
  }

  endRun(ticketId) {
    const id = this.runIds.get(ticketId);
    if (id !== undefined) this.store.endRun(id);
    this.runIds.delete(ticketId);
  }

  currentRun(ticketId) {
    const id = this.runIds.get(ticketId);
    return id === undefined ? undefined : this.store.getRun(id);
  }

  appendEvent(ticketId, kind, { phaseFrom = null, phaseTo = null, actor = 'engine', payload = {} } = {}) {
    this.store.appendEvent(ticketId, kind, { phaseFrom, phaseTo, actor, payload });
  }

  async closeSession(sessionId) {
    await this.driver.closeSession(sessionId);
    this.store.markSessionClosed(sessionId);
  }

  async closeTicketSessions(ticketId) {
    await this.driver.closeTicketSessions(ticketId);
    for (const session of this.store.listSessions(ticketId)) {
      if (session.closedAt === null) this.store.markSessionClosed(session.sessionId);
    }
  }

  async abortTicket(ticketId) {
    await this.closeTicketSessions(ticketId);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
