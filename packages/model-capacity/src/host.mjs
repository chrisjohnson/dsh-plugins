// dsh-model-capacity: the Host half.
//
// Owns one process-wide CapacityManager, gates every `llm/stream` call, and
// preflights agent-spawning tools. The service is exposed as `ctx.capacity` so
// other plugins and the panel can inspect it.

import { Service } from '@deepseek-ai/cordis';

import { ConfigError, isEnabled, limitFor, resolveConfig } from './config.mjs';
import { gatedStream } from './gate.mjs';
import { checkSubagentCapacity } from './guard.mjs';
import { CapacityManager } from './semaphore.mjs';

const PLUGIN_NAME = 'dsh-model-capacity';
const API_BASE = '/api/modelCapacity';
const ENDPOINTS = ['snapshot', 'sessionWaits', 'cancelSession', 'cancelWaiter', 'dismissReservation', 'forceRelease', 'setLimits'];

export default class ModelCapacity extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'capacity');
    const { config: resolved, warnings } = resolveConfig(config);
    this.log = ctx.logger(PLUGIN_NAME);
    for (const warning of warnings) this.log.warn(warning);
    this.config = resolved;
    this.manager = new CapacityManager({
      defaultLimit: resolved.defaultMaxConcurrent,
      limits: resolved.limits,
      queueLimitPerProvider: resolved.queueLimitPerProvider,
      reservationTtlMs: resolved.reservationTtlMs,
      onEvent: (type, payload) => this.#event(type, payload),
    });
    this.catalog = [];
    this.sessionMeta = new Map();
    this.waitHistory = [];
    this.waitSeq = 0;
    this.workspaceByPath = [];
    this.metaError = null;
    this.metaUpdatedAt = null;
    this.metaTimer = null;
    this.refreshTimer = null;
    this.reloadTimer = null;
    this.gateDisposer = null;
    this.guardDisposer = null;
    this.eventDisposers = [];
    this.started = false;

    const llm = ctx.get('llm');
    if (llm === undefined || llm === null) {
      throw new ConfigError('dsh-model-capacity needs the host LLM service (ctx.llm)');
    }
    this.llm = llm;
    this.#seedBuckets();

    ctx.effect(() => {
      void this.start().catch((error) => this.log.error('start failed: %s', String(error?.stack ?? error)));
      return () => this.stop();
    }, `${PLUGIN_NAME}: lifecycle`);
  }

  /**
   * Providers register asynchronously (the local adapters load after this row),
   * so a missing route is a loud diagnostic rather than a construction throw.
   * The configured limit still applies the moment that provider appears.
   */
  /**
   * Make the panel honest before any call happens: a configured limit and the
   * deployment's default model route each get a visible queue, even at 0/limit.
   * Other providers appear lazily on first use.
   */
  #seedBuckets() {
    for (const limit of this.config.limits) this.manager.bucket(limit.provider);
    const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.();
    if (typeof selection?.provider === 'string' && selection.provider !== '') this.manager.bucket(selection.provider);
  }

  #reportUnknownProviders() {
    const offered = new Set(this.llm.listProviders().map((provider) => provider.id));
    for (const limit of this.config.limits) {
      if (!offered.has(limit.provider)) {
        this.log.error(
          'limit names provider "%s", which the host does not offer yet (offered: %s); the limit applies if it appears',
          limit.provider,
          [...offered].join(', ') || 'none',
        );
      }
    }
  }

  #event(type, payload) {
    if (type === 'acquired' && payload.sessionId && payload.kind === 'call' && Number(payload.waitedMs) > 250) {
      this.#recordWait(payload);
    }
    if (process.env.DSH_MODEL_CAPACITY_DEBUG === '1') this.log.info('capacity %s %o', type, payload);
    try {
      this.ctx.emit('capacity/' + type, payload);
    } catch {
      // Observers must never break dispatch.
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.gateDisposer = this.ctx.on(
      'llm/stream',
      (options, next) => gatedStream(this.manager, options, next, isEnabled(this.config)),
      { global: true, prepend: true },
    );
    const tools = this.ctx.get('tools');
    if (tools !== undefined) {
      this.guardDisposer = tools.guard((execution) =>
        checkSubagentCapacity(execution, this.manager, this.config, this.catalog),
      );
    }
    for (const name of ['session/created', 'session/disposed']) {
      this.eventDisposers.push(
        this.ctx.on(
          name,
          (session) => {
            if (name === 'session/created') {
              const parent = session.header?.parentSession;
              if (typeof parent === 'string' && parent !== '') this.manager.bindChild(parent, session.id);
            } else {
              this.manager.releaseForSession(session.id);
            }
          },
          { global: true },
        ),
      );
    }
    this.eventDisposers.push(
      this.ctx.on(
        'session/event',
        (session, event) => {
          if (event.type !== 'tool/result') return;
          const callId = event.data?.message?.toolCallId;
          const isError = event.data?.message?.isError === true || event.data?.error !== undefined;
          if (isError && callId !== undefined) this.manager.cancelReservationByCallId(callId, 'tool_error');
        },
        { global: true },
      ),
    );
    this.eventDisposers.push(
      this.ctx.on('llm/adapters-updated', () => {
        void this.refreshCatalog().then(() => {
          this.#seedBuckets();
          this.#reportUnknownProviders();
        });
      }, { global: true }),
    );
    const expiry = setInterval(() => this.manager.expireReservations(), 5000);
    if (typeof expiry.unref === 'function') expiry.unref();
    this.expiryTimer = expiry;
    await this.refreshCatalog();
    await this.refreshSessionMeta();
    const metaTimer = setInterval(() => void this.refreshSessionMeta(), 10000);
    if (typeof metaTimer.unref === 'function') metaTimer.unref();
    this.metaTimer = metaTimer;
    this.#seedBuckets();
    this.#reportUnknownProviders();
    this.#installRoutes();
    this.#watchConfig();
    this.log.info('applied: limits=%s default=%d subagentTools=%s', JSON.stringify(Object.fromEntries(this.config.limits.map((l) => [l.provider, l.maxConcurrent]))), this.config.defaultMaxConcurrent, this.config.subagentTools.join(','));
  }

  stop() {
    if (this.expiryTimer !== null) clearInterval(this.expiryTimer);
    if (this.metaTimer !== null) clearInterval(this.metaTimer);
    if (this.reloadTimer !== null) clearInterval(this.reloadTimer);
    if (this.gateDisposer !== null) {
      try {
        this.gateDisposer();
      } catch {
        // already detached
      }
    }
    if (this.guardDisposer !== null) {
      try {
        this.guardDisposer();
      } catch {
        // already detached
      }
    }
    for (const dispose of this.eventDisposers) {
      try {
        dispose();
      } catch {
        // already detached
      }
    }
    this.eventDisposers = [];
    this.started = false;
  }

  async refreshCatalog() {
    const entries = [];
    for (const provider of this.llm.listProviders()) {
      let models = [];
      try {
        models = await this.llm.listModels(provider.id);
      } catch {
        models = [];
      }
      entries.push({ provider: provider.id, models: models.map((model) => ({ id: model.id, name: model.name ?? model.id })) });
    }
    this.catalog = entries;
    return entries;
  }

  /**
   * Cache `{title, cwd, workspace}` for every visible session. Titles are the
   * session log's `title` projection; workspace names come from the workspace
   * registry. Refreshed every 10 s so the panel can decorate synchronously
   * without turning each poll into a full session scan.
   */
  /** Attach a completed wait to the turn that was open when the call was admitted. */
  #recordWait(payload) {
    const session = this.ctx.get('sessions')?.get?.(payload.sessionId);
    const boundary = session === undefined ? undefined : this.ctx.get('sessionProjections')?.stateOf?.(session, 'turnBoundary');
    const turn = boundary?.lastTurn;
    if (typeof turn !== 'number' || turn < 1) return;
    this.waitSeq += 1;
    this.waitHistory.push({
      id: this.waitSeq,
      sessionId: payload.sessionId,
      turn,
      provider: payload.provider,
      model: payload.model ?? null,
      waitedMs: Math.max(0, Math.round(Number(payload.waitedMs))),
      at: Date.now(),
    });
    if (this.waitHistory.length > 5000) this.waitHistory.splice(0, this.waitHistory.length - 5000);
  }

  sessionWaits(sessionId) {
    return this.waitHistory.filter((entry) => entry.sessionId === sessionId).sort((a, b) => a.at - b.at);
  }

  async refreshSessionMeta() {
    const controller = this.ctx.get('sessionController');
    if (controller === undefined || typeof controller.list !== 'function') return;
    let items = [];
    try {
      const listed = await controller.list({}, AbortSignal.timeout(5000));
      items = listed?.items ?? [];
    } catch (error) {
      this.metaError = String(error?.message ?? error);
      this.log.warn('capacity session metadata refresh failed: %s', this.metaError);
      return;
    }
    const workspaces = this.ctx.get('workspaceRegistry')?.list?.() ?? [];
    this.workspaceByPath = workspaces
      .map((workspace) => ({ path: workspace.path, title: workspace.title }))
      .sort((a, b) => b.path.length - a.path.length);
    const next = new Map();
    for (const item of items) {
      const cwd = typeof item.cwd === 'string' ? item.cwd : null;
      next.set(item.sessionId, {
        title: item.projections?.values?.title ?? null,
        cwd,
        workspace: this.workspaceFor(cwd),
        running: item.running === true,
      });
    }
    this.sessionMeta = next;
    this.metaError = null;
    this.metaUpdatedAt = Date.now();
  }

  workspaceFor(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return null;
    const match = this.workspaceByPath.find((workspace) => cwd === workspace.path || cwd.startsWith(workspace.path + '/'));
    return match?.title ?? null;
  }

  /**
   * Prefer the live session: the projection cache may not be mounted for cold
   * sessions, but a live agent has its title fold and header cwd right here.
   */
  describe(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return { sessionTitle: null, workspace: null, cwd: null };
    const live = this.ctx.get('sessions')?.get?.(sessionId);
    if (live !== undefined && live !== null) {
      const title = this.ctx.get('sessionTitle')?.get?.(live)?.title ?? null;
      const cwd = live.header?.cwd ?? null;
      return { sessionTitle: title ?? this.sessionMeta.get(sessionId)?.title ?? null, workspace: this.workspaceFor(cwd), cwd };
    }
    const meta = this.sessionMeta.get(sessionId);
    return {
      sessionTitle: meta?.title ?? null,
      workspace: meta?.workspace ?? null,
      cwd: meta?.cwd ?? null,
    };
  }

  // ------------------------------------------------------------------ panel API

  snapshot() {
    const snap = this.manager.snapshot();
    const providers = snap.providers.map((provider) => ({
      ...provider,
      active: provider.active.map((lease) => ({ ...lease, ...this.describe(lease.sessionId) })),
      waiters: provider.waiters.map((waiter) => ({ ...waiter, ...this.describe(waiter.sessionId) })),
      reservations: provider.reservations.map((reservation) => ({
        ...reservation,
        parent: this.describe(reservation.parentSession),
        child: this.describe(reservation.childSession),
      })),
    }));
    return {
      enabled: isEnabled(this.config),
      asOf: snap.asOf,
      totals: snap.totals,
      limits: this.config.limits,
      defaultMaxConcurrent: this.config.defaultMaxConcurrent,
      queueLimitPerProvider: this.config.queueLimitPerProvider,
      writable: this.ctx.get('configEditor') !== undefined,
      providers,
      catalog: this.catalog,
      metadata: { sessions: this.sessionMeta.size, updatedAt: this.metaUpdatedAt, error: this.metaError },
    };
  }

  isWaitingForSession(sessionId) {
    return this.manager.waitersForSession(sessionId).some((waiter) => waiter.kind === 'call');
  }

  cancelSession(sessionId) {
    let cancelled = 0;
    for (const waiter of this.manager.waitersForSession(sessionId)) {
      if (this.manager.cancelWaiter(waiter.id)) cancelled += 1;
    }
    const controller = this.ctx.get('sessionController');
    if (controller !== undefined && typeof controller.cancel === 'function') {
      try {
        controller.cancel({ sessionId });
      } catch (error) {
        this.log.warn('session cancel failed for %s: %s', sessionId, String(error?.message ?? error));
      }
    }
    return { cancelled, sessionId };
  }

  cancelWaiter(waiterId) {
    return { cancelled: this.manager.cancelWaiter(waiterId), waiterId };
  }

  dismissReservation(reservationId) {
    return { dismissed: this.manager.cancelReservation(reservationId, 'panel'), reservationId };
  }

  forceRelease(leaseId) {
    return { released: this.manager.forceRelease(leaseId), leaseId };
  }

  // -------------------------------------------------------------------- routes

  #installRoutes() {
    this.ctx.inject(['connection'], (scope) => {
      const connection = scope.connection;
      if (connection === undefined || connection === null) {
        this.log.error('connection service is missing; the capacity panel stays unavailable');
        return;
      }
      const handler = async (endpoint, payload) => {
        const p = payload !== null && typeof payload === 'object' ? payload : {};
        try {
          switch (endpoint) {
            case 'snapshot':
              return { ok: true, value: this.snapshot() };
            case 'sessionWaits':
              if (typeof p.sessionId !== 'string') return { ok: false, error: { code: 'bad_request', message: 'sessionId is required', details: {} } };
              return { ok: true, value: { waits: this.sessionWaits(p.sessionId) } };
            case 'cancelSession':
              if (typeof p.sessionId !== 'string') return { ok: false, error: { code: 'bad_request', message: 'sessionId is required', details: {} } };
              return { ok: true, value: this.cancelSession(p.sessionId) };
            case 'cancelWaiter':
              if (typeof p.waiterId !== 'string') return { ok: false, error: { code: 'bad_request', message: 'waiterId is required', details: {} } };
              return { ok: true, value: this.cancelWaiter(p.waiterId) };
            case 'dismissReservation':
              if (typeof p.reservationId !== 'string') return { ok: false, error: { code: 'bad_request', message: 'reservationId is required', details: {} } };
              return { ok: true, value: this.dismissReservation(p.reservationId) };
            case 'forceRelease':
              if (typeof p.leaseId !== 'string') return { ok: false, error: { code: 'bad_request', message: 'leaseId is required', details: {} } };
              return { ok: true, value: this.forceRelease(p.leaseId) };
            case 'setLimits': {
              const editor = this.ctx.get('configEditor');
              if (editor === undefined) return { ok: false, error: { code: 'forbidden', message: 'this profile does not accept configuration edits', details: {} } };
              const row = editor.configuration().find((item) => item.entry?.id === 'model-capacity' || item.entry?.id?.endsWith(':model-capacity'));
              if (row === undefined) return { ok: false, error: { code: 'not_found', message: 'model-capacity has no config entry', details: {} } };
              const limits = Array.isArray(p.limits) ? p.limits.map((entry) => {
                const provider = String(entry?.provider ?? '');
                if (provider === '') throw new ConfigError('provider is required', 'limits');
                if (entry?.unlimited === true) return { provider, unlimited: true };
                return { provider, maxConcurrent: Number(entry?.maxConcurrent) };
              }) : [];
              const defaultMaxConcurrent = Number(p.defaultMaxConcurrent ?? this.config.defaultMaxConcurrent);
              const queueLimitPerProvider = Number(p.queueLimitPerProvider ?? this.config.queueLimitPerProvider);
              const candidate = resolveConfig({ ...this.config, limits, defaultMaxConcurrent, queueLimitPerProvider });
              await editor.edit(row.entry, (current, inherited) => {
                const next = { ...(structuredClone(inherited ?? {})), ...(structuredClone(current ?? {})) };
                next.limits = limits;
                next.defaultMaxConcurrent = defaultMaxConcurrent;
                next.queueLimitPerProvider = queueLimitPerProvider;
                return next;
              });
              this.config = candidate.config;
              this.manager.defaultLimit = candidate.config.defaultMaxConcurrent;
              this.manager.queueLimitPerProvider = candidate.config.queueLimitPerProvider;
              this.manager.configure(candidate.config.limits);
              this.#seedBuckets();
              this.#reportUnknownProviders();
              return { ok: true, value: this.snapshot() };
            }
            default:
              return { ok: false, error: { code: 'unknown_endpoint', message: `unknown endpoint ${endpoint}`, details: {} } };
          }
        } catch (error) {
          return { ok: false, error: { code: error?.code ?? 'internal', message: String(error?.message ?? error), details: {} } };
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
    });
  }

  // --------------------------------------------------------------- reloading

  #watchConfig() {
    const editor = this.ctx.get('configEditor');
    if (editor === undefined) return;
    let last = JSON.stringify(this.config);
    this.reloadTimer = setInterval(() => {
      try {
        const row = editor.configuration().find((item) => item.entry?.id === 'model-capacity' || item.entry?.id?.endsWith(':model-capacity'));
        if (row === undefined) return;
        const json = JSON.stringify(row.override ?? {});
        if (json === last) return;
        const { config, warnings } = resolveConfig(row.override ?? {});
        for (const warning of warnings) this.log.warn(warning);
        this.config = config;
        this.manager.defaultLimit = config.defaultMaxConcurrent;
        this.manager.queueLimitPerProvider = config.queueLimitPerProvider;
        this.manager.reservationTtlMs = config.reservationTtlMs;
        this.manager.configure(config.limits);
        last = json;
        this.#seedBuckets();
        this.#reportUnknownProviders();
        this.log.info('capacity config reloaded');
      } catch (error) {
        this.log.error('capacity config reload rejected, keeping previous: %s', String(error?.message ?? error));
      }
    }, 5000);
    if (typeof this.reloadTimer.unref === 'function') this.reloadTimer.unref();
  }
}

/** Re-exported for tests and other plugins that want the pure manager. */
export { CapacityManager, CapacityError } from './semaphore.mjs';
export { limitFor };
