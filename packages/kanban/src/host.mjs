// dsh-kanban: the Host half.
//
// Owns the SQLite board, the scheduler, the role sessions, the HTTP surface and
// the config lifecycle. Every decision lives in a testable module; this file is
// the wiring: services in, routes out.

import { AsyncLocalStorage } from 'node:async_hooks';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from './config.mjs';
import { applyRoutes, prepareRoutes, staleEffortWarnings } from './routing.mjs';
import { KanbanStore, WRITE_MODES } from './store.mjs';
import { appendAcceptance, editTicket, replaceAcceptance, startedFailure } from './edit.mjs';
import { openDatabase } from './db.mjs';
import { SessionDriver } from './dispatch.mjs';
import { Engine } from './engine.mjs';
import { hashText, loadPrompts, shortHash } from './prompts.mjs';
import { TICKET_COLUMNS, SPAN_COLUMNS, USAGE_COLUMNS, toCsv, toJsonl, usageRows } from './export.mjs';
import { canMarkDone, canRerunReview } from './lifecycle.mjs';
import { attentionFacts } from './attention.mjs';
import { isQuestionPark, planRevisionState } from './recovery.mjs';
import { startPlanning } from './planning.mjs';
import { moveToColumn, startBuild } from './build.mjs';
import { placement } from './ordering.mjs';
import { attemptLabel, closedNewestFirst, jumpSession, phaseSegments, phaseSessions, workingMs } from './board-view.mjs';
import { ALLOWED_MEDIA_TYPES, describeBodyImages, listTokens, prepareBodyImages, readImageFromStore, resolveAttachments } from './images.mjs';

const PLUGIN_NAME = 'dsh-kanban';
const API_BASE = '/api/kanban';
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

const ENDPOINTS = [
  'board',
  'workspaces',
  'ticket',
  'create',
  'update',
  'move',
  'resolve',
  'action',
  'reorder',
  'export',
  'analytics',
  'config',
  'setRoutes',
  'capabilities',
  'worktree',
  'events',
  'sessionInfo',
  'readImage',
];

const message = (error) => (error && error.message ? error.message : String(error));
const fail = (code, text, details = {}) => ({ ok: false, error: { code, message: text, details } });

