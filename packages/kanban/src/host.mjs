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
import { KanbanStore } from './store.mjs';
import { openDatabase } from './db.mjs';
import { SessionDriver } from './dispatch.mjs';
import { Engine } from './engine.mjs';
import { hashText, loadPrompts, shortHash } from './prompts.mjs';
import { TICKET_COLUMNS, SPAN_COLUMNS, USAGE_COLUMNS, toCsv, toJsonl, usageRows } from './export.mjs';
import { nowGroup } from './lifecycle.mjs';

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
  await validateRoutes(initial, llm);

  const db = openDatabase(dbPath);
  const store = new KanbanStore(db, {
    onEvent: (event) => {
      if (process.env.DSH_KANBAN_DEBUG === '1') log.info('event %s %s', event.kind, event.ticketId ?? '-');
    },
  });

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
        await validateRoutes(next.config, llm);
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

    const board = () => {
      const tickets = store.listTickets();
      const active = new Map([...engine.active.keys()].map((id) => [id, true]));
      const byColumn = { backlog: [], now: [], blocked: [], needs_attention: [], done: [], discarded: [] };
      for (const ticket of tickets) {
        const item = summary(ticket);
        if (ticket.phase === 'plan') item.planSessionId = driver.liveTicketSession(ticket.id, 'plan') ?? null;
        byColumn[ticket.column]?.push(item);
      }
      const awaiting = new Set(tickets.filter((ticket) => ticket.phase === 'plan' && driver.isAwaitingUser(ticket.id)).map((ticket) => ticket.id));
      for (const ticket of byColumn.now.slice()) {
        if (!awaiting.has(ticket.id)) continue;
        byColumn.now = byColumn.now.filter((item) => item.id !== ticket.id);
        byColumn.needs_attention.push({
          ...ticket,
          column: 'needs_attention',
          group: 'waiting',
          awaitingQuestion: true,
          needsAttentionReason: 'Waiting on your answer',
        });
      }
      const now = byColumn.now.map((ticket) => {
        const full = store.getTicket(ticket.id);
        const latest = store.listEvents(ticket.id, { limit: 1 })[0];
        const waiting = latest?.kind === 'awaiting_human' || (full.phase === 'plan' && full.planQuestions === 'interactive');
        return { ...ticket, group: nowGroup(full, { active: active.has(ticket.id), waiting }) };
      });
      const groups = { active: [], waiting: [], blocked: [] };
      for (const ticket of now) groups[ticket.group]?.push(ticket);
      byColumn.now = now;
      const counts = store.counts();
      counts.now = byColumn.now.length;
      counts.needs_attention = byColumn.needs_attention.length;
      return {
        counts,
        columns: byColumn,
        now: groups,
        inFlight: now.filter((t) => t.group === 'active' || t.group === 'waiting'),
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
      return {
        ticket: ticket.phase === 'plan' && driver.isAwaitingUser(ticket.id)
          ? { ...ticket, column: 'needs_attention', needsAttentionReason: 'Waiting on your answer' }
          : ticket,
        awaitingQuestion: ticket.phase === 'plan' && driver.isAwaitingUser(ticket.id),
        approvalSessionId: ticket.phase === 'verify' ? (driver.liveTicketSession(ticket.id, 'approval') ?? null) : null,
        acceptance: store.listAcceptance(ticket.id),
        conditions: store.listConditions(ticket.id),
        sessions: store.listSessions(ticket.id),
        spans,
        spanTree: tree(spans),
        timeline: timelineView(spans, artifacts, events),
        usage: store.rollup(ticket.id),
        events,
        artifacts,
        plan: plan === undefined ? null : safeJson(plan.content),
        review: review === undefined ? null : safeJson(review.content),
        verification: verification === undefined ? null : safeJson(verification.content),
        nowGroup: nowGroup(ticket, { active: engine.active.has(ticket.id) }),
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
          case 'create': {
            const column = p.column ?? 'backlog';
            if (!['backlog', 'now', 'blocked'].includes(column)) return fail('bad_request', 'column must be backlog, now, or blocked');
            let ticket = store.createTicket(p);
            appendConfigFingerprint(store, ticket.id);
            if (column === 'now') {
              ticket = engineRef.current.pickup(ticket.id);
            } else if (column === 'blocked') {
              ticket = store.transitionTicket(ticket.id, { column: 'blocked' }, { actor: 'human', reason: 'created blocked' });
            }
            void engineRef.current.tick();
            return { ok: true, value: { ticket } };
          }
          case 'update': {
            const updated = store.updateTicket(String(p.id), p.patch ?? {}, { actor: 'human', reason: p.reason ?? 'ticket edit' });
            void engineRef.current.tick();
            return { ok: true, value: { ticket: updated } };
          }
          case 'move': {
            const column = String(p.column);
            if (column === 'now' && store.getTicket(String(p.id))?.column === 'backlog') {
              return { ok: true, value: { ticket: engineRef.current.pickup(String(p.id)) } };
            }
            if (column === 'discarded' || column === 'done') {
              const t = store.getTicket(String(p.id));
              if (t === undefined) return fail('not_found', 'no such ticket');
              if (column === 'done') return fail('bad_request', 'done is set by human approval, not by dragging');
              await engineRef.current.abortTicket(t.id);
            }
            const updated = store.transitionTicket(String(p.id), { column }, { actor: 'human', reason: p.reason ?? 'human move' });
            void engineRef.current.tick();
            return { ok: true, value: { ticket: updated } };
          }
          case 'resolve': {
            const ticket = requireTicket(String(p.id));
            if (ticket.column !== 'needs_attention') return fail('bad_request', 'ticket is not in needs_attention');
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
            if (action === 'approvalSession') {
              const result = await engineRef.current.startApprovalSession(ticket.id);
              return { ok: true, value: { sessionId: result.sessionId } };
            }
            if (action === 'recoverSession') {
              if (typeof p.sessionId !== 'string') return fail('bad_request', 'sessionId is required');
              const attached = await driver.attachExistingSession(p.sessionId);
              return { ok: true, value: { attached } };
            }
            if (action === 'retry') {
              if (typeof p.instruction === 'string' && p.instruction.trim() !== '') {
                store.addArtifact(ticket.id, 'attempt_feedback', `Human instruction for the next attempt:\n${p.instruction}`);
              }
              if (p.patch !== undefined && typeof p.patch === 'object') {
                store.updateTicket(ticket.id, p.patch, { actor: 'human', reason: 'needs_attention resolution' });
              }
              const resumePhase = engineRef.current.retryPhase(ticket);
              const updated = store.transitionTicket(ticket.id, { column: 'now', phase: resumePhase }, { actor: 'human', reason: 'human retry' });
              void engineRef.current.tick();
              return { ok: true, value: { ticket: updated } };
            }
            return fail('bad_request', `unknown resolution action ${action}`);
          }
          case 'action': {
            const ticket = requireTicket(String(p.id));
            const action = String(p.action);
            if (action === 'block') {
              if (typeof p.reason !== 'string' || p.reason.trim() === '') return fail('bad_request', 'blocked needs a reason');
              const updated = store.transitionTicket(ticket.id, { column: 'blocked' }, { actor: 'human', reason: p.reason });
              return { ok: true, value: { ticket: updated } };
            }
            if (action === 'unblock') {
              const updated = store.transitionTicket(ticket.id, { column: 'now' }, { actor: 'human', reason: p.reason ?? 'unblocked' });
              void engineRef.current.tick();
              return { ok: true, value: { ticket: updated } };
            }
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
            if (action === 'approvalSession') {
              const result = await engineRef.current.startApprovalSession(ticket.id);
              return { ok: true, value: { sessionId: result.sessionId } };
            }
            if (action === 'recoverSession') {
              if (typeof p.sessionId !== 'string') return fail('bad_request', 'sessionId is required');
              const attached = await driver.attachExistingSession(p.sessionId);
              return { ok: true, value: { attached } };
            }
            if (action === 'addAcceptance') {
              if (typeof p.statement !== 'string' || p.statement.trim() === '') return fail('bad_request', 'statement is required');
              store.addAcceptance(ticket.id, p.statement, 'human');
              return { ok: true, value: { ticket: requireTicket(ticket.id), acceptance: store.listAcceptance(ticket.id) } };
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
            const ticket = requireTicket(String(p.id));
            const before = p.beforeId === undefined ? undefined : requireTicket(String(p.beforeId));
            const target = store.getTicket(ticket.id);
            let sortOrder = target.sortOrder;
            if (before !== undefined) {
              const siblings = store.listTickets({ columns: [target.column] });
              const index = siblings.findIndex((s) => s.id === before.id);
              const prev = index > 0 ? siblings[index - 1] : undefined;
              sortOrder = prev === undefined ? before.sortOrder - 500 : (prev.sortOrder + before.sortOrder) / 2;
            } else {
              const siblings = store.listTickets({ columns: [target.column] });
              const last = siblings[siblings.length - 1];
              sortOrder = (last?.sortOrder ?? 0) + 1000;
            }
            const updated = store.updateTicket(ticket.id, { sortOrder }, { actor: 'human', reason: 'reorder' });
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
                    { provider: entry.provider, model: entry.model, reasoningEffort: entry.reasoningEffort, allowTools: entry.allowTools },
                  ]),
                ),
                confidenceThreshold: live.confidenceThreshold,
                maxAttempts: live.maxAttempts,
                tickIntervalMs: live.tickIntervalMs,
                stallTimeoutMs: live.stallTimeoutMs,
                wipCap: live.wipCap,
                autoPromote: live.autoPromote,
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
            const hostProviders = new Map(llm.listProviders().map((provider) => [provider.id, provider]));
            const routes = [];
            for (const item of Array.isArray(p.routes) ? p.routes : []) {
              const role = String(item.role ?? '');
              if (!Object.hasOwn(live.roles, role)) return fail('bad_request', `unknown role "${role}"`);
              const provider = String(item.provider ?? '');
              const model = String(item.model ?? '');
              if (provider === '' || model === '') return fail('bad_request', `role ${role} needs both provider and model`);
              if (!hostProviders.has(provider)) return fail('bad_request', `provider "${provider}" is not offered by the host`);
              const models = await llm.listModels(provider).catch(() => []);
              if (models.length > 0 && !models.some((candidate) => candidate.id === model)) {
                return fail('bad_request', `model "${model}" is not offered by provider "${provider}"`);
              }
              routes.push({ role, provider, model });
            }
            if (routes.length === 0) return fail('bad_request', 'no routes supplied');
            await configEditor.edit(row.entry, (current, inherited) => {
              const next = structuredClone(current ?? {});
              next.roles = { ...(inherited?.roles ?? {}), ...(next.roles ?? {}) };
              for (const route of routes) {
                next.roles[route.role] = { ...(next.roles[route.role] ?? {}), provider: route.provider, model: route.model };
              }
              return next;
            });
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

function summary(ticket) {
  return {
    id: ticket.id,
    key: ticket.key,
    title: ticket.title,
    column: ticket.column,
    phase: ticket.phase,
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
  const rolePhase = { planner: 'plan', implementer: 'implement', reviewer: 'review' };
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

/** Verify every configured route against the host's live catalog. */
async function validateRoutes(config, llm) {
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
}
