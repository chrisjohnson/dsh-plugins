// dsh-model-capacity: the in-memory, process-wide capacity manager.
//
// One bucket per provider route. A bucket holds active leases and FIFO waiters.
// `used = active`; a call may start only while `used < limit`. Every model call
// — an interactive turn or a subagent child's request — waits in the same queue
// for its provider, in the order it arrived.
//
// There is no queue timeout and no timer of any kind. The only bound on waiting
// work is queueLimitPerProvider.

import { randomUUID } from 'node:crypto';

export class CapacityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CapacityError';
    this.code = code;
    this.details = details;
  }
}

const nowMs = () => Date.now();

export class CapacityManager {
  /**
   * @param {object} options
   * @param {number} options.defaultLimit fallback for an undeclared provider
   * @param {Array<{provider:string,maxConcurrent:number}>} options.limits
   * @param {number} options.queueLimitPerProvider
   * @param {(type:string, payload:object)=>void} [options.onEvent]
   * @param {()=>number} [options.now]
   */
  constructor({ defaultLimit = 1, limits = [], queueLimitPerProvider = 1000, onEvent = () => {}, now = nowMs } = {}) {
    this.defaultLimit = defaultLimit;
    this.queueLimitPerProvider = queueLimitPerProvider;
    this.onEvent = onEvent;
    this.now = now;
    this.buckets = new Map();
    this.leases = new Map();
    this.waiters = new Map();
    this.configure(limits);
  }

  configure(limits) {
    this.limits = new Map(limits.map((entry) => [entry.provider, entry.unlimited === true ? Infinity : entry.maxConcurrent]));
    for (const [provider, bucket] of this.buckets) {
      bucket.limit = this.limits.get(provider) ?? this.defaultLimit;
      this.drain(provider);
    }
  }

  get enabled() {
    return true;
  }

  bucket(provider) {
    let bucket = this.buckets.get(provider);
    if (bucket === undefined) {
      bucket = {
        provider,
        limit: this.limits.get(provider) ?? this.defaultLimit,
        active: new Set(),
        waiters: [],
      };
      this.buckets.set(provider, bucket);
    }
    return bucket;
  }

  used(provider) {
    return this.bucket(provider).active.size;
  }

  freeSlots(provider) {
    const bucket = this.bucket(provider);
    return Math.max(0, bucket.limit - bucket.active.size);
  }

  limit(provider) {
    return this.bucket(provider).limit;
  }