export default async function kanban(ctx, config = {}) {
  const log = ctx.logger(PLUGIN_NAME);
  const { config: initial, warnings } = resolveConfig(config);
  for (const warning of warnings) log.warn(warning);
  const configHash = shortHash(hashText(JSON.stringify(initial)));

  const dshHome = process.env.DSH_HOME ?? process.env.DSH_HOME_DIR ?? join(homedir(), '.dsh');
  const dbPath = initial.dbPath ?? join(dshHome, 'kanban', 'kanban.db');
  const promptsDir = initial.promptsDir === null ? join(PACKAGE_DIR, 'prompts') : isAbsolute(initial.promptsDir) ? initial.promptsDir : resolve(process.cwd(), initial.promptsDir);

  // Per-run config snapshot: a reload must not change the rules of a run that
  // already started. ALS makes the snapshot flow through every async step
  // without threading a parameter through the engine.
  const als = new AsyncLocalStorage();
  let live = initial;
  let prompts = await loadPrompts(initial, PACKAGE_DIR);
  const getConfig = () => als.getStore() ?? live;
  const getPrompts = () => als.getStore()?.__prompts ?? prompts;

  const llm = ctx.get('llm');
  if (llm === undefined || llm === null) {
    throw new Error('dsh-kanban needs the host LLM service (ctx.llm); every model call routes through it');
  }

  // ---- boot validation: refuse to run a route the host does not offer ------
  await validateRoutes(initial, llm, log);

  const db = openDatabase(dbPath);
  const store = new KanbanStore(db, {
    onEvent: (event) => {
      if (process.env.DSH_KANBAN_DEBUG === '1') log.info('event %s %s', event.kind, event.ticketId ?? '-');
    },
  });

  // The durable image bytes ride in DSH core's content-addressed attachment
  // store; the ticket body only carries `kanban-image:<id>` refs (src/images.mjs).
  // Looked up lazily so a profile without the service still boots and only an
  // actual image write says anything about it.
  const attachments = () => resolveAttachments(ctx);

  const driver = new SessionDriver({
    ctx,
    log,
    getConfig,
    store,
  });
  const engine = new Engine({ ctx, store, driver, getConfig, getPrompts, log });
  engine.configHash = configHash;
  engine.runInConfig = (snapshot, fn) => als.run({ ...snapshot, __prompts: prompts }, fn);

  const engineRef = { current: engine };
  const reloadState = { lastJson: null, timer: null };

  ctx.effect(() => {
    engineRef.current.start();
    return () => engineRef.current.stop();
  }, `${PLUGIN_NAME}: engine`);

  // ---- config reload (atomic, validated, never half-applied) ---------------
  const configEditor = ctx.get('configEditor');
  if (configEditor !== undefined) {
    const tryReload = async () => {
      try {
        const rows = configEditor.configuration();
        const row = rows.find((item) => item.entry?.id === 'kanban');
        if (row === undefined) return;
        const json = JSON.stringify(row.override ?? {});
        if (reloadState.lastJson === null) {
          reloadState.lastJson = json;
          return;
        }
        if (json === reloadState.lastJson) return;
        const next = resolveConfig(row.override ?? {});
        for (const warning of next.warnings) log.warn(warning);
        const nextPrompts = await loadPrompts(next.config, PACKAGE_DIR);
        await validateRoutes(next.config, llm, log);
        live = next.config;
        prompts = nextPrompts;
        engineRef.current.configHash = shortHash(hashText(JSON.stringify(next.config)));
        reloadState.lastJson = json;
        try {
                } catch (error) {
          log.warn('config reload: preset registration failed: %s', message(error));
        }
        log.info('config reloaded atomically (%d key(s))', Object.keys(next.config).length);
      } catch (error) {
        // Keep the previous config; never half-apply an invalid one.
        log.error('config reload rejected, keeping the previous config: %s', message(error));
      }
    };
    const timer = setInterval(() => void tryReload(), 5000);
    if (typeof timer.unref === 'function') timer.unref();
    reloadState.timer = timer;
    ctx.effect(() => () => clearInterval(timer), `${PLUGIN_NAME}: config watch`);
  }

  // ---- HTTP surface --------------------------------------------------------
  ctx.inject(['connection'], (scope) => {
    const connection = scope.connection;
    if (connection === undefined || connection === null) {
      log.error('connection service is missing; the board UI cannot reach the Host');
      return;
    }

    const requireTicket = (id) => {
      const ticket = store.getTicket(id);
      if (ticket === undefined) throw Object.assign(new Error('no such ticket'), { status: 'not_found' });
      return ticket;
    };

    /**
     * A human retry is a fresh budget, not one more round of a budget the engine
     * already spent. Both retry endpoints share the engine's one path so the
     * reset cannot be forgotten by one of them.
     */
    const retryWithFreshBudget = (ticket, { instruction, patch } = {}) =>
      engineRef.current.retry(ticket, { instruction, patch });

    /**
     * The human recovery actions both endpoints accept: close a ticket whose work
     * happened outside the engine, resume a parked one at review, and ask the
     * plan session for a revised plan. Returns undefined for any other action so
     * the caller keeps its own routing.
     */
    const recoveryAction = async (ticket, action, p) => {
      if (action === 'markDone') {
        const updated = await engineRef.current.markDone(ticket.id, typeof p.reason === 'string' ? p.reason : '');
        return { ok: true, value: { ticket: updated } };
      }
      if (action === 'rerunReview') {
        const updated = await engineRef.current.rerunReview(ticket.id, typeof p.instruction === 'string' ? p.instruction : '');
        return { ok: true, value: { ticket: updated } };
      }
      if (action === 'revisePlan') {
        const started = await engineRef.current.revisePlan(ticket.id, typeof p.instruction === 'string' ? p.instruction : '');
        return { ok: true, value: { ticket: started.ticket } };
      }
      return undefined;
    };

    /**
     * True while any session of this ticket is paused mid-turn on an unanswered
     * ask_user_question — in any phase, on an engine- or a human-driven turn
     * (KAN-17 generalized what used to be a plan-phase-only waiter scan).
     */
    const isAwaitingUser = (ticket) => driver.isAwaitingQuestion(ticket.id);

    /** True while any session of this ticket sits on an unanswered approval prompt (KAN-17). */
    const isAwaitingApproval = (ticket) => driver.isAwaitingApproval(ticket.id);

    /** The card-level visual status: attention | active | idle. Never a column. */
    const statusOf = (ticket) => attentionFacts(ticket, { engine, driver }).status;

    /** The facts a card shows that no ticket column holds: phase path, working time, attempt wording, jump target. */
    const derived = (ticket, telemetry, now) => {
      const facts = telemetry ?? { transitions: [], events: [], spans: [], sessions: [] };
      const closedAt = ticket.closedAt === null || ticket.closedAt === undefined ? null : Date.parse(ticket.closedAt);
      return {
        attemptLabel: attemptLabel(ticket.attemptCount),
        segments: phaseSegments({ transitions: facts.transitions, phase: ticket.phase, column: ticket.column }),
        workingMs: workingMs({ spans: facts.spans, events: facts.events, now, endAt: Number.isFinite(closedAt) ? closedAt : null }),
        sessionId: jumpSession(facts.sessions, driver.activeSessionIds(ticket.id)),
      };
    };

    const board = () => {
      const tickets = store.listTickets();
      const telemetry = store.boardTelemetry();
      const now = Date.now();
      const byColumn = { backlog: [], working: [], done: [], discarded: [] };
      for (const ticket of tickets) {
        const item = { ...summary(ticket, store.isEditable(ticket.id)), ...derived(ticket, telemetry.get(ticket.id), now) };
        if (ticket.phase === 'plan') item.planSessionId = driver.liveTicketSession(ticket.id, 'plan') ?? null;
        // A ticket parked because its session ended on a question reads exactly
        // like one whose session is paused inside the question: both are waiting
        // on the person's answer, and the card, chip and next-action say so.
        item.parkedOnQuestion = isQuestionPark(ticket.needsAttentionReason);
        item.awaitingQuestion = isAwaitingUser(ticket) || item.parkedOnQuestion;
        item.awaitingApproval = isAwaitingApproval(ticket);
        item.status = statusOf(ticket);
        // Attention without an engine park is a mid-turn human wait (KAN-17):
        // say which one, so the red card explains itself the way a park does.
        if (item.status === 'attention' && !ticket.needsAttentionReason) {
          item.needsAttentionReason = item.awaitingApproval ? 'Awaiting your approval' : 'Waiting on your answer';
        }
        byColumn[ticket.column]?.push(item);
      }
      return {
        counts: store.counts(),
        columns: byColumn,
        // Done and Discarded share one column on the board, newest closed first.
        closed: closedNewestFirst([...byColumn.done, ...byColumn.discarded]),
      };
    };

    const detail = (id) => {
      const ticket = requireTicket(id);
      const spans = store.listSpans(ticket.id);
      const events = store.listEvents(ticket.id, { limit: 300 });
      const artifacts = store.listArtifacts(ticket.id, { limit: 40 }).map((artifact) => ({
        ...artifact,
        content: store.getArtifact(artifact.id)?.content ?? '',
      }));
      const plan = store.latestArtifact(ticket.id, 'plan');
      const review = store.latestArtifact(ticket.id, 'review');
      const verification = store.latestArtifact(ticket.id, 'verification');
      const awaitingQuestion = isAwaitingUser(ticket);
      const parkedOnQuestion = isQuestionPark(ticket.needsAttentionReason);
      const awaitingApproval = isAwaitingApproval(ticket);
      // KAN-17: the session holding the pending ask, so the detail can open the
      // prompt itself. The verify-phase fallback below stays: a parked approval
      // has no in-flight wait, and its panel still opens the build session.
      const pendingWait = driver.humanWaitSession(ticket.id);
      // `editable` is the lock the client renders: the pencil is dead the moment
      // any engine has touched the ticket (see store.isEditable).
      const editable = store.isEditable(ticket.id);
      return {
        ticket: {
          ...(awaitingQuestion && !ticket.needsAttentionReason
            ? { ...ticket, needsAttentionReason: 'Waiting on your answer' }
            : ticket),
          editable,
          ...derived(ticket, store.boardTelemetry(ticket.id).get(ticket.id), Date.now()),
        },
        // Where each progress step opens: plan -> the latest plan session,
        // implement / review / approval -> the build session.
        phaseSessions: phaseSessions(store.listSessions(ticket.id)),
        // KAN-31: the client used to render "5 / 3" because it had the attempt
        // count and a hard-coded cap. The cap is configuration; the detail payload
        // is where the client can read the one the engine is actually enforcing.
        maxAttempts: getConfig().maxAttempts,
        awaitingQuestion,
        parkedOnQuestion,
        awaitingApproval,
        status: statusOf(ticket),
        // What the human may do right now. The engine owns every rule; the
        // client only draws the buttons these name.
        actions: {
          markDone: canMarkDone(ticket).ok,
          rerunReview: canRerunReview(ticket, { hasConditions: store.listConditions(ticket.id).length > 0 }).ok,
          revisePlan: engine.planRevisionBlock(ticket) === null,
        },
        planRevision: planRevisionState(events),
        // Approval runs inside the build session, so the session the panel opens
        // while a ticket waits is that same one. The field name is the client's
        // contract and stays.
        approvalSessionId: pendingWait?.sessionId
          ?? (ticket.phase === 'verify' ? (driver.liveTicketSession(ticket.id, 'build') ?? null) : null)
          ?? (parkedOnQuestion ? (driver.liveTicketSession(ticket.id, ticket.phase === 'plan' ? 'plan' : 'build') ?? null) : null),
        acceptance: store.listAcceptance(ticket.id),
        conditions: store.listConditions(ticket.id),
        sessions: store.listSessions(ticket.id),
        spans,
        spanTree: tree(spans),
        timeline: timelineView(spans, artifacts, events),
        usage: store.rollup(ticket.id),
        events,
        artifacts,
        // One entry per distinct `kanban-image:` ref in the body, in order;
        // `available: false` means the bytes no longer resolve and the client
        // renders the ref broken rather than hiding the human's reference.
        images: describeBodyImages(attachments(), ticket.body ?? ''),
        plan: plan === undefined ? null : safeJson(plan.content),
        review: review === undefined ? null : safeJson(review.content),
        verification: verification === undefined ? null : safeJson(verification.content),
      };
    };

    const handler = async (endpoint, payload) => {
      try {
        const p = payload !== null && typeof payload === 'object' ? payload : {};
        switch (endpoint) {
          case 'board':
            return { ok: true, value: board() };
          case 'workspaces': {
            const registry = ctx.get('workspaceRegistry');
            const items = registry === undefined || typeof registry.list !== 'function' ? [] : registry.list().map((workspace) => ({
              id: workspace.id,
              path: workspace.path,
              title: workspace.title,
            }));
            return { ok: true, value: { items } };
          }
          case 'ticket':
            return { ok: true, value: detail(String(p.id)) };
          case 'events':
            return { ok: true, value: store.listEvents(String(p.id), { limit: p.limit ?? 300, before: p.before ?? null }) };
          case 'readImage': {
            // Bytes for one body ref, for the detail view's <img> tags. The id
            // is content-addressed and re-digest-verified on the way out
            // (src/images.mjs); `name` is echoed from the request because the
            // display name lives in the body's alt text, not the object store.
            const out = await readImageFromStore(attachments(), String(p.attachmentId ?? ''));
            if (!out.ok) return fail(out.code, out.error);
            const declared = ALLOWED_MEDIA_TYPES.includes(p.mediaType) ? p.mediaType : 'application/octet-stream';
            return {
              ok: true,
              value: {
                base64: out.value.base64,
                mediaType: out.value.mediaType ?? declared,
                name: typeof p.name === 'string' && p.name !== '' ? p.name : null,
                width: out.value.width,
                height: out.value.height,
              },
            };
          }
          case 'sessionInfo': {
            // Read-only projection of the ticket a session belongs to. The chat
            // banner asks "did this turn's kanban_* call actually move the
            // ticket?" and answers it from the board's real state, never from
            // what the tool call claimed. Unknown sessions say so plainly.
            const sessionId = String(p.sessionId ?? '');
            if (sessionId === '') return fail('bad_request', 'sessionId is required');
            const session = store.findSession(sessionId);
            if (session === undefined || session.ticketId === null || session.ticketId === undefined) {
              return fail('not_found', `no kanban ticket is attached to session ${sessionId}`);
            }
            const ticket = store.getTicket(session.ticketId);
            if (ticket === undefined) return fail('not_found', `no such ticket ${session.ticketId}`);
            const planArtifact = store.latestArtifact(ticket.id, 'plan');
            const reviewArtifact = store.latestArtifact(ticket.id, 'review');
            const feedbackArtifact = store.latestArtifact(ticket.id, 'review_feedback');
            return {
              ok: true,
              value: {
                session: { sessionId: session.sessionId, role: session.role, purpose: session.purpose },
                ticket: {
                  id: ticket.id,
                  key: ticket.key,
                  title: ticket.title,
                  column: ticket.column,
                  phase: ticket.phase,
                  planTiming: ticket.planTiming ?? null,
                  needsAttentionReason: ticket.needsAttentionReason ?? null,
                },
                plan: planArtifact === undefined ? null : safeJson(planArtifact.content),
                conditions: store.listConditions(ticket.id),
                review: reviewArtifact === undefined ? null : safeJson(reviewArtifact.content),
                reviewFeedback: feedbackArtifact === undefined ? null : feedbackArtifact.content,
                // Did the LATEST review get sent back? The engine always writes
                // the `review` artifact before the `review_feedback` that rejects
                // it, and artifact ids are AUTOINCREMENT, so a feedback row newer
                // than the review row can only mean that review was rejected. This
                // is the one thing the client cannot infer from content alone: a
                // ticket sitting in `implement` with a passing latest review is
                // either a pass the code check bounced, or a pass that landed and
                // was later returned to implement by an approval follow-up plan —
                // and those two deserve opposite banners.
                reviewRejected: reviewArtifact !== undefined
                  && feedbackArtifact !== undefined
                  && Number(feedbackArtifact.id) > Number(reviewArtifact.id),
                acceptance: store.listAcceptance(ticket.id),
              },
            };
          }
          case 'create': {
            const column = p.column ?? 'backlog';
            if (!['backlog', 'working'].includes(column)) return fail('bad_request', 'column must be backlog or working');
            // KAN-15: the write mode is a closed vocabulary the store also
            // enforces; the preset id can only be checked against the live
            // registry, so the host does it here before a row exists.
            if (p.writeMode !== undefined && p.writeMode !== null && !WRITE_MODES.includes(p.writeMode)) {
              return fail('bad_request', `writeMode must be one of ${WRITE_MODES.join(', ')}`);
            }
            if (p.preset !== undefined && p.preset !== null) {
              const presets = ctx.get('agentPresets');
              if (typeof presets?.resolve !== 'function') return fail('unavailable', 'the agent preset registry is not mounted');
              try {
                await presets.resolve(String(p.preset));
              } catch {
                return fail('unknown_preset', `unknown agent preset: ${p.preset}`);
              }
            }
            // Images first: every pending ref must resolve to a stored attachment
            // before a ticket exists. A failed save creates nothing.
            const { images: uploads, ...fields } = p;
            const prepared = await prepareBodyImages({
              body: typeof fields.body === 'string' ? fields.body : '',
              images: uploads,
              attachments: attachments(),
            });
            if (!prepared.ok) return fail('bad_request', prepared.error);
            const ticket = store.createTicket({ ...fields, body: prepared.body, column });
            appendConfigFingerprint(store, ticket.id);
            void engineRef.current.tick();
            return { ok: true, value: { ticket } };
          }
          case 'update': {
            // The human edit boundary: a ticket any engine has touched is locked
            // (src/edit.mjs). Engine-internal writes go to the store directly.
            const patch = p.patch !== null && typeof p.patch === 'object' ? { ...p.patch } : {};
            const uploads = Array.isArray(p.images) ? p.images : [];
            const current = store.getTicket(String(p.id));
            const draftBody = typeof patch.body === 'string' ? patch.body : (current?.body ?? '');
            // Any body write goes through the ref gate, so a saved body can only
            // ever hold well-formed `kanban-image:` refs; an unresolvable
            // pending token applies no patch at all.
            if (current !== undefined && (uploads.length > 0 || patch.body !== undefined || listTokens(draftBody).length > 0)) {
              if (!store.isEditable(current.id)) return startedFailure(current);
              const prepared = await prepareBodyImages({ body: draftBody, images: uploads, attachments: attachments() });
              if (!prepared.ok) return fail('bad_request', prepared.error);
              if (patch.body !== undefined || prepared.body !== draftBody) patch.body = prepared.body;
            }
            const result = editTicket(store, String(p.id), patch, { reason: p.reason ?? 'ticket edit' });
            if (result.ok) void engineRef.current.tick();
            return result;
          }
          case 'move': {
            const column = String(p.column);
            if (!['backlog', 'working', 'done', 'discarded'].includes(column)) {
              return fail('bad_request', 'column must be backlog, working, done, or discarded');
            }
            if (column === 'done') return fail('bad_request', 'done is set by human approval, not by dragging');
            if (column === 'discarded') {
              const t = store.getTicket(String(p.id));
              if (t === undefined) return fail('not_found', 'no such ticket');
              await engineRef.current.abortTicket(t.id);
            }
            // A column move is an unconditional human statement of intent:
            // into Working starts the engine (any park is cleared by the move),
            // back into Backlog parks it. No WIP guard — the cap only throttles
            // concurrency, queued Working tickets wait their turn.
            const updated = moveToColumn({ store, engine: engineRef.current, id: String(p.id), column, reason: p.reason });
            return { ok: true, value: { ticket: updated } };
          }
          case 'resolve': {
            const ticket = requireTicket(String(p.id));
            if (!ticket.needsAttentionReason) return fail('bad_request', 'ticket is not parked for attention');
            const action = String(p.action ?? 'retry');
            if (action === 'discard') {
              if (ticket.phase === 'verify') {
                const updated = await engineRef.current.discard(ticket.id, typeof p.reason === 'string' ? p.reason : '');
                return { ok: true, value: { ticket: updated } };
              }
              await engineRef.current.abortTicket(ticket.id);
              const updated = store.transitionTicket(ticket.id, { column: 'discarded' }, { actor: 'human', reason: p.reason ?? 'discarded' });
              return { ok: true, value: { ticket: updated } };
            }
            if (action === 'approve') {
              const updated = await engineRef.current.approve(ticket.id, typeof p.message === 'string' ? p.message : '');
              return { ok: true, value: { ticket: updated } };
            }
            // KAN-30: the one-time approval of a plan that declared sandbox
            // grants. The park this action lifts is what kept the build from
            // starting; approving starts it with its grants live.
            if (action === 'approvePlan') {
              const updated = await engineRef.current.approvePlan(ticket.id, typeof p.message === 'string' ? p.message : '');
              void engineRef.current.tick();
              return { ok: true, value: { ticket: updated } };
            }
            if (action === 'recoverSession') {
              if (typeof p.sessionId !== 'string') return fail('bad_request', 'sessionId is required');
              const attached = await driver.attachExistingSession(p.sessionId);
              return { ok: true, value: { attached } };
            }
            if (action === 'retry') {
              return { ok: true, value: { ticket: retryWithFreshBudget(ticket, { instruction: p.instruction, patch: p.patch }) } };
            }
            const recovered = await recoveryAction(ticket, action, p);
            if (recovered !== undefined) return recovered;
            return fail('bad_request', `unknown resolution action ${action}`);
          }
          case 'action': {
            const ticket = requireTicket(String(p.id));
            const action = String(p.action);
            if (action === 'discard') {
              if (ticket.phase === 'verify') {
                const updated = await engineRef.current.discard(ticket.id, typeof p.reason === 'string' ? p.reason : '');
                return { ok: true, value: { ticket: updated } };
              }
              await engineRef.current.abortTicket(ticket.id);
              const updated = store.transitionTicket(ticket.id, { column: 'discarded' }, { actor: 'human', reason: p.reason ?? 'discarded' });
              return { ok: true, value: { ticket: updated } };
            }
            if (action === 'approve') {
              const updated = await engineRef.current.approve(ticket.id, typeof p.message === 'string' ? p.message : '');
              return { ok: true, value: { ticket: updated } };
            }
            // KAN-30: same approval of a plan's sandbox grants as on the
            // resolve endpoint, for callers that act on a ticket without
            // reading its park state first.
            if (action === 'approvePlan') {
              const updated = await engineRef.current.approvePlan(ticket.id, typeof p.message === 'string' ? p.message : '');
              void engineRef.current.tick();
              return { ok: true, value: { ticket: updated } };
            }
            if (action === 'recoverSession') {
              if (typeof p.sessionId !== 'string') return fail('bad_request', 'sessionId is required');
              const attached = await driver.attachExistingSession(p.sessionId);
              return { ok: true, value: { attached } };
            }
            // KAN-31: the same fresh-budget retry the resolve endpoint performs,
            // for callers that act on a ticket without reading its park state.
            // One shared path, so both endpoints reset the budget identically.
            if (action === 'retry') {
              if (!ticket.needsAttentionReason) return fail('bad_request', 'ticket is not parked for attention');
              return { ok: true, value: { ticket: retryWithFreshBudget(ticket, { instruction: p.instruction, patch: p.patch }) } };
            }
            const recovered = await recoveryAction(ticket, action, p);
            if (recovered !== undefined) return recovered;
            if (action === 'startPlanning') {
              // KAN-16: plan this Backlog ticket in place. The decision, and
              // every guard on it, lives in src/planning.mjs so it is testable
              // without the HTTP surface.
              const result = startPlanning({ store, driver, engine: engineRef.current, ticket });
              if (!result.ok) return fail(result.code, result.message);
              return { ok: true, value: { ticket: result.ticket } };
            }
            if (action === 'startBuild') {
              // Start the build of a planned Backlog ticket: the same move into
              // Working that dragging it there makes (src/build.mjs).
              const result = startBuild({ store, engine: engineRef.current, ticket, reason: p.reason });
              if (!result.ok) return fail(result.code, result.message);
              return { ok: true, value: { ticket: result.ticket } };
            }
            if (action === 'addAcceptance') {
              if (typeof p.statement !== 'string' || p.statement.trim() === '') return fail('bad_request', 'statement is required');
              return appendAcceptance(store, ticket.id, p.statement);
            }
            if (action === 'setAcceptance') {
              if (!Array.isArray(p.statements)) return fail('bad_request', 'statements must be an array');
              return replaceAcceptance(store, ticket.id, p.statements);
            }
            if (action === 'attachSession') {
              if (typeof p.sessionId !== 'string') return fail('bad_request', 'sessionId is required');
              store.attachSession({
                ticketId: ticket.id,
                dshSessionId: p.sessionId,
                role: typeof p.role === 'string' ? p.role : 'implementer',
              });
              return { ok: true, value: { ticket: requireTicket(ticket.id) } };
            }
            if (action === 'detachSession') {
              if (typeof p.sessionId !== 'string') return fail('bad_request', 'sessionId is required');
              store.detachSession(p.sessionId);
              return { ok: true, value: { ticket: requireTicket(ticket.id) } };
            }
            return fail('bad_request', `unknown action ${action}`);
          }
          case 'reorder': {
            // Drop a ticket before another one of its column (or at the end when
            // beforeId is absent or null). The arithmetic lives in src/ordering.mjs.
            const ticket = requireTicket(String(p.id));
            const beforeId = p.beforeId === undefined || p.beforeId === null ? null : requireTicket(String(p.beforeId)).id;
            const siblings = store.listTickets({ columns: [ticket.column] });
            const plan = placement(siblings, ticket.id, beforeId);
            if (!plan.ok) return fail(plan.code, plan.message);
            for (const other of plan.renumber) store.updateTicket(other.id, { sortOrder: other.sortOrder }, { actor: 'human', reason: 'reorder' });
            const patch = { sortOrder: plan.sortOrder };
            if (plan.priority !== ticket.priority) patch.priority = plan.priority;
            const updated = store.updateTicket(ticket.id, patch, { actor: 'human', reason: 'reorder' });
            void engineRef.current.tick();
            return { ok: true, value: { ticket: updated } };
          }
          case 'export': {
            const ticket = p.id === undefined ? undefined : requireTicket(String(p.id));
            const format = p.format === 'csv' ? 'csv' : 'jsonl';
            const kind = p.kind === 'spans' ? 'spans' : p.kind === 'usage' ? 'usage' : 'tickets';
            let rows;
            let columns;
            if (kind === 'spans') {
              rows = ticket === undefined ? store.listAllSpans() : store.listSpans(ticket.id);
              columns = SPAN_COLUMNS;
            } else if (kind === 'usage') {
              rows = ticket === undefined ? store.listTickets().flatMap((t) => usageRows(t, store.usageForTicket(t.id))) : usageRows(ticket, store.usageForTicket(ticket.id));
              columns = USAGE_COLUMNS;
            } else {
              rows = ticket === undefined ? store.listTickets() : [ticket];
              columns = TICKET_COLUMNS;
            }
            if (format === 'csv') return { ok: true, value: { format, kind, mime: 'text/csv', body: toCsv(rows, columns) } };
            return { ok: true, value: { format, kind, mime: 'application/x-ndjson', body: toJsonl(rows) } };
          }
          case 'analytics':
            return {
              ok: true,
              value: {
                attemptsToDone: store.attemptsToDone(),
                modelSuccessRate: store.modelSuccessRate(),
                calibration: store.calibration(),
                timeInPhase: store.timeInPhase(),
                costPerTicket: store.costPerTicket(),
                stallRate: store.stallRate(),
                counts: store.counts(),
              },
            };
          case 'capabilities':
            return {
              ok: true,
              value: {
                worktree: typeof ctx.get('betterGitWorktree')?.createForPath === 'function',
                continueKicker: typeof ctx.get('continueKicker')?.kick === 'function',
                // KAN-15: the New-ticket preset picker reads this. `default` is
                // the harness default id (what a null preset tracks), `items`
                // every registered preset with its activation diagnostic, so a
                // broken one can be labelled instead of silently failing.
                presets: await presetsCapability(ctx, log),
                writeModes: WRITE_MODES,
              },
            };
          case 'worktree': {
            const service = ctx.get('betterGitWorktree');
            if (typeof service?.createForPath !== 'function') return fail('unavailable', 'dsh-better-git-worktree is not mounted');
            const ticket = p.id === undefined ? undefined : requireTicket(String(p.id));
            const base = typeof p.workspaceCwd === 'string' && p.workspaceCwd !== ''
              ? p.workspaceCwd
              : ticket?.workspaceCwd ?? live.defaultWorkspaceCwd ?? process.cwd();
            const title = typeof p.title === 'string' && p.title.trim() !== '' ? p.title.trim() : (ticket?.title ?? 'Kanban worktree');
            const created = await service.createForPath({ path: base, title });
            try {
              await ctx.get('workspaceRegistry')?.create?.(created.managedRoot, title);
            } catch (error) {
              log.warn('worktree workspace registration failed: %s', message(error));
            }
            const updated = ticket === undefined
              ? undefined
              : store.updateTicket(ticket.id, { workspaceCwd: created.managedRoot }, { actor: 'human', reason: 'worktree created' });
            return { ok: true, value: { worktree: created, ticket: updated ?? null } };
          }
          case 'config': {
            const configEditor = ctx.get('configEditor');
            let groups = [];
            const sessionController = ctx.get('sessionController');
            if (sessionController?.modelCatalog !== undefined) {
              try {
                groups = (await sessionController.modelCatalog()).groups ?? [];
              } catch (error) {
                log.warn('could not load the session model catalog: %s', message(error));
              }
            }
            return {
              ok: true,
              value: {
                providers: live.providers,
                groups,
                writable: configEditor !== undefined,
                revision: null,
                routes: Object.fromEntries(
                  Object.keys(live.roles).map((role) => [role, engineRef.current.resolveRoute(role, 1)]),
                ),
                roles: Object.fromEntries(
                  Object.entries(live.roles).map(([role, entry]) => [
                    role,
                    { provider: entry.provider, model: entry.model, reasoningEffort: entry.reasoningEffort },
                  ]),
                ),
                confidenceThreshold: live.confidenceThreshold,
                maxAttempts: live.maxAttempts,
                tickIntervalMs: live.tickIntervalMs,
                stallTimeoutMs: live.stallTimeoutMs,
                wipCap: live.wipCap,
                escalationLadder: live.escalationLadder,
                promptsDir,
                promptHashes: prompts.hashes,
                dbPath,
              },
            };
          }
          case 'setRoutes': {
            const configEditor = ctx.get('configEditor');
            if (configEditor === undefined) return fail('forbidden', 'this profile does not accept configuration edits');
            const row = configEditor.configuration().find((item) => item.entry?.id === 'kanban' || item.entry?.id?.endsWith(':kanban'));
            if (row === undefined) return fail('not_found', 'kanban has no config entry');
            const prepared = await prepareRoutes({
              items: p.routes,
              roles: live.roles,
              providers: llm.listProviders().map((provider) => provider.id),
              listModels: (provider) => llm.listModels(provider),
              resolveModel: (provider, model) => llm.resolveModelInfo(provider, model),
            });
            if (!prepared.ok) return fail(prepared.code, prepared.message);
            const routes = prepared.routes;
            await configEditor.edit(row.entry, (current, inherited) => applyRoutes(current, inherited, routes));
            return { ok: true, value: { saved: routes.length } };
          }
          default:
            return fail('unknown_endpoint', `unknown endpoint ${endpoint}`);
        }
      } catch (error) {
        log.warn('kanban endpoint %s failed: %s', endpoint, message(error));
        const code = error?.status ?? error?.code ?? 'internal';
        return fail(String(code), message(error));
      }
    };

    const apiFetch = (endpoint) => async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        body = {};
      }
      const envelope = body && typeof body === 'object' && body.type === 'client-request' && typeof body.rpcId === 'string' ? body : null;
      const result = await handler(endpoint, envelope ? envelope.payload : body);
      const response = envelope ? { type: 'server-response', rpcId: envelope.rpcId, result } : result;
      return Response.json(response, { headers: { 'cache-control': 'no-store' } });
    };

    for (const endpoint of ENDPOINTS) {
      connection.fetch.register({
        path: `${API_BASE}/${endpoint}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: apiFetch(endpoint),
      });
    }
    log.info('applied: db=%s routes=%s/{%s}', dbPath, API_BASE, ENDPOINTS.join(','));
  });

  // ---- shutdown ------------------------------------------------------------
  ctx.effect(
    () => () => {
      engineRef.current.stop();
      store.close();
    },
    `${PLUGIN_NAME}: close store`,
  );
}

// ---------------------------------------------------------------------------

function summary(ticket, editable = false) {
  return {
    id: ticket.id,
    key: ticket.key,
    title: ticket.title,
    column: ticket.column,
    phase: ticket.phase,
    editable,
    priority: ticket.priority,
    sortOrder: ticket.sortOrder,
    attemptCount: ticket.attemptCount,
    planTiming: ticket.planTiming,
    planQuestions: ticket.planQuestions,
    spentUsd: ticket.spentUsd,
    budgetUsd: ticket.budgetUsd,
    allowPaid: ticket.allowPaid,
    needsAttentionReason: ticket.needsAttentionReason,
    updatedAt: ticket.updatedAt,
    createdAt: ticket.createdAt,
    closedAt: ticket.closedAt ?? null,
    totalMs: (() => {
      const created = Date.parse(ticket.createdAt);
      const closed = ticket.closedAt === null || ticket.closedAt === undefined ? Date.now() : Date.parse(ticket.closedAt);
      return Number.isFinite(created) && Number.isFinite(closed) ? Math.max(0, closed - created) : 0;
    })(),
  };
}

function tree(spans) {
  const byId = new Map(spans.map((span) => [span.id, { ...span, children: [] }]));
  const roots = [];
  for (const span of byId.values()) {
    if (span.parentSpanId !== null && byId.has(span.parentSpanId)) byId.get(span.parentSpanId).children.push(span);
    else roots.push(span);
  }
  return roots;
}



const TIMELINE_LABELS = {
  planner: 'Plan',
  implementer: 'Build',
  reviewer: 'Review',
  approver: 'Approval',
};

/**
 * Timeline blocks are plugin-owned workflow steps, not the session's individual
 * turns/tools. Agent spans are collapsed per role+attempt, so grilling includes
 * the human answer gap; judge calls and plugin steps stay separate and coloured.
 */
function timelineView(spans, artifacts = [], events = [], now = Date.now()) {
  const groups = new Map();
  const items = [];
  const artifactsBySpan = new Map();
  for (const artifact of artifacts) {
    if (artifact.spanId === null || artifact.spanId === undefined) continue;
    const list = artifactsBySpan.get(artifact.spanId) ?? [];
    list.push({ kind: artifact.kind, content: artifact.content, createdAt: artifact.createdAt });
    artifactsBySpan.set(artifact.spanId, list);
  }
  for (const span of spans) {
    const start = Date.parse(span.startedAt);
    if (!Number.isFinite(start)) continue;
    const end = span.endedAt === null || span.endedAt === undefined ? now : Date.parse(span.endedAt);
    const finish = Number.isFinite(end) ? Math.max(start, end) : now;
    if (span.kind === 'agent' && typeof span.role === 'string' && span.role !== 'orchestrator') {
      const attemptKey = span.role === 'griller' ? 1 : (span.attempt ?? 0);
      const key = `${span.role}|${attemptKey}`;
      const found = groups.get(key);
      if (found === undefined) {
        groups.set(key, {
          kind: 'phase',
          role: span.role,
          name: TIMELINE_LABELS[span.role] ?? span.role,
          attempt: attemptKey,
          start,
          end: finish,
          status: span.status,
          provider: span.provider ?? null,
          model: span.model ?? null,
          spans: 1,
          spanIds: [span.id],
          lastEnd: finish,
          maxGap: 0,
        });
      } else {
        found.start = Math.min(found.start, start);
        found.maxGap = Math.max(found.maxGap, Math.max(0, start - found.lastEnd));
        found.end = Math.max(found.end, finish);
        found.lastEnd = Math.max(found.lastEnd, finish);
        found.spans += 1;
        found.spanIds.push(span.id);
        if (span.status === 'failed' || span.status === 'abandoned') found.status = span.status;
      }
    } else if (span.kind === 'judge') {
      items.push({
        kind: 'judge', role: span.role, name: span.name, attempt: span.attempt ?? 0,
        start, end: finish, status: span.status, provider: span.provider ?? null, model: span.model ?? null,
        spanIds: [span.id],
        artifacts: artifactsBySpan.get(span.id) ?? [],
      });
    } else if (span.kind === 'workflow') {
      items.push({
        kind: 'plugin', role: null, name: span.name, attempt: span.attempt ?? 0,
        start, end: finish, status: span.status, provider: null, model: null,
        spanIds: [span.id],
        artifacts: artifactsBySpan.get(span.id) ?? [],
      });
    }
  }
  const rolePhase = { planner: 'plan', implementer: 'implement', reviewer: 'review', approver: 'verify' };
  const EVENT_KINDS = new Set([
    'phase_changed', 'conditions_set', 'planned', 'implemented', 'review', 'verification_failed', 'done',
    'retry_scheduled', 'needs_attention_reason', 'stalled', 'recovered',
    'awaiting_human', 'attempt_started', 'attempt_history',
    'session_reactivated', 'session_settled',
  ]);
  for (const group of groups.values()) {
    const phase = rolePhase[group.role];
    const related = events
      .filter((event) => {
        if (!EVENT_KINDS.has(event.kind)) return false;
        if (event.phaseFrom === phase) return true;
        const at = Date.parse(event.at);
        return Number.isFinite(at) && at >= group.start && at <= group.end + 1500;
      })
      .map((event) => ({
        kind: event.kind,
        at: event.at,
        actor: event.actor,
        phaseFrom: event.phaseFrom,
        phaseTo: event.phaseTo,
        payload: event.payload,
      }))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .slice(-20);
    const relatedArtifacts = (group.spanIds ?? []).flatMap((id) => artifactsBySpan.get(id) ?? []);
    items.push({ ...group, includesWait: group.maxGap > 2000, artifacts: relatedArtifacts, events: related });
  }
  return items
    .map((item) => ({
      kind: item.kind,
      role: item.role,
      name: item.name,
      attempt: item.attempt,
      provider: item.provider,
      model: item.model,
      status: item.status,
      spans: item.spans ?? 1,
      includesWait: item.includesWait === true,
      artifacts: item.artifacts ?? [],
      events: item.events ?? [],
      startedAt: new Date(item.start).toISOString(),
      endedAt: new Date(item.end).toISOString(),
      durationMs: item.end - item.start,
    }))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function appendConfigFingerprint(store, ticketId) {
  // The run row records the config hash; this event just marks the creation
  // context so an old ticket remains explainable after a YAML change.
  try {
    store.db.prepare('INSERT INTO events (ticket_id, at, kind, phase_from, phase_to, actor, payload_json) VALUES (?, ?, ?, NULL, NULL, ?, ?)').run(
      ticketId,
      new Date().toISOString(),
      'config_snapshot',
      'engine',
      JSON.stringify({}),
    );
  } catch {
    // best effort
  }
}

/**
 * The preset roster for the capabilities endpoint: the harness default id plus
 * every registered preset, with its activation diagnostic kept as a boolean so
 * the client can label a broken entry without parsing it. Null when the
 * registry is unavailable — the client then offers only the harness default.
 */
async function presetsCapability(ctx, log) {
  const presets = ctx.get('agentPresets');
  if (presets === undefined || presets === null || typeof presets.list !== 'function') return null;
  try {
    const items = await presets.list();
    return {
      default: presets.defaultId ?? null,
      items: items.map((row) => ({ id: row.id, name: row.name ?? row.id, broken: row.broken !== undefined && row.broken !== null })),
    };
  } catch (error) {
    log.warn('capabilities: preset roster failed: %s', message(error));
    return null;
  }
}

/** Verify every configured route against the host's live catalog. */
async function validateRoutes(config, llm, log) {
  const providers = new Map(llm.listProviders().map((provider) => [provider.id, provider]));
  const declared = new Set(config.providers.map((p) => p.name));
  for (const name of declared) {
    if (!providers.has(name)) {
      throw new Error(`kanban config: provider "${name}" is not offered by the host`);
    }
  }
  for (const [role, entry] of Object.entries(config.roles)) {
    if (entry.provider === null || entry.provider === undefined) continue;
    if (!providers.has(entry.provider)) {
      throw new Error(`kanban config: roles.${role}.provider "${entry.provider}" is not offered by the host`);
    }
    if (entry.model === null || entry.model === undefined) continue;
    const models = await llm.listModels(entry.provider);
    if (models.length > 0 && !models.some((model) => model.id === entry.model)) {
      throw new Error(`kanban config: roles.${role}.model "${entry.model}" is not offered by provider "${entry.provider}"`);
    }
  }
  // A level the live catalog no longer offers is a warning, never a boot failure:
  // the request path already rejects it with UNSUPPORTED_REASONING_EFFORT, and a
  // provider-config swap must not be able to take the profile down.
  if (log === undefined) return;
  for (const warning of await staleEffortWarnings(config.roles, (provider, model) => llm.resolveModelInfo(provider, model))) {
    log.warn(warning);
  }
}
