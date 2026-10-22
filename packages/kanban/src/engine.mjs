// dsh-kanban: the workflow engine.
//
// Code decides. This file owns every transition: intake, plan, implement,
// verify, review, retry, escalation, capacity admission, budget refusal and
// human waits. Role sessions are dispatched, their final JSON is judged
// mechanically, and an out-of-band judge is consulted only where the protocol
// says a human-level decision is needed.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { providerPolicy, routeForAttempt } from './config.mjs';
import { StoreError } from './store.mjs';
import { compareQueue } from './lifecycle.mjs';
import {
  acceptanceBlock,
  claimsBlock,
  doneWhenBlock,
  hashText,
  JUDGE_SCHEMAS,
  judgeRequest,
  render,
  RESULT_SCHEMA_HINT,
  shortHash,
} from './prompts.mjs';
import { continuationPrompt, extractJson, gateImplement, normalizePlan, validateAdjudication, validateCoverage, validateGrill, validatePlan, validateReview, validateVerification } from './result.mjs';
import { estimateTurnCost, priceUsage } from './usage.mjs';

const execFileAsync = promisify(execFile);

const MAX_DIFF_BYTES = 60_000;

export class Engine {
  constructor({ ctx, store, driver, judge, getConfig, getPrompts, log }) {
    this.ctx = ctx;
    this.store = store;
    this.driver = driver;
    this.judge = judge;
    this.getConfig = getConfig;
    this.getPrompts = getPrompts;
    this.log = log;
    this.active = new Map();
    this.runIds = new Map();
    this.configHash = null;
    this.runInConfig = (_snapshot, fn) => fn();
    this.timer = null;
    this.ticking = false;
    this.disposed = false;
    this.recovered = false;
    this.lastPrune = 0;
  }

