// dsh-kanban: the Host half.
//
// Owns the SQLite board, the scheduler, the role sessions, the HTTP surface and
// the config lifecycle. Every decision lives in a testable module; this file is
// the wiring: services in, routes out.

import { AsyncLocalStorage } from 'node:async_hooks';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { providerPolicy, resolveConfig } from './config.mjs';
import { KanbanStore } from './store.mjs';
import { openDatabase } from './db.mjs';
import { SessionDriver } from './dispatch.mjs';
import { createJudge } from './judge.mjs';
import { Engine } from './engine.mjs';
import { hashText, loadPrompts, shortHash } from './prompts.mjs';
import { TICKET_COLUMNS, SPAN_COLUMNS, USAGE_COLUMNS, toCsv, toJsonl, usageRows } from './export.mjs';
import { nowGroup } from './lifecycle.mjs';

const PLUGIN_NAME = 'dsh-kanban';
const API_BASE = '/api/kanban';
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

const ENDPOINTS = [
  'board',
  'ticket',
  'create',
  'update',
  'move',
  'answer',
  'resolve',
  'action',
  'reorder',
  'export',
  'analytics',
  'config',
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

  const judge = createJudge({
    llm,
    getConfig,
    budgetCheck: ({ route, ticket, promptChars, maxTokens }) => {
      const policy = providerPolicy(getConfig(), route.provider);
      if (policy.tier !== 'paid') return { ok: true };
      if (ticket === null || ticket === undefined) return { ok: true };
      if (!ticket.allowPaid) return { ok: false, reason: `orchestrator is routed to paid provider ${route.provider} but allow_paid is false` };
      return { ok: true };
    },
  });
  const driver = new SessionDriver({
    ctx,
    log,
    getConfig,
    isWaitingForCapacity: (sessionId) => ctx.get('capacity')?.isWaitingForSession?.(sessionId) === true,
  });
  const engine = new Engine({ ctx, store, driver, judge, getConfig, getPrompts, log });
  engine.configHash = configHash;
  engine.runInConfig = (snapshot, fn) => als.run({ ...snapshot, __prompts: prompts }, fn);
  await driver.ensurePresets();

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
          await driver.ensurePresets();
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
      for (const ticket of tickets) byColumn[ticket.column]?.push(summary(ticket));
      const now = byColumn.now.map((ticket) => {
        const full = store.getTicket(ticket.id);
        const latest = store.listEvents(ticket.id, { limit: 1 })[0];
        const waiting = latest?.kind === 'awaiting_human' || full.phase === 'grill';
        return { ...ticket, group: nowGroup(full, { active: active.has(ticket.id), waiting }) };
      });
      const groups = { active: [], waiting: [], blocked: [] };
      for (const ticket of now) groups[ticket.group]?.push(ticket);
      return {
        counts: store.counts(),
        columns: byColumn,
        now: groups,
        inFlight: now.filter((t) => t.group === 'active' || t.group === 'waiting'),
        capacity: capacityView(ctx, live),
      };
    };

    const detail = (id) => {
      const ticket = requireTicket(id);
      const spans = store.listSpans(ticket.id);
      const plan = store.latestArtifact(ticket.id, 'plan');
      const grill = store.latestArtifact(ticket.id, 'grill_questions');
      const review = store.latestArtifact(ticket.id, 'review');
      const verification = store.latestArtifact(ticket.id, 'verification');
      return {
        ticket,
        acceptance: store.listAcceptance(ticket.id),
        conditions: store.listConditions(ticket.id),
        sessions: store.listSessions(ticket.id),
        spans,
        spanTree: tree(spans),
        usage: store.rollup(ticket.id),
        events: store.listEvents(ticket.id, { limit: 300 }),
        artifacts: store.listArtifacts(ticket.id, { limit: 40 }),
        plan: plan === undefined ? null : safeJson(plan.content),
        grill: grill === undefined ? null : safeJson(grill.content),
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
          case 'ticket':
            return { ok: true, value: detail(String(p.id)) };
          case 'events':
            return { ok: true, value: store.listEvents(String(p.id), { limit: p.limit ?? 300, before: p.before ?? null }) };
          case 'create': {
            const ticket = store.createTicket(p);
            appendConfigFingerprint(store, ticket.id);
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
              if (column === 'done') return fail('bad_request', 'done is set by a passing review, not by dragging');
              await engineRef.current.abortTicket(t.id);
            }
            const updated = store.transitionTicket(String(p.id), { column }, { actor: 'human', reason: p.reason ?? 'human move' });
            void engineRef.current.tick();
            return { ok: true, value: { ticket: updated } };
          }
          case 'answer': {
            if (!Array.isArray(p.answers)) return fail('bad_request', 'answers must be an array of strings');
            const result = await engineRef.current.answerGrill(String(p.id), p.answers.map(String));
            return { ok: true, value: { outcome: result?.kind ?? 'accepted' } };
          }
          case 'resolve': {
            const ticket = requireTicket(String(p.id));
            if (ticket.column !== 'needs_attention') return fail('bad_request', 'ticket is not in needs_attention');
            const action = String(p.action ?? 'retry');
            if (action === 'discard') {
              await engineRef.current.abortTicket(ticket.id);
              const updated = store.transitionTicket(ticket.id, { column: 'discarded' }, { actor: 'human', reason: p.reason ?? 'discarded' });
              return { ok: true, value: { ticket: updated } };
            }
            if (action === 'retry') {
              if (typeof p.instruction === 'string' && p.instruction.trim() !== '') {
                store.addArtifact(ticket.id, 'attempt_feedback', `Human instruction for the next attempt:\n${p.instruction}`);
              }
              if (p.patch !== undefined && typeof p.patch === 'object') {
                store.updateTicket(ticket.id, p.patch, { actor: 'human', reason: 'needs_attention resolution' });
              }
              const updated = store.transitionTicket(ticket.id, { column: 'now', phase: 'implement' }, { actor: 'human', reason: 'human retry' });
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
              await engineRef.current.abortTicket(ticket.id);
              const updated = store.transitionTicket(ticket.id, { column: 'discarded' }, { actor: 'human', reason: p.reason ?? 'discarded' });
              return { ok: true, value: { ticket: updated } };
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
          case 'config':
            return {
              ok: true,
              value: {
                providers: live.providers,
                roles: Object.fromEntries(
                  Object.entries(live.roles).map(([role, entry]) => [
                    role,
                    { preset: entry.preset, provider: entry.provider, model: entry.model, reasoningEffort: entry.reasoningEffort, allowTools: entry.allowTools },
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
    spentUsd: ticket.spentUsd,
    budgetUsd: ticket.budgetUsd,
    allowPaid: ticket.allowPaid,
    needsAttentionReason: ticket.needsAttentionReason,
    updatedAt: ticket.updatedAt,
    createdAt: ticket.createdAt,
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

function capacityView(ctx, config) {
  const cap = ctx.get('capacity')?.snapshot?.();
  if (cap !== undefined) {
    return cap.providers.map((provider) => ({
      name: provider.name,
      maxConcurrent: provider.limit,
      used: provider.used,
      waiting: provider.waiters.length,
      reservations: provider.reservations.length,
      tier: 'global',
    }));
  }
  return config.providers.map((provider) => ({ name: provider.name, maxConcurrent: null, used: 0, waiting: 0, reservations: 0, tier: provider.tier ?? 'local' }));
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
      throw new Error(`kanban config: capacity is declared for provider "${name}", which the host does not offer`);
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