  #lease(provider, model, sessionId, kind, meta) {
    const id = randomUUID();
    const bucket = this.bucket(provider);
    const lease = {
      id,
      provider,
      model: model ?? null,
      sessionId: sessionId ?? null,
      kind: kind ?? 'call',
      startedAt: this.now(),
      released: false,
      waitedMs: Number(meta?.waitedMs ?? 0),
      ...meta,
      release: () => this.release(id),
    };
    bucket.active.add(id);
    this.leases.set(id, lease);
    this.onEvent('acquired', {
      leaseId: id,
      provider,
      model: lease.model,
      sessionId: lease.sessionId,
      kind: lease.kind,
      waitedMs: lease.waitedMs,
      active: bucket.active.size,
      limit: bucket.limit,
    });
    return lease;
  }

  /**
   * Wait for a slot (or take a free one). Resolves with a lease.
   * `signal` removes the waiter on abort; there is no timeout of our own.
   */
  acquire({ provider, model = null, sessionId = null, kind = 'call', signal, meta = {} }) {
    if (typeof provider !== 'string' || provider === '') {
      return Promise.reject(new CapacityError('CAPACITY_BAD_REQUEST', 'capacity acquire needs a provider'));
    }
    if (signal?.aborted) {
      return Promise.reject(new CapacityError('CAPACITY_ABORTED', 'aborted before capacity could be acquired', { provider }));
    }
    const bucket = this.bucket(provider);
    if (this.used(provider) < bucket.limit && bucket.waiters.length === 0) {
      return Promise.resolve(this.#lease(provider, model, sessionId, kind, meta));
    }
    if (bucket.waiters.length >= this.queueLimitPerProvider) {
      this.onEvent('rejected', { provider, sessionId, reason: 'queue_full', waiting: bucket.waiters.length });
      return Promise.reject(
        new CapacityError('CAPACITY_QUEUE_FULL', `capacity queue for "${provider}" is full (${bucket.waiters.length} waiting)`, {
          provider,
          limit: bucket.limit,
          waiting: bucket.waiters.length,
        }),
      );
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const waiter = {
        id,
        provider,
        model,
        sessionId,
        kind,
        meta,
        enqueuedAt: this.now(),
        resolve,
        reject,
        signal,
        onAbort: null,
      };
      if (signal !== undefined && signal !== null) {
        waiter.onAbort = () => {
          const removed = this.#removeWaiter(id);
          if (removed !== undefined) {
            reject(new CapacityError('CAPACITY_ABORTED', 'aborted while waiting for capacity', { provider, waiterId: id }));
          }
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      bucket.waiters.push(waiter);
      this.waiters.set(id, waiter);
      this.onEvent('waiting', {
        waiterId: id,
        provider,
        model,
        sessionId,
        position: bucket.waiters.length,
        waiting: bucket.waiters.length,
        active: bucket.active.size,
        limit: bucket.limit,
      });
    });
  }

  #removeWaiter(id) {
    const waiter = this.waiters.get(id);
    if (waiter === undefined) return undefined;
    this.waiters.delete(id);
    const bucket = this.bucket(waiter.provider);
    const index = bucket.waiters.findIndex((item) => item.id === id);
    if (index !== -1) bucket.waiters.splice(index, 1);
    if (waiter.signal !== undefined && waiter.signal !== null && waiter.onAbort !== null) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    this.onEvent('cancelled', { waiterId: id, provider: waiter.provider, sessionId: waiter.sessionId });
    return waiter;
  }

  /** Remove and reject one queued call (panel action). */
  cancelWaiter(id) {
    const waiter = this.#removeWaiter(id);
    if (waiter === undefined) return false;
    waiter.reject(new CapacityError('CAPACITY_CANCELLED', 'queued model call was cancelled', { provider: waiter.provider, waiterId: id }));
    return true;
  }

  release(leaseId) {
    const lease = this.leases.get(leaseId);
    if (lease === undefined || lease.released) return false;
    lease.released = true;
    this.leases.delete(leaseId);
    const bucket = this.bucket(lease.provider);
    bucket.active.delete(leaseId);
    this.onEvent('released', { leaseId, provider: lease.provider, sessionId: lease.sessionId, kind: lease.kind, active: bucket.active.size, limit: bucket.limit });
    this.drain(lease.provider);
    return true;
  }

  /** Release a lease without waiting for its stream to end (panel action). */
  forceRelease(leaseId) {
    const lease = this.leases.get(leaseId);
    if (lease === undefined || lease.released) return false;
    lease.released = true;
    this.leases.delete(leaseId);
    const bucket = this.bucket(lease.provider);
    bucket.active.delete(leaseId);
    this.onEvent('forced_release', { leaseId, provider: lease.provider, sessionId: lease.sessionId, model: lease.model });
    this.drain(lease.provider);
    return true;
  }

  drain(provider) {
    const bucket = this.bucket(provider);
    while (this.used(provider) < bucket.limit && bucket.waiters.length > 0) {
      const waiter = bucket.waiters.shift();
      this.waiters.delete(waiter.id);
      if (waiter.signal?.aborted) {
        waiter.reject(new CapacityError('CAPACITY_ABORTED', 'aborted while waiting for capacity', { provider }));
        continue;
      }
      if (waiter.signal !== undefined && waiter.signal !== null && waiter.onAbort !== null) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve(this.#lease(provider, waiter.model, waiter.sessionId, waiter.kind, {
        ...waiter.meta,
        waitedMs: Math.max(0, this.now() - waiter.enqueuedAt),
      }));
    }
  }

  waitersForSession(sessionId) {
    return [...this.waiters.values()].filter((waiter) => waiter.sessionId === sessionId);
  }

  /** Detached, JSON-safe view for the panel and HTTP route. */
  snapshot(now = this.now()) {
    const providers = [];
    let totalActive = 0;
    let totalWaiting = 0;
    for (const bucket of this.buckets.values()) {
      const active = [...bucket.active].map((id) => {
        const lease = this.leases.get(id);
        return {
          leaseId: id,
          sessionId: lease?.sessionId ?? null,
          model: lease?.model ?? null,
          kind: lease?.kind ?? 'call',
          startedAt: lease?.startedAt ?? null,
          elapsedMs: lease === undefined ? null : Math.max(0, now - lease.startedAt),
        };
      });
      const waiters = bucket.waiters.map((waiter, index) => ({
        waiterId: waiter.id,
        position: index + 1,
        sessionId: waiter.sessionId,
        model: waiter.model,
        kind: waiter.kind,
        enqueuedAt: waiter.enqueuedAt,
        waitedMs: Math.max(0, now - waiter.enqueuedAt),
      }));
      totalActive += active.length;
      totalWaiting += waiters.length;
      providers.push({
        name: bucket.provider,
        limit: bucket.limit === Infinity ? null : bucket.limit,
        unlimited: bucket.limit === Infinity,
        active,
        waiters,
        used: active.length,
      });
    }
    providers.sort((a, b) => a.name.localeCompare(b.name));
    return { asOf: now, totals: { active: totalActive, waiting: totalWaiting }, providers };
  }
}