  start() {
    this.driver.start();
    const tick = () => {
      if (this.disposed) return;
      void this.tick();
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
        if (ticket.phase === 'grill') continue; // waiting on the human
        this.launch(ticket);
      }
      // Backlog tickets with `now` intake work run without pickup.
      for (const ticket of this.store.listTickets({ columns: ['backlog'] })) {
        if (this.disposed) break;
        if (this.active.has(ticket.id)) continue;
        if (!this.hasBacklogIntake(ticket)) continue;
        this.launch(ticket);
      }
      this.maybePrune();
    } catch (error) {
      this.log.error('tick failed: %s', error?.stack ?? String(error));
    } finally {
      this.ticking = false;
    }
  }

  /** Start one ticket pipeline under its own immutable config snapshot. */
  launch(ticket) {
    if (this.active.has(ticket.id) || this.disposed) return;
    const snapshot = this.getConfig();
    const promise = this.runInConfig(snapshot, () => this.advance(ticket))
      .catch((error) => this.log.error('ticket %s advance failed: %s', ticket.key, error?.stack ?? String(error)))
      .finally(() => this.active.delete(ticket.id));
    this.active.set(ticket.id, promise);
  }

  // ------------------------------------------------------------- recovery



  /**
   * Restart safety. A host killed mid-turn leaves `running` spans and live
   * leases; neither survives the process. Mark them abandoned, release the
   * capacity, and put the ticket back into a dispatchable phase exactly once.
   */
  async recover() {
    for (const span of this.store.runningSpans()) {
      this.store.endSpan(span.id, { status: 'abandoned', error: 'host restarted mid-span' });
      const ticket = this.store.getTicket(span.ticketId);
      if (ticket === undefined) continue;
      if (['implement', 'verify', 'review'].includes(ticket.phase)) {
        if (ticket.attemptCount >= this.getConfig().maxAttempts) {
          this.store.setNeedsAttention(ticket.id, 'host restarted mid-run and the attempt budget is exhausted', { recoveredSpan: span.id });
        } else {
          this.appendEvent(ticket.id, 'recovered', {
            phaseFrom: ticket.phase,
            phaseTo: 'implement',
            payload: { spanId: span.id, reason: 'host restarted mid-span' },
          });
          this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: 'restart recovery' });
        }
      } else if (ticket.phase === 'plan') {
        this.appendEvent(ticket.id, 'recovered', { phaseFrom: 'plan', phaseTo: 'triage', payload: { spanId: span.id } });
        this.store.transitionTicket(ticket.id, { phase: 'triage' }, { actor: 'engine', reason: 'restart recovery' });
      } else if (ticket.phase === 'grill') {
        this.appendEvent(ticket.id, 'recovered', { phaseFrom: 'grill', phaseTo: 'grill', payload: { spanId: span.id } });
      }
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

  // ---------------------------------------------------------- auto-promote

  hasBacklogIntake(ticket) {
    if (ticket.column !== 'backlog') return false;
    if (ticket.phase === 'intake') return true;
    if (ticket.phase !== 'triage') return false;
    // Only `now` work runs before pickup. A judgement grill at backlog happens
    // only when its sibling plan work is also due at backlog.
    if (ticket.grillMode === 'now') return true;
    if (ticket.planMode === 'now') return true;
    return false;
  }

  /** True when a human or the engine settled the ticket while work was in flight. */
  stopped(ticketId) {
    const t = this.store.getTicket(ticketId);
    return t === undefined || ['done', 'discarded'].includes(t.column) || t.column === 'blocked';
  }

  /** Close every live role session for a ticket (human discard/block). */
  async abortTicket(ticketId) {
    for (const session of this.store.listSessions(ticketId)) {
      if (this.driver.isLive(session.sessionId)) await this.driver.closeSession(session.sessionId);
    }
  }

  /** Human drag into `now`, with the WIP guard enforced in code. */
  pickup(ticketId) {
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined) throw new StoreError('not_found', 'no such ticket');
    if (ticket.column !== 'backlog') throw new StoreError('invalid_transition', 'only a backlog ticket can be picked up');
    const config = this.getConfig();
    const nowCount = this.store.listTickets({ columns: ['now'] }).length;
    if (nowCount >= config.wipCap) {
      throw new StoreError('wip_cap', `WIP cap reached (${nowCount}/${config.wipCap}); finish or block a ticket first`);
    }
    const updated = this.store.transitionTicket(ticket.id, { column: 'now' }, { actor: 'human', reason: 'picked up' });
    this.appendEvent(ticket.id, 'picked_up', { payload: { wip: nowCount + 1 } });
    void this.tick();
    return updated;
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
      if (ticket.phase === 'grill' || ticket.phase === 'plan') continue; // blocked on now-intake/human
      if (ticket.phase === 'intake' || ticket.phase === 'triage') {
        if (ticket.grillMode === 'now' || ticket.planMode === 'now') continue;
      }
      this.store.transitionTicket(ticket.id, { column: 'now' }, { actor: 'engine', reason: 'auto_promote' });
      this.appendEvent(ticket.id, 'auto_promoted', { payload: { priorColumn: 'backlog' } });
      const updated = this.store.getTicket(ticket.id);
      this.launch(updated);
      room -= 1;
      promoted += 1;
    }
    if (promoted > 0) this.log.info('auto-promoted %d ticket(s)', promoted);
  }

  // -------------------------------------------------------------- pipeline

  /** Drive one ticket as far as capacity, human input and terminal states allow. */
  async advance(start) {
    let ticket = this.store.getTicket(start.id);
    let guard = 0;
    while (ticket !== undefined && !this.disposed) {
      if (guard++ > 40) {
        this.log.error('ticket %s exceeded pipeline guard; leaving it for the next tick', ticket.key);
        return;
      }
      if (['done', 'discarded', 'needs_attention', 'blocked'].includes(ticket.column)) return;
      if (ticket.column === 'backlog') {
        if (!this.hasBacklogIntake(ticket)) return;
        const result = await this.intake(ticket, 'backlog');
        if (result.kind !== 'continue') return;
        ticket = this.store.getTicket(ticket.id);
        continue;
      }
      if (ticket.column !== 'now') return;
      if (ticket.phase === 'grill') return; // human
      if (['intake', 'triage'].includes(ticket.phase)) {
        const result = await this.intake(ticket, 'pickup');
        if (result.kind !== 'continue') return;
        ticket = this.store.getTicket(ticket.id);
        continue;
      }
      if (ticket.phase === 'plan') {
        const result = await this.plan(ticket);
        if (result.kind !== 'continue') return;
        ticket = this.store.getTicket(ticket.id);
        continue;
      }
      if (ticket.phase === 'implement') {
        const result = await this.implement(ticket);
        if (result.kind !== 'continue') return;
        ticket = this.store.getTicket(ticket.id);
        continue;
      }
      if (ticket.phase === 'verify') {
        const result = await this.verify(ticket);
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

  // ---------------------------------------------------------------- intake

  async intake(ticket, situation) {
    if (ticket.phase === 'intake') {
      this.appendEvent(ticket.id, 'triaged', { phaseFrom: 'intake', phaseTo: 'triage', payload: { situation } });
      ticket = this.store.transitionTicket(ticket.id, { phase: 'triage' }, { actor: 'engine', reason: 'triage' });
      if (ticket.planMode === 'one_shot') {
        const converted = await this.convertAcceptance(ticket);
        if (converted === 'deferred') return { kind: 'wait' };
        if (converted === false) {
          this.appendEvent(ticket.id, 'triage_forced_plan', { payload: { reason: 'acceptance is not mechanically checkable' } });
          ticket = this.store.updateTicket(ticket.id, { planMode: 'at_pickup' }, { actor: 'engine', reason: 'triage could not make acceptance checkable' });
        }
        ticket = this.store.getTicket(ticket.id);
      }
    }

    // A one_shot conversion that could not run last tick (judge capacity) is
    // retried here; it is the only intake work owed while phase is triage.
    if (ticket.phase === 'triage' && ticket.planMode === 'one_shot' && this.store.listConditions(ticket.id).length === 0) {
      const converted = await this.convertAcceptance(ticket);
      if (converted === 'deferred') return { kind: 'wait' };
      if (converted === false) {
        this.appendEvent(ticket.id, 'triage_forced_plan', { payload: { reason: 'acceptance is not mechanically checkable' } });
        ticket = this.store.updateTicket(ticket.id, { planMode: 'at_pickup' }, { actor: 'engine', reason: 'triage could not make acceptance checkable' });
      } else {
        ticket = this.store.getTicket(ticket.id);
      }
    }

    const atPickup = situation === 'pickup';
    const planDue = this.planDue(ticket, atPickup);
    const grillSetting = ticket.grillMode;
    let grill = false;
    if (grillSetting === 'now') grill = situation === 'backlog';
    else if (grillSetting === 'at_pickup') grill = atPickup;
    else if (grillSetting === 'judgement' && planDue) {
      // Judgement is evaluated exactly when the sibling plan work would fire.
      const judged = await this.shouldGrill(ticket);
      if (!judged.ok) {
        return this.needsAttention(ticket, `grill judgement failed: ${judged.error}`);
      }
      grill = judged.grill;
    }

    if (grill) return this.grill(ticket);

    if (planDue) {
      if (ticket.phase !== 'plan') {
        ticket = this.store.transitionTicket(ticket.id, { phase: 'plan' }, { actor: 'engine', reason: 'plan due' });
      }
      return this.plan(ticket);
    }

    // one_shot with no plan: triage acceptance must already be checkable.
    if (ticket.planMode === 'one_shot') {
      const conditions = this.store.listConditions(ticket.id);
      if (conditions.length === 0) {
        return this.needsAttention(ticket, 'one_shot ticket has no checkable acceptance; triage could not convert it');
      }
      if (ticket.phase !== 'implement') {
        ticket = this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: 'one_shot skips planning' });
      }
      // A backlog one_shot ticket waits for pickup; implementation starts in `now`.
      if (ticket.column === 'backlog') return { kind: 'wait' };
      return this.implement(ticket);
    }
    return { kind: 'wait' };
  }

  planDue(ticket, atPickup) {
    if (ticket.planMode === 'one_shot') return false;
    if (ticket.planMode === 'now') return true;
    return atPickup;
  }

  async plan(ticket) {
    if (this.stopped(ticket.id)) return { kind: 'stopped' };
    const config = this.getConfig();
    const prompts = this.getPrompts();
    const acceptance = this.store.listAcceptance(ticket.id);
    const route = this.resolveRoute('planner', 1);
    const admission = this.admit(ticket, route, 'planner');
    if (!admission.ok) return this.hold(ticket, admission);

    const prompt = render(prompts.bodies.planner, {
      key: ticket.key,
      title: ticket.title,
      cwd: ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd(),
      tools: config.roles.planner.allowTools.join(', '),
      body: ticket.body,
      acceptance: acceptanceBlock(acceptance),
    });
    const runId = this.ensureRun(ticket);
    let turn = await this.roleTurn({
      ticket,
      role: 'planner',
      route,
      prompt,
      spanName: 'plan',
      attempt: 1,
      runId,
    });
    if (turn.kind !== 'ok') return this.failedTurn(ticket, turn, 'plan');
    let parsed = extractJson(turn.finalText ?? '');
    let errors = parsed.ok ? validatePlan(parsed.value) : [parsed.reason];
    if (errors.length > 0) {
      const retry = continuationPrompt(errors, 'Required: {"summary":string,"steps":[string],"done_when":[{"id":string,"statement":string,"how_verified":string}]}');
      turn = await this.continueTurn({ ticket, role: 'planner', route, sessionId: turn.sessionId, prompt: retry, runId, spanName: 'plan-continuation' });
      if (turn.kind !== 'ok') return this.failedTurn(ticket, turn, 'plan');
      parsed = extractJson(turn.finalText ?? '');
      errors = parsed.ok ? validatePlan(parsed.value) : [parsed.reason];
    }
    if (errors.length > 0) return this.needsAttention(ticket, `planner did not return a valid plan: ${errors.join('; ')}`);

    let plan = normalizePlan(parsed.value);
    const planVersion = this.store.currentPlanVersion(ticket.id) + 1;
    this.store.replaceConditions(ticket.id, planVersion, plan.conditions, 'plan');
    this.store.addArtifact(ticket.id, 'plan', JSON.stringify({ ...plan, planVersion }, null, 2), { spanId: turn.spanId });

    // Intent coverage is a separate judgement, not an implement retry.
    const coverage = await this.judgeCall({
      ticket,
      task: 'coverage',
      taskText: 'If every done_when condition is met, is the human acceptance plausibly satisfied? Answer covers=true only when each acceptance phrase is served by at least one condition.',
      payload: { acceptance, done_when: plan.conditions },
      schema: JUDGE_SCHEMAS.coverage,
      validate: validateCoverage,
      spanName: 'coverage',
      runId,
    });
    if (!coverage.ok) {
      return this.needsAttention(ticket, `intent-coverage judgement failed: ${coverage.error}`);
    }
    if (coverage.value.covers === false) {
      this.appendEvent(ticket.id, 'coverage_gap', { payload: { reason: coverage.value.reason, missing: coverage.value.missing ?? [] } });
      const revise = await this.continueTurn({
        ticket,
        role: 'planner',
        route,
        sessionId: turn.sessionId,
        prompt: `The intent-coverage check failed: ${coverage.value.reason}\nAdd or revise done_when conditions so that meeting all of them plausibly satisfies the acceptance. Return the complete plan JSON again.`,
        runId,
        spanName: 'plan-revision',
      });
      if (revise.kind === 'ok') {
        const reparsed = extractJson(revise.finalText ?? '');
        if (reparsed.ok && validatePlan(reparsed.value).length === 0) {
          plan = normalizePlan(reparsed.value);
          const version = this.store.currentPlanVersion(ticket.id) + 1;
          this.store.replaceConditions(ticket.id, version, plan.conditions, 'plan');
          this.store.addArtifact(ticket.id, 'plan', JSON.stringify({ ...plan, planVersion: version }, null, 2), { spanId: revise.spanId });
        } else {
          return this.needsAttention(ticket, 'intent coverage failed and the planner could not revise the plan');
        }
      } else {
        return this.needsAttention(ticket, 'intent coverage failed and the planner revision turn failed');
      }
    }
    this.appendEvent(ticket.id, 'planned', { phaseFrom: 'plan', phaseTo: 'implement', payload: { planVersion } });
    const next = this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: 'plan complete' });
    if (next.column === 'backlog') return { kind: 'wait' };
    return this.implement(next);
  }

  async shouldGrill(ticket) {
    const acceptance = this.store.listAcceptance(ticket.id);
    const judged = await this.judgeCall({
      ticket,
      task: 'grillDecision',
      taskText: 'Decide whether this ticket needs a human grilling pass before planning. Grill when scope, constraints, or "done" are genuinely ambiguous; do not grill for routine work.',
      payload: { title: ticket.title, body: ticket.body, acceptance },
      schema: JUDGE_SCHEMAS.grillDecision,
      validate: (value) => (typeof value.grill === 'boolean' ? [] : ['grill must be a boolean']),
      spanName: 'grill-judgement',
      runId: this.ensureRun(ticket),
    });
    if (!judged.ok) return { ok: false, grill: false, error: judged.error, reason: judged.reason };
    return { ok: true, grill: judged.value.grill === true };
  }

  async grill(ticket) {
    if (this.stopped(ticket.id)) return { kind: 'stopped' };
    const config = this.getConfig();
    const prompts = this.getPrompts();
    const acceptance = this.store.listAcceptance(ticket.id);
    if (ticket.phase !== 'grill') {
      ticket = this.store.transitionTicket(ticket.id, { phase: 'grill' }, { actor: 'engine', reason: 'grill due' });
    }
    const route = this.resolveRoute('griller', 1);
    const admission = this.admit(ticket, route, 'griller');
    if (!admission.ok) return this.hold(ticket, admission);
    const prompt = render(prompts.bodies.griller, {
      key: ticket.key,
      title: ticket.title,
      body: ticket.body,
      acceptance: acceptanceBlock(acceptance),
      phase: 'questions',
      tools: config.roles.griller.allowTools.join(', '),
    });
    const runId = this.ensureRun(ticket);
    const turn = await this.roleTurn({ ticket, role: 'griller', route, prompt, spanName: 'grill', attempt: 1, runId });
    if (turn.kind !== 'ok') return this.failedTurn(ticket, turn, 'grill');
    const parsed = extractJson(turn.finalText ?? '');
    if (!parsed.ok) return this.needsAttention(ticket, `griller returned no JSON: ${parsed.reason}`);
    const errors = validateGrill(parsed.value);
    if (errors.length > 0) return this.needsAttention(ticket, `griller JSON invalid: ${errors.join('; ')}`);
    const questions = parsed.value.questions ?? [];
    this.store.addArtifact(ticket.id, 'grill_questions', JSON.stringify({ questions, sessionId: turn.sessionId }, null, 2), { spanId: turn.spanId });
    if (questions.length === 0) {
      for (const statement of parsed.value.refined_acceptance ?? []) this.store.addAcceptance(ticket.id, statement, 'grill');
      this.appendEvent(ticket.id, 'grill_answered', { payload: { questions: 0, refined: (parsed.value.refined_acceptance ?? []).length } });
      return this.afterGrill(this.store.transitionTicket(ticket.id, { phase: 'plan' }, { actor: 'engine', reason: 'grill not needed' }));
    }
    this.appendEvent(ticket.id, 'awaiting_human', { payload: { kind: 'grill', questions, sessionId: turn.sessionId } });
    return { kind: 'awaiting_human' };
  }

  /** Human answers to a grilling session. Called from the HTTP surface. */
  async answerGrill(ticketId, answers) {
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined) throw new Error('no such ticket');
    if (ticket.phase !== 'grill') throw new Error('ticket is not waiting on grill answers');
    if (!Array.isArray(answers) || answers.some((a) => typeof a !== 'string')) throw new Error('answers must be strings');
    const config = this.getConfig();
    const prompts = this.getPrompts();
    const prior = this.store.latestArtifact(ticket.id, 'grill_questions');
    const questions = prior === undefined ? [] : (JSON.parse(prior.content).questions ?? []);
    const acceptance = this.store.listAcceptance(ticket.id);
    const route = this.resolveRoute('griller', 1);
    const admission = this.admit(ticket, route, 'griller');
    if (!admission.ok) return this.hold(ticket, admission);
    const sessionId = prior === undefined ? undefined : safeJson(prior.content)?.sessionId;
    const prompt = render(prompts.bodies.griller, {
      key: ticket.key,
      title: ticket.title,
      body: ticket.body,
      acceptance: acceptanceBlock(acceptance),
      phase: `answers\n\nQuestions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nHuman answers:\n${answers.map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
      tools: config.roles.griller.allowTools.join(', '),
    });
    const runId = this.ensureRun(ticket);
    let turn;
    if (typeof sessionId === 'string' && this.driver.isLive(sessionId)) {
      turn = await this.continueTurn({ ticket, role: 'griller', route, sessionId, prompt, runId, spanName: 'grill-answers' });
    } else {
      turn = await this.roleTurn({ ticket, role: 'griller', route, prompt, spanName: 'grill-answers', attempt: 1, runId });
    }
    if (turn.kind !== 'ok') return this.failedTurn(ticket, turn, 'grill-answers');
    const parsed = extractJson(turn.finalText ?? '');
    if (!parsed.ok) return this.needsAttention(ticket, `griller answers were not JSON: ${parsed.reason}`);
    const errors = validateGrill(parsed.value);
    if (errors.length > 0) return this.needsAttention(ticket, `griller answers invalid: ${errors.join('; ')}`);
    for (const statement of parsed.value.refined_acceptance ?? []) this.store.addAcceptance(ticket.id, statement, 'grill');
    this.appendEvent(ticket.id, 'grill_answered', { payload: { questions: questions.length, answers, refined: (parsed.value.refined_acceptance ?? []).length } });
    return this.afterGrill(this.store.transitionTicket(ticket.id, { phase: 'plan' }, { actor: 'human', reason: 'grill answers supplied' }));
  }

  /** Route after grill completes: plan if due, one_shot goes straight to implement, else wait for pickup. */
  afterGrill(ticket) {
    if (ticket.planMode === 'one_shot') {
      const next = this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: 'one_shot skips planning' });
      if (next.column === 'backlog') return { kind: 'wait' };
      return this.implement(next);
    }
    if (this.planDue(ticket, ticket.column === 'now')) return this.plan(ticket);
    return { kind: 'wait' };
  }

  async convertAcceptance(ticket) {
    const acceptance = this.store.listAcceptance(ticket.id);
    if (acceptance.length === 0) return false;
    const result = await this.judgeCall({
      ticket,
      task: 'triage',
      taskText:
        'Convert the human acceptance into concrete, individually checkable done_when conditions. If the acceptance cannot be made mechanically checkable from the repository, answer checkable=false with a reason instead of inventing conditions.',
      payload: { title: ticket.title, body: ticket.body, acceptance },
      schema: JUDGE_SCHEMAS.triage,
      validate: (value) => {
        if (typeof value.checkable !== 'boolean') return ['checkable must be a boolean'];
        if (value.checkable === false) return [];
        const errors = validatePlan({ done_when: value.done_when });
        return errors;
      },
      spanName: 'triage',
      runId: this.ensureRun(ticket),
    });
    if (!result.ok) return 'deferred';
    if (result.value.checkable === false) return false;
    const plan = normalizePlan({ done_when: result.value.done_when });
    const version = this.store.currentPlanVersion(ticket.id) + 1;
    this.store.replaceConditions(ticket.id, version, plan.conditions, 'triage');
    this.appendEvent(ticket.id, 'acceptance_converted', { payload: { count: plan.conditions.length, source: 'triage' } });
    return true;
  }

  // -------------------------------------------------------------- implement

  async implement(ticket) {
    if (this.stopped(ticket.id)) return { kind: 'stopped' };
    const config = this.getConfig();
    const attempt = ticket.attemptCount + 1;
    if (attempt > config.maxAttempts) {
      return this.needsAttention(ticket, `attempt budget exhausted (${config.maxAttempts})`);
    }
    const route = this.resolveRoute('implementer', attempt);
    const admission = this.admit(ticket, route, 'implementer', { attempt });
    if (!admission.ok) return this.hold(ticket, admission);

    this.store.setAttempt(ticket.id, attempt, route.rung);
    this.appendEvent(ticket.id, 'attempt_started', { payload: { attempt, rung: route.rung, provider: route.provider, model: route.model } });
    const acceptance = this.store.listAcceptance(ticket.id);
    const conditions = this.store.listConditions(ticket.id);
    const planArtifact = this.store.latestArtifact(ticket.id, 'plan');
    const plan = planArtifact === undefined ? { summary: 'one_shot: no plan', steps: [] } : safeJson(planArtifact.content) ?? {};
    const feedback = this.store.latestArtifact(ticket.id, 'attempt_feedback');
    const prompts = this.getPrompts();
    const prompt = render(prompts.bodies.implementer, {
      key: ticket.key,
      title: ticket.title,
      cwd: ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd(),
      tools: config.roles.implementer.allowTools.join(', '),
      acceptance: acceptanceBlock(acceptance),
      plan: `${plan.summary ?? ''}\n${(plan.steps ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
      done_when: doneWhenBlock(conditions),
      body: ticket.body,
      feedback: feedback === undefined ? '(first attempt)' : feedback.content,
    });

    const reuse = config.reuseSessionOnRetry ? this.driver.liveTicketSession(ticket.id) : undefined;
    if (attempt > 1 && reuse === undefined) await this.closeStaleSessions(ticket.id);
    const runId = this.ensureRun(ticket);
    let turn;
    if (reuse !== undefined && this.driver.isLive(reuse)) {
      turn = await this.continueTurn({ ticket, role: 'implementer', route, sessionId: reuse, prompt, runId, spanName: 'implement', attempt });
    } else {
      turn = await this.roleTurn({ ticket, role: 'implementer', route, prompt, spanName: 'implement', attempt, runId });
    }
    if (turn.kind !== 'ok') return this.failedTurn(ticket, turn, 'implement');
    return this.handleImplementResult(ticket, turn, { attempt, route, runId });
  }

  async handleImplementResult(ticket, turn, { attempt, route, runId }) {
    const config = this.getConfig();
    const threshold = this.thresholdFor(ticket);
    const conditions = this.store.listConditions(ticket.id);
    let parsed = extractJson(turn.finalText ?? '');
    let parsedOk = parsed.ok;
    this.store.addArtifact(ticket.id, 'implement_result', JSON.stringify({ attempt, raw: turn.finalText, parsed: parsed.ok ? parsed.value : null }, null, 2), { spanId: turn.spanId });

    let decision = parsed.ok ? gateImplement({ value: parsed.value, conditions, threshold }) : { decision: 'adjudicate', gaps: [parsed.reason], schemaErrors: [parsed.reason] };

    // No JSON (or schema mismatch): one continuation demanding the contract.
    let continuations = 0;
    while ((decision.decision === 'adjudicate') && (continuations < config.maxContinuations) && (decision.reason === 'schema' || !parsedOk)) {
      continuations += 1;
      const retry = continuationPrompt(decision.gaps.length > 0 ? decision.gaps : [parsed.reason ?? 'no JSON'], RESULT_SCHEMA_HINT);
      const again = await this.continueTurn({ ticket, role: 'implementer', route, sessionId: turn.sessionId, prompt: retry, runId, spanName: `implement-continuation-${continuations}`, attempt });
      if (again.kind !== 'ok') return this.failedTurn(ticket, again, 'implement-continuation');
      const reparsed = extractJson(again.finalText ?? '');
      parsed = reparsed;
      parsedOk = reparsed.ok;
      decision = reparsed.ok
        ? gateImplement({ value: reparsed.value, conditions, threshold })
        : { decision: 'adjudicate', gaps: [reparsed.reason], schemaErrors: [reparsed.reason] };
      turn = again;
      if (decision.decision !== 'adjudicate') break;
    }

    if (decision.decision === 'questions') {
      return this.answerQuestions(ticket, { questions: decision.gaps, attempt, route, runId, turn });
    }
    if (decision.decision === 'blocked') {
      return this.needsAttention(ticket, 'implementer reported blocked', { gaps: decision.gaps });
    }
    if (decision.decision === 'pass') {
      if (this.store.listConditions(ticket.id).length === 0) return this.needsAttention(ticket, 'no done_when conditions exist; cannot verify');
      this.appendEvent(ticket.id, 'implemented', { phaseFrom: 'implement', phaseTo: 'verify', payload: { attempt, conditions: decision.conditions } });
      const next = this.store.transitionTicket(ticket.id, { phase: 'verify' }, { actor: 'engine', reason: 'mechanical gate passed' });
      return this.verify(next);
    }

    // Adjudication: one narrow, out-of-band question.
    const diff = await this.diff(ticket);
    const adjudicated = await this.judgeCall({
      ticket,
      task: 'adjudication',
      taskText:
        'You receive the plan, the diff, the implementer output and the mechanical gaps. Either return corrected, evidence-backed done_when JSON (verdict=done), declare not_done with a concrete instruction for the next attempt, or escalate to a human. You may not raise a confidence without citing new evidence.',
      payload: {
        plan: (() => {
          const artifact = this.store.latestArtifact(ticket.id, 'plan');
          return artifact === undefined ? null : safeJson(artifact.content);
        })(),
        diff,
        implementer: parsed.ok ? parsed.value : { unparsed: turn.finalText },
        gaps: decision.gaps,
      },
      schema: JUDGE_SCHEMAS.adjudication,
      validate: validateAdjudication,
      spanName: 'adjudicate',
      runId,
      maxAttempts: config.maxAdjudications > 0 ? 2 : 1,
    });
    if (!adjudicated.ok) {
      if (adjudicated.reason === 'budget' || adjudicated.reason === 'needs_attention') {
        return this.needsAttention(ticket, `adjudication unavailable: ${adjudicated.error}`);
      }
      return this.retryOrEscalate(ticket, `adjudication failed: ${adjudicated.error}`, { attempt, instruction: null });
    }
    if (adjudicated.value.verdict === 'human') {
      return this.needsAttention(ticket, adjudicated.value.reason ?? 'adjudicator escalated to a human', { gaps: decision.gaps });
    }
    if (adjudicated.value.verdict === 'done') {
      const regate = gateImplement({ value: { status: 'complete', summary: 'adjudicated', changed_files: [], done_when: adjudicated.value.done_when, questions: [], residual_risks: [] }, conditions, threshold });
      if (regate.decision === 'pass') {
        for (const row of regate.conditions) {
          this.store.recordVerification(ticket.id, { spanId: adjudicated.spanId, conditionId: row.id, met: row.met, confidence: row.confidence, evidence: row.evidence, cycle: attempt });
        }
        this.appendEvent(ticket.id, 'adjudicated', { payload: { verdict: 'done', attempt } });
        const next = this.store.transitionTicket(ticket.id, { phase: 'verify' }, { actor: 'engine', reason: 'adjudication accepted' });
        return this.verify(next);
      }
      return this.retryOrEscalate(ticket, 'adjudicator declared done but the corrected evidence did not pass the mechanical gate', { attempt, instruction: null });
    }
    return this.retryOrEscalate(ticket, `verification gaps: ${decision.gaps.join('; ')}`, {
      attempt,
      instruction: adjudicated.value.instruction ?? null,
    });
  }

  async answerQuestions(ticket, { questions, attempt, route, runId, turn }) {
    const config = this.getConfig();
    const asked = this.store.latestArtifact(ticket.id, 'auto_answers');
    const rounds = asked === undefined ? [] : safeJson(asked.content) ?? [];
    if (rounds.length >= 2) {
      return this.needsAttention(ticket, `implementer asked ${rounds.length + questions.length} questions after two automatic rounds`, { questions });
    }
    const answers = [];
    for (const question of questions) {
      const judged = await this.judgeCall({
        ticket,
        task: 'answer',
        taskText:
          'Answer the implementer question from the ticket, plan and acceptance. Product decisions and irreversible choices must escalate to a human instead of being guessed.',
        payload: { question, ticket: { key: ticket.key, title: ticket.title, body: ticket.body }, acceptance: this.store.listAcceptance(ticket.id) },
        schema: JUDGE_SCHEMAS.answer,
        validate: (value) => (typeof value.answer !== 'string' || typeof value.escalate !== 'boolean' ? ['answer/escalate malformed'] : []),
        spanName: 'answer-question',
        runId,
      });
      if (!judged.ok) return this.needsAttention(ticket, `could not answer implementer question: ${judged.error}`, { question });
      if (judged.value.escalate === true) return this.needsAttention(ticket, `question needs a human: ${question}`, { question, reason: judged.value.reason });
      answers.push({ question, answer: judged.value.answer, confidence: judged.value.confidence });
    }
    rounds.push({ questions, answers });
    this.store.addArtifact(ticket.id, 'auto_answers', JSON.stringify(rounds, null, 2));
    this.appendEvent(ticket.id, 'questions_answered', { payload: { count: answers.length, round: rounds.length } });
    const retry = [
      'The orchestrator answers your questions from the ticket and plan:',
      ...answers.map((a, i) => `${i + 1}. Q: ${a.question}\n   A: ${a.answer}`),
      '',
      'Continue the same attempt and finish with the required result JSON.',
    ].join('\n');
    const again = await this.continueTurn({ ticket, role: 'implementer', route, sessionId: turn.sessionId, prompt: retry, runId, spanName: 'implement-answer', attempt });
    if (again.kind !== 'ok') return this.failedTurn(ticket, again, 'implement-answer');
    return this.handleImplementResult(ticket, again, { attempt, route, runId });
  }

  // ----------------------------------------------------------------- verify

  async verify(ticket) {
    if (this.stopped(ticket.id)) return { kind: 'stopped' };
    const config = this.getConfig();
    const conditions = this.store.listConditions(ticket.id);
    if (conditions.length === 0) return this.needsAttention(ticket, 'no done_when conditions to verify');
    const claimsArtifact = this.store.latestArtifact(ticket.id, 'implement_result');
    const claims = claimsArtifact === undefined ? null : safeJson(claimsArtifact.content)?.parsed ?? null;
    const route = this.resolveRoute('verifier', ticket.attemptCount);
    const admission = this.admit(ticket, route, 'verifier', { attempt: ticket.attemptCount });
    if (!admission.ok) return this.hold(ticket, admission);
    const prompts = this.getPrompts();
    const prompt = render(prompts.bodies.verifier, {
      key: ticket.key,
      title: ticket.title,
      cwd: ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd(),
      tools: config.roles.verifier.allowTools.join(', '),
      done_when: doneWhenBlock(conditions),
      claims: claimsBlock(claims),
      threshold: this.thresholdFor(ticket),
    });
    const runId = this.ensureRun(ticket);
    const turn = await this.roleTurn({ ticket, role: 'verifier', route, prompt, spanName: 'verify', attempt: ticket.attemptCount, runId });
    if (turn.kind !== 'ok') return this.failedTurn(ticket, turn, 'verify');

    let parsed = extractJson(turn.finalText ?? '');
    let errors = parsed.ok ? validateVerification(parsed.value) : [parsed.reason];
    if (errors.length > 0) {
      const cont = await this.continueTurn({
        ticket,
        role: 'verifier',
        route,
        sessionId: turn.sessionId,
        prompt: continuationPrompt(errors, 'Required: {"summary":string,"done_when":[{"id":string,"met":boolean,"confidence":number,"evidence":string}],"residual_risks":[string]}'),
        runId,
        spanName: 'verify-continuation',
        attempt: ticket.attemptCount,
      });
      if (cont.kind === 'ok') {
        turn = cont;
        parsed = extractJson(cont.finalText ?? '');
        errors = parsed.ok ? validateVerification(parsed.value) : [parsed.reason];
      }
    }
    if (errors.length > 0) return this.retryOrEscalate(ticket, `verifier returned invalid JSON: ${errors.join('; ')}`, { attempt: ticket.attemptCount });
    const threshold = this.thresholdFor(ticket);
    const planIds = conditions.map((c) => c.id);
    const verdicts = parsed.value.done_when ?? [];
    const missing = planIds.filter((id) => !verdicts.some((v) => v.id === id));
    const failed = verdicts.filter((v) => v.met !== true || v.confidence < threshold || !String(v.evidence ?? '').trim());
    for (const verdict of verdicts) {
      this.store.recordVerification(ticket.id, {
        spanId: turn.spanId,
        conditionId: verdict.id,
        met: verdict.met,
        confidence: verdict.confidence,
        evidence: verdict.evidence,
        cycle: ticket.attemptCount,
      });
    }
    this.store.addArtifact(ticket.id, 'verification', JSON.stringify(parsed.value, null, 2), { spanId: turn.spanId });
    if (missing.length === 0 && failed.length === 0) {
      this.appendEvent(ticket.id, 'verified', { phaseFrom: 'verify', phaseTo: 'review', payload: { conditions: verdicts.length } });
      const next = this.store.transitionTicket(ticket.id, { phase: 'review' }, { actor: 'engine', reason: 'verifier passed every condition' });
      return this.review(next);
    }
    const gaps = [
      ...missing.map((id) => `${id}: verifier produced no verdict`),
      ...failed.map((v) => `${v.id}: met=${v.met} confidence=${v.confidence}`),
    ];
    return this.retryOrEscalate(ticket, `verification failed: ${gaps.join('; ')}`, { attempt: ticket.attemptCount });
  }

  // ----------------------------------------------------------------- review

  async review(ticket) {
    if (this.stopped(ticket.id)) return { kind: 'stopped' };
    const config = this.getConfig();
    const route = this.resolveRoute('reviewer', ticket.attemptCount);
    const admission = this.admit(ticket, route, 'reviewer', { attempt: ticket.attemptCount });
    if (!admission.ok) return this.hold(ticket, admission);
    const acceptance = this.store.listAcceptance(ticket.id);
    const planArtifact = this.store.latestArtifact(ticket.id, 'plan');
    const verification = this.store.latestArtifact(ticket.id, 'verification');
    const diff = await this.diff(ticket);
    const prompts = this.getPrompts();
    const prompt = render(prompts.bodies.reviewer, {
      key: ticket.key,
      title: ticket.title,
      cwd: ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd(),
      tools: config.roles.reviewer.allowTools.join(', '),
      acceptance: acceptanceBlock(acceptance),
      plan: planArtifact === undefined ? '(one_shot: no plan)' : planArtifact.content,
      done_when: doneWhenBlock(this.store.listConditions(ticket.id)),
      verification: verification === undefined ? '(none)' : verification.content,
      diff,
    });
    const runId = this.ensureRun(ticket);
    const turn = await this.roleTurn({ ticket, role: 'reviewer', route, prompt, spanName: 'review', attempt: ticket.attemptCount, runId });
    if (turn.kind !== 'ok') return this.failedTurn(ticket, turn, 'review');
    let parsed = extractJson(turn.finalText ?? '');
    let errors = parsed.ok ? validateReview(parsed.value) : [parsed.reason];
    if (errors.length > 0) {
      const cont = await this.continueTurn({
        ticket,
        role: 'reviewer',
        route,
        sessionId: turn.sessionId,
        prompt: continuationPrompt(errors, 'Required: {"verdict":"pass|fail","reasons":[string],"scope_drift":string,"acceptance_coverage":[{"condition":string,"acceptance":string}]}'),
        runId,
        spanName: 'review-continuation',
        attempt: ticket.attemptCount,
      });
      if (cont.kind === 'ok') {
        turn = cont;
        parsed = extractJson(cont.finalText ?? '');
        errors = parsed.ok ? validateReview(parsed.value) : [parsed.reason];
      }
    }
    if (errors.length > 0) return this.retryOrEscalate(ticket, `reviewer returned invalid JSON: ${errors.join('; ')}`, { attempt: ticket.attemptCount });
    this.store.addArtifact(ticket.id, 'review', JSON.stringify(parsed.value, null, 2), { spanId: turn.spanId });
    if (parsed.value.verdict === 'pass') {
      this.appendEvent(ticket.id, 'done', { phaseFrom: 'review', phaseTo: 'closed', payload: { attempt: ticket.attemptCount, coverage: parsed.value.acceptance_coverage ?? [] } });
      const done = this.store.transitionTicket(ticket.id, { column: 'done', phase: 'closed' }, { actor: 'engine', reason: 'review passed' });
      this.endRun(ticket.id);
      await this.closeTicketSessions(ticket.id);
      return { kind: 'done', ticket: done };
    }
    return this.retryOrEscalate(ticket, `review failed: ${(parsed.value.reasons ?? []).join('; ')}`, { attempt: ticket.attemptCount });
  }

  // ------------------------------------------------------------ retry paths

  retryOrEscalate(ticket, reason, { attempt, instruction = null }) {
    const config = this.getConfig();
    this.store.addArtifact(
      ticket.id,
      'attempt_feedback',
      [`Previous attempt ${attempt} failed.`, `Reason: ${reason}`, instruction === null ? '' : `Instruction for the next attempt: ${instruction}`].join('\n'),
    );
    if (attempt >= config.maxAttempts) {
      return this.needsAttention(ticket, `attempt ${attempt}/${config.maxAttempts} exhausted: ${reason}`, { instruction });
    }
    this.appendEvent(ticket.id, 'retry_scheduled', { phaseFrom: ticket.phase, phaseTo: 'implement', payload: { attempt, nextAttempt: attempt + 1, reason } });
    const next = this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason });
    return this.implement(next);
  }

  async failedTurn(ticket, turn, phaseName) {
    if (turn.kind === 'no_capacity') return { kind: 'wait' };
    if (turn.kind === 'budget') return this.hold(ticket, turn);
    if (turn.kind === 'needs_attention') return this.needsAttention(ticket, turn.reason);
    const reason = `turn ${turn.kind} in ${phaseName}: ${turn.error ?? 'unknown'}`;
    if (turn.failureCode === 'MISSING_CREDENTIAL' || turn.failureCode === 'AUTH' || turn.failureCode === 'NO_ADAPTER') {
      return this.needsAttention(ticket, `provider configuration error: ${reason}`, { failureCode: turn.failureCode });
    }
    if (phaseName.startsWith('plan') || phaseName.startsWith('grill')) {
      return this.needsAttention(ticket, reason, { phase: phaseName });
    }
    return this.retryOrEscalate(ticket, reason, { attempt: ticket.attemptCount });
  }

  hold(ticket, admission) {
    if (admission.reason === 'budget') {
      return this.needsAttention(ticket, admission.message, { budget: true });
    }
    if (admission.reason === 'paid_not_allowed') {
      return this.needsAttention(ticket, admission.message, { budget: true });
    }
    return this.needsAttention(ticket, admission.message ?? 'dispatch refused');
  }

  needsAttention(ticket, reason, payload = {}) {
    this.appendEvent(ticket.id, 'needs_attention_reason', { payload: { reason, ...payload } });
    this.store.setNeedsAttention(ticket.id, reason, payload);
    this.endRun(ticket.id);
    this.appendEvent(ticket.id, 'attempt_history', { payload: this.attemptHistory(ticket.id) });
    return { kind: 'needs_attention' };
  }

  attemptHistory(ticketId) {
    const events = this.store.listEvents(ticketId, { limit: 500 });
    return events
      .filter((event) => ['attempt_started', 'implemented', 'verified', 'review', 'retry_scheduled', 'needs_attention_reason'].includes(event.kind))
      .map((event) => ({ at: event.at, kind: event.kind, payload: event.payload }));
  }

  // -------------------------------------------------------------- role turns

  /**
   * Admit one model call against declared capacity and budget. Returns
   * `{ok:false, reason}` for "wait" (no slot) and "needs_attention" (budget or
   * paid policy), never a silent downgrade.
   */
  admit(ticket, route, role, { attempt = ticket.attemptCount + 1 } = {}) {
    const config = this.getConfig();
    if (route.provider === null || route.model === null) {
      return { ok: false, reason: 'needs_attention', message: `no route configured for role ${role}` };
    }
    const policy = providerPolicy(config, route.provider);
    const paid = policy.tier === 'paid';
    if (paid) {
      if (!ticket.allowPaid) {
        return { ok: false, reason: 'paid_not_allowed', message: `role ${role} is routed to paid provider ${route.provider} but allow_paid is false` };
      }
      const estimate = estimateTurnCost({ policy, promptChars: 6000, maxOutputTokens: 8192 });
      if (estimate === null) {
        return { ok: false, reason: 'budget', message: `paid provider ${route.provider} has no complete price; refusing to spend unverifiably` };
      }
      if (ticket.spentUsd + estimate > ticket.budgetUsd) {
        return { ok: false, reason: 'budget', message: `budget exhausted: spent $${ticket.spentUsd.toFixed(2)} + estimate $${estimate.toFixed(2)} > $${ticket.budgetUsd.toFixed(2)}` };
      }
    }
    return { ok: true, policy, attempt };
  }

  async roleTurn({ ticket, role, route, prompt, spanName, attempt, runId }) {
    const spanId = randomUUID();
    const promptHash = shortHash(hashText(prompt));
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
      const session = await this.driver.ensureTicketSession({ ticket, role, route });
      this.driver.setPhase(session.sessionId, role);
      this.driver.setRoute(session.sessionId, route);
      this.store.attachSession({
        ticketId: ticket.id,
        dshSessionId: session.sessionId,
        role: 'workflow',
        preset: session.preset,
        provider: route.provider,
        model: route.model,
      });
      this.store.addArtifact(ticket.id, `${role}_prompt_${spanName}`, prompt, { spanId });
      const turn = await this.driver.sendTurn({
        sessionId: session.sessionId,
        prompt,
        stallTimeoutMs: this.getConfig().stallTimeoutMs,
      });
      const durationMs = Number(process.hrtime.bigint() - startedMono) / 1e6;
      this.recordToolSpans(ticket, span, turn.events ?? []);
      this.recordTurnUsage(ticket, span, route, turn.usage);
      if (turn.status === 'ok') {
        this.store.endSpan(span.id, { status: 'ok', durationMs });
        return { kind: 'ok', finalText: turn.finalText, usage: turn.usage, sessionId: session.sessionId, spanId: span.id, events: turn.events ?? [] };
      }
      if (turn.status === 'stalled') {
        this.store.endSpan(span.id, { status: 'abandoned', error: 'stalled', durationMs });
        this.appendEvent(ticket.id, 'stalled', { payload: { role, spanId: span.id, attempt } });
        return { kind: 'failed', error: 'turn stalled; no progress before stallTimeoutMs', sessionId: session.sessionId, spanId: span.id };
      }
      this.store.endSpan(span.id, { status: 'failed', error: turn.error ?? turn.status, durationMs });
      const failureReason = turn.reason?.kind === 'error' ? turn.reason.error : null;
      return {
        kind: 'failed',
        error: turn.error ?? turn.status,
        failureCode: failureReason?.code ?? null,
        sessionId: session.sessionId,
        spanId: span.id,
      };
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - startedMono) / 1e6;
      this.store.endSpan(span.id, { status: 'failed', error: String(error?.message ?? error), durationMs });
      return { kind: 'failed', error: String(error?.message ?? error), spanId: span.id };
    }
  }

  async continueTurn({ ticket, role, route, sessionId, prompt, runId, spanName, attempt }) {
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
      attempt: attempt ?? ticket.attemptCount,
    });
    const startedMono = process.hrtime.bigint();
    try {
      this.driver.setPhase(sessionId, role);
      this.driver.setRoute(sessionId, route);
      const turn = await this.driver.sendTurn({ sessionId, prompt, stallTimeoutMs: this.getConfig().stallTimeoutMs });
      const durationMs = Number(process.hrtime.bigint() - startedMono) / 1e6;
      this.recordTurnUsage(ticket, span, route, turn.usage);
      if (turn.status === 'ok') {
        this.store.endSpan(span.id, { status: 'ok', durationMs });
        return { kind: 'ok', finalText: turn.finalText, usage: turn.usage, sessionId, spanId: span.id };
      }
      this.store.endSpan(span.id, { status: turn.status === 'stalled' ? 'abandoned' : 'failed', error: turn.error ?? turn.status, durationMs });
      return { kind: 'failed', error: turn.error ?? turn.status, sessionId, spanId: span.id };
    } catch (error) {
      this.store.endSpan(span.id, { status: 'failed', error: String(error?.message ?? error) });
      return { kind: 'failed', error: String(error?.message ?? error), spanId: span.id };
    }
  }

  /** Record one child span per tool start/end pair seen in the turn's events. */
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
        const startedAt = new Date(call.time).toISOString();
        const endedAt = new Date(event.time).toISOString();
        const id = randomUUID();
        this.store.startSpan({
          id,
          ticketId: ticket.id,
          runId: parentSpan.runId,
          parentSpanId: parentSpan.id,
          kind: 'tool',
          name: call.data.name,
          role: parentSpan.role,
          attempt: parentSpan.attempt,
        });
        this.store.db
          .prepare('UPDATE spans SET started_at = ?, ended_at = ?, duration_ms = ?, status = ? WHERE id = ?')
          .run(startedAt, endedAt, Math.max(0, event.time - call.time), event.data.error === undefined ? 'ok' : 'failed', id);
      }
    }
  }

  recordTurnUsage(ticket, span, route, usage) {
    if (usage === null || usage === undefined) return;
    const policy = providerPolicy(this.getConfig(), route.provider);
    const priced = priceUsage(usage, policy);
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
    if (priced.costUsd !== null && priced.costUsd > 0) this.store.addSpend(ticket.id, priced.costUsd);
  }

  /** One out-of-band judgement, with its own span and usage. */
  async judgeCall({ ticket, task, taskText, payload, schema, validate, spanName, runId, maxAttempts = 2 }) {
    const config = this.getConfig();
    const route = this.resolveRoute('orchestrator', 1);
    const admission = this.admit(ticket, route, 'orchestrator');
    if (!admission.ok) return { ok: false, error: admission.message ?? admission.reason, reason: admission.reason };
    const policy = providerPolicy(config, route.provider);
    const spanId = randomUUID();
    const span = this.store.startSpan({
      id: spanId,
      ticketId: ticket.id,
      runId,
      kind: 'judge',
      name: spanName,
      role: 'orchestrator',
      provider: route.provider,
      model: route.model,
    });
    const startedMono = process.hrtime.bigint();
    try {
      const prompts = this.getPrompts();
      const request = judgeRequest({ basePrompt: prompts.bodies.orchestrator, task: taskText, payload, schema });
      const result = await this.judge.judgeJson({
        task,
        system: request.system,
        payload: request.user,
        schema,
        ticket,
        maxAttempts,
      });
      const durationMs = Number(process.hrtime.bigint() - startedMono) / 1e6;
      this.store.recordUsage({
        spanId: span.id,
        provider: route.provider,
        model: route.model,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        cacheReadTokens: result.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: result.usage?.cacheWriteTokens ?? 0,
        costUsd: priceUsage(result.usage, policy).costUsd,
        priceVersion: priceUsage(result.usage, policy).priceVersion,
      });
      const spent = priceUsage(result.usage, policy).costUsd;
      if (spent !== null && spent > 0) this.store.addSpend(ticket.id, spent);
      const errors = validate(result.value);
      if (errors.length > 0) {
        this.store.endSpan(span.id, { status: 'failed', error: errors.join('; '), durationMs });
        return { ok: false, error: `judge schema invalid: ${errors.join('; ')}`, spanId: span.id };
      }
      this.store.endSpan(span.id, { status: 'ok', durationMs });
      this.store.addArtifact(ticket.id, `judge_${spanName}`, JSON.stringify(result.value, null, 2), { spanId: span.id });
      return { ok: true, value: result.value, spanId: span.id };
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - startedMono) / 1e6;
      this.store.endSpan(span.id, { status: 'failed', error: String(error?.message ?? error), durationMs });
      return { ok: false, error: String(error?.message ?? error), code: error?.code, spanId: span.id };
    }
  }

  // ------------------------------------------------------------------ misc

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

  thresholdFor(ticket) {
    const config = this.getConfig();
    if (config.allowTicketThresholdOverride && typeof ticket.confidenceThreshold === 'number') return ticket.confidenceThreshold;
    return config.confidenceThreshold;
  }

  ensureRun(ticket) {
    const existing = this.currentRun(ticket.id);
    if (existing !== undefined) return existing.id;
    const prompts = this.getPrompts();
    const config = this.getConfig();
    const configHash = this.configHash ?? hashText(JSON.stringify(config));
    const id = this.store.startRun({ ticketId: ticket.id, configHash, promptHashes: prompts.hashes });
    this.runIds.set(ticket.id, id);
    return id;
  }

  currentRun(ticketId) {
    const id = this.runIds.get(ticketId);
    if (id === undefined) return undefined;
    return this.store.getRun(id);
  }

  endRun(ticketId) {
    const id = this.runIds.get(ticketId);
    if (id === undefined) return;
    this.store.endRun(id);
    this.runIds.delete(ticketId);
  }

  findReusableSession(ticketId) {
    const id = this.driver.liveTicketSession(ticketId);
    return id === undefined ? undefined : { sessionId: id };
  }

  async closeStaleSessions(ticketId) {
    const id = this.driver.liveTicketSession(ticketId);
    if (id !== undefined) await this.driver.closeSession(id);
  }

  async closeTicketSessions(ticketId) {
    for (const session of this.store.listSessions(ticketId)) {
      await this.driver.closeSession(session.sessionId);
    }
  }

  appendEvent(ticketId, kind, { phaseFrom = null, phaseTo = null, actor = 'engine', payload = {} } = {}) {
    try {
      const at = new Date().toISOString();
      this.store.db
        .prepare('INSERT INTO events (ticket_id, at, kind, phase_from, phase_to, actor, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ticketId, at, kind, phaseFrom, phaseTo, actor, JSON.stringify(payload ?? {}));
      this.store.pendingEvents.push({ ticketId, at, kind, phaseFrom, phaseTo, actor, payload });
    } catch (error) {
      this.log.warn('could not append event %s: %s', kind, String(error?.message ?? error));
    }
  }

  async diff(ticket) {
    const cwd = ticket.workspaceCwd ?? this.getConfig().defaultWorkspaceCwd ?? process.cwd();
    try {
      const [stat, status, diff] = await Promise.all([
        execFileAsync('git', ['-C', cwd, 'diff', '--stat', 'HEAD'], { timeout: 10_000, maxBuffer: MAX_DIFF_BYTES }),
        execFileAsync('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 10_000, maxBuffer: 100_000 }),
        execFileAsync('git', ['-C', cwd, 'diff', 'HEAD'], { timeout: 10_000, maxBuffer: MAX_DIFF_BYTES }),
      ]);
      const untracked = status.stdout
        .split('\n')
        .filter((line) => line.startsWith('??'))
        .map((line) => line.slice(3))
        .slice(0, 50);
      return [
        'STAT:',
        stat.stdout.trim() || '(no tracked changes)',
        '',
        'UNTRACKED:',
        untracked.length === 0 ? '(none)' : untracked.join('\n'),
        '',
        'DIFF:',
        diff.stdout.slice(0, MAX_DIFF_BYTES) || '(empty)',
      ].join('\n');
    } catch (error) {
      return `(could not read git diff in ${cwd}: ${String(error?.message ?? error)})`;
    }
  }

}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
