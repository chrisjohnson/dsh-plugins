// dsh-kanban: the workflow engine.
//
// Code decides. This file owns every transition: flat plan session, the
// implement <-> review -> approval session, code-gated approval, retries,
// human attention, and session teardown. Agents return structured data through
// tools; no phase result is parsed out of assistant prose.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { providerPolicy, routeForAttempt } from './config.mjs';
import { StoreError } from './store.mjs';
import { TERMINAL_COLUMNS, canMarkDone, canRerunReview } from './lifecycle.mjs';
import { refsFromBody, resolveAttachments } from './images.mjs';
import { hashText, render, shortHash } from './prompts.mjs';
import { cloneNames, resolveLiveCheckouts } from './guard.mjs';
import { archiveSkipReason, archivesColumn, copyIsGone } from './archive.mjs';
import { conditionsMarkdown, implementResultMarkdown, planMarkdown, reviewMarkdown, submissionContract } from './render.mjs';
import { normalizePlan, validatePlan, verifyReview, classifyGaps, nonDeferredProven } from './result.mjs';
import { countGrants, isPlanReady, planReadyReason } from './grants.mjs';
import { estimateTurnCost, priceUsage } from './usage.mjs';
import { endedOnQuestion, questionParkReason, recoverySummary, restartResumeAllowed } from './recovery.mjs';

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
 * The sentence naming the clones this ticket's build may cut, so the cross-ticket
 * guard and the prompt agree on one convention. Empty when the key carries no number.
 */
