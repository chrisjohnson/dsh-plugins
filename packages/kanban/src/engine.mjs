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
import { refsFromBody, resolveAttachments } from './images.mjs';
import { hashText, render, shortHash } from './prompts.mjs';
import { normalizePlan, validatePlan, verifyReview, classifyGaps, nonDeferredProven } from './result.mjs';
import { countGrants, isPlanReady, planReadyReason } from './grants.mjs';
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

/**
 * The durable image refs in a ticket body, resolved to host file paths through
 * the attachment store. A ref whose bytes the store can no longer locate (or a
 * backend that exposes no host files) comes back with `path: null` and is
 * marked unavailable in the prompt rather than silently dropped — the agent
 * should know the human referenced an image it cannot see.
 */
export function attachedImages(ctx, body) {
  const refs = refsFromBody(typeof body === 'string' ? body : '');
  const out = [];
  const seen = new Set();
  const attachments = resolveAttachments(ctx);
  for (const ref of refs) {
    if (ref.attachmentId === null || seen.has(ref.attachmentId)) continue;
    seen.add(ref.attachmentId);
    let path = null;
    try {
      const found = attachments?.imageHostPath?.({ attachmentId: ref.attachmentId });
      if (typeof found === 'string' && found !== '') path = found;
    } catch {
      path = null;
    }
    out.push({ name: ref.name === '' ? ref.attachmentId : ref.name, path });
  }
  return out;
}

/**
 * The ticket block every role session reads first. `images` is the output of
 * `attachedImages`; an empty list adds nothing, so a ticket without images
 * keeps the exact prompt it had before images existed.
 */
export function ticketStateBlock(ticket, acceptance, images = []) {
  const lines = [
    `Title: ${ticket.title}`,
    '',
    'Body:',
    ticket.body?.trim() === '' ? '(empty)' : ticket.body,
  ];
  if (Array.isArray(images) && images.length > 0) {
    lines.push('', 'Attached images (read-only, on this host):');
    for (const image of images) {
      lines.push(image.path ? `- ${image.name}: ${image.path}` : `- ${image.name}: (unavailable)`);
    }
    lines.push('Use the read_image tool on these paths to look at them.');
  }
  lines.push('', 'Acceptance (starting point, human):', acceptanceBlock(acceptance));
  return lines.join('\n');
}

function acceptanceBlock(acceptance) {
  return acceptance.length === 0 ? '(none)' : acceptance.map((a) => `- ${a.statement}`).join('\n');
}

function doneWhenBlock(conditions) {
  return conditions.map((c) => `${conditionHead(c)}\n  verify: ${c.howVerified}${deferredNote(c)}`).join('\n');
}

/**
 * KAN-31: the deferred marker, in the one wording the build, the review and the
 * approval prompt all use. A deferred condition is planned work the agent must
 * NOT do and cannot evidence — it is handed to the human at approval — so every
 * phase has to see the same thing the gate decided on.
 */
function deferredNote(condition) {
  if (condition.deferred !== true) return '';
  const evidence = typeof condition.humanEvidence === 'string' && condition.humanEvidence.trim() !== ''
    ? condition.humanEvidence.trim()
    : condition.howVerified;
  return ` (deferred to approval — human evidence: ${evidence})`;
}

function conditionHead(c) {
  return `- ${c.id}: ${c.statement}`;
}

/**
 * KAN-31: the release-scope line, rendered only when the plan declared a scope,
 * so a plan written before 0.17.0 gets the byte-identical prompt it had.
 */
function releaseScopeLine(plan) {
  const scope = plan === null || plan === undefined ? undefined : plan.releaseScope;
  if (scope === 'stop_before_merge') {
    return 'Release scope: this plan stops before the release. Do not merge to the default branch, tag, or deploy — those steps are deferred conditions the human performs at approval. Land the work on this branch and prove the conditions that are yours.';
  }
  if (scope === 'full_release') {
    return 'Release scope: this plan carries the release through. Merging, tagging and deploying are in-scope work for this build unless a condition marks them deferred.';
  }
  return '';
}

/**
 * KAN-32: the questions line an autonomous ticket's build and review prompts
 * carry. The engine answers an option-batch ask by taking the first
 * (recommended) option and logging the choice, so the prompt can say plainly
 * that asking is safe — and require the decision be written down, because a
 * choice nobody recorded is a choice nobody can review. Empty for every
 * interactive ticket, which keeps its prompt byte-identical to before.
 */
