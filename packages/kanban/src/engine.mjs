// dsh-kanban: the workflow engine.
//
// Code decides. This file owns every transition: flat plan session, the
// implement <-> review session, code-gated approval, retries,
// human attention, and session teardown. Agents return structured data through
// tools; no phase result is parsed out of assistant prose.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { providerPolicy, routeForAttempt } from './config.mjs';
import { StoreError } from './store.mjs';
import { compareQueue } from './lifecycle.mjs';
import { hashText, render, shortHash } from './prompts.mjs';
import { normalizePlan, validatePlan, verifyReview } from './result.mjs';
import { estimateTurnCost, priceUsage } from './usage.mjs';

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 60_000;

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
    this.configHash = null;
    this.timer = null;
    this.ticking = false;
    this.disposed = false;
    this.recovered = false;
    this.lastPrune = 0;
    if (this.driver !== null && typeof this.driver === 'object') {
      this.driver.approval = {
        approve: (ticketId, message) => this.approve(ticketId, message),
        discard: (ticketId, reason) => this.discard(ticketId, reason),
        plan: (ticketId, value) => this.submitApprovalPlan(ticketId, value),
      };
    }
  }

  start() {
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
      await this.autoPromote();
      const now = this.store.listTickets({ columns: ['now'] });
      for (const ticket of now) {
        if (this.disposed) break;
        if (this.active.has(ticket.id)) continue;
        this.launch(ticket);
      }
      for (const ticket of this.store.listTickets({ columns: ['backlog'] })) {
        if (this.disposed) break;
        if (this.active.has(ticket.id)) continue;
        if (ticket.phase !== 'plan' || ticket.planTiming !== 'now') continue;
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
      if (ticket.phase === 'plan') {
        this.appendEvent(ticketId, 'restart_recovered', {
          phaseFrom: 'plan',
          phaseTo: 'plan',
          payload: { sessionId: session.sessionId, reason: 'plan session interrupted by restart' },
        });
        this.store.setNeedsAttention(ticketId, 'plan session was interrupted by a restart; retry to plan again', {
          restartRecovery: true,
          sessionId: session.sessionId,
        });
      } else if (ticket.phase === 'review') {
        this.store.transitionTicket(ticketId, { phase: 'implement' }, { actor: 'engine', reason: 'restart recovery' });
      } else if (ticket.phase === 'verify') {
        this.store.setNeedsAttention(ticketId, 'approval session was interrupted by a restart; approve, discard, or open approval again');
      }
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

  async autoPromote() {
    const config = this.getConfig();
    if (!config.autoPromote || config.wipCap <= 0) return;
    const now = this.store.listTickets({ columns: ['now'] });
    let room = config.wipCap - now.length;
    let promoted = 0;
    if (room <= 0) return;
    const backlog = this.store.listTickets({ columns: ['backlog'] }).sort(compareQueue);
    for (const ticket of backlog) {
      if (room <= 0 || promoted >= config.autoPromotePerTick) break;
      this.store.transitionTicket(ticket.id, { column: 'now' }, { actor: 'engine', reason: 'auto_promote' });
      this.appendEvent(ticket.id, 'auto_promoted', { payload: { priorColumn: 'backlog' } });
      promoted += 1;
      room -= 1;
    }
    if (promoted > 0) this.log.info('auto-promoted %d ticket(s)', promoted);
  }

  /** Human drag into now, with the WIP guard enforced in code. */
  pickup(ticketId) {
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined) throw new StoreError('not_found', 'no such ticket');
    if (ticket.column !== 'backlog') throw new StoreError('invalid_transition', 'only a backlog ticket can be picked up');
    const config = this.getConfig();
    const nowCount = this.store.listTickets({ columns: ['now'] }).length;
    if (nowCount >= config.wipCap) throw new StoreError('wip_cap', `WIP cap reached (${nowCount}/${config.wipCap}); finish or block a ticket first`);
    const updated = this.store.transitionTicket(ticket.id, { column: 'now' }, { actor: 'human', reason: 'picked up' });
    this.appendEvent(ticket.id, 'picked_up', { payload: { wip: nowCount + 1 } });
    void this.tick();
    return updated;
  }

  /** Drive one ticket as far as the current session phase allows. */
  async advance(start) {
    let ticket = this.store.getTicket(start.id);
    let guard = 0;
    while (ticket !== undefined && !this.disposed) {
      if (guard++ > 40) {
        this.log.error('ticket %s exceeded pipeline guard', ticket.key);
        return;
      }
      if (['done', 'discarded', 'needs_attention', 'blocked'].includes(ticket.column)) return;
      if (ticket.phase === 'closed') return;
      if (ticket.phase === 'plan') {
        if (ticket.column === 'backlog' && ticket.planTiming !== 'now') return;
        const result = await this.plan(ticket);
        if (result.kind !== 'continue') return;
        ticket = this.store.getTicket(ticket.id);
        if (ticket.column === 'backlog') return;
        continue;
      }
      if (ticket.column !== 'now') return;
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
    const turn = await this.roleTurn({ ticket, role: 'planner', purpose: 'plan', route, prompt, spanName: 'plan', attempt: 1, runId });
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
    return { kind: next.column === 'now' ? 'continue' : 'wait' };
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
    });
    const runId = this.ensureRun(ticket);
    const turn = await this.roleTurn({ ticket, role: 'implementer', purpose: 'build', route, prompt, spanName: 'implement', attempt, runId });
    if (turn.kind !== 'ok') return this.failedTurn(ticket, turn, 'implement');
    if (turn.action === null || turn.action.type !== 'implementation') {
      return this.needsAttention(ticket, 'implementer ended without calling kanban_submit_implementation');
    }
    const value = turn.action.value;
    this.store.addArtifact(ticket.id, 'implement_result', JSON.stringify(value, null, 2), { spanId: turn.spanId });
    if (value.status === 'blocked') return this.needsAttention(ticket, 'implementer reported blocked', { gaps: value.reasons ?? value.residual_risks ?? [] });
    this.appendEvent(ticket.id, 'implemented', { phaseFrom: 'implement', phaseTo: 'review', payload: { attempt } });
    const next = this.store.transitionTicket(ticket.id, { phase: 'review' }, { actor: 'engine', reason: 'implementation submitted' });
    return { kind: next.column === 'now' ? 'continue' : 'wait' };
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
    const planArtifact = this.store.latestArtifact(ticket.id, 'plan');
    const implementArtifact = this.store.latestArtifact(ticket.id, 'implement_result');
    const diff = await this.diff(ticket);
    const prompt = render(prompts.bodies.review, {
      key: ticket.key,
      title: ticket.title,
      cwd: ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd(),
      acceptance: acceptanceBlock(acceptance),
      plan: planArtifact === undefined ? '(no plan)' : planArtifact.content,
      done_when: doneWhenBlock(this.store.listConditions(ticket.id)),
      implementation: implementArtifact === undefined ? '(none)' : implementArtifact.content,
      diff,
    });
    const runId = this.ensureRun(ticket);
    const turn = await this.roleTurn({ ticket, role: 'reviewer', purpose: 'build', route, prompt, spanName: 'review', attempt: ticket.attemptCount, runId });
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
      await this.closeSession(turn.sessionId);
      await this.enterApproval(ticket);
      return { kind: 'wait' };
    }
    const instruction = typeof value.instruction === 'string' && value.instruction.trim() !== '' ? value.instruction : (value.reasons ?? []).join('; ');
    this.store.addArtifact(ticket.id, 'review_feedback', instruction, { spanId: turn.spanId });
    this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: `review requested changes: ${instruction}` });
    return { kind: 'continue' };
  }

  // --------------------------------------------------------------- approval

  async enterApproval(ticket) {
    this.store.transitionTicket(ticket.id, { phase: 'verify' }, { actor: 'engine', reason: 'review passed; awaiting approval' });
    this.store.setNeedsAttention(ticket.id, 'Awaiting human approval');
    this.appendEvent(ticket.id, 'approval_requested', {
      phaseFrom: 'review',
      phaseTo: 'verify',
      payload: { attempt: ticket.attemptCount },
    });
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

  async startApprovalSession(ticketId) {
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${ticketId}`);
    if (ticket.phase !== 'verify') throw new StoreError('bad_request', 'ticket is not awaiting approval');
    const route = this.resolveRoute('implementer', ticket.attemptCount);
    const result = await this.driver.ensureTicketSession({ ticket, role: 'implementer', route, purpose: 'approval' });
    this.driver.setPhase(result.sessionId, 'implementer');
    this.driver.setRoute(result.sessionId, route);
    this.store.attachSession({
      ticketId: ticket.id,
      dshSessionId: result.sessionId,
      role: 'implementer',
      purpose: 'approval',
      provider: route.provider,
      model: route.model,
    });
    void this.approvalIntro(ticket, result.sessionId, route);
    return result;
  }

  async approvalIntro(ticket, sessionId, route) {
    const plan = this.store.latestArtifact(ticket.id, 'plan');
    const review = this.store.latestArtifact(ticket.id, 'review');
    const acceptance = this.store.listAcceptance(ticket.id);
    const prompt = [
      `Approval session for ${ticket.key}: ${ticket.title}`,
      '',
      'The implementation passed code-checkable review and is waiting for the human.',
      'You have workspace-write, shell, browser and repository tools. Inspect, merge, deploy, or iterate only when the human asks.',
      'Do not call kanban_approve, kanban_discard, or kanban_submit_plan until the human explicitly asks.',
      '',
      'Ticket body:',
      ticket.body || '(empty)',
      '',
      'Acceptance:',
      acceptanceBlock(acceptance),
      '',
      'Plan:',
      plan?.content ?? '(none)',
      '',
      'Review:',
      review?.content ?? '(none)',
    ].join('\n');
    try {
      const runId = this.ensureRun(ticket);
      await this.roleTurn({ ticket, role: 'implementer', purpose: 'approval', route, prompt, spanName: 'approval', attempt: ticket.attemptCount, runId });
    } catch (error) {
      this.log.warn('approval session intro failed: %s', String(error?.message ?? error));
    }
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
    const sessionId = this.driver.liveTicketSession(ticket.id, 'approval');
    if (sessionId !== undefined) await this.closeSession(sessionId);
    return this.store.transitionTicket(ticket.id, { column: 'now', phase: 'implement' }, { actor: 'human', reason: 'approval follow-up plan' });
  }

  // -------------------------------------------------------------- role turn

  async roleTurn({ ticket, role, purpose, route, prompt, spanName, attempt, runId }) {
    const promptHash = shortHash(hashText(prompt));
    const spanId = randomUUID();
    const span = this.store.startSpan({
      id: spanId,
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
      this.store.addArtifact(ticket.id, `${role}_prompt_${spanName}`, prompt, { spanId });
      const turn = await this.driver.sendTurn({ sessionId: session.sessionId, prompt, stallTimeoutMs: this.getConfig().stallTimeoutMs });
      const durationMs = Number(process.hrtime.bigint() - startedMono) / 1e6;
      this.recordToolSpans(ticket, span, turn.events ?? []);
      this.recordTurnUsage(ticket, span, route, turn.usage);
      if (turn.status === 'ok') {
        this.store.endSpan(span.id, { status: 'ok', durationMs });
        return { kind: 'ok', action: turn.action ?? null, finalText: turn.finalText, usage: turn.usage, sessionId: session.sessionId, spanId: span.id };
      }
      if (turn.status === 'stalled') {
        this.store.endSpan(span.id, { status: 'abandoned', error: 'stalled', durationMs });
        return { kind: 'failed', error: 'turn stalled', sessionId: session.sessionId, spanId: span.id };
      }
      this.store.endSpan(span.id, { status: 'failed', error: turn.error ?? turn.status, durationMs });
      return { kind: 'failed', error: turn.error ?? turn.status, sessionId: session.sessionId, spanId: span.id };
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - startedMono) / 1e6;
      this.log.error('role turn %s/%s failed: %s', role, spanName, error?.stack ?? String(error));
      this.store.endSpan(span.id, { status: 'failed', error: String(error?.message ?? error), durationMs });
      return { kind: 'failed', error: String(error?.stack ?? error), spanId: span.id };
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
    return ticket === undefined || ['done', 'discarded', 'blocked'].includes(ticket.column);
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
    this.appendEvent(ticket.id, 'needs_attention_reason', { payload: { reason, failedPhase: ticket.phase, ...payload } });
    this.store.setNeedsAttention(ticket.id, reason, payload);
    void this.closeTicketSessions(ticket.id);
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