function cloneNamesLine(ticket) {
  const names = cloneNames(ticket.key);
  if (names === null) return '';
  return `Clone naming: if the work needs its own checkout of the plugins or deploy repository, create it under the worktrees directory as \`${names.plugins}\` and \`${names.deploy}\`. Never read or write another open ticket's workspace, worktree or clone (any path segment named \`kan<number>\` or \`kan<number>-<name>\` for another ticket), and never write to the live production checkout.`;
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
    /** ticketId -> { phase, sessionId } for a session a restart interrupted and the engine resumes on its own */
    this.resumeMarks = new Map();
    /** in-flight post-close archive steps, so a test (or stop) can wait for them */
    this.postCloseTasks = new Set();
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
      // At the cap nothing can launch, so the store is not asked at all; below
      // it, only the tickets that could actually launch are read.
      if (this.active.size < config.wipCap) {
        for (const ticket of this.store.listRunnable()) {
          if (this.disposed || this.active.size >= config.wipCap) break;
          if (this.active.has(ticket.id)) continue;
          if (this.busy(ticket)) continue;
          this.launch(ticket);
        }
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
      if (session.ticketId === null || session.ticketId === undefined) continue;
      const list = openTickets.get(session.ticketId) ?? [];
      list.push(session);
      openTickets.set(session.ticketId, list);
    }
    for (const [ticketId, sessions] of openTickets) {
      const session = sessions[sessions.length - 1];
      await this.driver.closeTicketSessions(ticketId);
      for (const open of sessions) this.store.markSessionClosed(open.sessionId);
      const ticket = this.store.getTicket(ticketId);
      if (ticket === undefined || ticket.column === 'done' || ticket.column === 'discarded') continue;
      const phase = ticket.phase === 'verify' ? 'approval' : ticket.phase;
      // A ticket that was already parked when the service went down keeps the
      // reason it was parked for: the restart interrupted nothing.
      if (ticket.needsAttentionReason) {
        this.appendEvent(ticketId, 'restart_recovered', {
          phaseFrom: ticket.phase,
          phaseTo: ticket.phase,
          payload: { sessionId: session.sessionId, phase, autoResume: false, kept: true, reason: ticket.needsAttentionReason },
        });
        continue;
      }
      // The engine only drives a ticket in Working, or a plan-now ticket planning
      // in Backlog: those were mid-flight. One automatic resume, and only if the
      // previous automatic resume of this ticket got anywhere before another
      // restart arrived.
      const driven = ticket.column === 'working' || (ticket.column === 'backlog' && ticket.phase === 'plan' && ticket.planTiming === 'now');
      const resumable = driven && ['plan', 'implement', 'review', 'verify'].includes(ticket.phase);
      const events = this.store.listEvents(ticketId, { limit: 500 });
      if (resumable && restartResumeAllowed(events)) {
        const reason = `${phase} session was interrupted by a restart; resuming it automatically`;
        this.appendEvent(ticketId, 'restart_recovered', {
          phaseFrom: ticket.phase,
          phaseTo: ticket.phase,
          payload: { sessionId: session.sessionId, phase, autoResume: true, reason },
        });
        this.resumeMarks.set(ticketId, { phase: ticket.phase, sessionId: session.sessionId });
        continue;
      }
      const reason = resumable
        ? `${phase} session was interrupted by a restart again before the automatic resume made progress; open the existing session to continue, or retry`
        : `${phase} session was interrupted by a restart; open the existing session to continue, or retry`;
      this.appendEvent(ticketId, 'restart_recovered', {
        phaseFrom: ticket.phase,
        phaseTo: ticket.phase,
        payload: { sessionId: session.sessionId, phase, autoResume: false, reason },
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
      // Approval is a park, not a loop: the only thing the engine does here on
      // its own is pick up a hand-over a restart cut off.
      if (ticket.phase === 'verify' && this.resumeMarks.has(ticket.id)) await this.resumeApproval(ticket);
      return;
    }
  }

  // ------------------------------------------------------ session continuity
  //
  // A round of work should continue in the conversation that holds it. When the
  // session is live it is simply reused; when it is only on disk (a restart, a
  // park that closed it) the driver reopens it. Only when nothing can be brought
  // back does the engine start cold, and then the first prompt carries a summary
  // of what the lost conversation knew.

  /** The live-or-reopened session of one purpose, or `{ ok: false, reason, none }`. */
  async continuity(ticket, purpose) {
    const live = this.driver.liveTicketSession?.(ticket.id, purpose);
    if (live !== undefined && live !== null) return { ok: true, sessionId: live, via: 'live' };
    if (typeof this.driver.reactivateSession !== 'function') {
      return { ok: false, none: true, reason: 'the driver cannot reopen a session' };
    }
    const result = await this.driver.reactivateSession(ticket.id, purpose);
    if (result.ok) {
      this.appendEvent(ticket.id, 'session_resumed', {
        phaseFrom: ticket.phase,
        phaseTo: ticket.phase,
        payload: { sessionId: result.sessionId, purpose, via: result.via },
      });
    }
    return result;
  }

  /** True when the ticket has earlier build work a fresh session would not know about. */
  hasBuildHistory(ticket) {
    if (this.store.listSessions(ticket.id).some((session) => (session.purpose ?? 'build') === 'build')) return true;
    return this.store.latestArtifact(ticket.id, 'implement_result') !== undefined
      || this.store.latestArtifact(ticket.id, 'review') !== undefined;
  }

  /**
   * The summary a cold build session starts from: attempt history, the last
   * review and whether it passed, what shipped, what is left.
   */
  buildSeed(ticket) {
    const config = this.getConfig();
    const conditions = this.store.listConditions(ticket.id);
    const reviewRow = this.store.latestArtifact(ticket.id, 'review');
    const review = reviewRow === undefined ? null : safeJson(reviewRow.content);
    const implementRow = this.store.latestArtifact(ticket.id, 'implement_result');
    const implementation = implementRow === undefined ? null : safeJson(implementRow.content);
    let passedReview = false;
    let failingIds = [];
    if (review !== null) {
      try {
        const decision = this.reviewDecision(review, conditions, this.store.listAcceptance(ticket.id), config.confidenceThreshold);
        passedReview = decision.route === 'approval';
        failingIds = decision.failingIds;
      } catch {
        passedReview = false;
      }
      // The ticket moved on from this review (a later approval follow-up plan
      // sent it back): a pass that no longer stands is not a pass.
      if (passedReview && ticket.phase === 'implement' && this.store.latestArtifact(ticket.id, 'review_feedback')?.id > reviewRow.id) {
        passedReview = false;
      }
    }
    const events = this.store.listEvents(ticket.id, { limit: 500 });
    return recoverySummary({
      ticket,
      attempts: events.filter((event) => event.kind === 'implemented').length,
      maxAttempts: config.maxAttempts,
      events,
      implementation,
      review,
      passedReview,
      failingIds,
      conditions,
    });
  }

  /**
   * The newest human instruction this role has not been spoken to since. The
   * instruction is written when the human retries; it only reaches a model if a
   * prompt carries it, and a prompt recorded after it already did.
   */
  pendingInstruction(ticket, role) {
    const feedback = this.store.latestArtifact(ticket.id, 'attempt_feedback');
    if (feedback === undefined) return '';
    const last = this.store.latestArtifactIdWithPrefix(ticket.id, `${role}_prompt_`);
    return feedback.id > last ? feedback.content : '';
  }

  /** A prompt plus the optional blocks that follow it, blank-line separated. */
  composePrompt(base, ...extras) {
    return [base, ...extras].filter((part) => typeof part === 'string' && part.trim() !== '').join('\n\n');
  }

  /** True once, when a restart interrupted this phase and the engine is picking it back up. */
  takeResumeMark(ticketId, phase) {
    const mark = this.resumeMarks.get(ticketId);
    if (mark === undefined || mark.phase !== phase) return null;
    this.resumeMarks.delete(ticketId);
    return mark;
  }

  resumePrompt(submitTool, what) {
    return [
      `The service restarted while you were ${what}. Your conversation is intact.`,
      `Continue from where you stopped: check the workspace for what is already done, finish what is left, and end by calling \`${submitTool}\`.`,
      `Ending the turn without calling \`${submitTool}\` parks the ticket for a human.`,
    ].join(' ');
  }

  /** The park for a restart-interrupted session that could not be reopened. */
  resumeFailed(ticket, phaseName, reason) {
    return this.needsAttention(ticket, `${phaseName} session could not be reopened after a restart (${reason}); a human Retry starts a fresh session from a summary of the work so far`, {
      restartRecovery: true,
    });
  }

  // ------------------------------------------------------------------ plan

  /**
   * The full planning prompt a new plan session starts from, with the note that
   * says when the planner is standing on an old commit (it would otherwise plan
   * against code that is not current and nobody would tell it why).
   */
  renderPlanPrompt(ticket, prep = {}) {
    const config = this.getConfig();
    const prompts = this.getPrompts();
    const acceptance = this.store.listAcceptance(ticket.id);
    const promptFile = ticket.planQuestions === 'autonomous' ? 'plan-self' : 'plan-human';
    const rendered = render(prompts.bodies[promptFile] ?? prompts.bodies['plan-human'], {
      ticket_state: ticketStateBlock(ticket, acceptance, attachedImages(this.ctx, ticket.body)),
      acceptance: acceptanceBlock(acceptance),
      key: ticket.key,
      title: ticket.title,
      // The planner has to know what the build session will be standing
      // on to declare the grants it will actually need — the mode it writes
      // under and the root that mode confines it to.
      write_mode: ticket.writeMode ?? 'workspace-write',
      cwd: ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd(),
    });
    return typeof prep.note === 'string' && prep.note !== '' ? `${rendered}\n\n${prep.note}\n` : rendered;
  }

  /**
   * A turn ended without the structured submission its phase needs. If it ended
   * on a question the person has to answer, say so: the ticket parks on the
   * question, with the session to answer it in, instead of on a generic failure.
   */
  endedWithoutSubmission(ticket, turn, phaseName, fallbackReason) {
    const question = endedOnQuestion(turn.finalText);
    if (question === null) return this.needsAttention(ticket, fallbackReason);
    return this.needsAttention(ticket, questionParkReason(phaseName, question), {
      awaitingAnswer: true,
      sessionId: turn.sessionId ?? null,
      phase: phaseName,
    });
  }

  async plan(ticket) {
    if (this.stopped(ticket.id)) return { kind: 'stopped' };
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
    // A restart that interrupted planning resumes the same conversation with a
    // short continuation; if that conversation cannot be reopened the ticket
    // parks with the reason rather than planning blind in a new session.
    let prompt;
    if (this.takeResumeMark(ticket.id, 'plan') !== null) {
      const resumed = await this.continuity(ticket, 'plan');
      if (!resumed.ok) return this.resumeFailed(ticket, 'plan', resumed.reason);
      prompt = this.composePrompt(this.resumePrompt('kanban_submit_plan', 'planning this ticket'), this.pendingInstruction(ticket, 'planner'));
    } else {
      prompt = this.composePrompt(this.renderPlanPrompt(ticket, prep), this.pendingInstruction(ticket, 'planner'));
    }
    const runId = this.ensureRun(ticket);
    let turn = await this.roleTurn({ ticket, role: 'planner', purpose: 'plan', route, prompt, spanName: 'plan', attempt: 1, runId, preparedCwd: prep.cwd });
    if (turn.kind !== 'ok') turn = (await this.autoRecover(ticket, turn, 'plan')) ?? turn;
    if (turn.kind !== 'ok') return this.failedTurn(ticket, turn, 'plan');
    const action = turn.action;
    if (action === null || action.type !== 'plan') {
      return this.endedWithoutSubmission(ticket, turn, 'plan', 'plan session ended without calling kanban_submit_plan');
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
    // A restart that cut the build off resumes it; that is the same attempt
    // continuing, not another one spent.
    const resuming = this.resumeMarks.get(ticket.id)?.phase === 'implement';
    const attempt = resuming ? Math.max(1, ticket.attemptCount) : ticket.attemptCount + 1;
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
      // The guard speaks about conditions: it fires only when the round before
      // failed named ones. A failure that named none (a bookkeeping rejection)
      // gives it nothing to say was not fixed, so the round goes ahead.
      if (held !== null && held.failingIds.length > 0 && now !== null && now === held.diffHash && !resuming) {
        return this.needsAttention(ticket, `no progress: the working tree is unchanged since the round that last failed ${held.failingIds.join(', ')}`, {
          noProgress: true,
          failingIds: held.failingIds,
        });
      }
      if (now !== null) this.saveReworkSignature(ticket, now, this.reworkNamedIds(ticket, rework));
    }
    // Where the round runs: a resumed or still-live session carries its own
    // history; a replacement for a lost one is told what the lost one knew.
    let sessionNote = '';
    let resumePrompt = null;
    if (resuming) {
      this.resumeMarks.delete(ticket.id);
      const resumed = await this.continuity(ticket, 'build');
      if (!resumed.ok) return this.resumeFailed(ticket, 'build', resumed.reason);
      resumePrompt = this.resumePrompt('kanban_submit_implementation', 'working on this ticket');
    } else {
      const continued = await this.continuity(ticket, 'build');
      if (!continued.ok && this.hasBuildHistory(ticket)) sessionNote = this.buildSeed(ticket);
    }
    this.store.setAttempt(ticket.id, attempt, route.rung);
    const rendered = resumePrompt !== null ? resumePrompt : render(prompts.bodies[rework === null ? 'implement' : 'rework'], {
      key: ticket.key,
      title: ticket.title,
      cwd: ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd(),
      ticket_state: ticketStateBlock(ticket, acceptance, attachedImages(this.ctx, ticket.body)),
      acceptance: acceptanceBlock(acceptance),
      plan: planMarkdown(planValue),
      done_when: conditionsMarkdown(conditions, { note: deferredNote }),
      review: rework === null ? '' : reviewMarkdown(rework),
      submission_contract: submissionContract({ conditions, threshold: this.thresholdFor(ticket), rework: rework !== null }),
      clone_names: cloneNamesLine(ticket),
      release_scope: releaseScopeLine(planValue),
      question_note: questionNote(ticket, 'kanban_submit_implementation'),
    });
    const prompt = this.composePrompt(sessionNote, rendered, this.pendingInstruction(ticket, 'implementer'));
    const runId = this.ensureRun(ticket);
    let turn = await this.roleTurn({ ticket, role: 'implementer', purpose: 'build', route, prompt, spanName: 'implement', attempt, runId });
    if (turn.kind !== 'ok') turn = (await this.autoRecover(ticket, turn, 'implement')) ?? turn;
    if (turn.kind !== 'ok') return this.failedTurn(ticket, turn, 'implement');
    if (turn.action === null || turn.action.type !== 'implementation') {
      return this.endedWithoutSubmission(ticket, turn, 'build', 'implementer ended without calling kanban_submit_implementation');
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
    const reviewAttempt = Math.max(1, ticket.attemptCount);
    const route = this.resolveRoute('reviewer', reviewAttempt);
    const admission = this.admit(ticket, route, 'reviewer', { attempt: reviewAttempt });
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
    let prompt;
    let sessionNote = '';
    if (this.takeResumeMark(ticket.id, 'review') !== null) {
      const resumed = await this.continuity(ticket, 'build');
      if (!resumed.ok) return this.resumeFailed(ticket, 'review', resumed.reason);
      prompt = this.resumePrompt('kanban_submit_review', 'reviewing this ticket');
    } else {
      const continued = await this.continuity(ticket, 'build');
      if (!continued.ok && this.hasBuildHistory(ticket)) sessionNote = this.buildSeed(ticket);
      const planArtifact = this.store.latestArtifact(ticket.id, 'plan');
      const planValue = planArtifact === undefined ? null : safeJson(planArtifact.content);
      const implementedArtifact = this.store.latestArtifact(ticket.id, 'implement_result');
      const implemented = implementedArtifact === undefined ? null : safeJson(implementedArtifact.content);
      prompt = render(prompts.bodies.review, {
        key: ticket.key,
        title: ticket.title,
        cwd: ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd(),
        ticket_state: ticketStateBlock(ticket, acceptance, attachedImages(this.ctx, ticket.body)),
        acceptance: acceptanceBlock(acceptance),
        plan: planMarkdown(planValue),
        implementation: implementResultMarkdown(implemented),
        done_when: conditionsMarkdown(conditions, { note: deferredNote }),
        question_note: questionNote(ticket, 'kanban_submit_review'),
      });
    }
    prompt = this.composePrompt(sessionNote, prompt, this.pendingInstruction(ticket, 'reviewer'));
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
    return this.approvalTurn(current, route, prompt);
  }

  /**
   * Pick a hand-over back up after a restart cut it off. The conversation is
   * reopened and asked again for the same hand-over; if it cannot be reopened
   * the ticket parks with the reason (the approval park is the safe place for it).
   */
  async resumeApproval(ticket) {
    this.resumeMarks.delete(ticket.id);
    const route = this.resolveRoute('approver', ticket.attemptCount);
    const resumed = await this.continuity(ticket, 'build');
    if (!resumed.ok) {
      this.resumeFailed(ticket, 'approval', resumed.reason);
      return { kind: 'wait' };
    }
    if (route.provider === null || route.model === null) {
      this.store.setNeedsAttention(ticket.id, 'Awaiting human approval');
      return { kind: 'wait' };
    }
    if (this.driver.isLive?.(resumed.sessionId) === true) {
      this.driver.setPhase(resumed.sessionId, 'approver');
      this.driver.setRoute(resumed.sessionId, route);
    }
    const reviewRow = this.store.latestArtifact(ticket.id, 'review');
    const review = reviewRow === undefined ? null : safeJson(reviewRow.content);
    let deferred = [];
    if (review !== null) {
      try {
        deferred = this.reviewDecision(review, this.store.listConditions(ticket.id), this.store.listAcceptance(ticket.id), this.getConfig().confidenceThreshold).deferred;
      } catch {
        deferred = [];
      }
    }
    const prompt = this.composePrompt(
      'The service restarted while you were handing this work over. Your conversation is intact; give the hand-over again.',
      render(this.getPrompts().bodies.approval, {
        key: ticket.key,
        title: ticket.title,
        deferred: deferredBlock(deferred, this.store.listConditions(ticket.id)),
      }),
    );
    return this.approvalTurn(ticket, route, prompt);
  }

  /** The approval turn itself: send the hand-over, then park for the human unless the agent already closed the ticket. */
  async approvalTurn(current, route, prompt) {
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
    this.postClose(done);
    return done;
  }

  async discard(ticketId, reason = '') {
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${ticketId}`);
    await this.closeTicketSessions(ticket.id);
    const discarded = this.store.transitionTicket(ticket.id, { column: 'discarded', phase: 'closed' }, { actor: 'human', reason: reason || 'discarded' });
    this.endRun(ticket.id);
    this.appendEvent(ticket.id, 'discarded', { phaseFrom: ticket.phase, phaseTo: 'closed', actor: 'human', payload: { reason } });
    this.postClose(discarded);
    return discarded;
  }

  /**
   * After a ticket closes: clear its managed worktree and archive its sessions,
   * when `archiveWorkspaceOnClose` asks for it. Fire-and-forget by design — it
   * runs after the close has committed and can never fail or delay it; every
   * outcome, including a failure, is a log line and a ticket event.
   */
  postClose(ticket) {
    let task;
    try {
      task = Promise.resolve(this.archiveClosedWorkspace(ticket))
        .catch((error) => this.recordArchive(ticket, 'workspace_archive_skipped', { reason: 'error', detail: errorText(error) }))
        .finally(() => this.postCloseTasks.delete(task));
    } catch (error) {
      this.log.warn('ticket %s workspace archive failed to start: %s', ticket?.key, errorText(error));
      return;
    }
    this.postCloseTasks.add(task);
  }

  /** Resolve once every post-close archive step started so far has finished. */
  async settlePostClose() {
    while (this.postCloseTasks.size > 0) await Promise.allSettled([...this.postCloseTasks]);
  }

  recordArchive(ticket, kind, payload) {
    try {
      this.log.info('ticket %s %s: %s', ticket.key, kind, JSON.stringify(payload));
      this.appendEvent(ticket.id, kind, { phaseFrom: 'closed', phaseTo: 'closed', actor: 'engine', payload });
    } catch (error) {
      this.log.warn('ticket %s could not record %s: %s', ticket.key, kind, errorText(error));
    }
  }

  async archiveClosedWorkspace(closed) {
    const config = this.getConfig();
    if (!archivesColumn(config.archiveWorkspaceOnClose, closed.column)) return;
    const ticket = this.store.getTicket(closed.id) ?? closed;
    if (!archivesColumn(config.archiveWorkspaceOnClose, ticket.column)) return;
    const skip = archiveSkipReason({
      ticket,
      tickets: this.store.listTickets(),
      openSessions: this.store.listOpenSessions(),
      liveCheckouts: resolveLiveCheckouts(config),
    });
    if (skip !== null) {
      if (!skip.silent) this.recordArchive(ticket, 'workspace_archive_skipped', { reason: skip.reason, detail: skip.detail ?? null, path: ticket.workspaceCwd });
      return;
    }
    const alreadyDone = this.store.listEvents(ticket.id, { limit: 50 }).some((event) => event.kind === 'workspace_archived');
    if (alreadyDone) return;
    const path = ticket.workspaceCwd;

    // The worktree service is looked up now: plugin mount order is not fixed, and
    // a deployment without it (or on an older release) simply keeps its copies.
    let service;
    try {
      service = this.ctx.get('betterGitWorktree');
    } catch {
      service = undefined;
    }
    if (typeof service?.removeForPath !== 'function') {
      this.recordArchive(ticket, 'workspace_archive_skipped', { reason: 'worktree_service_unavailable', path });
      return;
    }
    const result = await service.removeForPath({ path });
    if (!copyIsGone(result, existsSync(path))) {
      this.recordArchive(ticket, 'workspace_archive_skipped', {
        reason: result?.refused === true ? 'removal_refused' : 'not_removed',
        code: result?.code ?? null,
        detail: result?.reason ?? null,
        path,
      });
      return;
    }

    const sessionIds = [...new Set(this.store.listSessions(ticket.id).map((session) => session.sessionId))];
    const registry = this.ctx.get('workspaceRegistry');
    const archived = [];
    const unknown = [];
    const failed = [];
    for (const sessionId of sessionIds) {
      if (typeof registry?.archiveSession !== 'function') {
        failed.push({ sessionId, error: 'no workspaceRegistry.archiveSession' });
        continue;
      }
      let lastError = null;
      let outcome = 'failed';
      for (let attempt = 0; attempt < 3 && outcome === 'failed'; attempt++) {
        try {
          await registry.archiveSession(sessionId);
          outcome = 'archived';
        } catch (error) {
          lastError = error;
          if (error?.name === 'WorkspaceUnknownSessionError') outcome = 'unknown';
          else await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
      if (outcome === 'archived') archived.push(sessionId);
      else if (outcome === 'unknown') unknown.push(sessionId);
      else failed.push({ sessionId, error: errorText(lastError) });
    }
    this.recordArchive(ticket, 'workspace_archived', {
      path,
      removed: result.removed === true,
      sessionsArchived: archived.length,
      sessionsUnknown: unknown.length,
      sessionsFailed: failed,
    });
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

  // --------------------------------------------------- human recovery actions

  /**
   * A human retry is a fresh budget, not one more round of a budget the engine
   * already spent. Without this the counter only ever climbs, so the second park
   * after an exhausted run says "retry grants a fresh budget" while the code
   * would refuse the very next attempt. Both retry endpoints share this one path
   * so the reset cannot be forgotten by one of them.
   *
   * The instruction is recorded as an artifact and reaches the next prompt of
   * the role that resumes (see `pendingInstruction`); the session that holds
   * the earlier work is reopened by that prompt's turn, or replaced by one that
   * starts from a summary of it.
   */
  retry(ticket, { instruction, patch } = {}) {
    if (typeof instruction === 'string' && instruction.trim() !== '') {
      this.store.addArtifact(ticket.id, 'attempt_feedback', `Human instruction for the next attempt:\n${instruction}`);
    }
    if (patch !== undefined && patch !== null && typeof patch === 'object') {
      this.store.updateTicket(ticket.id, patch, { actor: 'human', reason: 'needs_attention resolution' });
    }
    const resumePhase = this.retryPhase(ticket);
    this.store.setAttempt(ticket.id, 0, 0);
    this.store.appendEvent(ticket.id, 'budget_reset', {
      phaseFrom: ticket.phase,
      phaseTo: resumePhase,
      actor: 'human',
      payload: { from: ticket.attemptCount, to: 0, reason: 'human retry' },
    });
    // A human retry is new input, so the unchanged-tree guard starts over: the
    // tree it remembers was left by a round the human has now responded to.
    if (this.store.latestArtifact(ticket.id, 'rework_signature') !== undefined) {
      this.store.addArtifact(ticket.id, 'rework_signature', JSON.stringify({ diffHash: null, failingIds: [], reset: 'human retry' }, null, 2));
    }
    this.resumeMarks.delete(ticket.id);
    // Retry lifts the park and relaunches the ticket in the column it is in: a
    // Working ticket runs again immediately; a Backlog one waits idle until it is
    // dragged to Working (or plans in place if it is a plan-now ticket back at
    // the plan phase).
    this.store.clearNeedsAttention(ticket.id, { actor: 'human', reason: 'human retry' });
    const updated = this.store.transitionTicket(ticket.id, { phase: resumePhase }, { actor: 'human', reason: 'human retry' });
    void this.tick();
    return updated;
  }

  /**
   * Resume a parked ticket at the review phase: its implement phase has nothing
   * left to do, so the only thing missing is a review of the work that exists.
   * The attempt budget is untouched; nothing is spent until the review sends
   * the work back.
   */
  async rerunReview(ticketId, message = '') {
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${ticketId}`);
    const check = canRerunReview(ticket, { hasConditions: this.store.listConditions(ticketId).length > 0 });
    if (!check.ok) throw new StoreError('bad_request', check.reason);
    if (typeof message === 'string' && message.trim() !== '') {
      this.store.addArtifact(ticket.id, 'attempt_feedback', `Human instruction for the next attempt:\n${message}`);
    }
    this.resumeMarks.delete(ticket.id);
    this.store.clearNeedsAttention(ticket.id, { actor: 'human', reason: 're-run review' });
    this.appendEvent(ticket.id, 'review_rerun', {
      phaseFrom: ticket.phase,
      phaseTo: 'review',
      actor: 'human',
      payload: { priorReason: ticket.needsAttentionReason, message: typeof message === 'string' ? message : '' },
    });
    const updated = this.store.transitionTicket(ticket.id, { phase: 'review' }, { actor: 'human', reason: 're-run review' });
    void this.tick();
    return updated;
  }

  /**
   * Close a ticket as done when its work was finished outside the engine. Any
   * open ticket qualifies, in any column and any phase, parked or not: the human
   * is stating that the outcome the ticket asked for already exists. The reason
   * is required and recorded, and the done event says the engine did not do it.
   */
  async markDone(ticketId, reason) {
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${ticketId}`);
    const check = canMarkDone(ticket);
    if (!check.ok) throw new StoreError('bad_request', check.reason);
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (why === '') throw new StoreError('bad_request', 'a reason is required to mark a ticket done');
    this.resumeMarks.delete(ticket.id);
    this.reactivations.delete(ticket.id);
    await this.closeTicketSessions(ticket.id);
    const done = this.store.transitionTicket(ticket.id, { column: 'done', phase: 'closed' }, { actor: 'human', reason: why, outsideEngine: true });
    this.endRun(ticket.id);
    this.appendEvent(ticket.id, 'done', {
      phaseFrom: ticket.phase,
      phaseTo: 'closed',
      actor: 'human',
      payload: {
        attempt: ticket.attemptCount,
        message: why,
        reason: why,
        outsideEngine: true,
        fromColumn: ticket.column,
        wasParked: Boolean(ticket.needsAttentionReason),
      },
    });
    this.postClose(done);
    return done;
  }

  // ------------------------------------------------------------ revise plan

  /** Why a plan cannot be revised right now, or null when it can. */
  planRevisionBlock(ticket) {
    if (TERMINAL_COLUMNS.includes(ticket.column)) return `ticket is already ${ticket.column}`;
    if (this.active.has(ticket.id) || this.busy(ticket)) return 'a turn is in flight on this ticket';
    if (this.store.latestArtifact(ticket.id, 'plan') === undefined) return 'the ticket has no plan yet';
    if (ticket.phase === 'plan') {
      if (!isPlanReady(ticket.needsAttentionReason)) return 'the plan is still being written';
    } else if (ticket.phase !== 'implement') {
      return `a plan can only be revised before the build starts, not in ${ticket.phase}`;
    }
    if (this.buildStarted(ticket)) return 'the build has already started; a plan can only be revised before then';
    return null;
  }

  /** True once any build work exists for the ticket. */
  buildStarted(ticket) {
    if (this.store.listSessions(ticket.id).some((session) => (session.purpose ?? 'build') === 'build')) return true;
    return this.store.latestArtifact(ticket.id, 'implement_result') !== undefined || ticket.attemptCount > 0;
  }

  /**
   * Ask the plan session for a revised plan. The instruction goes to the same
   * conversation that wrote the plan (reopened if it is only on disk), and its
   * resubmission replaces the plan and done_when as a new plan version through
   * the same path every plan takes, so sandbox grants supersede exactly as they
   * do for any new version. The call returns once the revision is under way;
   * `done` settles when it has been applied or rejected.
   */
  async revisePlan(ticketId, instruction) {
    const ticket = this.store.getTicket(ticketId);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${ticketId}`);
    const text = typeof instruction === 'string' ? instruction.trim() : '';
    if (text === '') throw new StoreError('bad_request', 'an instruction is required to revise the plan');
    const blocked = this.planRevisionBlock(ticket);
    if (blocked !== null) throw new StoreError('bad_request', blocked);
    this.appendEvent(ticket.id, 'plan_revision_requested', {
      phaseFrom: ticket.phase,
      phaseTo: ticket.phase,
      actor: 'human',
      payload: { instruction: text, planVersion: this.store.currentPlanVersion(ticket.id) },
    });
    const done = this.runPlanRevision(ticket, text)
      .catch((error) => {
        this.log.error('ticket %s plan revision failed: %s', ticket.key, error?.stack ?? String(error));
        return this.rejectPlanRevision(ticket, `the revision failed: ${String(error?.message ?? error)}`, text);
      })
      .finally(() => {
        this.active.delete(ticket.id);
        // The revision held the ticket; now that it has let go, whatever the
        // new plan unblocks (a Working ticket's build) starts on this tick.
        void this.tick();
      });
    this.active.set(ticket.id, done);
    return { ticket: this.store.getTicket(ticket.id), done };
  }

  /** Say, on the ticket, that a revision did not take: an event and an artifact the detail view shows. */
  rejectPlanRevision(ticket, reason, instruction) {
    this.appendEvent(ticket.id, 'plan_revision_rejected', {
      phaseFrom: ticket.phase,
      phaseTo: ticket.phase,
      payload: { reason, instruction },
    });
    this.store.addArtifact(ticket.id, 'plan_revision_rejected', reason);
    return { kind: 'rejected', reason };
  }

  async runPlanRevision(ticket, instruction) {
    const route = this.resolveRoute('planner', 1);
    const admission = this.admit(ticket, route, 'planner', { attempt: 1 });
    if (!admission.ok) return this.rejectPlanRevision(ticket, admission.message ?? 'dispatch refused', instruction);
    const planRow = this.store.latestArtifact(ticket.id, 'plan');
    const continued = await this.continuity(ticket, 'plan');
    let prompt;
    if (continued.ok) {
      prompt = [
        'The human asked for a revised plan. Their instruction:',
        '',
        instruction,
        '',
        'Revise the plan you wrote accordingly, re-reading the workspace where the instruction needs it, and call `kanban_submit_plan` with the complete revised plan (summary, steps, done_when, and sandbox / release_scope where they apply). The submission replaces the current plan and its done_when conditions. Do not start building.',
      ].join('\n');
    } else {
      prompt = this.composePrompt(
        this.renderPlanPrompt(ticket),
        `The ticket already has a plan, shown below. The human asked for it to be revised.\n\nCurrent plan:\n${planRow.content}\n\nInstruction:\n${instruction}\n\nCall \`kanban_submit_plan\` with the complete revised plan. It replaces the current plan and its done_when conditions.`,
      );
    }
    const runId = this.ensureRun(ticket);
    let turn = await this.roleTurn({ ticket, role: 'planner', purpose: 'plan', route, prompt, spanName: 'plan-revision', attempt: 1, runId });
    if (turn.kind !== 'ok') turn = (await this.autoRecover(ticket, turn, 'plan')) ?? turn;
    this.endRun(ticket.id);
    if (turn.kind !== 'ok') return this.rejectPlanRevision(ticket, `the plan session's turn failed: ${turn.error ?? 'unknown'}`, instruction);
    const action = turn.action;
    if (action === null || action.type !== 'plan') {
      const question = endedOnQuestion(turn.finalText);
      return this.rejectPlanRevision(
        ticket,
        question === null
          ? 'the plan session ended without resubmitting a plan; the current plan is unchanged'
          : `the plan session asked a question instead of resubmitting a plan (${question}); answer it in the plan session, or send the instruction again`,
        instruction,
      );
    }
    const errors = validatePlan(action.value);
    if (errors.length > 0) return this.rejectPlanRevision(ticket, `the revised plan was rejected: ${errors.join('; ')}; the current plan is unchanged`, instruction);
    if (!Array.isArray(action.value.done_when) || action.value.done_when.length === 0) {
      return this.rejectPlanRevision(ticket, 'the revised plan was rejected: no done_when conditions; the current plan is unchanged', instruction);
    }
    const fresh = this.store.getTicket(ticket.id);
    if (fresh === undefined || TERMINAL_COLUMNS.includes(fresh.column)) return { kind: 'stopped' };
    const stored = this.storePlan(fresh, action.value, {
      spanId: turn.spanId,
      phaseFrom: fresh.phase,
      phaseTo: 'implement',
      payload: { revised: true },
    });
    await this.closeSession(turn.sessionId);
    if (stored.grantCount > 0) {
      // New grants are not covered by any earlier approval: the plan goes back
      // to the human, and the ticket waits for it exactly as a first plan does.
      if (fresh.phase !== 'plan') this.store.transitionTicket(fresh.id, { phase: 'plan' }, { actor: 'engine', reason: 'plan revised with sandbox grants' });
      this.parkPlanReady(this.store.getTicket(fresh.id), stored);
    } else {
      this.store.clearNeedsAttention(fresh.id, { actor: 'engine', reason: 'plan revised' });
      if (fresh.phase !== 'implement') this.store.transitionTicket(fresh.id, { phase: 'implement' }, { actor: 'engine', reason: 'plan revised' });
    }
    return { kind: 'applied', version: stored.version };
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

  /**
   * The condition ids a review named as not done: its unmet rows plus the
   * conditions the code gate found wanting. Empty is honest — a failure that is
   * pure bookkeeping names nothing.
   */
  reworkNamedIds(ticket, rework) {
    const ids = reworkFailingIds(rework);
    try {
      const decision = this.reviewDecision(rework, this.store.listConditions(ticket.id), this.store.listAcceptance(ticket.id), this.getConfig().confidenceThreshold);
      for (const id of decision.failingIds) if (!ids.includes(id)) ids.push(id);
    } catch {
      // A review the gate cannot read names whatever its own rows name.
    }
    return ids;
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
    // A ticket a human closed while a turn was winding down is not parked: the
    // late failure belongs to work that no longer matters.
    const current = this.store.getTicket(ticket.id);
    if (current === undefined || TERMINAL_COLUMNS.includes(current.column)) return { kind: 'stopped' };
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

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
