// dsh-take-a-number: the Host half.
//
// Owns one TanClient connection to the machine's take-a-number daemon and gates
// every `llm/stream` call: mapped provider routes take a number in their GPU's
// queue, unmapped routes pass through. The daemon is the single source of
// truth for the whole box (every dsh instance, opencode, …), so the panel this
// plugin serves shows box-wide activity, not just this process.
//
// Coexistence: if dsh-model-capacity is also mounted (its `capacity` service
// is present), this plugin refuses to gate — two gates on the same call would
// double-queue it. The panel still works.

import { Service } from '@deepseek-ai/cordis';
import { TanClient, withLease } from 'take-a-number/client';

import { ConfigError, deriveInstance, isEnabled, queueFor, resolveConfig } from './config.mjs';
import { gatedStream } from './gate.mjs';

const PLUGIN_NAME = 'dsh-take-a-number';
const API_BASE = '/api/takeANumber';
const STREAM_ENDPOINT = 'stream';
const ENDPOINTS = ['snapshot', 'cancelWaiter', 'forceRelease', 'setLimits'];
const META_MAX_AGE_MS = 10000;

export default class TakeANumber extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'takeANumber');
    const { config: resolved, warnings } = resolveConfig(config);
    this.log = ctx.logger(PLUGIN_NAME);
    for (const warning of warnings) this.log.warn(warning);
    this.config = resolved;
    this.client = null;
    this.coexisting = false;
    this.sessionMeta = new Map();
    this.metaError = null;
    this.metaUpdatedAt = null;
    this.metaInFlight = false;
    this.metaTriedAt = 0;
    this.gateDisposer = null;
    this.started = false;

    ctx.effect(() => {
      void this.start().catch((error) => this.log.error('start failed: %s', String(error?.stack ?? error)));
      return () => this.stop();
    }, `${PLUGIN_NAME}: lifecycle`);
  }

  #reportCoexistence() {
    const capacity = this.ctx.get('capacity');
    this.coexisting = capacity !== undefined && capacity !== null;
    if (this.coexisting) {
      this.log.error(
        'dsh-model-capacity is also mounted; take-a-number will NOT gate model calls to avoid double-queueing. ' +
        'Remove the model-capacity row from the profile to hand gating to the machine-wide queue.',
      );
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.#reportCoexistence();
    this.client = new TanClient({
      sock: this.config.sock,
      tcp: this.config.tcp,
      harness: 'dsh',
      instance: deriveInstance(process.env),
    });
    this.client.on('degraded', () => this.log.warn('take-a-number daemon unreachable — passing model calls through (fail-open)'));
    this.client.on('restored', () => this.log.info('take-a-number daemon restored — gating resumed'));
    await this.client.connect();
    this.gateDisposer = this.ctx.on(
      'llm/stream',
      (options, next) => gatedStream(
        {
          enabled: this.#gatingEnabled(),
          queueId: queueFor(this.config, options.provider),
          client: this.client,
          withLease,
          describe: (sessionId) => this.describe(sessionId),
          clientToken: this.config.clientToken,
        },
        options,
        next,
      ),
      { global: true, prepend: true },
    );
    this.#installRoutes();
    await this.refreshSessionMeta();
    this.log.info('applied: instance=%s queues=%s', deriveInstance(process.env), JSON.stringify(this.config.queues));
  }

  #gatingEnabled() {
    return isEnabled(this.config) && !this.coexisting;
  }

  stop() {
    if (this.gateDisposer !== null) {
      try {
        this.gateDisposer();
      } catch {
        // already detached
      }
      this.gateDisposer = null;
    }
    if (this.client !== null) {
      this.client.close();
      this.client = null;
    }
    this.started = false;
  }

  // ------------------------------------------------------------------ metadata

  #touchMeta() {
    if (this.metaInFlight) return;
    if (Date.now() - this.metaTriedAt < META_MAX_AGE_MS) return;
    this.metaTriedAt = Date.now();
    this.metaInFlight = true;
    void this.refreshSessionMeta()
      .catch(() => {})
      .finally(() => {
        this.metaInFlight = false;
      });
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
      return;
    }
    const next = new Map();
    for (const item of items) {
      next.set(item.sessionId, { title: item.projections?.values?.title ?? null });
    }
    this.sessionMeta = next;
    this.metaError = null;
    this.metaUpdatedAt = Date.now();
  }

  /** Session title + current turn for the acquire metadata. */
  describe(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return { sessionTitle: null, turn: null };
    let title = this.sessionMeta.get(sessionId)?.title ?? null;
    let turn = null;
    try {
      const live = this.ctx.get('sessions')?.get?.(sessionId);
      if (live !== undefined && live !== null) {
        title = this.ctx.get('sessionTitle')?.get?.(live)?.title ?? title;
      }
      const boundary = this.ctx.get('sessionProjections')?.stateOf?.(live ?? null, 'turnBoundary');
      if (typeof boundary?.lastTurn === 'number' && boundary.lastTurn >= 1) turn = boundary.lastTurn;
    } catch {
      // best effort
    }
    return { sessionTitle: title, turn };
  }

  // -------------------------------------------------------------------- panel

  async snapshot() {
    this.#touchMeta();
    const status = await this.client?.status();
    if (status === null || status === undefined) {
      return {
        ok: false,
        asOf: Date.now(),
        totals: { active: 0, waiting: 0 },
        queues: [],
        identities: [],
        degraded: true,
        metadata: { sessions: this.sessionMeta.size, updatedAt: this.metaUpdatedAt, error: this.metaError },
      };
    }
    return {
      ok: true,
      asOf: status.asOf,
      version: status.version,
      uptimeMs: status.uptimeMs,
      totals: status.totals,
      queues: status.queues,
      identities: status.identities,
      degraded: false,
      metadata: { sessions: this.sessionMeta.size, updatedAt: this.metaUpdatedAt, error: this.metaError },
    };
  }

  async cancelWaiter(waiterId) {
    return { cancelled: (await this.client?.cancel(waiterId))?.cancelled === true };
  }

  async forceRelease(leaseId) {
    return { released: (await this.client?.forceRelease(leaseId))?.released === true };
  }

  async setLimits(payload) {
    const result = await this.client?.setLimits(payload);
    return result === null ? { ok: false, error: 'daemon unreachable' } : { ok: true };
  }

  // -------------------------------------------------------------------- routes

  #installRoutes() {
    this.ctx.inject(['connection'], (scope) => {
      const connection = scope.connection;
      if (connection === undefined || connection === null) {
        this.log.error('connection service is missing; the take-a-number panel stays unavailable');
        return;
      }
      const handler = async (endpoint, payload) => {
        const p = payload !== null && typeof payload === 'object' ? payload : {};
        try {
          switch (endpoint) {
            case 'snapshot':
              return { ok: true, value: await this.snapshot() };
            case 'cancelWaiter':
              if (typeof p.waiterId !== 'string') return { ok: false, error: { code: 'bad_request', message: 'waiterId is required', details: {} } };
              return { ok: true, value: await this.cancelWaiter(p.waiterId) };
            case 'forceRelease':
              if (typeof p.leaseId !== 'string') return { ok: false, error: { code: 'bad_request', message: 'leaseId is required', details: {} } };
              return { ok: true, value: await this.forceRelease(p.leaseId) };
            case 'setLimits': {
              if (!Array.isArray(p.queues)) return { ok: false, error: { code: 'bad_request', message: 'queues array is required', details: {} } };
              return { ok: true, value: await this.setLimits(p) };
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
      connection.fetch.register({
        path: `${API_BASE}/${STREAM_ENDPOINT}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => this.#openStream(request),
      });
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

  /**
   * The push channel: the daemon's NDJSON status stream, re-served to the
   * browser. The host holds the daemon subscription only while a panel is
   * listening.
   */
  #openStream(request) {
    const encoder = new TextEncoder();
    let unsubscribe = null;
    let clientSub = null;
    const stop = () => {
      if (clientSub !== null) {
        try {
          clientSub();
        } catch {
          // already gone
        }
        clientSub = null;
      }
      unsubscribe = null;
    };
    const body = new ReadableStream({
      start: (controller) => {
        const push = (frame) => {
          if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        };
        try {
          clientSub = this.client?.events((frame) => push(frame));
        } catch {
          clientSub = null;
        }
        // Seed the panel immediately so the first paint is current.
        void this.snapshot().then((snap) => push(snap));
        request.signal?.addEventListener('abort', () => {
          stop();
          try {
            controller.close();
          } catch {
            // already closed
          }
        }, { once: true });
      },
      cancel: stop,
    });
    return new Response(body, {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
    });
  }
}

export { ConfigError, queueFor, deriveInstance } from './config.mjs';
export { KIND_MAP, kindFor, composeDescription } from './gate.mjs';