function questionNote(ticket, submitTool) {
  if (ticket.planQuestions !== 'autonomous') return '';
  return (
    'Questions: this ticket is set to decide autonomously, so an `ask_user_question` batch whose every question carries options is answered for you — ' +
    'the first (recommended) option is taken and the choice is recorded on the ticket as a `question_answered_autonomously` event. ' +
    'Asking is therefore safe: it does not stall the ticket. Ask whenever a real choice exists, put the option you recommend first, ' +
    `and name every choice taken this way in your \`${submitTool}\` report. A question with no options is still a question for a human, and it will wait for one.`
  );
}

/**
 * The compact condition list the review prompt carries: id plus statement, no
 * how_verified. The reviewer's own session already holds the plan and the diff,
 * so the ids are all it needs to answer against — and the one thing it must not
 * invent is an id.
 */
function conditionListBlock(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return '(the plan declared no conditions)';
  return conditions.map((c) => `- \`${c.id}\` — ${c.statement}${deferredNote(c)}`).join('\n');
}

/**
 * KAN-31: the deferred section of the approval prompt. Empty when nothing is
 * deferred, so an ordinary ticket gets the exact hand-over it got before; when
 * something is, the human is told precisely which conditions are theirs to
 * evidence and what to look at.
 *
 * The leading and trailing newlines are part of the value, not of the template:
 * `approval.md` ends with `{{deferred}}` with no newline of its own, so an empty
 * value here reproduces the pre-0.17.0 prompt byte for byte.
 */
function deferredBlock(deferredIds, conditions) {
  if (!Array.isArray(deferredIds) || deferredIds.length === 0) return '';
  const byId = new Map((conditions ?? []).map((c) => [c.id, c]));
  const lines = deferredIds.map((id) => {
    const condition = byId.get(id);
    if (condition === undefined) return `- \`${id}\``;
    return `- \`${id}\` — ${condition.statement}${deferredNote(condition)}`;
  });
  return [
    '',
    '',
    'Deferred conditions — the human evidences these, not you:',
    '',
    ...lines,
    '',
    'Name each one in your hand-over and say what to check. Do not attempt them and do not call them failures: the review passed with these left open on purpose.',
  ].join('\n');
}

/**
 * The condition ids the review that sent this round back left failing. A fail is
 * allowed to stop listing rows it already bounced, so an empty set is honest and
 * the park message says so rather than guessing.
 */
