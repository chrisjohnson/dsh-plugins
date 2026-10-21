// dsh-model-capacity: the in-memory, process-wide capacity manager.
//
// One bucket per provider route. A bucket holds active leases, FIFO waiters and
// pending subagent reservations. `used = active + reserved`; a call may start
// only while `used < limit`. Interactive calls wait in the queue; subagent
// dispatch reserves synchronously and fails loudly when the bucket is full.
//
// There is no queue timeout. The only timer is reservation cleanup, so a child
// that never materialises cannot hold a slot forever.

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
   * @param {number} options.reservationTtlMs
   * @param {(type:string, payload:object)=>void} [options.onEvent]
   * @param {()=>number} [options.now]
   */
  constructor({ defaultLimit = 1, limits = [], queueLimitPerProvider = 1000, reservationTtlMs = 300000, onEvent = () => {}, now = nowMs } = {}) {
    this.defaultLimit = defaultLimit;
    this.queueLimitPerProvider = queueLimitPerProvider;
    this.reservationTtlMs = reservationTtlMs;
    this.onEvent = onEvent;
    this.now = now;
    this.buckets = new Map();
    this.leases = new Map();
    this.waiters = new Map();
    this.reservations = new Map();
    this.configure(limits);
  }

  configure(limits) {
    this.limits = new Map(limits.map((entry) => [entry.provider, entry.maxConcurrent]));
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
        reservations: new Set(),
      };
      this.buckets.set(provider, bucket);
    }
    return bucket;
  }

  used(provider) {
    const bucket = this.bucket(provider);
    return bucket.active.size + bucket.reservations.size;
  }

  freeSlots(provider) {
    const bucket = this.bucket(provider);
    return Math.max(0, bucket.limit - bucket.active.size - bucket.reservations.size);
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
      ...meta,
      release: () => this.release(id),
    };
    bucket.active.add(id);
    this.leases.set(id, lease);
    this.onEvent('acquired', { leaseId: id, provider, model: lease.model, sessionId: lease.sessionId, kind: lease.kind, active: bucket.active.size, limit: bucket.limit });
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
      waiter.resolve(this.#lease(provider, waiter.model, waiter.sessionId, waiter.kind, waiter.meta));
    }
  }

  /**
   * Reserve one slot for a subagent dispatch. Synchronous: the tool guard needs
   * an immediate yes/no. Throws a CapacityError whose message is shown to the
   * model when the provider is full.
   */
  reserve({ provider, parentSession, tool = 'subagent', callId = null }) {
    const bucket = this.bucket(provider);
    if (this.used(provider) >= bucket.limit) {
      const details = {
        provider,
        limit: bucket.limit,
        active: bucket.active.size,
        reserved: bucket.reservations.size,
        waiting: bucket.waiters.length,
      };
      this.onEvent('rejected', { provider, parentSession, tool, ...details });
      throw new CapacityError(
        'CAPACITY_EXCEEDED',
        `provider "${provider}" is at its limit (${bucket.active.size + bucket.reservations.size}/${bucket.limit} in use, ${bucket.waiters.length} waiting)`,
        details,
      );
    }
    const reservation = {
      id: randomUUID(),
      provider,
      parentSession,
      tool,
      callId,
      childSession: null,
      state: 'pending',
      createdAt: this.now(),
    };
    this.reservations.set(reservation.id, reservation);
    bucket.reservations.add(reservation.id);
    this.onEvent('reserved', { reservationId: reservation.id, provider, parentSession, tool });
    return reservation;
  }

  /** Map the child session a reservation was made for (first `session/created` after a reservation). */
  bindChild(parentSession, childSession) {
    if (typeof parentSession !== 'string' || parentSession === '') return undefined;
    for (const reservation of this.reservations.values()) {
      if (reservation.parentSession === parentSession && reservation.childSession === null) {
        reservation.childSession = childSession;
        reservation.state = 'mapped';
        this.onEvent('reservation_mapped', { reservationId: reservation.id, parentSession, childSession, provider: reservation.provider });
        return reservation;
      }
    }
    return undefined;
  }

  /**
   * Convert a mapped reservation to the active lease for the child's first call.
   * A mismatched provider cancels the reservation and returns null so the call
   * takes the normal queue.
   */
  consumeReservation(sessionId, provider) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    for (const reservation of this.reservations.values()) {
      if (reservation.childSession !== sessionId) continue;
      if (reservation.provider !== provider) {
        this.cancelReservation(reservation.id, 'provider_mismatch');
        return null;
      }
      this.reservations.delete(reservation.id);
      this.bucket(reservation.provider).reservations.delete(reservation.id);
      this.onEvent('reservation_consumed', { reservationId: reservation.id, provider, childSession: sessionId });
      return this.#lease(provider, null, sessionId, 'call', { reservationId: reservation.id });
    }
    return null;
  }

  cancelReservation(id, reason = 'cancelled') {
    const reservation = this.reservations.get(id);
    if (reservation === undefined) return false;
    this.reservations.delete(id);
    this.bucket(reservation.provider).reservations.delete(id);
    this.onEvent('reservation_cancelled', {
      reservationId: id,
      provider: reservation.provider,
      parentSession: reservation.parentSession,
      childSession: reservation.childSession,
      reason,
    });
    this.drain(reservation.provider);
    return true;
  }

  /** Cancel a reservation whose tool call failed before a child consumed it. */
  cancelReservationByCallId(callId, reason = 'tool_error') {
    if (typeof callId !== 'string' || callId === '') return false;
    for (const reservation of [...this.reservations.values()]) {
      if (reservation.callId === callId) return this.cancelReservation(reservation.id, reason);
    }
    return false;
  }

  /** Drop expired reservations; called by the host timer. */
  expireReservations(now = this.now()) {
    let count = 0;
    for (const reservation of [...this.reservations.values()]) {
      if (now - reservation.createdAt >= this.reservationTtlMs) {
        this.cancelReservation(reservation.id, 'ttl');
        count += 1;
      }
    }
    return count;
  }

  /** Release a reservation that belongs to a disposed child, if it was never consumed. */
  releaseForSession(sessionId) {
    let count = 0;
    for (const reservation of [...this.reservations.values()]) {
      if (reservation.childSession === sessionId) {
        this.cancelReservation(reservation.id, 'session_disposed');
        count += 1;
      }
    }
    return count;
  }

  waitersForSession(sessionId) {
    return [...this.waiters.values()].filter((waiter) => waiter.sessionId === sessionId);
  }

  /** Detached, JSON-safe view for the panel and HTTP route. */
  snapshot(now = this.now()) {
    const providers = [];
    let totalActive = 0;
    let totalWaiting = 0;
    let totalReservations = 0;
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
      const reservations = [...bucket.reservations].map((id) => {
        const reservation = this.reservations.get(id);
        return {
          reservationId: id,
          parentSession: reservation?.parentSession ?? null,
          childSession: reservation?.childSession ?? null,
          tool: reservation?.tool ?? null,
          state: reservation?.state ?? 'pending',
          createdAt: reservation?.createdAt ?? null,
          ageMs: reservation === undefined ? null : Math.max(0, now - reservation.createdAt),
        };
      });
      totalActive += active.length;
      totalWaiting += waiters.length;
      totalReservations += reservations.length;
      providers.push({
        name: bucket.provider,
        limit: bucket.limit,
        active,
        waiters,
        reservations,
        used: active.length + reservations.length,
      });
    }
    providers.sort((a, b) => a.name.localeCompare(b.name));
    return { asOf: now, totals: { active: totalActive, waiting: totalWaiting, reservations: totalReservations }, providers };
  }
}
