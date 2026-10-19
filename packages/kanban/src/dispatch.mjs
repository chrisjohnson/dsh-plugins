// dsh-kanban: role-session dispatcher.
//
// Code creates a session from a role preset, sends one prompt, and waits for the
// turn to stop. It never asks an agent what to do next: the final message is
// returned as data to the engine.
//
// Turn-stop detection has two signals, in this order:
//   1. the host's `session/event` feed (`turn/end`) — the real event;
//   2. polling the live agent's status on the worker tick, for the case where a
//      listener was attached after the event fired (restart, HMR).
// The watchdog is separate: a turn with no event for `stallTimeoutMs` resolves
// as stalled and the engine abandons its span and lease.

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { createUserMessage } from '@deepseek-ai/dsh-llm';

export class DispatchError extends Error {
  constructor(message, { code = 'DISPATCH_FAILED' } = {}) {
    super(message);
    this.name = 'DispatchError';
    this.code = code;
  }
}

const PRESET_PLUGINS = [
  {
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: {
      prefix: 'You are a workflow agent in a DeepSeek Harness role session.',
      suffix: 'Your working directory is {{cwd}}.',
    },
  },
  { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
  { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
];

/** Existing sessions can be reused for a continuation, but never across tickets. */
export class SessionDriver {
  constructor({ ctx, log, getConfig }) {
    this.ctx = ctx;
    this.agents = ctx.get('agents');
    this.log = log;
    this.getConfig = getConfig;
    this.waiters = new Map();
    /** sessionId -> {handle, role, preset, ticketId} */
    this.live = new Map();
    this.registeredPresets = new Map();
    this.disposed = false;
    this.offEvent = null;
  }

  start() {
    this.offEvent = this.ctx.on('session/event', (session, event) => {
      const waiter = this.waiters.get(session.id);
      if (waiter === undefined) return;
      waiter.lastEventAt = Date.now();
      if (event.type === 'turn/end') {
        try {
          this.#settleTurn(session, event, waiter);
        } catch (error) {
          this.log.warn('kanban driver: settle failed: %s', String(error?.stack ?? error));
        }
      }
    });
  }

  stop() {
    this.disposed = true;
    if (this.offEvent !== null) {
      try {
        this.offEvent();
      } catch {
        // already detached
      }
      this.offEvent = null;
    }
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ status: 'disposed', finalText: null, usage: null, reason: null, error: 'plugin stopped' });
    }
    this.waiters.clear();
  }

  /** Register the shipped role presets once. A pre-existing id is reused, never re-registered. */
  async ensurePresets() {
    const presets = this.ctx.get('agentPresets');
    if (presets === undefined) throw new DispatchError('agentPresets service is missing; role presets cannot be bound', { code: 'NO_PRESETS' });
    const config = this.getConfig();
    const ids = new Set();
    for (const role of ['griller', 'planner', 'implementer', 'verifier', 'reviewer']) {
      const id = config.roles[role].preset;
      if (typeof id === 'string' && id.startsWith('kanban-')) ids.add(id);
    }
    for (const id of ids) {
      if (this.registeredPresets.has(id)) continue;
      const existing = await presets.resolve(id).catch(() => undefined);
      if (existing !== undefined) {
        this.registeredPresets.set(id, null);
        continue;
      }
      const dispose = await presets.register({
        id,
        name: id.replace('kanban-', 'Kanban '),
        description: 'Role-scoped workflow session owned by dsh-kanban',
        plugins: PRESET_PLUGINS,
      });
      this.registeredPresets.set(id, dispose);
    }
  }

  /**
   * Create one role session on a concrete route.
   * @returns {Promise<{sessionId:string, handle:object, preset:string}>}
   */
  async createRoleSession({ ticket, role, route }) {
    if (this.disposed) throw new DispatchError('plugin is stopping');
    if (this.agents === undefined) throw new DispatchError('agents service is missing', { code: 'NO_AGENTS' });
    const config = this.getConfig();
    const cwd = ticket.workspaceCwd ?? config.defaultWorkspaceCwd ?? process.cwd();
    await mkdir(cwd, { recursive: true }).catch(() => {});
    const presets = this.ctx.get('agentPresets');
    if (presets === undefined) throw new DispatchError('agentPresets service is missing', { code: 'NO_PRESETS' });
    const requested = config.roles[role].preset;
    const resolved = await presets.resolve(requested ?? undefined);
    if (resolved.broken !== undefined) {
      throw new DispatchError(`preset ${resolved.id} is broken: ${resolved.broken}`, { code: 'PRESET_BROKEN' });
    }
    const allow = Array.isArray(config.roles[role].allowTools) ? config.roles[role].allowTools : [];
    const sessionId = randomUUID();
    const handle = await this.agents.create({
      sessionId,
      meta: { cwd, agentPreset: resolved.id },
      agentOptions: {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === null || route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      },
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, resolved.id);
        // Allow-list as a mask over the preset's inherited tools, then a
        // monotonic guard so a newly mounted tool cannot slip past it.
        try {
          const visible = new Set(agentCtx.tools.schemas().map((schema) => schema.name));
          const keep = allow.filter((name) => visible.has(name));
          if (keep.length > 0) agentCtx.tools.restrict({ allow: keep });
        } catch (error) {
          this.log.warn('role %s: tool mask could not be applied: %s', role, String(error?.message ?? error));
        }
        agentCtx.tools.guard((execution) => {
          const name = execution?.name;
          if (typeof name !== 'string') return 'kanban: unnamed tool call denied';
          return allow.includes(name) ? undefined : `kanban: role "${role}" may not call "${name}"`;
        });
      },
    });
    this.live.set(sessionId, { handle, role, preset: resolved.id, ticketId: ticket.id });
    return { sessionId, handle, preset: resolved.id };
  }



  #settleTurn(session, event, waiter) {
    this.waiters.delete(session.id);
    clearTimeout(waiter.timer);
    const turn = event.data.turn;
    const events = session.snapshotEvents ? session.snapshotEvents() : [];
    const turnEvents = events.filter((e) => e.data !== null && typeof e.data === 'object' && e.data.turn === turn);
    const assistants = turnEvents.filter((e) => e.type === 'assistant/message');
    const last = assistants[assistants.length - 1];
    const finalText =
      last === undefined
        ? ''
        : (last.data.message.content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('');
    const usage = aggregateUsage(assistants.map((e) => e.data.usage));
    const reason = event.data.reason ?? null;
    const failed = reason !== null && ['error', 'aborted', 'interrupted', 'max-tokens'].includes(reason.kind);
    waiter.resolve({
      status: failed ? 'failed' : 'ok',
      finalText,
      usage,
      reason,
      error: failed ? (reason.kind === 'error' ? (reason.error?.message ?? 'model error') : reason.kind) : null,
      turn,
      events: turnEvents,
      session,
    });
  }

  /**
   * Send one prompt and wait for its turn to end.
   * @returns {Promise<{status:'ok'|'failed'|'stalled'|'disposed', finalText:string|null, usage:object|null, reason:object|null, error:string|null, startedMono:bigint}>}
   */
  sendTurn({ sessionId, prompt, stallTimeoutMs }) {
    const live = this.live.get(sessionId);
    if (live === undefined) return Promise.reject(new DispatchError(`session ${sessionId} is not live`, { code: 'NOT_LIVE' }));
    if (this.waiters.has(sessionId)) return Promise.reject(new DispatchError(`session ${sessionId} already has a turn in flight`, { code: 'BUSY' }));
    const startedMono = process.hrtime.bigint();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = this.waiters.get(sessionId);
        if (waiter === undefined) return;
        this.waiters.delete(sessionId);
        waiter.resolve({ status: 'stalled', finalText: null, usage: null, reason: null, error: 'no turn event within stallTimeoutMs', startedMono });
      }, stallTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const waiter = { resolve, reject, timer, lastEventAt: Date.now(), startedMono, sessionId };
      this.waiters.set(sessionId, waiter);
      try {
        live.handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
      } catch (error) {
        this.waiters.delete(sessionId);
        clearTimeout(timer);
        reject(new DispatchError(`could not admit prompt: ${error?.message ?? error}`, { code: 'PROMPT_REJECTED' }));
      }
    });
  }

  /**
   * Fallback signal: the worker tick asks whether a waiting agent has already
   * gone idle, which covers a turn/end event that fired before our listener.
   */
  reconcileTurns() {
    const now = Date.now();
    for (const [sessionId, waiter] of [...this.waiters]) {
      const live = this.live.get(sessionId);
      if (live === undefined) continue;
      if (now - waiter.lastEventAt > this.getConfig().stallTimeoutMs) {
        this.waiters.delete(sessionId);
        clearTimeout(waiter.timer);
        waiter.resolve({ status: 'stalled', finalText: null, usage: null, reason: null, error: 'stalled', startedMono: waiter.startedMono });
        continue;
      }
      if (live.handle.agent.status === 'idle' && now - waiter.lastEventAt > 1500) {
        const session = live.handle.agent.session;
        const events = session.snapshotEvents ? session.snapshotEvents() : [];
        const ends = events.filter((event) => event.type === 'turn/end');
        const lastEnd = ends[ends.length - 1];
        if (lastEnd !== undefined) {
          try {
            this.#settleTurn(session, lastEnd, waiter);
          } catch (error) {
            this.log.warn('kanban driver: reconcile settle failed: %s', String(error?.stack ?? error));
          }
        }
      }
    }
  }

  async closeSession(sessionId, { dispose = true } = {}) {
    const live = this.live.get(sessionId);
    if (live === undefined) return;
    this.live.delete(sessionId);
    const waiter = this.waiters.get(sessionId);
    if (waiter !== undefined) {
      this.waiters.delete(sessionId);
      clearTimeout(waiter.timer);
      waiter.resolve({ status: 'disposed', finalText: null, usage: null, reason: null, error: 'session closed' });
    }
    if (dispose) {
      try {
        await live.handle.dispose();
      } catch (error) {
        this.log.warn('session %s dispose failed: %s', sessionId, String(error?.message ?? error));
      }
    }
  }

  isLive(sessionId) {
    return this.live.has(sessionId);
  }
}

export function aggregateUsage(usages) {
  const present = usages.filter((u) => u !== null && u !== undefined && typeof u === 'object');
  if (present.length === 0) return null;
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const usage of present) {
    total.inputTokens += Number(usage.inputTokens ?? 0);
    total.outputTokens += Number(usage.outputTokens ?? 0);
    total.cacheReadTokens += Number(usage.cacheReadTokens ?? 0);
    total.cacheWriteTokens += Number(usage.cacheWriteTokens ?? 0);
  }
  return total;
}