function reworkFailingIds(rework) {
  const rows = Array.isArray(rework?.done_when) ? rework.done_when : [];
  const ids = [];
  for (const row of rows) {
    if (row !== null && typeof row === 'object' && row.met !== true && row.id !== undefined) {
      const id = String(row.id);
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * The condition ids a list of review gaps names. `verifyReview` writes every
 * per-condition gap as `done_when.<id> …`, so the id is recoverable without
 * re-running the gate — which is what the no-progress signature needs.
 */
function gapConditionIds(gaps) {
  const ids = [];
  for (const gap of Array.isArray(gaps) ? gaps : []) {
    const match = /^done_when\.(\S+)/.exec(String(gap));
    if (match !== null && !ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
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
    // KAN-18: the working copy is settled here — the moment planning actually
    // starts — not when the ticket was written. A throw (an origin that could not
    // be fetched) parks the ticket with git's own reason: no plan runs against a
    // base this plugin could not bring up to date. A driver without the seam
    // (a test double, or a stripped-down mount) plans exactly as before.
    let prep = { cwd: undefined, note: undefined };
    try {
      if (typeof this.driver.preparePlanWorktree === 'function') {
        prep = (await this.driver.preparePlanWorktree(ticket)) ?? prep;
      }
    } catch (error) {
      return this.failedTurn(ticket, { kind: 'failed', error: String(error?.message ?? error) }, 'plan');
    }
    const promptFile = ticket.planQuestions === 'autonomous' ? 'plan-self' : 'plan-human';
    const rendered = render(prompts.bodies[promptFile] ?? prompts.bodies['plan-human'], {
      ticket_state: ticketStateBlock(ticket, acceptance, attachedImages(this.ctx, ticket.body)),
      acceptance: acceptanceBlock(acceptance),
      key: ticket.key,
      title: ticket.title,
      // KAN-30: the planner has to know what the build session will be standing
      // on to declare the grants it will actually need — the mode it writes
      // under and the root that mode confines it to.
      write_mode: ticket.writeMode ?? 'workspace-write',
      cwd: ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd(),
    });
    // The planner has to know when it is standing on an old commit, or it plans
    // against code that is not current and nobody tells it why.
    const prompt = typeof prep.note === 'string' && prep.note !== '' ? `${rendered}\n\n${prep.note}\n` : rendered;
    const runId = this.ensureRun(ticket);
    let turn = await this.roleTurn({ ticket, role: 'planner', purpose: 'plan', route, prompt, spanName: 'plan', attempt: 1, runId, preparedCwd: prep.cwd });
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
    const stored = this.storePlan(ticket, action.value, { spanId: turn.spanId });
    await this.closeSession(turn.sessionId);
    // KAN-30: a plan that declares sandbox grants never reaches Build on its
    // own — the human approving the plan is the one-time grant. A plan without
    // grants takes the exact path it always took.
    if (stored.grantCount > 0) {
      this.parkPlanReady(ticket, stored);
      return { kind: 'wait' };
    }
    const next = this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: 'plan submitted' });
    return { kind: next.column === 'working' ? 'continue' : 'wait' };
  }

  /**
   * Store one submitted plan — conditions plus the plan artifact — and report
   * what it declares. Every plan path (the planner turn, the approval
   * follow-up, the human's manual submission) funnels through here so the
   * grant bookkeeping cannot drift between them. The artifact carries the
   * validated `sandbox` section verbatim, which is what makes a new plan
   * version supersede the old grants without any schema change.
   */
  storePlan(ticket, value, { spanId = null, phaseFrom = 'plan', phaseTo = 'implement', payload = {} } = {}) {
    const plan = normalizePlan(value);
    const version = this.store.currentPlanVersion(ticket.id) + 1;
    this.store.replaceConditions(ticket.id, version, plan.conditions, 'plan');
    this.store.addArtifact(ticket.id, 'plan', JSON.stringify({ ...plan, planVersion: version }, null, 2), { spanId });
    const grantCount = countGrants(plan.sandbox);
    this.appendEvent(ticket.id, 'planned', {
      phaseFrom,
      phaseTo: grantCount > 0 ? phaseFrom : phaseTo,
      payload: { planVersion: version, grants: grantCount, ...payload },
    });
    return { plan, version, grantCount };
  }

  /**
   * KAN-30: park a plan-phase ticket on the Plan-ready reason. The board shows
   * the grants and the Approve-plan action; the engine does nothing further
   * until a human lifts the park (approvePlan) or replaces the plan.
   */
  parkPlanReady(ticket, stored) {
    this.appendEvent(ticket.id, 'plan_ready', {
      phaseFrom: ticket.phase,
      phaseTo: ticket.phase,
      payload: {
        planVersion: stored.version,
        grantCount: stored.grantCount,
        grants: stored.plan.sandbox?.grants ?? null,
      },
    });
    return this.store.setNeedsAttention(ticket.id, planReadyReason(stored.grantCount), {
      planVersion: stored.version,
      grantCount: stored.grantCount,
    });
  }

  /**
   * KAN-30: the one-time human approval of a plan that declared sandbox
   * grants. Lifting the park is what makes the grants live — from here the
   * build session's grant approver answers covered escalation asks in place of
   * the human. A ticket not parked on the Plan-ready reason is a bad request:
   * this action must never double as a generic retry.
   */
  async approvePlan(ticketId, message = '') {
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${ticketId}`);
    if (TERMINAL_COLUMNS.includes(ticket.column)) throw new StoreError('bad_request', 'ticket is closed');
    if (!isPlanReady(ticket.needsAttentionReason)) throw new StoreError('bad_request', 'ticket is not awaiting plan approval');
    const planRow = this.store.latestArtifact(ticketId, 'plan');
    const plan = planRow === undefined ? null : safeJson(planRow.content);
    const grantCount = countGrants(plan?.sandbox);
    this.store.clearNeedsAttention(ticketId, { actor: 'human', reason: 'plan approved' });
    this.appendEvent(ticketId, 'plan_approved', {
      phaseFrom: ticket.phase,
      phaseTo: 'implement',
      actor: 'human',
      payload: { planVersion: plan?.planVersion ?? null, grantCount, message },
    });
    return this.store.transitionTicket(ticketId, { phase: 'implement' }, { actor: 'human', reason: 'plan approved' });
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
    if (attempt > config.maxAttempts) {
      return this.needsAttention(ticket, `attempt budget exhausted (${config.maxAttempts}) — a human Retry with instruction grants a fresh budget`);
    }
    const route = this.resolveRoute('implementer', attempt);
    const admission = this.admit(ticket, route, 'implementer', { attempt });
    if (!admission.ok) return this.hold(ticket, admission);
    const prompts = this.getPrompts();
    const conditions = this.store.listConditions(ticket.id);
    const acceptance = this.store.listAcceptance(ticket.id);
    const planArtifact = this.store.latestArtifact(ticket.id, 'plan');
    const planValue = planArtifact === undefined ? null : safeJson(planArtifact.content);
    const reviewArtifact = this.store.latestArtifact(ticket.id, 'review');
    const rework = reviewArtifact === undefined ? null : safeJson(reviewArtifact.content);
    // KAN-31: a rework round is only worth an attempt if there is something new
    // to review. The signature records the tree this rework round started from;
    // if the tree a later rework round starts from is that same tree, the round
    // in between changed nothing and would only repeat itself, so park instead
    // of spending the attempt on a copy of the last one.
    if (rework !== null) {
      const held = this.reworkSignature(ticket);
      const now = await this.workingTreeHash(ticket);
      if (held !== null && now !== null && now === held.diffHash) {
        const ids = held.failingIds.length > 0 ? held.failingIds.join(', ') : 'the conditions the last review named';
        return this.needsAttention(ticket, `no progress: the working tree is unchanged since the round that last failed ${ids}`, {
          noProgress: true,
          failingIds: held.failingIds,
        });
      }
      if (now !== null) this.saveReworkSignature(ticket, now, reworkFailingIds(rework));
    }
    this.store.setAttempt(ticket.id, attempt, route.rung);
    const prompt = render(prompts.bodies[rework === null ? 'implement' : 'rework'], {
      key: ticket.key,
      title: ticket.title,
      cwd: ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd(),
      acceptance: acceptanceBlock(acceptance),
      plan: planArtifact === undefined ? '(no plan)' : planArtifact.content,
      done_when: doneWhenBlock(conditions),
      review: rework === null ? '' : JSON.stringify(rework, null, 2),
      review_line: reworkLine(rework),
      release_scope: releaseScopeLine(planValue),
      question_note: questionNote(ticket, 'kanban_submit_implementation'),
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

  /**
   * Decide what a submitted review means, in code, before any attempt is spent.
   *
   * Three routes out of a pass. Substantive gaps — a condition the plan can hold
   * the build to that is unmet, under-confident or unevidenced — go back to
   * implementation, as they always did. Cosmetic gaps — a missing, duplicated or
   * invented id, a malformed coverage row, an uncovered statement — are a defect
   * in the *review*, so they go back to the reviewer, not to the builder. And a
   * pass whose only open conditions are deferred ones is a clean pass: the
   * deferred ids ride into the approval prompt with it.
   *
   * A fail verdict gets the same reading: a reviewer that marks every non-deferred
   * condition met and only the deferred ones unmet is describing a pass, and gets
   * the pass's routing.
   */
  reviewDecision(value, conditions, acceptance, threshold) {
    const { gaps, deferred } = verifyReview(value, conditions, acceptance, threshold);
    const { substantive, cosmetic } = classifyGaps(gaps);
    const failing = new Set(gapConditionIds(substantive));
    if (value.verdict === 'pass') {
      if (substantive.length > 0) return { route: 'implement', gaps, substantive, cosmetic, deferred, failingIds: [...failing] };
      if (cosmetic.length > 0) return { route: 'cosmetic', gaps, substantive, cosmetic, deferred, failingIds: [...failing] };
      return { route: 'approval', gaps, substantive, cosmetic, deferred, failingIds: [] };
    }
    for (const row of Array.isArray(value.done_when) ? value.done_when : []) {
      if (row !== null && typeof row === 'object' && row.met !== true && row.id !== undefined) failing.add(String(row.id));
    }
    // A fail that leaves only deferred conditions open is describing a pass — but
    // only if it actually proved the build's own conditions. `met: true` for every
    // non-deferred id is that proof. A missing row is not: the tool lets a fail
    // omit rows it already bounced, so absence is bookkeeping, never evidence.
    // Such a review goes back to the reviewer (one retry, then a park) rather than
    // approving a ticket nobody checked or burning a build round on the reviewer's
    // own omission.
    if (substantive.length === 0 && deferred.length > 0) {
      const proven = nonDeferredProven(value, conditions);
      if (proven.ok) return { route: 'approval', gaps, substantive, cosmetic, deferred, failingIds: [] };
      const unproven = proven.unproven.map((id) => `done_when.${id} is not proven met by the review`);
      return {
        route: 'cosmetic',
        gaps: [...gaps, ...unproven],
        substantive,
        cosmetic: [...cosmetic, ...unproven],
        deferred,
        failingIds: [],
      };
    }
    return { route: 'implement', gaps, substantive, cosmetic, deferred, failingIds: [...failing] };
  }

  /**
   * Send a review back to implementation and record why. A pass the code gate
   * rejects records its gaps, as it always did; a plain `fail` records nothing
   * extra — its instruction is the feedback, and inventing a gap list for a
   * reviewer that was allowed to omit rows would only put noise on the timeline.
   */
  reviewToImplement(ticket, { gaps, substantive }, feedback, spanId, verdict) {
    this.store.addArtifact(ticket.id, 'review_feedback', feedback, { spanId });
    if (verdict === 'pass') {
      this.appendEvent(ticket.id, 'review_rejected', {
        phaseFrom: 'review',
        phaseTo: 'implement',
        payload: { gaps, substantive },
      });
    }
    this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'engine', reason: feedback });
    return { kind: 'continue' };
  }

  /**
   * KAN-31: the one retry a cosmetic review gets, in the session that wrote it.
   * The message is the exact gap text plus the two lists the gate checks against,
   * so the reviewer has nothing to guess.
   */
  reviewRetryPrompt(conditions, acceptance, cosmetic, verdict = 'pass') {
    const opening = verdict === 'pass'
      ? 'Your review passed, but it cannot be code-verified. The gaps are in the review submission itself, not in the work.'
      : 'Your review failed, but it cannot be code-verified as submitted. The gaps below are in your own answer, not in the work: you left a condition the build is responsible for unproven, so the engine can neither send the build back on it nor treat the review as complete.'
    return [
      opening + ' Do not change any file, and do not send the build away to fix what only your answer can fix.',
      '',
      ...cosmetic.map((gap) => `- ${gap}`),
      '',
      `The plan's condition ids are exactly: ${conditions.map((c) => `\`${c.id}\``).join(', ') || '(none — submit an empty done_when array)'}.`,
      `The stored acceptance statements are: ${acceptance.length === 0 ? 'none — submit an empty acceptance_coverage array' : acceptance.map((a) => `"${a.statement}"`).join(', ')}.`,
      'Report deferred conditions with `met: false` and evidence naming what the human checks at approval; if the only unmet conditions are deferred, the verdict is pass.',
      '',
      'Call kanban_submit_review again with the complete corrected object.',
    ].join('\n');
  }

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
      question_note: questionNote(ticket, 'kanban_submit_review'),
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
    const decision = this.reviewDecision(value, this.store.listConditions(ticket.id), acceptance, config.confidenceThreshold);
    if (decision.route === 'implement') {
      const feedback = value.verdict === 'pass'
        ? `Review cannot be code-verified: ${decision.gaps.join('; ')}`
        : (typeof value.instruction === 'string' && value.instruction.trim() !== '' ? value.instruction : (value.reasons ?? []).join('; '));
      return this.reviewToImplement(ticket, decision, feedback, turn.spanId, value.verdict);
    }
    if (decision.route === 'approval') {
      await this.enterApproval(ticket, turn.sessionId, { deferred: decision.deferred });
      return { kind: 'wait' };
    }
    // Cosmetic only: one retry in the same session. No implement transition, so
    // no attempt is spent, and a reviewer that fixes its own answer continues
    // from here exactly as if it had been right the first time.
    this.appendEvent(ticket.id, 'review_retry', { phaseFrom: 'review', phaseTo: 'review', payload: { gaps: decision.cosmetic } });
    const retryPrompt = this.reviewRetryPrompt(conditions, acceptance, decision.cosmetic, value.verdict);
    let retry = await this.roleTurn({ ticket, role: 'reviewer', purpose: 'build', route, prompt: retryPrompt, spanName: 'review-retry', attempt: ticket.attemptCount, runId });
    if (retry.kind !== 'ok') retry = (await this.autoRecover(ticket, retry, 'review')) ?? retry;
    if (retry.kind !== 'ok') return this.failedTurn(ticket, retry, 'review');
    if (retry.action === null || retry.action.type !== 'review') {
      return this.needsAttention(ticket, `Review cannot be code-verified: ${decision.cosmetic.join('; ')} — the retry ended without calling kanban_submit_review`);
    }
    const second = retry.action.value;
    this.store.addArtifact(ticket.id, 'review', JSON.stringify(second, null, 2), { spanId: retry.spanId });
    const again = this.reviewDecision(second, this.store.listConditions(ticket.id), acceptance, config.confidenceThreshold);
    if (again.route === 'implement') {
      const feedback = second.verdict === 'pass'
        ? `Review cannot be code-verified: ${again.gaps.join('; ')}`
        : (typeof second.instruction === 'string' && second.instruction.trim() !== '' ? second.instruction : (second.reasons ?? []).join('; '));
      return this.reviewToImplement(ticket, again, feedback, retry.spanId, second.verdict);
    }
    if (again.route === 'approval') {
      await this.enterApproval(ticket, retry.sessionId, { deferred: again.deferred });
      return { kind: 'wait' };
    }
    // Still cosmetic after its one retry: the reviewer cannot complete its own
    // submission. Park with the exact text — the work was never in question, so
    // the human gets the gap list, not a failed build round.
    const reason = `Review cannot be code-verified: ${again.cosmetic.join('; ')} — the reviewer was asked once to fix its own submission and could not`;
    this.store.addArtifact(ticket.id, 'review_feedback', reason, { spanId: retry.spanId });
    this.appendEvent(ticket.id, 'review_rejected', { phaseFrom: 'review', phaseTo: 'review', payload: { gaps: again.cosmetic, cosmetic: true, retry: true } });
    return this.needsAttention(ticket, reason, { cosmeticGaps: again.cosmetic });
  }

  // --------------------------------------------------------------- approval
  //
  // Approval is a phase of the build session, not a session of its own. The
  // session that just passed review keeps its workspace, its history and its
  // tools; only its phase role flips to `approver` — which is what arms
  // kanban_approve / kanban_discard / kanban_submit_plan — and its route flips to
  // the configured approver route. One slim prompt asks the agent to hand the
  // work over to the human, and the ticket then parks for them.

  async enterApproval(ticket, sessionId, { deferred = [] } = {}) {
    const current = this.store.transitionTicket(ticket.id, { phase: 'verify' }, { actor: 'engine', reason: 'review passed; awaiting approval' });
    const deferredIds = Array.isArray(deferred) ? deferred : [];
    this.appendEvent(current.id, 'approval_requested', {
      phaseFrom: 'review',
      phaseTo: 'verify',
      payload: { attempt: current.attemptCount, ...(deferredIds.length > 0 ? { deferred: deferredIds } : {}) },
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
      // Empty for every ticket with nothing deferred, which keeps the hand-over
      // byte-identical to the one this plugin has always sent.
      deferred: deferredBlock(deferredIds, this.store.listConditions(current.id)),
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
    const stored = this.storePlan(ticket, value, { phaseFrom: 'verify', payload: { fromApproval: true } });
    const sessionId = this.driver.liveTicketSession(ticket.id, 'build');
    if (sessionId !== undefined) await this.closeSession(sessionId);
    // KAN-30: a follow-up plan that re-declares grants re-parks the ticket on
    // the Plan-ready reason — the old approval is not consent to new grants.
    // Without grants the follow-up takes over the ticket exactly where it stood.
    if (stored.grantCount > 0) {
      return this.parkPlanReady(this.store.getTicket(ticket.id), stored);
    }
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
      const stored = this.storePlan(ticket, action.value, { payload: { manual: true } });
      await this.closeSession(sessionId);
      // KAN-30: a manual plan submission with grants parks on Plan-ready like
      // any other — the human who submits it still approves its grants as a
      // separate, explicit act. Without grants it moves as before.
      if (stored.grantCount > 0) {
        this.parkPlanReady(this.store.getTicket(ticket.id), stored);
        return;
      }
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
      // KAN-31: the same code gate and the same three-way routing the engine's
      // own review uses. A human-submitted review gets no retry turn — there is
      // no reviewer to send back to — so a cosmetic gap parks with its text
      // instead of spending an implement attempt on it.
      const decision = this.reviewDecision(value, this.store.listConditions(ticket.id), this.store.listAcceptance(ticket.id), this.getConfig().confidenceThreshold);
      if (decision.route === 'approval') {
        await this.enterApproval(ticket, sessionId, { deferred: decision.deferred });
        return;
      }
      if (decision.route === 'cosmetic') {
        const reason = `Review cannot be code-verified: ${decision.cosmetic.join('; ')}`;
        this.store.addArtifact(ticket.id, 'review_feedback', reason);
        this.appendEvent(ticket.id, 'review_rejected', { phaseFrom: 'review', phaseTo: 'review', payload: { gaps: decision.cosmetic, cosmetic: true, manual: true } });
        this.needsAttention(ticket, reason, { cosmeticGaps: decision.cosmetic, manual: true });
        return;
      }
      if (value.verdict !== 'pass') {
        const instruction = typeof value.instruction === 'string' && value.instruction.trim() !== '' ? value.instruction : (value.reasons ?? []).join('; ');
        this.store.addArtifact(ticket.id, 'review_feedback', instruction);
        this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'human', reason: `manual review requested changes: ${instruction}` });
        return;
      }
      const feedback = `Review cannot be code-verified: ${decision.gaps.join('; ')}`;
      this.store.addArtifact(ticket.id, 'review_feedback', feedback);
      this.appendEvent(ticket.id, 'review_rejected', { phaseFrom: 'review', phaseTo: 'implement', payload: { gaps: decision.gaps, manual: true } });
      this.store.transitionTicket(ticket.id, { phase: 'implement' }, { actor: 'human', reason: feedback });
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

  async roleTurn({ ticket, role, purpose, route, prompt, spanName, attempt, runId, preparedCwd }) {
    const promptHash = shortHash(hashText(prompt));
    const span = this.startRoleSpan({ ticket, role, route, spanName, attempt, runId, promptHash });
    // Everything a later auto-recovery needs to record its continuation turns
    // the same way, carried on the result instead of re-derived by the caller.
    const context = { role, route, attempt, runId, spanName };
    const startedMono = process.hrtime.bigint();
    try {
      const session = await this.driver.ensureTicketSession({ ticket, role, route, purpose, preparedCwd });
      this.driver.setPhase(session.sessionId, role);
      this.driver.setRoute(session.sessionId, route);
      this.store.attachSession({
        ticketId: ticket.id,
        dshSessionId: session.sessionId,
        role: purpose,
        purpose,
        // The preset the driver actually mounted (KAN-15): the ticket's choice
        // for a build session, 'standard' for plan and verify.
        preset: session.preset ?? 'standard',
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

  /**
   * KAN-31: the fingerprint of the working tree a rework round starts from —
   * exactly the git inputs `diff` reads (tracked diff, status, untracked list),
   * hashed instead of rendered. Null when git cannot answer, because an
   * unreadable tree must never be the reason a round is called no-progress.
   */
  async workingTreeHash(ticket) {
    const config = this.getConfig();
    const cwd = ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd();
    try {
      const [status, diff, head] = await Promise.all([
        execFileAsync('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 10_000, maxBuffer: 100_000 }),
        execFileAsync('git', ['-C', cwd, 'diff', 'HEAD'], { timeout: 10_000, maxBuffer: MAX_DIFF_BYTES }),
        // HEAD is part of the fingerprint because `diff HEAD` is relative to it:
        // a round that committed its work leaves a clean tree and would otherwise
        // look exactly like a round that did nothing.
        execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 10_000, maxBuffer: 1000 }),
      ]);
      const untracked = status.stdout
        .split('\n')
        .filter((line) => line.startsWith('??'))
        .map((line) => line.slice(3))
        .slice(0, 50);
      return hashText(`${head.stdout}\n${status.stdout}\n${untracked.join('\n')}\n${diff.stdout}`);
    } catch {
      return null;
    }
  }

  /** The last recorded rework signature, or null when there is none to honour. */
  reworkSignature(ticket) {
    const row = this.store.latestArtifact(ticket.id, 'rework_signature');
    const value = row === undefined ? null : safeJson(row.content);
    if (value === null || typeof value.diffHash !== 'string' || value.diffHash === '') return null;
    return { diffHash: value.diffHash, failingIds: Array.isArray(value.failingIds) ? value.failingIds.map(String) : [] };
  }

  /** Record the tree this rework round starts from and what it has to fix. */
  saveReworkSignature(ticket, diffHash, failingIds) {
    this.store.addArtifact(ticket.id, 'rework_signature', JSON.stringify({ diffHash, failingIds }, null, 2));
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
